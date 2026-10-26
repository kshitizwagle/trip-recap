"use client";

import type maplibregl from "maplibre-gl";
import {forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type CSSProperties, type Ref} from "react";
import {createSceneMap, FRAMES, type FrameId, type MapStyleId, RecapScene} from "@/lib/recap-scene";
import type {TripData, TripMedia} from "@/lib/trip-types";

export interface MapPreviewHandle {
  replayRoute: () => void;
  togglePlay: () => void;
  fitRoute: () => void;
}

export interface MapPreviewProps {
  data: TripData;
  styleId: MapStyleId;
  frame: FrameId;
  vehicle: string;
  playbackSpeed: number;
  onPlayingChange?: (playing: boolean) => void;
}

function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/**
 * Live preview drawn by the same RecapScene as the MP4 export: the camera follows the traveller
 * while playing, and the map is free to pan while paused.
 */
const MapPreview = forwardRef(function MapPreview(
  {data, styleId, frame, vehicle, playbackSpeed, onPlayingChange}: MapPreviewProps,
  ref: Ref<MapPreviewHandle>,
) {
  const mapHostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const sceneRef = useRef<RecapScene | null>(null);
  const timeRef = useRef(0);
  const playingRef = useRef(false);
  const followRef = useRef(true);
  const speedRef = useRef(playbackSpeed);
  const vehicleRef = useRef(vehicle);
  const dirtyRef = useRef(true);
  const snapRef = useRef(true);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [overlay, setOverlay] = useState<TripMedia | null>(null);
  const overlayIdRef = useRef<string | null>(null);

  speedRef.current = playbackSpeed;
  vehicleRef.current = vehicle;

  const setPlayingBoth = useCallback(
    (value: boolean) => {
      playingRef.current = value;
      setPlaying(value);
      onPlayingChange?.(value);
    },
    [onPlayingChange],
  );

  const replayRoute = useCallback(() => {
    timeRef.current = 0;
    followRef.current = true;
    sceneRef.current?.resetCamera();
    dirtyRef.current = true;
    setPlayingBoth(true);
  }, [setPlayingBoth]);

  const togglePlay = useCallback(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    if (playingRef.current) {
      setPlayingBoth(false);
      return;
    }
    if (timeRef.current >= scene.duration) timeRef.current = 0;
    followRef.current = true;
    sceneRef.current?.resetCamera();
    setPlayingBoth(true);
  }, [setPlayingBoth]);

  const fitRoute = useCallback(() => {
    const map = mapRef.current;
    const scene = sceneRef.current;
    if (!map || !scene) return;
    setPlayingBoth(false);
    followRef.current = false;
    const target = scene.overviewTarget(map);
    if (target) map.easeTo({center: [target.lng, target.lat], zoom: target.zoom, duration: 600});
  }, [setPlayingBoth]);

  useImperativeHandle(ref, () => ({replayRoute, togglePlay, fitRoute}), [replayRoute, togglePlay, fitRoute]);

  // Map + scene lifecycle.
  useEffect(() => {
    const host = mapHostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    const scene = new RecapScene(data);
    sceneRef.current = scene;
    const start = scene.coords[0] ?? [85.324, 27.676];
    const {map} = createSceneMap(host, {styleId, center: start, interactive: true});
    mapRef.current = map;
    timeRef.current = 0;
    followRef.current = true;
    setTime(0);
    let raf = 0;
    let last = performance.now();
    let lastUiUpdate = 0;
    let disposed = false;

    const resize = () => {
      const rect = host.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      map.resize();
      dirtyRef.current = true;
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);

    const markDirty = () => {
      dirtyRef.current = true;
    };
    map.on("move", markDirty);
    map.on("dragstart", () => {
      followRef.current = false;
      if (playingRef.current) setPlayingBoth(false);
    });

    const frame = (now: number) => {
      if (disposed) return;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (playingRef.current) {
        timeRef.current = Math.min(scene.duration, timeRef.current + dt * speedRef.current);
        if (timeRef.current >= scene.duration) setPlayingBoth(false);
        dirtyRef.current = true;
      }
      if (followRef.current && (playingRef.current || snapRef.current) && map.isStyleLoaded()) {
        scene.updateCamera(map, timeRef.current, playingRef.current ? dt : 1);
        snapRef.current = false;
      }
      const ctx = canvas.getContext("2d");
      if (ctx && (dirtyRef.current || playingRef.current)) {
        const rect = host.getBoundingClientRect();
        const scale = rect.width ? canvas.width / rect.width : 1;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        scene.draw(ctx, map, timeRef.current, {
          width: canvas.width,
          height: canvas.height,
          scale,
          clockMs: now,
          vehicle: vehicleRef.current,
          timeProgress: scene.duration ? timeRef.current / scene.duration : 0,
        });
        dirtyRef.current = false;
        const visible = scene.visibleMedia(timeRef.current);
        const id = visible?.media.id ?? null;
        if (id !== overlayIdRef.current) {
          overlayIdRef.current = id;
          setOverlay(visible?.media ?? null);
        }
      }
      if (now - lastUiUpdate > 200) {
        lastUiUpdate = now;
        setTime(timeRef.current);
      }
      raf = requestAnimationFrame(frame);
    };

    map.once("load", () => {
      resize();
      scene.resetCamera();
      setPlayingBoth(true);
    });
    raf = requestAnimationFrame(frame);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      observer.disconnect();
      map.remove();
      mapRef.current = null;
      sceneRef.current = null;
    };
  }, [data, styleId, setPlayingBoth]);

  // Redraw when only the vehicle changes.
  useEffect(() => {
    dirtyRef.current = true;
  }, [vehicle]);

  const duration = sceneRef.current?.duration ?? data.timeline?.duration_seconds ?? 0;

  return (
    <section className="map-frame" aria-label="Trip route map">
      <div className={`map-canvas-frame frame-${frame}`} style={{"--frame-ratio": String(FRAMES[frame].ratio)} as CSSProperties}>
        <div className="map-host" ref={mapHostRef} />
        <canvas className="map-overlay" ref={canvasRef} aria-hidden="true" />
        <div className={overlay ? "media-overlay is-visible" : "media-overlay"}>
          {overlay ? (
            overlay.media_type === "video" ? (
              <video key={overlay.id} src={overlay.url} muted playsInline autoPlay aria-label={overlay.filename} />
            ) : (
              <img key={overlay.id} src={overlay.preview_url} alt={overlay.filename} onError={() => setOverlay(null)} />
            )
          ) : null}
        </div>
      </div>
      <div className="map-scrubber">
        <button type="button" className="map-play" onClick={togglePlay} aria-label={playing ? "Pause" : "Play"}>
          {playing ? "❚❚" : "▶"}
        </button>
        <input
          type="range"
          min={0}
          max={1000}
          value={duration ? Math.round((time / duration) * 1000) : 0}
          aria-label="Timeline position"
          onChange={(event) => {
            timeRef.current = (Number(event.target.value) / 1000) * duration;
            followRef.current = true;
            sceneRef.current?.resetCamera();
            snapRef.current = true;
            dirtyRef.current = true;
            setTime(timeRef.current);
          }}
        />
        <span className="map-clock">{formatClock(time)} / {formatClock(duration)}</span>
      </div>
    </section>
  );
});

MapPreview.displayName = "MapPreview";

export default MapPreview;
