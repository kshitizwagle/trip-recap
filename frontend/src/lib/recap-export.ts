"use client";

// In-browser replacement for backend/app/renderer (Playwright + FFmpeg). It renders the trip
// frame by frame from the same timeline the preview plays, waits for map tiles before every
// capture, encodes H.264 with WebCodecs and writes an MP4 with engine/mp4.ts.

import maplibregl from "maplibre-gl";
import {buildMp4File, type VideoSample} from "./engine/mp4.ts";
import {visibleMediaAt} from "./engine/timeline.ts";
import type {Timeline} from "./engine/models.ts";
import type {TripData, TripMedia} from "./trip-types";

export const EXPORT_WIDTH = 1080;
export const EXPORT_HEIGHT = 1920;
export const EXPORT_FPS = 30;
export const EXPORT_MAX_SECONDS = 90;
const SCALE = 2; // CSS pixels -> output pixels
const TIMESCALE = 90_000;
const LIBERTY_STYLE = "https://tiles.openfreemap.org/styles/liberty";
const ATTRIBUTION = "© OpenFreeMap © OpenMapTiles © OpenStreetMap contributors";

const AURA = {
  bgDeep: "#0f0e14",
  fg: "#edecee",
  gray: "#6d6d6d",
  border: "#2e2c3a",
  accentSoft: "#8464c6",
  green: "#61ffca",
};

export interface ExportProgress {
  stage: "preparing" | "rendering" | "finishing";
  frame: number;
  frames: number;
}

export interface ExportOptions {
  vehicle?: string;
  onProgress?: (progress: ExportProgress) => void;
  signal?: AbortSignal;
}

type Coordinate = [number, number];

export function canExportVideo(): boolean {
  return typeof window !== "undefined" && "VideoEncoder" in window && "VideoFrame" in window;
}

function distance([aLon, aLat]: Coordinate, [bLon, bLat]: Coordinate): number {
  const r = Math.PI / 180;
  const h = Math.sin(((bLat - aLat) * r) / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(((bLon - aLon) * r) / 2) ** 2;
  return 12_742_017.6 * Math.asin(Math.sqrt(h));
}

class RoutePath {
  readonly coords: Coordinate[];
  private readonly cumulative: number[] = [0];
  readonly total: number;

  constructor(data: TripData) {
    const route = data.route?.geometry.coordinates;
    this.coords = route?.length
      ? route.map(([lon, lat]) => [lon, lat] as Coordinate)
      : data.observations.map(({longitude, latitude}) => [longitude, latitude] as Coordinate);
    for (let i = 1; i < this.coords.length; i += 1) this.cumulative.push(this.cumulative[i - 1] + distance(this.coords[i - 1], this.coords[i]));
    this.total = this.cumulative[this.cumulative.length - 1] ?? 0;
  }

  at(progress: number): {point: Coordinate; index: number; heading: Coordinate} {
    const target = Math.max(0, Math.min(1, progress)) * this.total;
    let index = 0;
    while (index < this.cumulative.length - 2 && this.cumulative[index + 1] < target) index += 1;
    const start = this.coords[index];
    const end = this.coords[Math.min(index + 1, this.coords.length - 1)] ?? start;
    const span = Math.max((this.cumulative[index + 1] ?? 0) - this.cumulative[index], 1e-6);
    const ratio = Math.max(0, Math.min(1, (target - this.cumulative[index]) / span));
    return {point: [start[0] + (end[0] - start[0]) * ratio, start[1] + (end[1] - start[1]) * ratio], index, heading: end};
  }
}

function waitFor(map: maplibregl.Map, event: "load" | "idle" | "render", timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    map.once(event, () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function mapSettled(map: maplibregl.Map, maxMs = 8000): Promise<void> {
  map.triggerRepaint();
  await waitFor(map, "render", 300);
  const started = performance.now();
  while (!(map.loaded() && map.areTilesLoaded()) && performance.now() - started < maxMs) {
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = url;
  });
}

function loadVideo(url: string): Promise<HTMLVideoElement | null> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.onloadeddata = () => resolve(video);
    video.onerror = () => resolve(null);
    video.src = url;
  });
}

