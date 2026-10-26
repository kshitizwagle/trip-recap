"use client";

// MP4 export: renders the same RecapScene as the preview, frame by frame, at the chosen frame shape,
// quality and frame rate. Waits for map tiles before every capture, encodes H.264 with WebCodecs and
// writes the file with engine/mp4.ts. Replaces the backend's Playwright + FFmpeg renderer.

import type maplibregl from "maplibre-gl";
import {buildMp4File, type VideoSample} from "./engine/mp4.ts";
import {createSceneMap, type FrameId, frameSize, type MapStyleId, RecapScene} from "./recap-scene";
import type {TripData, TripMedia} from "./trip-types";

export const EXPORT_MAX_SECONDS = 120;
export const EXPORT_QUALITIES = [720, 1080, 1440] as const;
export const EXPORT_FRAME_RATES = [30, 60] as const;
export type ExportQuality = (typeof EXPORT_QUALITIES)[number];
export type ExportFrameRate = (typeof EXPORT_FRAME_RATES)[number];
const TIMESCALE = 90_000;
/** Map CSS pixels on the short edge; labels and HUD scale from this, so every quality looks alike. */
const CSS_SHORT_SIDE = 540;

export interface ExportProgress {
  stage: "preparing" | "rendering" | "finishing";
  frame: number;
  frames: number;
}

export interface ExportOptions {
  vehicle: string;
  styleId: MapStyleId;
  frame: FrameId;
  quality: ExportQuality;
  fps: ExportFrameRate;
  onProgress?: (progress: ExportProgress) => void;
  signal?: AbortSignal;
}

export function canExportVideo(): boolean {
  return typeof window !== "undefined" && "VideoEncoder" in window && "VideoFrame" in window;
}

export function exportDimensions(frame: FrameId, quality: ExportQuality): [number, number] {
  return frameSize(frame, quality);
}

async function pickEncoderConfig(width: number, height: number, fps: number): Promise<VideoEncoderConfig> {
  const bitrate = Math.round(width * height * fps * 0.09);
  for (const codec of ["avc1.640034", "avc1.640033", "avc1.640028", "avc1.4d0028", "avc1.42e028"]) {
    const config: VideoEncoderConfig = {codec, width, height, bitrate, framerate: fps, avc: {format: "avc"}};
    try {
      if ((await VideoEncoder.isConfigSupported(config)).supported) return config;
    } catch {
      // try the next profile
    }
  }
  throw new Error(`This browser cannot encode H.264 at ${width}×${height}. Try a lower quality, or a recent Chrome, Edge or Safari.`);
}

function waitForEvent(map: maplibregl.Map, event: "load" | "render", timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    map.once(event, () => {
      clearTimeout(timer);
      resolve();
    });
  });
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

type MediaSource = {item: TripMedia; image?: HTMLImageElement | null; video?: HTMLVideoElement | null};

async function drawMedia(ctx: CanvasRenderingContext2D, scene: RecapScene, media: Map<string, MediaSource>, time: number, width: number, height: number) {
  const visible = scene.visibleMedia(time);
  if (!visible) return;
  const entry = media.get(visible.media.id);
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
  const box = RecapScene.mediaBox(width, height, sourceWidth, sourceHeight);
  const alpha = Math.min(1, Math.max(0, (time - visible.shownAt) / 0.4));
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(0, (1 - alpha) * 16 * box.unit);
  ctx.shadowColor = "rgba(0, 0, 0, 0.55)";
  ctx.shadowBlur = 32 * box.unit;
  ctx.shadowOffsetY = 12 * box.unit;
  ctx.beginPath();
  ctx.roundRect(box.x, box.y, box.w + box.pad * 2, box.h + box.pad * 2, box.radius);
  ctx.fillStyle = "rgba(15, 14, 20, 0.94)";
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.lineWidth = box.unit;
  ctx.strokeStyle = "#6d6d6d";
  ctx.stroke();
  ctx.drawImage(source, box.x + box.pad, box.y + box.pad, box.w, box.h);
  ctx.restore();
}

