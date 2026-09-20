"use client";

import maplibregl from "maplibre-gl";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from "react";
import type {TripData, TripMedia} from "@/lib/trip-types";
import type {TimelineEvent} from "@/lib/trip-types";

type Coordinate = [number, number];

const SATELLITE_TILES =
  "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg";
const LIBERTY_STYLE = "https://tiles.openfreemap.org/styles/liberty";

export interface MapPreviewHandle {
  replayRoute: () => void;
  fitRoute: (duration?: number) => void;
  setTripTime: (seconds: number) => Promise<void>;
}

export interface MapPreviewProps {
  data: TripData;
  mapStyle: "Street" | "Satellite" | "Hybrid";
  vehicle: string;
  playbackSpeed: number;
  slowPoints: boolean;
}

declare global {
  interface Window {
    setTripTime?: (seconds: number) => Promise<void>;
    tripReady?: boolean;
  }
}

function satelliteStyle(): maplibregl.StyleSpecification {
  return {
    version: 8,
    sources: {
      satellite: {
        type: "raster",
        tiles: [SATELLITE_TILES],
        tileSize: 256,
        attribution: "EOX Sentinel-2 cloudless",
      },
    },
    layers: [{id: "satellite", type: "raster", source: "satellite"}],
  };
}

function routeCoordinates(data: TripData): Coordinate[] {
  const route = data.route?.geometry.coordinates;
  if (route?.length) return route.map(([longitude, latitude]) => [longitude, latitude]);
  return data.observations.map(({longitude, latitude}) => [longitude, latitude]);
}