function seek(video: HTMLVideoElement, time: number): Promise<void> {
  const target = Math.max(0, Math.min(time, (video.duration || 0) - 0.05));
  if (Math.abs(video.currentTime - target) < 0.01) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => resolve();
    video.addEventListener("seeked", done, {once: true});
    setTimeout(done, 1500);
    video.currentTime = target;
  });
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

async function pickEncoderConfig(): Promise<VideoEncoderConfig> {
  for (const codec of ["avc1.640028", "avc1.4d0028", "avc1.42e028", "avc1.640033"]) {
    const config: VideoEncoderConfig = {
      codec,
      width: EXPORT_WIDTH,
      height: EXPORT_HEIGHT,
      bitrate: 10_000_000,
      framerate: EXPORT_FPS,
      avc: {format: "avc"},
    };
    try {
      if ((await VideoEncoder.isConfigSupported(config)).supported) return config;
    } catch {
      // try the next profile
    }
  }
  throw new Error("This browser cannot encode H.264 video. Try a recent Chrome, Edge or Safari.");
}

/** Renders the trip to a 1080×1920, 30 FPS H.264 MP4 entirely in the browser. */
export async function exportRecapVideo(data: TripData, options: ExportOptions = {}): Promise<Blob> {
  if (!canExportVideo()) throw new Error("Video export needs WebCodecs. Try a recent Chrome, Edge or Safari.");
  const timeline: Timeline | null = data.timeline as Timeline | null;
  if (!timeline) throw new Error("This trip has no timeline to render");
  const {onProgress, signal} = options;
  const vehicle = options.vehicle ?? "🛵";
  const checkAbort = () => {
    if (signal?.aborted) throw new DOMException("Export cancelled", "AbortError");
  };

  onProgress?.({stage: "preparing", frame: 0, frames: 0});
  const config = await pickEncoderConfig();
  const path = new RoutePath(data);
  const cssWidth = EXPORT_WIDTH / SCALE;
  const cssHeight = EXPORT_HEIGHT / SCALE;

  const host = document.createElement("div");
  Object.assign(host.style, {position: "fixed", left: "-20000px", top: "0", width: `${cssWidth}px`, height: `${cssHeight}px`, pointerEvents: "none"});
  document.body.appendChild(host);

  const map = new maplibregl.Map({
    container: host,
    style: LIBERTY_STYLE,
    center: path.coords[0] ?? [85.324, 27.676],
    zoom: 8,
    interactive: false,
    attributionControl: false,
    fadeDuration: 0,
    pixelRatio: SCALE,
    canvasContextAttributes: {preserveDrawingBuffer: true},
  });

  const media = new Map<string, {item: TripMedia; image?: HTMLImageElement | null; video?: HTMLVideoElement | null}>();
  const encoded: VideoSample[] = [];
  let avcC: Uint8Array | null = null;
  let encoderError: unknown = null;
  const encoder = new VideoEncoder({
    output: (chunk, metadata) => {
      const description = metadata?.decoderConfig?.description;
      if (description && !avcC) {
        const view = ArrayBuffer.isView(description)
          ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
          : new Uint8Array(description);
        avcC = new Uint8Array(view);
      }
      const bytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(bytes);
      encoded.push({data: bytes, isKey: chunk.type === "key", duration: TIMESCALE / EXPORT_FPS});
    },
    error: (error) => {
      encoderError = error;
    },
  });

  try {
    encoder.configure(config);
    await waitFor(map, "load", 20_000);
    checkAbort();

    map.addSource("route", {type: "geojson", data: {type: "Feature", properties: {}, geometry: {type: "LineString", coordinates: path.coords}}});
    map.addLayer({id: "route", type: "line", source: "route", paint: {"line-color": AURA.accentSoft, "line-width": 5, "line-opacity": 0.7, "line-dasharray": [2, 1.4]}});
    map.addSource("traveled", {type: "geojson", data: {type: "Feature", properties: {}, geometry: {type: "LineString", coordinates: []}}});
    map.addLayer({id: "traveled", type: "line", source: "traveled", paint: {"line-color": AURA.green, "line-width": 7}});
    if (path.coords.length > 1) {
      const bounds = path.coords.reduce((acc, point) => acc.extend(point), new maplibregl.LngLatBounds(path.coords[0], path.coords[0]));
      map.fitBounds(bounds, {padding: {top: 120, right: 70, bottom: 360, left: 70}, duration: 0});
    } else if (path.coords.length === 1) {
      map.jumpTo({center: path.coords[0], zoom: 14});
    }

    for (const item of data.trip.media) {
      if (!timeline.events.some((event) => event.type === "media_show" && event.payload.media_id === item.id)) continue;
      media.set(item.id, item.media_type === "video" ? {item, video: await loadVideo(item.url)} : {item, image: await loadImage(item.preview_url)});
    }
    await mapSettled(map, 20_000);
    checkAbort();

    const canvas = document.createElement("canvas");
    canvas.width = EXPORT_WIDTH;
    canvas.height = EXPORT_HEIGHT;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D is unavailable");
    const traveled = map.getSource("traveled") as maplibregl.GeoJSONSource;

    const outputSeconds = Math.min(timeline.duration_seconds, EXPORT_MAX_SECONDS);
    const frames = Math.max(1, Math.ceil(outputSeconds * EXPORT_FPS));
    for (let index = 0; index < frames; index += 1) {
      checkAbort();
      if (encoderError) throw encoderError;
      const progress = frames === 1 ? 0 : index / (frames - 1);
      const time = timeline.duration_seconds * progress;
      const position = path.at(time / Math.max(timeline.duration_seconds, 0.001));
      traveled.setData({
        type: "Feature",
        properties: {},
        geometry: {type: "LineString", coordinates: path.coords.slice(0, position.index + 1).concat([position.point])},
      });
      await mapSettled(map);

      ctx.drawImage(map.getCanvas(), 0, 0, EXPORT_WIDTH, EXPORT_HEIGHT);
      drawObservations(ctx, map, data);
      drawVehicle(ctx, map, position.point, position.heading, vehicle);
      await drawMedia(ctx, media, timeline, time);
      drawAttribution(ctx);

      const frame = new VideoFrame(canvas, {timestamp: Math.round((index * 1_000_000) / EXPORT_FPS), duration: Math.round(1_000_000 / EXPORT_FPS)});
      encoder.encode(frame, {keyFrame: index % (EXPORT_FPS * 2) === 0});
      frame.close();
      while (encoder.encodeQueueSize > 4) await new Promise((resolve) => setTimeout(resolve, 5));
      onProgress?.({stage: "rendering", frame: index + 1, frames});
    }

    onProgress?.({stage: "finishing", frame: frames, frames});
    await encoder.flush();
    if (encoderError) throw encoderError;
    if (!avcC) throw new Error("The video encoder did not return its configuration");
    const file = buildMp4File({width: EXPORT_WIDTH, height: EXPORT_HEIGHT, timescale: TIMESCALE, avcC}, encoded);
    return new Blob([file as BlobPart], {type: "video/mp4"});
  } finally {
    if (encoder.state !== "closed") encoder.close();
    media.forEach((entry) => entry.video?.removeAttribute("src"));
    map.remove();
    host.remove();
  }
}

