"use client";

// One renderer for the live preview and the MP4 export: map styles, frame shapes, a camera that
// follows the traveller, the glowing route, labelled stops and the HUD. Both consume the same
// timeline through playbackStateAt, so what you preview is what you export.

import maplibregl from "maplibre-gl";
import {OUTRO_SECONDS, playbackStateAt, type PlaybackState} from "./engine/timeline.ts";
import type {Timeline} from "./engine/models.ts";
import type {TripData} from "./trip-types";

/* ---------- Map styles ---------- */

export type MapStyleId = "dark" | "light" | "street" | "satellite";

function esri(path: string, attribution: string): maplibregl.StyleSpecification {
  return {
    version: 8,
    sources: {
      base: {
        type: "raster",
        tiles: [`https://server.arcgisonline.com/ArcGIS/rest/services/${path}/MapServer/tile/{z}/{y}/{x}`],
        tileSize: 256,
        maxzoom: 18,
        attribution,
      },
    },
    layers: [{id: "base", type: "raster", source: "base", paint: {"raster-fade-duration": 0}}],
  };
}

const OSM_ATTRIBUTION = "© OpenFreeMap © OpenMapTiles © OpenStreetMap contributors";
const ESRI_ATTRIBUTION = "© Esri, HERE, Garmin, © OpenStreetMap contributors";
const ESRI_IMAGERY = "Imagery © Esri, Maxar, Earthstar Geographics";

export const MAP_STYLES: Record<MapStyleId, {label: string; style: string | maplibregl.StyleSpecification; fallback: maplibregl.StyleSpecification; attribution: string}> = {
  dark: {label: "Dark", style: "https://tiles.openfreemap.org/styles/dark", fallback: esri("Canvas/World_Dark_Gray_Base", ESRI_ATTRIBUTION), attribution: OSM_ATTRIBUTION},
  light: {label: "Light", style: "https://tiles.openfreemap.org/styles/positron", fallback: esri("Canvas/World_Light_Gray_Base", ESRI_ATTRIBUTION), attribution: OSM_ATTRIBUTION},
  street: {label: "Street", style: "https://tiles.openfreemap.org/styles/liberty", fallback: esri("World_Street_Map", ESRI_ATTRIBUTION), attribution: OSM_ATTRIBUTION},
  satellite: {label: "Satellite", style: esri("World_Imagery", ESRI_IMAGERY), fallback: esri("World_Imagery", ESRI_IMAGERY), attribution: ESRI_IMAGERY},
};
export const MAP_STYLE_IDS = Object.keys(MAP_STYLES) as MapStyleId[];

export interface SceneMapOptions {
  styleId: MapStyleId;
  center: [number, number];
  interactive?: boolean;
  pixelRatio?: number;
  preserveDrawingBuffer?: boolean;
}

/** Creates a map for the scene. If the vector style can't load, it switches to the Esri equivalent. */
export function createSceneMap(container: HTMLElement, options: SceneMapOptions): {map: maplibregl.Map; attribution: () => string} {
  const spec = MAP_STYLES[options.styleId];
  let usingFallback = false;
  let styleLoaded = false;
  const map = new maplibregl.Map({
    container,
    style: spec.style,
    center: options.center,
    zoom: 8,
    interactive: options.interactive ?? false,
    attributionControl: false,
    fadeDuration: 0,
    pixelRatio: options.pixelRatio,
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    canvasContextAttributes: {preserveDrawingBuffer: options.preserveDrawingBuffer ?? false},
  });
  const useFallback = () => {
    if (usingFallback || styleLoaded) return;
    usingFallback = true;
    map.setStyle(spec.fallback);
  };
  map.on("style.load", () => {
    styleLoaded = true;
  });
  map.on("error", (event: {sourceId?: string}) => {
    if (!event.sourceId) useFallback();
  });
  // The OpenFreeMap styles name a few point-of-interest icons their sprites lack; they draw as nothing.
  map.on("styleimagemissing", ({id}: {id: string}) => {
    if (!map.hasImage(id)) map.addImage(id, {width: 1, height: 1, data: new Uint8Array(4)});
  });
  setTimeout(useFallback, 8000);
  return {map, attribution: () => (usingFallback ? (spec.fallback.sources.base as {attribution?: string}).attribution ?? spec.attribution : spec.attribution)};
}