function segmentDistance([aLon, aLat]: Coordinate, [bLon, bLat]: Coordinate): number {
  const toRadians = (value: number) => (value * Math.PI) / 180;
  const lat1 = toRadians(aLat);
  const lat2 = toRadians(bLat);
  const dLat = toRadians(bLat - aLat);
  const dLon = toRadians(bLon - aLon);
  const haversine =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6371008.8 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

function routeBounds(coords: Coordinate[]): maplibregl.LngLatBounds | null {
  if (!coords.length) return null;
  return coords.reduce(
    (bounds, coordinate) => bounds.extend(coordinate),
    new maplibregl.LngLatBounds(coords[0], coords[0]),
  );
}

function paddedBounds(bounds: maplibregl.LngLatBounds): [[number, number], [number, number]] {
  const west = bounds.getWest();
  const east = bounds.getEast();
  const south = bounds.getSouth();
  const north = bounds.getNorth();
  const longitudePadding = Math.max((east - west) * 0.35, 0.01);
  const latitudePadding = Math.max((north - south) * 0.35, 0.01);
  return [
    [west - longitudePadding, south - latitudePadding],
    [east + longitudePadding, north + latitudePadding],
  ];
}

function easeInOut(value: number): number {
  return value < 0.5 ? 2 * value * value : 1 - ((-2 * value + 2) ** 2) / 2;
}

const MapPreview = forwardRef(function MapPreview(
  {data, mapStyle, vehicle, playbackSpeed, slowPoints}: MapPreviewProps,
  ref: Ref<MapPreviewHandle>,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const glyphRef = useRef<HTMLSpanElement | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const animationRef = useRef<number | null>(null);
  const coordinatesRef = useRef<Coordinate[]>([]);
  const cumulativeRef = useRef<number[]>([]);
  const totalDistanceRef = useRef(0);
  const boundsRef = useRef<maplibregl.LngLatBounds | null>(null);
  const [overlayMedia, setOverlayMedia] = useState<TripMedia | null>(null);
  const [renderMode, setRenderMode] = useState(false);

  useEffect(() => {
    setRenderMode(new URLSearchParams(window.location.search).get("render") === "1");
  }, []);

  const setRouteProgress = (progress: number) => {
    const map = mapRef.current;
    const marker = markerRef.current;
    const coords = coordinatesRef.current;
    if (!map || !marker || !coords.length) return;

    const target = Math.max(0, Math.min(1, progress)) * totalDistanceRef.current;
    let index = 0;
    while (
      index < cumulativeRef.current.length - 2 &&
      cumulativeRef.current[index + 1] < target
    ) {
      index += 1;
    }

    const start = coords[index];
    const end = coords[Math.min(index + 1, coords.length - 1)] ?? start;
    const segmentStart = cumulativeRef.current[index] ?? 0;
    const segmentEnd = cumulativeRef.current[index + 1] ?? segmentStart;
    const segmentLength = Math.max(segmentEnd - segmentStart, 0.000001);
    const ratio = Math.max(0, Math.min(1, (target - segmentStart) / segmentLength));
    const point: Coordinate = [
      start[0] + (end[0] - start[0]) * ratio,
      start[1] + (end[1] - start[1]) * ratio,
    ];

    marker.setLngLat(point);
    if (glyphRef.current && map && start && end) {
      const projectedStart = map.project(start);
      const projectedEnd = map.project(end);
      if (Math.abs(projectedEnd.x - projectedStart.x) > 0.25) {
        glyphRef.current.style.setProperty(
          "--direction",
          projectedEnd.x >= projectedStart.x ? "1" : "-1",
        );
      }
    }

    const traveled = map.getSource("traveled") as maplibregl.GeoJSONSource | undefined;
    traveled?.setData({
      type: "Feature",
      properties: {},
      geometry: {type: "LineString", coordinates: coords.slice(0, index + 1).concat([point])},
    });
  };

  const fitRoute = (duration = 0) => {
    if (!mapRef.current || !boundsRef.current) return;
    mapRef.current.resize();
    mapRef.current.fitBounds(boundsRef.current, {
      padding: {top: 92, right: 92, bottom: 108, left: 92},
      duration,
    });
  };

  const routeStops = () => {
    const values = data.observations
      .map((observation) => Number(observation.progress))
      .filter(Number.isFinite)
      .map((value) => Math.max(0, Math.min(1, value)))
      .sort((a, b) => a - b);
    const unique: number[] = [];
    for (const value of values) {
      if (!unique.length || Math.abs(value - unique[unique.length - 1]) > 0.003) unique.push(value);
    }
    if (!unique.length || unique[0] > 0.001) unique.unshift(0);
    if (unique[unique.length - 1] < 0.999) unique.push(1);
    return unique;
  };

  const replayRoute = () => {
    if (coordinatesRef.current.length < 2) return;
    if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
    const stops = routeStops();
    const speed = Math.max(0.25, playbackSpeed || 1);
    const travelMilliseconds = 14000 / speed;
    const pointDelay = (slowPoints ? 650 : 0) / speed;
    const phases: Array<{type: "move" | "slow"; from?: number; to?: number; at?: number; duration: number}> = [];

    for (let index = 0; index < stops.length - 1; index += 1) {
      const from = stops[index];
      const to = stops[index + 1];
      phases.push({type: "move", from, to, duration: Math.max(350, travelMilliseconds * Math.max(to - from, 0.035))});
      if (pointDelay && index + 1 < stops.length - 1) phases.push({type: "slow", at: to, duration: pointDelay});
    }

    const total = phases.reduce((sum, phase) => sum + phase.duration, 0);
    const started = performance.now();
    const frame = (now: number) => {
      let remaining = Math.min(total, now - started);
      let progress = 0;
      for (const phase of phases) {
        if (remaining > phase.duration) {
          remaining -= phase.duration;
          progress = phase.type === "move" ? phase.to ?? 0 : phase.at ?? 0;
          continue;
        }
        if (phase.type === "slow") {
          progress = phase.at ?? 0;
        } else {
          const raw = Math.max(0, Math.min(1, remaining / phase.duration));
          const eased = slowPoints ? easeInOut(raw) : raw;
          progress = (phase.from ?? 0) + ((phase.to ?? 0) - (phase.from ?? 0)) * eased;
        }
        break;
      }
      setRouteProgress(progress);
      if (now - started < total) animationRef.current = requestAnimationFrame(frame);
    };
    animationRef.current = requestAnimationFrame(frame);
  };

  const setTripTime = async (seconds: number) => {
    if (!data.timeline) return;
    const duration = Math.max(data.timeline.duration_seconds, 0.001);
    const time = Math.max(0, Math.min(duration, seconds));
    setRouteProgress(time / duration);
    let visibleEvent: TimelineEvent | null = null;
    for (const event of data.timeline.events) {
      if (event.video_time > time) break;
      if (event.type === "media_show") visibleEvent = event;
      if (event.type === "media_hide" && visibleEvent?.payload.media_id === event.payload.media_id) {
        visibleEvent = null;
      }
    }
    if (!visibleEvent) {
      setOverlayMedia(null);
      return;
    }
    const mediaId = visibleEvent.payload.media_id;
    if (typeof mediaId !== "string") return;
    setOverlayMedia(data.trip.media.find((media) => media.id === mediaId) ?? null);
  };

  useImperativeHandle(ref, () => ({replayRoute, fitRoute, setTripTime}), [data, playbackSpeed, slowPoints]);

  useEffect(() => {
    const currentMap = mapRef.current;
    if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
    markersRef.current.forEach((marker) => marker.remove());
    markersRef.current = [];
    setOverlayMedia(null);
    currentMap?.remove();
    mapRef.current = null;
    markerRef.current = null;
    glyphRef.current = null;
    window.tripReady = false;

    const coordinates = routeCoordinates(data);
    coordinatesRef.current = coordinates;
    cumulativeRef.current = [0];
    for (let index = 1; index < coordinates.length; index += 1) {
      cumulativeRef.current.push(
        cumulativeRef.current[index - 1] + segmentDistance(coordinates[index - 1], coordinates[index]),
      );
    }
    totalDistanceRef.current = cumulativeRef.current[cumulativeRef.current.length - 1] ?? 0;
    boundsRef.current = routeBounds(coordinates);

    if (!containerRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: mapStyle === "Satellite" ? satelliteStyle() : LIBERTY_STYLE,
      center: coordinates[0] ?? [85.324, 27.676],
      zoom: coordinates.length ? 8 : 6,
      dragPan: true,
      dragRotate: false,
      keyboard: true,
      boxZoom: true,
      scrollZoom: true,
      touchPitch: false,
      pitchWithRotate: false,
    });
    mapRef.current = map;
    if (!renderMode) map.addControl(new maplibregl.NavigationControl({showCompass: false, visualizePitch: false}), "top-right");

    map.on("load", () => {
      if (mapStyle === "Hybrid") {
        map.addSource("satellite-underlay", {
          type: "raster",
          tiles: [SATELLITE_TILES],
          tileSize: 256,
          attribution: "EOX Sentinel-2 cloudless",
        });
        const firstOverlay = map.getStyle().layers?.find(
          (layer) => layer.type !== "fill" && layer.type !== "background",
        );
        map.addLayer({id: "satellite-underlay", type: "raster", source: "satellite-underlay"}, firstOverlay?.id);
      }

      const routeFeature = data.route ?? {
        type: "Feature" as const,
        properties: {inferred: false},
        geometry: {type: "LineString" as const, coordinates},
      };
      map.addSource("route", {type: "geojson", data: routeFeature});
      map.addLayer({id: "route", type: "line", source: "route", paint: {"line-color": "#9b8cb4", "line-width": 5, "line-opacity": 0.7}});
      map.addSource("traveled", {
        type: "geojson",
        data: {type: "Feature", properties: {}, geometry: {type: "LineString", coordinates: []}},
      });
      map.addLayer({id: "traveled", type: "line", source: "traveled", paint: {"line-color": "#b9f6dd", "line-width": 7}});

      data.observations.forEach((observation) => {
        const wrapper = document.createElement("div");
        wrapper.className = "observation-marker";
        const dot = document.createElement("span");
        dot.className = "observation-dot";
        const label = document.createElement("span");
        label.className = "place-label";
        label.textContent = observation.place || "Loading…";
        wrapper.append(dot, label);
        const marker = new maplibregl.Marker({element: wrapper, anchor: "left"})
          .setLngLat([observation.longitude, observation.latitude])
          .addTo(map);
        markersRef.current.push(marker);
      });

      if (coordinates.length) {
        const markerElement = document.createElement("div");
        markerElement.className = "vehicle-marker";
        const glyph = document.createElement("span");
        glyph.className = "vehicle-glyph";
        glyph.textContent = renderMode ? "🛵" : vehicle;
        markerElement.appendChild(glyph);
        glyphRef.current = glyph;
        markerRef.current = new maplibregl.Marker({
          element: markerElement,
          anchor: "center",
          rotationAlignment: "viewport",
          pitchAlignment: "viewport",
        }).setLngLat(coordinates[0]).addTo(map);
        markersRef.current.push(markerRef.current);
      }

      if (boundsRef.current && coordinates.length > 1) {
        map.setMaxBounds(paddedBounds(boundsRef.current));
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            fitRoute(0);
            map.setMinZoom(Math.max(2, map.getZoom() - 1.5));
          });
        });
      } else if (coordinates.length === 1) {
        map.setCenter(coordinates[0]);
        map.setZoom(14);
        map.setMinZoom(11);
      }

      if (renderMode) {
        window.tripReady = true;
      } else {
        replayRoute();
      }
    });

    return () => {
      if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
      markersRef.current.forEach((marker) => marker.remove());
      markersRef.current = [];
      map.remove();
      mapRef.current = null;
      window.tripReady = false;
    };
  }, [data, mapStyle, renderMode, vehicle]);

  useEffect(() => {
    const previous = window.setTripTime;
    window.setTripTime = setTripTime;
    return () => {
      if (window.setTripTime === setTripTime) window.setTripTime = previous;
    };
  }, [setTripTime]);

  return (
    <section className="map-frame" aria-label="Trip route map">
      <div id="map" ref={containerRef} />
      <div id="media-overlay" className={overlayMedia ? "media-overlay is-visible" : "media-overlay"}>
        {overlayMedia ? (
          overlayMedia.media_type === "video" ? (
            <video src={overlayMedia.url} muted playsInline autoPlay controls aria-label={overlayMedia.filename} />
          ) : (
            <img src={overlayMedia.preview_url} alt={overlayMedia.filename} />
          )
        ) : null}
      </div>
    </section>
  );
});

MapPreview.displayName = "MapPreview";

export default MapPreview;