function drawObservations(ctx: CanvasRenderingContext2D, map: maplibregl.Map, data: TripData) {
  ctx.save();
  ctx.font = `600 ${10 * SCALE}px "IBM Plex Mono", monospace`;
  ctx.textBaseline = "middle";
  for (const observation of data.observations) {
    const {x, y} = map.project([observation.longitude, observation.latitude]);
    const px = x * SCALE;
    const py = y * SCALE;
    ctx.beginPath();
    ctx.arc(px, py, 5.5 * SCALE, 0, Math.PI * 2);
    ctx.fillStyle = AURA.green;
    ctx.fill();
    ctx.lineWidth = 3 * SCALE;
    ctx.strokeStyle = AURA.bgDeep;
    ctx.stroke();
    const label = observation.place || "Unknown place";
    const text = label.length > 26 ? `${label.slice(0, 25)}…` : label;
    const width = ctx.measureText(text).width + 16 * SCALE;
    const left = px + 12 * SCALE;
    roundRect(ctx, left, py - 11 * SCALE, width, 22 * SCALE, 2 * SCALE);
    ctx.fillStyle = "rgba(15, 14, 20, 0.92)";
    ctx.fill();
    ctx.lineWidth = 1 * SCALE;
    ctx.strokeStyle = "rgba(237, 236, 238, 0.15)";
    ctx.stroke();
    ctx.fillStyle = AURA.fg;
    ctx.fillText(text, left + 8 * SCALE, py);
  }
  ctx.restore();
}