/* ---------- Frames ---------- */

export type FrameId = "portrait" | "landscape" | "square";
export const FRAMES: Record<FrameId, {label: string; ratio: number}> = {
  portrait: {label: "9:16", ratio: 9 / 16},
  landscape: {label: "16:9", ratio: 16 / 9},
  square: {label: "1:1", ratio: 1},
};
export const FRAME_IDS = Object.keys(FRAMES) as FrameId[];

/** Output pixel size for a frame, with `shortSide` pixels on the shorter edge. Always even. */
export function frameSize(frame: FrameId, shortSide: number): [number, number] {
  const ratio = FRAMES[frame].ratio;
  const even = (value: number) => Math.round(value / 2) * 2;
  return ratio >= 1 ? [even(shortSide * ratio), even(shortSide)] : [even(shortSide), even(shortSide / ratio)];
}

/* ---------- Scene ---------- */

const AURA = {
  ink: "#0f0e14",
  fg: "#edecee",
  muted: "#bdbdbd",
  metadata: "#908f98",
  accent: "#a277ff",
  accentSoft: "#8464c6",
  green: "#61ffca",
};
const FONT_MONO = '"IBM Plex Mono", ui-monospace, monospace';
const FONT_SERIF = 'Fraunces, Georgia, serif';
/** Vehicle value that draws the chevron arrow instead of an emoji. */
export const ARROW = "arrow";
const FONT_EMOJI = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';

type LngLat = [number, number];
type Rect = [number, number, number, number];
interface Camera {
  lng: number;
  lat: number;
  zoom: number;
}

/** Seconds of the outro spent pulling back; the rest holds on the whole route. */
const OUTRO_ZOOM_SECONDS = 1.8;

/**
 * Camera `t` (0..1) of the way from `from` to `to`, zooming about the one point that keeps its place
 * on screen, so the view opens out around where the trip ended instead of sliding across the map.
 */
function zoomPath(from: Camera, to: Camera, t: number): Camera {
  const a = maplibregl.MercatorCoordinate.fromLngLat([from.lng, from.lat]);
  const b = maplibregl.MercatorCoordinate.fromLngLat([to.lng, to.lat]);
  const zoom = from.zoom + (to.zoom - from.zoom) * t;
  const r = 2 ** (from.zoom - to.zoom);
  let x = a.x + (b.x - a.x) * t;
  let y = a.y + (b.y - a.y) * t;
  if (Math.abs(1 - r) > 0.05) {
    const fx = (b.x - a.x * r) / (1 - r);
    const fy = (b.y - a.y * r) / (1 - r);
    const s = 2 ** (from.zoom - zoom);
    x = fx - (fx - a.x) * s;
    y = fy - (fy - a.y) * s;
  }
  const center = new maplibregl.MercatorCoordinate(x, y).toLngLat();
  return {lng: center.lng, lat: center.lat, zoom};
}

export interface DrawOptions {
  /** Canvas size in device pixels. */
  width: number;
  height: number;
  /** Device pixels per map CSS pixel. */
  scale: number;
  /** Wall-clock milliseconds, for the pulse. */
  clockMs: number;
  vehicle: string;
  /** 0..1 position in the timeline, for the progress bar. */
  timeProgress: number;
  attribution?: string;
}

