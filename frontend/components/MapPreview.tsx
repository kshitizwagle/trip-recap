'use client';

import { useEffect, useRef } from 'react';
import type { Map as MapLibreMap, Marker } from 'maplibre-gl';
import type { TripPayload, TripMedia } from '@/lib/types';

const SATELLITE_TILES = 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg';

function satelliteStyle() {
  return {
    version: 8 as const,
    sources: {
      satellite: {
        type: 'raster' as const,
        tiles: [SATELLITE_TILES],
        tileSize: 256,
        attribution: 'EOX Sentinel-2 cloudless',
      },
    },
    layers: [{ id: 'satellite', type: 'raster' as const, source: 'satellite' }],
  };
}

function segmentDistance(a: number[], b: number[]) {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6371008.8 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function routeCoordinates(data: TripPayload): number[][] {
  const route = data.route?.geometry?.coordinates;
  if (route?.length) return route;
  return data.observations.map((observation) => [observation.longitude, observation.latitude]);
}

function easeInOut(t: number) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

export default function MapPreview({
  data,
  mapStyle,
  vehicle,
  playbackSpeed,
  slowAtPoints,
  renderOnly,
  replayToken,
  fitToken,
}: {
  data: TripPayload;
  mapStyle: 'Street' | 'Satellite' | 'Hybrid';
  vehicle: string;
  playbackSpeed: number;
  slowAtPoints: boolean;
  renderOnly: boolean;
  replayToken: number;
  fitToken: number;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markerRef = useRef<Marker | null>(null);
  const glyphRef = useRef<HTMLSpanElement | null>(null);
  const markersRef = useRef<Marker[]>([]);
  const rafRef = useRef<number | null>(null);
  const coordsRef = useRef<number[][]>([]);
  const cumulativeRef = useRef<number[]>([]);
  const totalDistanceRef = useRef(0);
  const boundsRef = useRef<any>(null);

  function setupDistance(coords: number[][]) {
    const cumulative = [0];
    for (let i = 1; i < coords.length; i += 1) {
      cumulative.push(cumulative[i - 1] + segmentDistance(coords[i - 1], coords[i]));
    }
    cumulativeRef.current = cumulative;
    totalDistanceRef.current = cumulative.at(-1) ?? 0;
  }

  function positionAt(progress: number) {
    const coords = coordsRef.current;
    if (!coords.length) return null;
    if (coords.length === 1) return { point: coords[0], index: 0 };
    const target = Math.max(0, Math.min(1, progress)) * totalDistanceRef.current;
    let index = 0;
    while (index < cumulativeRef.current.length - 2 && cumulativeRef.current[index + 1] < target) index += 1;
    const a = coords[index];
    const b = coords[index + 1];
    const start = cumulativeRef.current[index];
    const end = cumulativeRef.current[index + 1];
    const length = Math.max(end - start, 0.000001);
    const t = Math.max(0, Math.min(1, (target - start) / length));
    return { point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], index };
  }

  function setRouteProgress(progress: number) {
    const map = mapRef.current;
    const marker = markerRef.current;
    if (!map || !marker) return;
    const result = positionAt(progress);
    if (!result) return;
    marker.setLngLat(result.point as [number, number]);
    const coords = coordsRef.current;
    const nextIndex = Math.min(result.index + 1, coords.length - 1);
    const a = coords[result.index];
    const b = coords[nextIndex];
    if (glyphRef.current && a && b) {
      const pa = map.project(a as [number, number]);
      const pb = map.project(b as [number, number]);
      if (Math.abs(pb.x - pa.x) > 0.25) {
        glyphRef.current.style.setProperty('--direction', pb.x >= pa.x ? '1' : '-1');
      }
    }
    const traveled = coords.slice(0, result.index + 1).concat([result.point]);
    const source = map.getSource('traveled') as any;
    source?.setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: traveled } });
  }

  function fitRoute(duration = 0) {
    const map = mapRef.current;
    if (!map || !boundsRef.current) return;
    map.resize();
    map.fitBounds(boundsRef.current, {
      padding: { top: 90, right: 90, bottom: 110, left: 90 },
      duration,
    });
  }

  function replayRoute() {
    if (coordsRef.current.length < 2) return;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    const values = data.observations
      .map((observation) => Number(observation.progress))
      .filter(Number.isFinite)
      .map((value) => Math.max(0, Math.min(1, value)))
      .sort((a, b) => a - b);
    const stops: number[] = [];
    for (const value of values) {
      if (!stops.length || Math.abs(value - stops.at(-1)!) > 0.003) stops.push(value);
    }
    if (!stops.length || stops[0] > 0.001) stops.unshift(0);
    if (stops.at(-1)! < 0.999) stops.push(1);

    const phases: Array<{ type: 'move' | 'slow'; from?: number; to?: number; at?: number; duration: number }> = [];
    const speed = Math.max(0.25, playbackSpeed || 1);
    const travelMs = 14000 / speed;
    const pointDelay = (slowAtPoints ? 650 : 0) / speed;
    for (let i = 0; i < stops.length - 1; i += 1) {
      const from = stops[i];
      const to = stops[i + 1];
      phases.push({ type: 'move', from, to, duration: Math.max(350, travelMs * Math.max(to - from, 0.035)) });
      if (pointDelay && i + 1 < stops.length - 1) phases.push({ type: 'slow', at: to, duration: pointDelay });
    }
    const total = phases.reduce((sum, phase) => sum + phase.duration, 0);
    const started = performance.now();

    const frame = (now: number) => {
      let remaining = Math.min(total, now - started);
      let progress = 0;
      for (const phase of phases) {
        if (remaining > phase.duration) {
          remaining -= phase.duration;
          progress = phase.type === 'move' ? phase.to! : phase.at!;
          continue;
        }
        if (phase.type === 'slow') progress = phase.at!;
        else {
          const raw = Math.max(0, Math.min(1, remaining / phase.duration));
          const t = slowAtPoints ? easeInOut(raw) : raw;
          progress = phase.from! + (phase.to! - phase.from!) * t;
        }
        break;
      }
      setRouteProgress(progress);
      if (now - started < total) rafRef.current = requestAnimationFrame(frame);
    };
    rafRef.current = requestAnimationFrame(frame);
  }

  function hideOverlay() {
    if (!overlayRef.current) return;
    overlayRef.current.innerHTML = '';
    overlayRef.current.style.display = 'none';
    delete overlayRef.current.dataset.mediaId;
  }

  function showMedia(media?: TripMedia) {
    hideOverlay();
    if (!media || !overlayRef.current) return;
    const element = media.media_type === 'video' ? document.createElement('video') : document.createElement('img');
    if (element instanceof HTMLVideoElement) {
      element.src = media.url;
      element.muted = true;
      element.playsInline = true;
      element.preload = 'auto';
    } else {
      element.src = media.preview_url;
      element.alt = media.filename;
    }
    overlayRef.current.appendChild(element);
    overlayRef.current.dataset.mediaId = media.id;
    overlayRef.current.style.display = 'block';
  }

  useEffect(() => {
    let cancelled = false;
    const setup = async () => {
      if (!containerRef.current) return;
      const maplibregl = await import('maplibre-gl');
      if (cancelled || !containerRef.current) return;
      markersRef.current.forEach((marker) => marker.remove());
      markersRef.current = [];
      mapRef.current?.remove();

      const coords = routeCoordinates(data);
      coordsRef.current = coords;
      setupDistance(coords);
      const selectedStyle = renderOnly ? 'Street' : mapStyle;
      const map = new maplibregl.Map({
        container: containerRef.current,
        style: selectedStyle === 'Satellite' ? satelliteStyle() : 'https://tiles.openfreemap.org/styles/liberty',
        center: (coords[0] ?? [85.324, 27.676]) as [number, number],
        zoom: coords.length ? 8 : 6,
        attributionControl: { compact: true },
        dragPan: true,
        dragRotate: false,
        keyboard: true,
        boxZoom: true,
        scrollZoom: true,
        touchPitch: false,
        pitchWithRotate: false,
      });
      mapRef.current = map;
      map.touchZoomRotate.enable();
      map.touchZoomRotate.disableRotation();
      if (!renderOnly) {
        map.addControl(
          new maplibregl.NavigationControl({ showCompass: false, visualizePitch: false }),
          'top-right',
        );
      }

      map.on('load', () => {
        if (selectedStyle === 'Hybrid') {
          map.addSource('satellite-underlay', {
            type: 'raster',
            tiles: [SATELLITE_TILES],
            tileSize: 256,
            attribution: 'EOX Sentinel-2 cloudless',
          });
          const firstOverlay = map.getStyle().layers?.find(
            (layer) => layer.type !== 'fill' && layer.type !== 'background',
          );
          map.addLayer(
            { id: 'satellite-underlay', type: 'raster', source: 'satellite-underlay' },
            firstOverlay?.id,
          );
        }
        const routeFeature = data.route ?? {
          type: 'Feature',
          properties: { inferred: false },
          geometry: { type: 'LineString', coordinates: coords },
        };
        map.addSource('route', { type: 'geojson', data: routeFeature as any });
        map.addLayer({
          id: 'route',
          type: 'line',
          source: 'route',
          paint: { 'line-color': '#64748b', 'line-width': 5, 'line-opacity': 0.55 },
        });
        map.addSource('traveled', {
          type: 'geojson',
          data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [] } },
        });
        map.addLayer({
          id: 'traveled',
          type: 'line',
          source: 'traveled',
          paint: { 'line-color': '#0f172a', 'line-width': 7 },
        });

        data.observations.forEach((observation) => {
          const wrapper = document.createElement('div');
          wrapper.className = 'observation-marker';
          const dot = document.createElement('span');
          dot.className = 'observation-dot';
          const label = document.createElement('span');
          label.className = 'place-label';
          label.textContent = observation.place || 'Unknown place';
          wrapper.append(dot, label);
          const marker = new maplibregl.Marker({ element: wrapper, anchor: 'left' })
            .setLngLat([observation.longitude, observation.latitude])
            .addTo(map);
          markersRef.current.push(marker);
        });

        if (coords.length) {
          const wrapper = document.createElement('div');
          wrapper.className = 'vehicle-marker';
          const glyph = document.createElement('span');
          glyph.className = 'vehicle-glyph';
          glyph.textContent = renderOnly ? '🛵' : vehicle;
          wrapper.appendChild(glyph);
          glyphRef.current = glyph;
          const marker = new maplibregl.Marker({
            element: wrapper,
            anchor: 'center',
            rotationAlignment: 'viewport',
            pitchAlignment: 'viewport',
          }).setLngLat(coords[0] as [number, number]).addTo(map);
          markerRef.current = marker;
          markersRef.current.push(marker);
        }

        if (coords.length > 1) {
          const bounds = coords.reduce(
            (current, coordinate) => current.extend(coordinate as [number, number]),
            new maplibregl.LngLatBounds(
              coords[0] as [number, number],
              coords[0] as [number, number],
            ),
          );
          boundsRef.current = bounds;
          const west = bounds.getWest();
          const east = bounds.getEast();
          const south = bounds.getSouth();
          const north = bounds.getNorth();
          const lonPad = Math.max((east - west) * 0.35, 0.01);
          const latPad = Math.max((north - south) * 0.35, 0.01);
          map.setMaxBounds([
            [west - lonPad, south - latPad],
            [east + lonPad, north + latPad],
          ]);
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              fitRoute(0);
              map.setMinZoom(Math.max(2, map.getZoom() - 1.5));
            }),
          );
        }

        if (renderOnly) {
          window.tripReady = true;
        } else {
          replayRoute();
        }
      });
    };
    setup();
    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      markersRef.current.forEach((marker) => marker.remove());
      markersRef.current = [];
      mapRef.current?.remove();
      mapRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.id, data.place_names, mapStyle, vehicle, renderOnly]);

  useEffect(() => {
    if (mapRef.current) replayRoute();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replayToken, playbackSpeed, slowAtPoints]);

  useEffect(() => {
    if (fitToken > 0) fitRoute(350);
  }, [fitToken]);

  useEffect(() => {
    window.tripData = data.trip;
    window.routeData = data.route;
    window.timelineData = data.timeline;
    window.setTripTime = async (seconds: number) => {
      if (!data.timeline) return;
      const duration = Math.max(data.timeline.duration_seconds, 0.001);
      const time = Math.max(0, Math.min(duration, seconds));
      setRouteProgress(time / duration);
      let visible: any = null;
      for (const event of data.timeline.events) {
        if (event.video_time > time) break;
        if (event.type === 'media_show') visible = event;
        if (
          event.type === 'media_hide' &&
          visible?.payload?.media_id === event.payload?.media_id
        ) {
          visible = null;
        }
      }
      if (!visible) return hideOverlay();
      const media = data.trip.media.find(
        (item) => item.id === visible.payload?.media_id,
      );
      if (media && overlayRef.current?.dataset.mediaId !== media.id) {
        showMedia(media);
      }
    };
  }, [data]);

  return (
    <div className="map-shell">
      <div ref={containerRef} className="map" />
      <div ref={overlayRef} className="media-overlay" />
    </div>
  );
}

declare global {
  interface Window {
    tripReady: boolean;
    tripData: unknown;
    routeData: unknown;
    timelineData: unknown;
    setTripTime: (seconds: number) => Promise<void>;
  }
}