/** Renders the trip to an H.264 MP4 entirely in the browser. */
export async function exportRecapVideo(data: TripData, options: ExportOptions): Promise<Blob> {
  if (!canExportVideo()) throw new Error("Video export needs WebCodecs. Try a recent Chrome, Edge or Safari.");
  const timeline = data.timeline;
  if (!timeline) throw new Error("This trip has no timeline to render");
  const {onProgress, signal, fps} = options;
  const checkAbort = () => {
    if (signal?.aborted) throw new DOMException("Export cancelled", "AbortError");
  };

  onProgress?.({stage: "preparing", frame: 0, frames: 0});
  const [width, height] = exportDimensions(options.frame, options.quality);
  const config = await pickEncoderConfig(width, height, fps);
  const scale = Math.min(width, height) / CSS_SHORT_SIDE;
  const scene = new RecapScene(data);

  const host = document.createElement("div");
  Object.assign(host.style, {position: "fixed", left: "-30000px", top: "0", width: `${width / scale}px`, height: `${height / scale}px`, pointerEvents: "none"});
  document.body.appendChild(host);
  const {map, attribution} = createSceneMap(host, {
    styleId: options.styleId,
    center: scene.coords[0] ?? [85.324, 27.676],
    pixelRatio: scale,
    preserveDrawingBuffer: true,
  });

  const media = new Map<string, MediaSource>();
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
      encoded.push({data: bytes, isKey: chunk.type === "key", duration: TIMESCALE / fps});
    },
    error: (error) => {
      encoderError = error;
    },
  });

  const settle = async (maxMs: number) => {
    map.triggerRepaint();
    await waitForEvent(map, "render", 250);
    const started = performance.now();
    while (!(map.loaded() && map.areTilesLoaded()) && performance.now() - started < maxMs) {
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  };

  try {
    encoder.configure(config);
    await waitForEvent(map, "load", 20_000);
    checkAbort();
    for (const item of data.trip.media) {
      if (!timeline.events.some((event) => event.type === "media_show" && event.payload.media_id === item.id)) continue;
      media.set(item.id, item.media_type === "video" ? {item, video: await loadVideo(item.url)} : {item, image: await loadImage(item.preview_url)});
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D is unavailable");

    const sourceDuration = scene.duration;
    const outputSeconds = Math.min(sourceDuration, EXPORT_MAX_SECONDS);
    const frames = Math.max(1, Math.ceil(outputSeconds * fps));
    const step = frames > 1 ? sourceDuration / (frames - 1) : 0;
    scene.resetCamera();
    for (let index = 0; index < frames; index += 1) {
      checkAbort();
      if (encoderError) throw encoderError;
      const time = index * step;
      scene.updateCamera(map, time, step);
      await settle(index === 0 ? 20_000 : 8000);

      ctx.drawImage(map.getCanvas(), 0, 0, width, height);
      scene.draw(ctx, map, time, {
        width,
        height,
        scale,
        clockMs: (index / fps) * 1000,
        vehicle: options.vehicle,
        timeProgress: sourceDuration ? time / sourceDuration : 1,
        attribution: attribution(),
      });
      await drawMedia(ctx, scene, media, time, width, height);

      const frame = new VideoFrame(canvas, {timestamp: Math.round((index * 1_000_000) / fps), duration: Math.round(1_000_000 / fps)});
      encoder.encode(frame, {keyFrame: index % (fps * 2) === 0});
      frame.close();
      while (encoder.encodeQueueSize > 4) await new Promise((resolve) => setTimeout(resolve, 5));
      onProgress?.({stage: "rendering", frame: index + 1, frames});
    }

    onProgress?.({stage: "finishing", frame: frames, frames});
    await encoder.flush();
    if (encoderError) throw encoderError;
    if (!avcC) throw new Error("The video encoder did not return its configuration");
    const file = buildMp4File({width, height, timescale: TIMESCALE, avcC}, encoded);
    return new Blob([file as BlobPart], {type: "video/mp4"});
  } finally {
    if (encoder.state !== "closed") encoder.close();
    media.forEach((entry) => entry.video?.removeAttribute("src"));
    map.remove();
    host.remove();
  }
}