function haversine([aLon, aLat]: LngLat, [bLon, bLat]: LngLat): number {
  const r = Math.PI / 180;
  const h = Math.sin(((bLat - aLat) * r) / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(((bLon - aLon) * r) / 2) ** 2;
  return 12_742_017.6 * Math.asin(Math.sqrt(h));
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function overlaps(a: Rect, b: Rect): boolean {
  return a[0] < b[0] + b[2] && a[0] + a[2] > b[0] && a[1] < b[1] + b[3] && a[1] + a[3] > b[1];
}

function formatKm(meters: number): string {
  return meters >= 10_000 ? `${Math.round(meters / 1000)} km` : meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
}

/** Distances along a line in Web Mercator units, the space MapLibre measures `line-progress` in. */
export interface HudText {
  title: string;
  subtitle: string;
  km: string;
  line1: string;
  line2: string;
  moving: boolean;
}

export class RecapScene {
  /** Route, timeline and observation order are fixed for a scene; only stop names may change. */
  data: TripData;
  readonly timeline: Timeline | null;
  readonly coords: LngLat[];
  private readonly cumulative: number[] = [0];
  readonly total: number;
  readonly routeMeters: number;
  private camera: Camera | null = null;
  /** Where the camera was when the pull-back to the whole route began. */
  private outroFrom: Camera | null = null;

  constructor(data: TripData) {
    this.data = data;
    this.timeline = (data.timeline as Timeline | null) ?? null;
    const route = data.route?.geometry.coordinates;
    this.coords = route?.length
      ? route.map(([lon, lat]) => [lon, lat] as LngLat)
      : data.observations.map(({longitude, latitude}) => [longitude, latitude] as LngLat);
    for (let i = 1; i < this.coords.length; i += 1) this.cumulative.push(this.cumulative[i - 1] + haversine(this.coords[i - 1], this.coords[i]));
    this.total = this.cumulative[this.cumulative.length - 1] ?? 0;
    this.routeMeters = data.summary.distance_meters || this.total;
  }

  /** Takes new stop names (lookups and renames) without touching the route or timeline. */
  setLabels(data: TripData) {
    this.data = data;
  }

  /**
   * Where the traveller passes a stop: its point on the routed line. Without a route the line joins
   * the GPS points themselves, so the GPS point is used.
   */
  stopPoint(index: number): LngLat {
    const observation = this.data.observations[index];
    if (!observation) return [0, 0];
    if (!this.data.route || this.coords.length < 2) return [observation.longitude, observation.latitude];
    return this.position(observation.progress).point;
  }

  /** Stops whose photos were taken away from the road: the road point and the observed GPS point. */
  offRoute(minMeters = 25): Array<{index: number; on: LngLat; gps: LngLat}> {
    if (!this.data.route) return [];
    return this.data.observations.flatMap((observation, index) => {
      const gps: LngLat = [observation.longitude, observation.latitude];
      const on = this.stopPoint(index);
      return haversine(on, gps) > minMeters ? [{index, on, gps}] : [];
    });
  }

  /** The pill text for a stop: its place name, else its first file. */
  stopLabel(index: number): string {
    const observation = this.data.observations[index];
    if (!observation) return "";
    const name = observation.place && observation.place !== "Unknown place" ? observation.place : observation.media_files[0] ?? "Endpoint";
    return name.length > 28 ? `${name.slice(0, 27)}…` : name;
  }

  /** Every word the HUD shows at a moment, for the canvas export and the DOM preview alike. */
  hudText(state: PlaybackState): HudText {
    const {title, subtitle} = this.title();
    const observations = this.data.observations;
    const name = (index: number | null) => {
      const item = index === null ? undefined : observations[index];
      if (!item) return "";
      return item.place && item.place !== "Unknown place" ? item.place : `Point ${String(item.order).padStart(2, "0")}`;
    };
    let line1: string;
    let line2: string;
    if (state.phase === "move" && state.toIndex !== null) {
      line1 = `${name(state.atIndex)} → ${name(state.toIndex)}`;
      line2 = `leg ${state.toIndex} of ${Math.max(observations.length - 1, 1)}`;
    } else if (state.phase === "outro") {
      line1 = `${observations.length} points · ${formatKm(this.routeMeters)}`;
      line2 = "the whole route";
    } else {
      line1 = name(state.atIndex) || "Starting point";
      const media = observations[state.atIndex]?.media_files.length ?? 0;
      line2 = state.phase === "intro" ? "start" : `stop ${state.atIndex + 1} of ${observations.length}${media ? ` · ${media} memor${media === 1 ? "y" : "ies"}` : ""}`;
    }
    return {title, subtitle, km: formatKm(state.progress * this.routeMeters), line1, line2, moving: state.phase === "move"};
  }

  get duration(): number {
    return this.timeline?.duration_seconds ?? 0;
  }

  state(time: number): PlaybackState {
    if (!this.timeline) return {progress: 0, atIndex: 0, toIndex: null, moveProgress: 0, phase: "intro"};
    return playbackStateAt(this.timeline, this.data.observations, time);
  }

  private indexAt(meters: number): number {
    let lo = 0;
    let hi = this.cumulative.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.cumulative[mid] < meters) lo = mid;
      else hi = mid;
    }
    return hi;
  }

  position(progress: number): {point: LngLat; index: number; next: LngLat} {
    if (this.coords.length < 2) {
      const only = this.coords[0] ?? [0, 0];
      return {point: only, index: 0, next: only};
    }
    const target = Math.max(0, Math.min(1, progress)) * this.total;
    const index = this.indexAt(target);
    const a = this.coords[index - 1];
    const b = this.coords[index];
    const span = this.cumulative[index] - this.cumulative[index - 1] || 1;
    const t = Math.max(0, Math.min(1, (target - this.cumulative[index - 1]) / span));
    return {point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], index, next: b};
  }

  private bounds(fromMeters: number, toMeters: number, minSpanDegrees: number): maplibregl.LngLatBounds | null {
    if (!this.coords.length) return null;
    const i0 = Math.max(0, this.indexAt(Math.max(0, fromMeters)) - 1);
    const i1 = this.indexAt(Math.min(this.total, toMeters));
    const first = this.coords[i0];
    const bounds = new maplibregl.LngLatBounds(first, first);
    for (let i = i0; i <= i1; i += 1) bounds.extend(this.coords[i]);
    const center = bounds.getCenter();
    const half = minSpanDegrees / 2;
    bounds.extend([center.lng - half, center.lat - half * 0.7]);
    bounds.extend([center.lng + half, center.lat + half * 0.7]);
    return bounds;
  }

  /** Screen areas the HUD covers, so stop labels avoid them. */
  static hudRects(width: number, height: number, unit: number): Rect[] {
    const pad = 18 * unit;
    return [
      [0, 0, Math.min(width * 0.62, 260 * unit), pad + 66 * unit],
      [width - 150 * unit, 0, 150 * unit, pad + 50 * unit],
      [0, height - 96 * unit, Math.min(width, 420 * unit), 96 * unit],
    ];
  }

  /** Room the HUD takes, in map CSS pixels. */
  static hudPadding(cssWidth: number, cssHeight: number) {
    const unit = Math.min(cssWidth, cssHeight) / 540;
    return {top: 92 * unit, bottom: 104 * unit, left: Math.max(28, cssWidth * 0.08), right: Math.max(28, cssWidth * 0.08)};
  }

  overviewTarget(map: maplibregl.Map): Camera | null {
    const bounds = this.bounds(0, this.total, 0.01);
    return bounds ? this.fit(map, bounds, 15) : null;
  }

  cameraTarget(map: maplibregl.Map, time: number): Camera | null {
    const state = this.state(time);
    if (state.phase === "intro" || state.phase === "outro" || this.coords.length < 2) return this.overviewTarget(map);
    const here = state.progress * this.total;
    const back = Math.max(400, Math.min(15_000, this.total * 0.05));
    const bounds = this.bounds(here - back, here + back * 2.6, Math.max(0.012, Math.min(0.12, this.total / 1_200_000)));
    return bounds ? this.fit(map, bounds, 15.5) : null;
  }

  private fit(map: maplibregl.Map, bounds: maplibregl.LngLatBounds, maxZoom: number): Camera | null {
    const container = map.getContainer();
    const padding = RecapScene.hudPadding(container.clientWidth, container.clientHeight);
    const camera = map.cameraForBounds(bounds, {padding});
    if (!camera?.center) return null;
    const center = maplibregl.LngLat.convert(camera.center);
    return {lng: center.lng, lat: center.lat, zoom: Math.min(camera.zoom ?? 10, maxZoom)};
  }

  resetCamera() {
    this.camera = null;
    this.outroFrom = null;
  }

  /** Eases the map camera toward the target for this time. `dt` in seconds. */
  updateCamera(map: maplibregl.Map, time: number, dt: number) {
    const target = this.cameraTarget(map, time);
    if (!target) return;
    const outro = this.coords.length >= 2 && this.state(time).phase === "outro";
    if (!outro) this.outroFrom = null;
    if (outro) {
      // A timed pull-back that always lands on the whole route, instead of easing after it.
      this.outroFrom ??= {...(this.camera ?? target)};
      const t = Math.max(0, Math.min(1, (time - (this.duration - OUTRO_SECONDS)) / OUTRO_ZOOM_SECONDS));
      this.camera = zoomPath(this.outroFrom, target, t * t * (3 - 2 * t));
    } else if (!this.camera) {
      this.camera = {...target};
    } else {
      const k = 1 - Math.exp(-dt * 2.2);
      this.camera.lng += (target.lng - this.camera.lng) * k;
      this.camera.lat += (target.lat - this.camera.lat) * k;
      this.camera.zoom += (target.zoom - this.camera.zoom) * k * 0.85;
    }
    map.jumpTo({center: [this.camera.lng, this.camera.lat], zoom: this.camera.zoom});
  }

  /** Draws route, stops, traveller and HUD over the map. Does not clear the canvas. */
  draw(ctx: CanvasRenderingContext2D, map: maplibregl.Map, time: number, options: DrawOptions) {
    const {width, height, scale} = options;
    const unit = Math.min(width, height) / 540;
    const state = this.state(time);
    const project = (point: LngLat) => {
      const p = map.project(point);
      return {x: p.x * scale, y: p.y * scale};
    };
    const reserved: Rect[] = [];
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    this.drawRoute(ctx, project, state, unit);
    const head = this.position(state.progress);
    reserved.push(...RecapScene.hudRects(width, height, unit));
    this.drawHud(ctx, state, options, unit, reserved);
    this.drawStops(ctx, project, state, unit, width, height, reserved);
    this.drawHead(ctx, project, head, state, options, unit);
    ctx.restore();
  }

  private path(ctx: CanvasRenderingContext2D, points: Array<{x: number; y: number}>) {
    ctx.beginPath();
    let last: {x: number; y: number} | null = null;
    points.forEach((point, i) => {
      if (i === 0) ctx.moveTo(point.x, point.y);
      else if (!last || Math.abs(point.x - last.x) + Math.abs(point.y - last.y) > 1.2 || i === points.length - 1) ctx.lineTo(point.x, point.y);
      else return;
      last = point;
    });
  }

  private drawRoute(ctx: CanvasRenderingContext2D, project: (p: LngLat) => {x: number; y: number}, state: PlaybackState, unit: number) {
    if (this.coords.length < 2) return;
    const all = this.coords.map(project);
    // Remaining road: dashed when it is an inferred route, faint solid when it only joins GPS points.
    ctx.strokeStyle = this.data.route ? "rgba(162, 119, 255, 0.75)" : "rgba(237, 236, 238, 0.35)";
    ctx.lineWidth = 2.6 * unit;
    ctx.setLineDash(this.data.route ? [6 * unit, 5 * unit] : []);
    this.path(ctx, all);
    ctx.stroke();
    ctx.setLineDash([]);

    if (state.progress <= 0) return;
    const head = this.position(state.progress);
    const travelled = all.slice(0, head.index).concat([project(head.point)]);
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.strokeStyle = AURA.green;
    ctx.globalAlpha = 0.14;
    ctx.lineWidth = 14 * unit;
    this.path(ctx, travelled);
    ctx.stroke();
    ctx.globalAlpha = 0.26;
    ctx.lineWidth = 7 * unit;
    ctx.stroke();
    ctx.restore();
    ctx.strokeStyle = AURA.green;
    ctx.lineWidth = 3.6 * unit;
    this.path(ctx, travelled);
    ctx.stroke();
  }

  private drawStops(
    ctx: CanvasRenderingContext2D,
    project: (p: LngLat) => {x: number; y: number},
    state: PlaybackState,
    unit: number,
    width: number,
    height: number,
    reserved: Rect[],
  ) {
    const observations = this.data.observations;
    const reachedUpTo = state.atIndex;
    const font = 11 * unit;
    // Observed GPS spots off the road: a faint ring tethered to where the route passes.
    ctx.save();
    ctx.setLineDash([3 * unit, 3 * unit]);
    ctx.lineWidth = 1.2 * unit;
    ctx.strokeStyle = "rgba(237, 236, 238, 0.4)";
    for (const {on, gps} of this.offRoute()) {
      const a = project(on);
      const b = project(gps);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(b.x, b.y, 3 * unit, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();

    observations.forEach((observation, index) => {
      const p = project(this.stopPoint(index));
      const reached = index <= reachedUpTo;
      ctx.beginPath();
      ctx.arc(p.x, p.y, (reached ? 5 : 3.5) * unit, 0, Math.PI * 2);
      ctx.fillStyle = reached ? AURA.green : "rgba(237, 236, 238, 0.55)";
      ctx.fill();
      ctx.lineWidth = 2.5 * unit;
      ctx.strokeStyle = AURA.ink;
      ctx.stroke();
    });

    const current = state.atIndex;
    const order = observations
      .map((observation, index) => ({observation, index}))
      .filter(({index}) => index <= reachedUpTo || index === state.toIndex)
      .sort((a, b) => (b.index === current ? 1 : 0) - (a.index === current ? 1 : 0) || b.index - a.index);
    ctx.textBaseline = "middle";
    for (const {observation, index} of order) {
      const p = project(this.stopPoint(index));
      if (p.x < -50 || p.y < -50 || p.x > width + 50 || p.y > height + 50) continue;
      const number = String(observation.order).padStart(2, "0");
      const label = this.stopLabel(index);
      ctx.font = `600 ${font}px ${FONT_MONO}`;
      const numberWidth = ctx.measureText(number).width;
      ctx.font = `500 ${font}px ${FONT_MONO}`;
      const labelWidth = ctx.measureText(label).width;
      const w = numberWidth + labelWidth + 22 * unit;
      const h = font + 12 * unit;
      const hot = index === current && state.phase !== "outro";
      for (const [dx, dy] of [[10 * unit, -h / 2], [-w - 10 * unit, -h / 2], [-w / 2, -h - 10 * unit], [-w / 2, 10 * unit]]) {
        const rect: Rect = [p.x + dx, p.y + dy, w, h];
        if (rect[0] < 4 || rect[1] < 4 || rect[0] + w > width - 4 || rect[1] + h > height - 4) continue;
        if (reserved.some((other) => overlaps(rect, other))) continue;
        reserved.push(rect);
        roundRect(ctx, rect[0], rect[1], w, h, h / 2);
        ctx.fillStyle = hot ? "rgba(15, 14, 20, 0.94)" : "rgba(15, 14, 20, 0.78)";
        ctx.fill();
        if (hot) {
          ctx.lineWidth = 1.5 * unit;
          ctx.strokeStyle = AURA.green;
          ctx.stroke();
        }
        ctx.font = `600 ${font}px ${FONT_MONO}`;
        ctx.fillStyle = AURA.accent;
        ctx.fillText(number, rect[0] + 9 * unit, rect[1] + h / 2 + unit * 0.5);
        ctx.font = `500 ${font}px ${FONT_MONO}`;
        ctx.fillStyle = AURA.fg;
        ctx.fillText(label, rect[0] + 13 * unit + numberWidth, rect[1] + h / 2 + unit * 0.5);
        break;
      }
    }
  }

  private drawHead(
    ctx: CanvasRenderingContext2D,
    project: (p: LngLat) => {x: number; y: number},
    head: {point: LngLat; next: LngLat},
    state: PlaybackState,
    options: DrawOptions,
    unit: number,
  ) {
    if (this.coords.length < 1) return;
    const p = project(head.point);
    const next = project(head.next);
    const pulse = 0.5 + 0.5 * Math.sin(options.clockMs / 230);
    const glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, (26 + pulse * 8) * unit);
    glow.addColorStop(0, "rgba(97, 255, 202, 0.55)");
    glow.addColorStop(0.4, "rgba(97, 255, 202, 0.18)");
    glow.addColorStop(1, "rgba(97, 255, 202, 0)");
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 36 * unit, 0, Math.PI * 2);
    ctx.fill();
    if (options.vehicle === ARROW) {
      // The arrow from the first trip-map design: a notched chevron pointing along the road.
      const dx = next.x - p.x;
      const dy = next.y - p.y;
      if (Math.hypot(dx, dy) > 0.5) this.heading = Math.atan2(dy, dx);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(this.heading);
      ctx.beginPath();
      ctx.moveTo(12 * unit, 0);
      ctx.lineTo(-8 * unit, -8 * unit);
      ctx.lineTo(-3.5 * unit, 0);
      ctx.lineTo(-8 * unit, 8 * unit);
      ctx.closePath();
      ctx.shadowColor = "rgba(0, 0, 0, 0.5)";
      ctx.shadowBlur = 8 * unit;
      ctx.fillStyle = AURA.green;
      ctx.fill();
      ctx.shadowColor = "transparent";
      ctx.lineWidth = 2.2 * unit;
      ctx.lineJoin = "round";
      ctx.strokeStyle = AURA.ink;
      ctx.stroke();
      ctx.restore();
      return;
    }
    ctx.save();
    ctx.translate(p.x, p.y - 2 * unit);
    if (next.x < p.x - 0.5) ctx.scale(-1, 1);
    ctx.font = `${26 * unit}px ${FONT_EMOJI}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = "rgba(0, 0, 0, 0.55)";
    ctx.shadowBlur = 10 * unit;
    ctx.shadowOffsetY = 3 * unit;
    ctx.fillText(options.vehicle, 0, 0);
    ctx.restore();
  }

  /** Last travel direction, kept so the arrow doesn't snap when it sits exactly on a vertex. */
  private heading = 0;

  private title(): {title: string; subtitle: string} {
    const started = this.data.summary.started_at ? new Date(this.data.summary.started_at) : null;
    const title = started ? started.toLocaleDateString([], {day: "numeric", month: "short", year: "numeric"}) : "Trip recap";
    const points = this.data.summary.stop_count;
    return {title, subtitle: `${points} point${points === 1 ? "" : "s"} · ${formatKm(this.routeMeters)}`};
  }

  private drawHud(ctx: CanvasRenderingContext2D, state: PlaybackState, options: DrawOptions, unit: number, reserved: Rect[]) {
    const {width, height} = options;
    const pad = 18 * unit;

    // Legibility gradients over any basemap.
    let gradient = ctx.createLinearGradient(0, 0, 0, 110 * unit);
    gradient.addColorStop(0, "rgba(15, 14, 20, 0.62)");
    gradient.addColorStop(1, "rgba(15, 14, 20, 0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, 110 * unit);
    gradient = ctx.createLinearGradient(0, height - 130 * unit, 0, height);
    gradient.addColorStop(0, "rgba(15, 14, 20, 0)");
    gradient.addColorStop(1, "rgba(15, 14, 20, 0.7)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, height - 130 * unit, width, 130 * unit);

    const shadow = () => {
      ctx.shadowColor = "rgba(0, 0, 0, 0.6)";
      ctx.shadowBlur = 10 * unit;
    };
    const {title, subtitle, km, line1, line2, moving} = this.hudText(state);
    ctx.save();
    shadow();
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    ctx.fillStyle = AURA.metadata;
    ctx.font = `500 ${10 * unit}px ${FONT_MONO}`;
    ctx.fillText("TRIP RECAP", pad, pad + 10 * unit);
    ctx.fillStyle = AURA.fg;
    ctx.font = `700 ${24 * unit}px ${FONT_SERIF}`;
    ctx.fillText(title, pad, pad + 38 * unit);
    ctx.fillStyle = AURA.muted;
    ctx.font = `500 ${11 * unit}px ${FONT_MONO}`;
    ctx.fillText(subtitle, pad, pad + 56 * unit);

    ctx.textAlign = "right";
    ctx.fillStyle = AURA.fg;
    ctx.font = `600 ${24 * unit}px ${FONT_MONO}`;
    ctx.fillText(km, width - pad, pad + 26 * unit);
    ctx.fillStyle = AURA.metadata;
    ctx.font = `500 ${10 * unit}px ${FONT_MONO}`;
    ctx.fillText("ON THE ROAD", width - pad, pad + 42 * unit);
    ctx.restore();

    // Current leg card.
    const big = 17 * unit;
    const small = 11 * unit;
    ctx.save();
    ctx.font = `600 ${big}px ${FONT_MONO}`;
    const maxText = width - pad * 2 - 30 * unit;
    let text = line1;
    while (ctx.measureText(text).width > maxText && text.length > 4) text = `${text.slice(0, -2)}…`;
    const w1 = ctx.measureText(text).width;
    ctx.font = `500 ${small}px ${FONT_MONO}`;
    const w2 = ctx.measureText(line2).width;
    const boxW = Math.min(width - pad * 2, Math.max(w1, w2) + 30 * unit);
    const boxH = big + small + 26 * unit;
    const x = pad;
    const y = height - pad - boxH - 6 * unit;
    roundRect(ctx, x, y, boxW, boxH, 6 * unit);
    ctx.fillStyle = "rgba(15, 14, 20, 0.88)";
    ctx.fill();
    ctx.lineWidth = 1 * unit;
    ctx.strokeStyle = "rgba(46, 44, 58, 1)";
    ctx.stroke();
    ctx.fillStyle = moving ? AURA.green : AURA.accent;
    ctx.fillRect(x, y + 10 * unit, 3 * unit, boxH - 20 * unit);
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = AURA.fg;
    ctx.font = `600 ${big}px ${FONT_MONO}`;
    ctx.fillText(text, x + 15 * unit, y + 10 * unit + big);
    ctx.fillStyle = AURA.metadata;
    ctx.font = `500 ${small}px ${FONT_MONO}`;
    ctx.fillText(line2, x + 15 * unit, y + 16 * unit + big + small);
    reserved.push([x, y, boxW, boxH]);

    // Progress along the timeline.
    const progress = Math.min(1, Math.max(0, options.timeProgress));
    ctx.fillStyle = "rgba(237, 236, 238, 0.14)";
    ctx.fillRect(0, height - 3 * unit, width, 3 * unit);
    ctx.fillStyle = AURA.green;
    ctx.fillRect(0, height - 3 * unit, width * progress, 3 * unit);

    if (options.attribution) {
      ctx.font = `500 ${8 * unit}px ${FONT_MONO}`;
      ctx.textAlign = "right";
      ctx.textBaseline = "bottom";
      ctx.fillStyle = "rgba(237, 236, 238, 0.7)";
      ctx.fillText(options.attribution, width - 8 * unit, height - 7 * unit);
    }
    ctx.restore();
  }
}
