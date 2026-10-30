"use client";

import maplibregl from "maplibre-gl";
import {forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type CSSProperties, type ReactNode, type Ref} from "react";
import {ARROW, createSceneMap, FRAMES, type FrameId, type MapStyleId, RecapScene} from "@/lib/recap-scene";
import type {TripData} from "@/lib/trip-types";

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
  /** Extra controls placed in the playback row (map style, speed, frame). */
  children?: ReactNode;
}

type LngLat = [number, number];

const GREEN = "#61ffca";
const PILL_SIDES = ["right", "left", "top", "bottom"] as const;
/** How often stop labels re-pick their sides while the camera follows. */
const PILL_LAYOUT_MS = 200;

function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/**
 * The road driven so far, as its own line. MapLibre's `line-gradient` drops the colour on some tiles
 * of a long route, so the trail is not drawn as a gradient over the whole road.
 */
function travelledData(scene: RecapScene, progress: number): GeoJSON.Feature | GeoJSON.FeatureCollection {
  if (scene.coords.length < 2 || progress <= 0) return {type: "FeatureCollection", features: []};
  const head = scene.position(progress);
  return {type: "Feature", properties: {}, geometry: {type: "LineString", coordinates: [...scene.coords.slice(0, head.index), head.point]}};
}

/** Compass bearing from a to b, in degrees clockwise from north. */
function bearing(a: LngLat, b: LngLat): number {
  const dx = (b[0] - a[0]) * Math.cos((a[1] * Math.PI) / 180);
  return (Math.atan2(dx, b[1] - a[1]) * 180) / Math.PI;
}

function lineData(scene: RecapScene): GeoJSON.Feature | GeoJSON.FeatureCollection {
  if (scene.coords.length < 2) return {type: "FeatureCollection", features: []};
  return {type: "Feature", properties: {}, geometry: {type: "LineString", coordinates: scene.coords}};
}

/** Dashed tethers from the road to each off-road photo spot, and a ring at the observed GPS point. */
function spotData(scene: RecapScene): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: scene.offRoute().flatMap(({on, gps}) => [
      {type: "Feature" as const, properties: {}, geometry: {type: "LineString" as const, coordinates: [on, gps]}},
      {type: "Feature" as const, properties: {}, geometry: {type: "Point" as const, coordinates: gps}},
    ]),
  };
}

/** Routed roads are inferred, so they are dashed; a line that only joins GPS points is faint and solid. */
function roadPaint(map: maplibregl.Map, scene: RecapScene) {
  const inferred = Boolean(scene.data.route);
  map.setPaintProperty("trip-road", "line-color", inferred ? "#a277ff" : "#edecee");
  map.setPaintProperty("trip-road", "line-opacity", inferred ? 0.75 : 0.35);
  map.setPaintProperty("trip-road", "line-dasharray", inferred ? [2.3, 1.9] : [1, 0]);
}

function addRouteLayers(map: maplibregl.Map, scene: RecapScene) {
  map.addSource("trip-spots", {type: "geojson", data: spotData(scene)});
  map.addLayer({id: "trip-spot-tether", type: "line", source: "trip-spots", filter: ["==", ["geometry-type"], "LineString"], paint: {"line-color": "#edecee", "line-opacity": 0.4, "line-width": 1.2, "line-dasharray": [2, 2]}});
  map.addLayer({id: "trip-spot", type: "circle", source: "trip-spots", filter: ["==", ["geometry-type"], "Point"], paint: {"circle-radius": 3, "circle-color": "rgba(0, 0, 0, 0)", "circle-stroke-color": "#edecee", "circle-stroke-opacity": 0.5, "circle-stroke-width": 1.2}});
  map.addSource("trip-route", {type: "geojson", data: lineData(scene)});
  map.addSource("trip-travelled", {type: "geojson", data: travelledData(scene, 0)});
  const round = {"line-join": "round", "line-cap": "round"} as const;
  map.addLayer({id: "trip-road", type: "line", source: "trip-route", layout: {"line-join": "round"}, paint: {"line-width": 2.6}});
  map.addLayer({id: "trip-glow-wide", type: "line", source: "trip-travelled", layout: round, paint: {"line-width": 14, "line-opacity": 0.1, "line-blur": 4, "line-color": GREEN}});
  map.addLayer({id: "trip-glow", type: "line", source: "trip-travelled", layout: round, paint: {"line-width": 7, "line-opacity": 0.2, "line-blur": 2, "line-color": GREEN}});
  map.addLayer({id: "trip-trail", type: "line", source: "trip-travelled", layout: round, paint: {"line-width": 3.6, "line-color": GREEN}});
  roadPaint(map, scene);
}