function drawVehicle(ctx: CanvasRenderingContext2D, map: maplibregl.Map, point: Coordinate, heading: Coordinate, vehicle: string) {
  const at = map.project(point);
  const next = map.project(heading);
  ctx.save();
  ctx.translate(at.x * SCALE, at.y * SCALE);
  if (next.x < at.x - 0.25) ctx.scale(-1, 1);
  ctx.font = `${29 * SCALE}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = "rgba(0, 0, 0, 0.5)";
  ctx.shadowBlur = 12 * SCALE;
  ctx.shadowOffsetY = 4 * SCALE;
  ctx.fillText(vehicle, 0, 0);
  ctx.restore();
}

async function drawMedia(
  ctx: CanvasRenderingContext2D,
  media: Map<string, {item: TripMedia; image?: HTMLImageElement | null; video?: HTMLVideoElement | null}>,
  timeline: Timeline,
  time: number,
) {
  const visible = visibleMediaAt(timeline, time);
  if (!visible) return;
  const entry = media.get(visible.mediaId);
  let source: CanvasImageSource | null = null;
  let sourceWidth = 0;
  let sourceHeight = 0;
  if (entry?.video) {
    await seek(entry.video, time - visible.shownAt);
    source = entry.video;
    sourceWidth = entry.video.videoWidth;
    sourceHeight = entry.video.videoHeight;
  } else if (entry?.image) {
    source = entry.image;
    sourceWidth = entry.image.naturalWidth;
    sourceHeight = entry.image.naturalHeight;
  }
  if (!source || !sourceWidth || !sourceHeight) return;

  const fadeEvent = timeline.events.find((event) => event.type === "media_show" && event.payload.media_id === visible.mediaId && event.video_time === visible.shownAt);
  const fade = Number(fadeEvent?.payload.fade_seconds ?? 0.4) || 0.4;
  const alpha = Math.min(1, Math.max(0, (time - visible.shownAt) / fade));
  const margin = 22 * SCALE;
  const pad = 7 * SCALE;
  const maxW = EXPORT_WIDTH * 0.82 - pad * 2;
  const maxH = EXPORT_HEIGHT * 0.42 - pad * 2;
  const scale = Math.min(maxW / sourceWidth, maxH / sourceHeight);
  const w = sourceWidth * scale;
  const h = sourceHeight * scale;
  const x = EXPORT_WIDTH - margin - w - pad * 2;
  const y = EXPORT_HEIGHT - margin - h - pad * 2 - 40;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.shadowColor = "rgba(0, 0, 0, 0.55)";
  ctx.shadowBlur = 32 * SCALE;
  ctx.shadowOffsetY = 12 * SCALE;
  roundRect(ctx, x, y, w + pad * 2, h + pad * 2, 3 * SCALE);
  ctx.fillStyle = "rgba(15, 14, 20, 0.94)";
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.lineWidth = 1 * SCALE;
  ctx.strokeStyle = AURA.gray;
  ctx.stroke();
  ctx.drawImage(source, x + pad, y + pad, w, h);
  ctx.restore();
}

function drawAttribution(ctx: CanvasRenderingContext2D) {
  ctx.save();
  ctx.font = `500 ${9 * SCALE}px "IBM Plex Mono", monospace`;
  ctx.textAlign = "right";
  ctx.textBaseline = "bottom";
  const width = ctx.measureText(ATTRIBUTION).width;
  ctx.fillStyle = "rgba(15, 14, 20, 0.6)";
  ctx.fillRect(EXPORT_WIDTH - width - 24, EXPORT_HEIGHT - 34, width + 24, 34);
  ctx.fillStyle = "rgba(237, 236, 238, 0.85)";
  ctx.fillText(ATTRIBUTION, EXPORT_WIDTH - 12, EXPORT_HEIGHT - 9);
  ctx.restore();
}
