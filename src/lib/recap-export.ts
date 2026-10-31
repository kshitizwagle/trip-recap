"use client";

// MP4 export: renders the same RecapScene as the preview, frame by frame, at the chosen frame shape,
// quality and frame rate. Waits for map tiles before every capture, encodes H.264 with WebCodecs and
// writes the file with engine/mp4.ts.

import type maplibregl from "maplibre-gl";
import {buildMp4File, type VideoSample} from "./engine/mp4.ts";
import {createSceneMap, type FrameId, frameSize, type MapStyleId, RecapScene} from "./recap-scene";
import type {TripData} from "./trip-types";

export const EXPORT_MAX_SECONDS = 300;
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
  /** Playback speed, as in the preview: 0.5 makes the MP4 twice as long. */
  speed?: number;
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
  // Ask for a hardware encoder at any profile first; fall back to whatever the browser offers.
  for (const hardwareAcceleration of ["prefer-hardware", "no-preference"] as const) {
    for (const codec of ["avc1.640034", "avc1.640033", "avc1.640028", "avc1.4d0028", "avc1.42e028"]) {
      const config: VideoEncoderConfig = {codec, width, height, bitrate, framerate: fps, hardwareAcceleration, avc: {format: "avc"}};
      try {
        if ((await VideoEncoder.isConfigSupported(config)).supported) return config;
      } catch {
        // try the next profile
      }
    }
  }
  throw new Error(`This browser cannot encode H.264 at ${width}×${height}. Try a lower quality, or a recent Chrome, Edge or Safari.`);
}

function nextMapEvent(map: maplibregl.Map, event: "data" | "styledata", timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      map.off(event, done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    map.on(event, done);
  });
}

/** Lets the page paint progress between frames. Message tasks, unlike timers, are not slowed in hidden tabs. */
function yieldToPage(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => resolve();
    channel.port2.postMessage(null);
  });
}

function nextDequeue(encoder: VideoEncoder, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      encoder.removeEventListener("dequeue", done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    encoder.addEventListener("dequeue", done);
  });
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

  // Renders on demand instead of on animation frames, which a hidden tab or covered window does not
  // get, and waits on tile arrivals instead of polling with timers, which hidden tabs slow down.
  const settle = async (maxMs: number) => {
    map.redraw();
    const started = performance.now();
    while (!(map.loaded() && map.areTilesLoaded()) && performance.now() - started < maxMs) {
      await nextMapEvent(map, "data", 100);
      map.redraw();
    }
  };

  try {
    encoder.configure(config);
    const styleStarted = performance.now();
    while (!map.isStyleLoaded() && performance.now() - styleStarted < 20_000) await nextMapEvent(map, "styledata", 250);
    checkAbort();

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D is unavailable");

    const sourceDuration = scene.duration;
    const speed = options.speed && options.speed > 0 ? options.speed : 1;
    const outputSeconds = Math.min(sourceDuration / speed, EXPORT_MAX_SECONDS);
    const frames = Math.max(1, Math.ceil(outputSeconds * fps));
    const step = frames > 1 ? sourceDuration / (frames - 1) : 0;
    scene.resetCamera();
    for (let index = 0; index < frames; index += 1) {
      checkAbort();
      if (encoderError) throw encoderError;
      const time = index * step;
      // Same camera smoothing per real second as the live preview.
      scene.updateCamera(map, time, 1 / fps);
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

      const frame = new VideoFrame(canvas, {timestamp: Math.round((index * 1_000_000) / fps), duration: Math.round(1_000_000 / fps)});
      encoder.encode(frame, {keyFrame: index % (fps * 2) === 0});
      frame.close();
      while (encoder.encodeQueueSize > 4) await nextDequeue(encoder, 50);
      onProgress?.({stage: "rendering", frame: index + 1, frames});
      await yieldToPage();
    }

    onProgress?.({stage: "finishing", frame: frames, frames});
    await encoder.flush();
    if (encoderError) throw encoderError;
    if (!avcC) throw new Error("The video encoder did not return its configuration");
    const file = buildMp4File({width, height, timescale: TIMESCALE, avcC}, encoded);
    return new Blob([file as BlobPart], {type: "video/mp4"});
  } finally {
    if (encoder.state !== "closed") encoder.close();
    map.remove();
    host.remove();
  }
}