function headElement(vehicle: string): HTMLElement {
  const element = document.createElement("div");
  element.className = "trip-head";
  element.innerHTML = '<span class="trip-head__glow"></span>';
  if (vehicle === ARROW) {
    element.insertAdjacentHTML("beforeend", '<svg class="trip-head__arrow" viewBox="-10 -14 20 24" aria-hidden="true"><path d="M0 -12 L8 8 L0 3.5 L-8 8 Z" /></svg>');
  } else {
    const glyph = document.createElement("span");
    glyph.className = "trip-head__glyph";
    glyph.textContent = vehicle;
    element.append(glyph);
  }
  return element;
}

interface Pill {
  marker: maplibregl.Marker;
  label: HTMLElement;
  /** Label size, measured once per name so layout does not reflow every pass. */
  size: [number, number] | null;
}

function pillElement(scene: RecapScene, index: number): {element: HTMLElement; label: HTMLElement} {
  const element = document.createElement("div");
  element.className = "trip-pill";
  element.dataset.side = "none";
  element.innerHTML = '<span class="trip-pill__dot"></span><span class="trip-pill__label"><b></b><span></span></span>';
  const label = element.querySelector<HTMLElement>(".trip-pill__label")!;
  label.querySelector("b")!.textContent = String(scene.data.observations[index].order).padStart(2, "0");
  label.querySelector("span")!.textContent = ` ${scene.stopLabel(index)}`;
  return {element, label};
}

/**
 * Labels for the stops reached so far and the one ahead take the first side that clears the HUD and
 * earlier labels, current stop first; a label with no room hides and keeps its dot.
 */
function layoutPills(map: maplibregl.Map, pills: Pill[], order: number[], blocked: DOMRect[]) {
  const frame = map.getContainer();
  const width = frame.clientWidth;
  const height = frame.clientHeight;
  const taken = [...blocked];
  const shown = new Set<number>();
  for (const index of order) {
    const pill = pills[index];
    if (!pill) continue;
    pill.size ??= [pill.label.offsetWidth, pill.label.offsetHeight];
    const [w, h] = pill.size;
    const {x, y} = map.project(pill.marker.getLngLat());
    const gap = 10;
    const boxes = {
      right: new DOMRect(x + gap, y - h / 2, w, h),
      left: new DOMRect(x - gap - w, y - h / 2, w, h),
      top: new DOMRect(x - w / 2, y - gap - h, w, h),
      bottom: new DOMRect(x - w / 2, y + gap, w, h),
    };
    const side = PILL_SIDES.find((name) => {
      const box = boxes[name];
      const inside = box.left >= 4 && box.top >= 4 && box.right <= width - 4 && box.bottom <= height - 4;
      return inside && taken.every((other) => box.right < other.left || box.left > other.right || box.bottom < other.top || box.top > other.bottom);
    });
    if (!side) continue;
    shown.add(index);
    taken.push(boxes[side]);
    pill.marker.getElement().dataset.side = side;
  }
  pills.forEach((pill, index) => {
    if (!shown.has(index)) pill.marker.getElement().dataset.side = "none";
  });
}

/**
 * Live preview in the portfolio ride map's style: the road and the green trail are MapLibre line
 * layers, the arrow and stop pills are markers, and the HUD is markup over the map. The MP4 export
 * draws the same scene on a canvas, and both read the timeline through RecapScene, so what you
 * preview is what you export. The map is built once per style and the scene once per route; stop
 * names arriving from lookups or renames only relabel the pills.
 */
const MapPreview = forwardRef(function MapPreview(
  {data, styleId, frame, vehicle, playbackSpeed, onPlayingChange, children}: MapPreviewProps,
  ref: Ref<MapPreviewHandle>,
) {
  const mapHostRef = useRef<HTMLDivElement>(null);
  const hudRefs = {
    title: useRef<HTMLDivElement>(null),
    stat: useRef<HTMLDivElement>(null),
    panel: useRef<HTMLDivElement>(null),
    name: useRef<HTMLHeadingElement>(null),
    meta: useRef<HTMLParagraphElement>(null),
    km: useRef<HTMLSpanElement>(null),
    line1: useRef<HTMLParagraphElement>(null),
    line2: useRef<HTMLParagraphElement>(null),
    bar: useRef<HTMLSpanElement>(null),
  };
  const mapRef = useRef<maplibregl.Map | null>(null);
  const sceneRef = useRef<RecapScene | null>(null);
  const headRef = useRef<maplibregl.Marker | null>(null);
  const pillsRef = useRef<Pill[]>([]);
  /** Bumped whenever the pills are rebuilt, so their reached/current classes are reapplied. */
  const pillsGenRef = useRef(0);
  const timeRef = useRef(0);
  const playingRef = useRef(false);
  const followRef = useRef(true);
  const speedRef = useRef(playbackSpeed);
  const dirtyRef = useRef(true);
  const snapRef = useRef(true);
  const layoutDueRef = useRef(0);
  const autoplayRef = useRef(true);
  const [mapReady, setMapReady] = useState(false);
  const [mapFailed, setMapFailed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);

  speedRef.current = playbackSpeed;

  // Only a new route or timeline makes a new scene; names and renames reuse it.
  const routeKey = useMemo(
    () => [data.id, data.route?.geometry.coordinates.length ?? 0, data.timeline?.duration_seconds ?? 0, data.observations.map((item) => item.id).join(",")].join("|"),
    [data],
  );
  const dataRef = useRef(data);
  dataRef.current = data;

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
    scene.resetCamera();
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

  /** Rebuilds the stop pills from the current scene's names. */
  const buildPills = useCallback(() => {
    const map = mapRef.current;
    const scene = sceneRef.current;
    pillsRef.current.forEach((pill) => pill.marker.remove());
    pillsRef.current = [];
    if (!map || !scene) return;
    pillsRef.current = scene.data.observations.map((_, index) => {
      const {element, label} = pillElement(scene, index);
      const marker = new maplibregl.Marker({element}).setLngLat(scene.stopPoint(index)).addTo(map);
      return {marker, label, size: null};
    });
    pillsGenRef.current += 1;
    layoutDueRef.current = 0;
    dirtyRef.current = true;
  }, []);

  // Map lifecycle: one map per basemap style. Playback time carries over a style switch.
  useEffect(() => {
    const host = mapHostRef.current;
    if (!host) return;
    const start = sceneRef.current?.coords[0] ?? (dataRef.current.observations[0] ? [dataRef.current.observations[0].longitude, dataRef.current.observations[0].latitude] as LngLat : [85.324, 27.676] as LngLat);
    let map: maplibregl.Map;
    try {
      ({map} = createSceneMap(host, {styleId, center: start, interactive: true, pixelRatio: Math.min(window.devicePixelRatio || 1, 2)}));
    } catch {
      setMapFailed(true);
      return;
    }
    mapRef.current = map;
    setMapReady(false);
    setMapFailed(false);
    snapRef.current = true;
    sceneRef.current?.resetCamera();
    map.touchZoomRotate.disableRotation();
    map.addControl(new maplibregl.AttributionControl({compact: true}), "bottom-right");
    // Tile and style hiccups are handled by the fallback style; only a map that never starts is a failure.
    map.on("error", (event) => {
      if (!map.loaded() && event.error?.message?.includes("WebGL")) setMapFailed(true);
    });
    map.getCanvas().addEventListener("webglcontextlost", () => setMapFailed(true));
    map.on("dragstart", () => {
      followRef.current = false;
      if (playingRef.current) setPlayingBoth(false);
    });
    const markDirty = () => {
      dirtyRef.current = true;
    };
    const relayout = () => {
      layoutDueRef.current = 0;
      dirtyRef.current = true;
    };
    map.on("move", markDirty);
    map.on("moveend", relayout);

    // A style switch replaces every layer, so the route goes back on after each style load.
    map.on("style.load", () => {
      const scene = sceneRef.current;
      if (scene && !map.getSource("trip-route")) addRouteLayers(map, scene);
      dirtyRef.current = true;
    });
    map.once("load", () => {
      map.resize();
      // Compact credits start open; fold them so they do not sit on the HUD.
      host.querySelector(".maplibregl-compact-show")?.classList.remove("maplibregl-compact-show");
      setMapReady(true);
      setMapFailed(false);
    });

    const observer = new ResizeObserver(() => {
      map.resize();
      snapRef.current = true;
      layoutDueRef.current = 0;
      dirtyRef.current = true;
    });
    observer.observe(host);

    return () => {
      observer.disconnect();
      headRef.current?.remove();
      headRef.current = null;
      pillsRef.current.forEach((pill) => pill.marker.remove());
      pillsRef.current = [];
      map.remove();
      mapRef.current = null;
    };
  }, [styleId, setPlayingBoth]);

  // Scene lifecycle: a new route or timeline starts playback from the beginning.
  useEffect(() => {
    sceneRef.current = new RecapScene(dataRef.current);
    timeRef.current = 0;
    followRef.current = true;
    snapRef.current = true;
    autoplayRef.current = true;
    setTime(0);
  }, [routeKey]);

  // Puts the scene on the map whenever either is new. Only a new route autoplays; a style switch keeps
  // the time and the play state.
  useEffect(() => {
    const map = mapRef.current;
    const scene = sceneRef.current;
    if (!map || !scene || !mapReady) return;
    const source = map.getSource("trip-route") as maplibregl.GeoJSONSource | undefined;
    if (source) {
      source.setData(lineData(scene));
      (map.getSource("trip-spots") as maplibregl.GeoJSONSource | undefined)?.setData(spotData(scene));
      roadPaint(map, scene);
    } else {
      addRouteLayers(map, scene);
    }
    buildPills();
    if (autoplayRef.current) {
      autoplayRef.current = false;
      setPlayingBoth(true);
    }
  }, [routeKey, mapReady, buildPills, setPlayingBoth]);

  // New names relabel the pills and the HUD without restarting anything.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || scene.data === data) return;
    scene.setLabels(data);
    buildPills();
  }, [data, buildPills]);

  // The traveller marker follows the chosen vehicle.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const head = new maplibregl.Marker({element: headElement(vehicle), rotationAlignment: "map", pitchAlignment: "map"});
    headRef.current?.remove();
    headRef.current = head;
    dirtyRef.current = true;
    return () => {
      head.remove();
      if (headRef.current === head) headRef.current = null;
    };
  }, [vehicle, mapReady]);

  // One animation loop: advances time, moves the camera, the trail, the arrow, the pills and the HUD.
  useEffect(() => {
    if (!mapReady) return;
    let raf = 0;
    let last = performance.now();
    let lastUiUpdate = 0;
    let shownTrail = -1;
    let trailSource: maplibregl.GeoJSONSource | undefined;
    let trailScene: RecapScene | null = null;
    let shownStops = "";
    let shownHud = "";

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const map = mapRef.current;
      const scene = sceneRef.current;
      if (!map || !scene) return;
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
      if (now - lastUiUpdate > 200) {
        lastUiUpdate = now;
        setTime(timeRef.current);
      }
      if (!dirtyRef.current) return;
      dirtyRef.current = false;

      const state = scene.state(timeRef.current);
      const trail = Math.round(state.progress * 20_000) / 20_000;
      const source = map.getSource("trip-travelled") as maplibregl.GeoJSONSource | undefined;
      // A style switch or a new route brings a new source or scene, which needs the trail again.
      if (source && (trail !== shownTrail || source !== trailSource || scene !== trailScene)) {
        shownTrail = trail;
        trailSource = source;
        trailScene = scene;
        source.setData(travelledData(scene, trail));
      }

      const head = headRef.current;
      if (head && scene.coords.length) {
        const here = scene.position(state.progress);
        head.setLngLat(here.point);
        if (!head.getElement().isConnected) head.addTo(map);
        if (here.next[0] !== here.point[0] || here.next[1] !== here.point[1]) {
          if (vehicleIsArrow(head)) head.setRotation(bearing(here.point, here.next));
          else head.getElement().classList.toggle("is-westward", map.project(here.next).x < map.project(here.point).x - 0.5);
        }
      }

      const pills = pillsRef.current;
      const current = state.phase === "outro" ? -1 : state.atIndex;
      const stops = `${state.atIndex}|${state.toIndex}|${current}|${pillsGenRef.current}`;
      if (stops !== shownStops) {
        shownStops = stops;
        layoutDueRef.current = 0;
        pills.forEach((pill, index) => {
          const element = pill.marker.getElement();
          element.classList.toggle("is-reached", index <= state.atIndex);
          element.classList.toggle("is-current", index === current);
        });
      }
      if (now >= layoutDueRef.current && pills.length) {
        layoutDueRef.current = now + PILL_LAYOUT_MS;
        const origin = map.getContainer().getBoundingClientRect();
        const blocked = [hudRefs.title, hudRefs.stat, hudRefs.panel]
          .map((item) => item.current)
          .filter((element): element is HTMLDivElement => Boolean(element && element.offsetParent))
          .map((element) => {
            const rect = element.getBoundingClientRect();
            return new DOMRect(rect.left - origin.left, rect.top - origin.top, rect.width, rect.height);
          });
        const order = pills
          .map((_, index) => index)
          .filter((index) => index <= state.atIndex || index === state.toIndex)
          .sort((a, b) => (b === current ? 1 : 0) - (a === current ? 1 : 0) || b - a);
        layoutPills(map, pills, order, blocked);
      }

      const text = scene.hudText(state);
      const hud = `${text.title}|${text.subtitle}|${text.km}|${text.line1}|${text.line2}|${text.moving}`;
      if (hud !== shownHud) {
        shownHud = hud;
        if (hudRefs.name.current) hudRefs.name.current.textContent = text.title;
        if (hudRefs.meta.current) hudRefs.meta.current.textContent = text.subtitle;
        if (hudRefs.km.current) hudRefs.km.current.textContent = text.km;
        if (hudRefs.line1.current) hudRefs.line1.current.textContent = text.line1;
        if (hudRefs.line2.current) hudRefs.line2.current.textContent = text.line2;
        hudRefs.panel.current?.classList.toggle("is-moving", text.moving);
      }
      if (hudRefs.bar.current) hudRefs.bar.current.style.transform = `scaleX(${scene.duration ? Math.min(1, timeRef.current / scene.duration) : 0})`;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [mapReady, setPlayingBoth]);

  const duration = sceneRef.current?.duration ?? data.timeline?.duration_seconds ?? 0;

  return (
    <section className="map-frame" aria-label="Trip route map">
      <div className={`map-canvas-frame frame-${frame}`} style={{"--frame-ratio": String(FRAMES[frame].ratio)} as CSSProperties} aria-busy={!mapReady}>
        <div className="map-host" ref={mapHostRef} />
        {!mapReady && !mapFailed && <div className="trip-shimmer" aria-hidden="true" />}
        <div className="trip-hud" aria-hidden="true">
          <div ref={hudRefs.title} className="trip-hud__title">
            <p className="trip-hud__eyebrow">Trip recap</p>
            <h3 ref={hudRefs.name} className="trip-hud__name" />
            <p ref={hudRefs.meta} className="trip-hud__meta" />
          </div>
          <div ref={hudRefs.stat} className="trip-hud__stat">
            <span ref={hudRefs.km} className="trip-hud__km" />
            <span className="trip-hud__eyebrow">On the road</span>
          </div>
          <div ref={hudRefs.panel} className="trip-hud__panel">
            <p ref={hudRefs.line1} className="trip-hud__line" />
            <p ref={hudRefs.line2} className="trip-hud__sub" />
          </div>
          <span className="trip-hud__track"><span ref={hudRefs.bar} className="trip-hud__bar" /></span>
        </div>
        {!mapReady && !mapFailed && <p className="trip-map-status" role="status">loading map…</p>}
        {mapFailed && <p className="trip-map-status">The map could not load in this browser.</p>}
      </div>
      <div className="controls">
        <button type="button" id="play" className="btn primary" onClick={togglePlay} disabled={!mapReady}>
          {playing ? "Pause" : "Play"}
        </button>
        <button type="button" id="restart" className="btn" onClick={replayRoute} disabled={!mapReady}>Restart</button>
        <div className="scrub">
          <input
            type="range"
            min={0}
            max={1000}
            value={duration ? Math.round((time / duration) * 1000) : 0}
            aria-label="Trip progress"
            onChange={(event) => {
              timeRef.current = (Number(event.target.value) / 1000) * duration;
              followRef.current = true;
              sceneRef.current?.resetCamera();
              snapRef.current = true;
              dirtyRef.current = true;
              setTime(timeRef.current);
            }}
          />
          <output className="clock">{formatClock(time)}</output>
        </div>
        {children}
      </div>
    </section>
  );
});

function vehicleIsArrow(head: maplibregl.Marker): boolean {
  return Boolean(head.getElement().querySelector(".trip-head__arrow"));
}

MapPreview.displayName = "MapPreview";

export default MapPreview;
