// Session analysis: media → trips with routes, endpoints and timelines, serialized for the UI.
// Pure orchestration over injected services.

import {haversineMeters} from "./geo.ts";
import {uuid5} from "./ids.ts";
import {type MediaPoint, type Observation, type Route, type Timeline, type Trip, routeAsGeoJson} from "./models.ts";
import {observationDistance, TripBuilder} from "./trip.ts";
import {buildRoute, type Router, routeProgresses} from "./routing.ts";
import {TimelineBuilder} from "./timeline.ts";
import type {LocationSuggestion} from "./places.ts";

export interface AnalyzeOptions {
  keepAsOneTrip: boolean;
  startLocation: string | null;
  endLocation: string | null;
  returnToStart: boolean;
  /** Photo spots closer than this to the previous stop shape the road instead of becoming stops. */
  stopDistanceMeters?: number;
}

export interface AnalyzeServices {
  router: Router;
  forwardGeocode: (query: string) => Promise<LocationSuggestion | null>;
  now?: () => Date;
}

export interface AnalyzedTrip {
  trip: Trip;
  route: Route | null;
  timeline: Timeline;
  routeError: string | null;
}

type LatLon = [number, number];

export function parseCoordinates(value: string): LatLon | null {
  const parts = value.split(",").map((part) => part.trim());
  if (parts.length !== 2 || parts.some((part) => part === "")) return null;
  const latitude = Number(parts[0]);
  const longitude = Number(parts[1]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    throw new Error("Coordinates must be valid latitude, longitude values");
  }
  return [latitude, longitude];
}

export async function resolveLocation(value: string | null, services: AnalyzeServices): Promise<LatLon | null> {
  const text = (value ?? "").trim();
  if (!text) return null;
  const coordinates = parseCoordinates(text);
  if (coordinates) return coordinates;
  let result: LocationSuggestion | null;
  try {
    result = await services.forwardGeocode(text);
  } catch (error) {
    throw new Error(`Location lookup failed for '${text}': ${error instanceof Error ? error.message : error}`);
  }
  if (!result) throw new Error(`Could not find location: ${text}`);
  return [result.latitude, result.longitude];
}

function endpointObservation(kind: string, [latitude, longitude]: LatLon, when: string): Observation {
  return {
    id: uuid5(`${kind}:${latitude.toFixed(7)}:${longitude.toFixed(7)}:${when}`),
    arrival: when,
    departure: when,
    latitude,
    longitude,
    media_ids: [],
  };
}

function samePoint(observation: Observation, [latitude, longitude]: LatLon): boolean {
  return haversineMeters(observation.latitude, observation.longitude, latitude, longitude) < 1;
}

export function applyRouteEndpoints(
  trip: Trip,
  start: LatLon | null,
  end: LatLon | null,
  returnToStart: boolean,
  now: () => Date = () => new Date(),
): void {
  const observations = [...trip.observations];
  const fallbackTime = trip.started_at ?? trip.ended_at ?? now().toISOString();

  if (start) {
    const startTime = observations.length ? observations[0].arrival : fallbackTime;
    if (!observations.length || !samePoint(observations[0], start)) {
      observations.unshift(endpointObservation("start", start, startTime));
    }
  }

  if (returnToStart) {
    if (observations.length) {
      const loop: LatLon = start ?? [observations[0].latitude, observations[0].longitude];
      if (observations.length > 1 || !samePoint(observations[observations.length - 1], loop)) {
        observations.push(endpointObservation("return", loop, observations[observations.length - 1].departure));
      }
    }
  } else if (end) {
    const endTime = observations.length ? observations[observations.length - 1].departure : fallbackTime;
    if (!observations.length || !samePoint(observations[observations.length - 1], end)) {
      observations.push(endpointObservation("end", end, endTime));
    }
  }

  trip.observations = observations;
  trip.stats.distance_meters = observationDistance(observations);
}

export async function analyzeMedia(
  media: MediaPoint[],
  options: AnalyzeOptions,
  services: AnalyzeServices,
): Promise<AnalyzedTrip[]> {
  if (!media.length) throw new Error("No retained media to analyze");

  const start = await resolveLocation(options.startLocation, services);
  const end = options.returnToStart ? null : await resolveLocation(options.endLocation, services);
  const tripGapSeconds = options.keepAsOneTrip || options.returnToStart ? 36500 * 86400 : 12 * 3600;
  const trips = new TripBuilder({tripGapSeconds, stopDistanceMeters: options.stopDistanceMeters}).build(media);
  if (!trips.length) throw new Error("No supported media metadata could be analyzed");

  const results: AnalyzedTrip[] = [];
  for (const [index, trip] of trips.entries()) {
    applyRouteEndpoints(
      trip,
      index === 0 ? start : null,
      index === trips.length - 1 ? end : null,
      options.returnToStart && trips.length === 1,
      services.now,
    );
    let route: Route | null = null;
    let routeError: string | null = null;
    if (trip.observations.length >= 2) {
      try {
        route = await buildRoute(trip, services.router);
      } catch (error) {
        routeError = error instanceof Error ? error.message : String(error);
      }
    }
    const timeline = new TimelineBuilder().build(trip);
    results.push({trip, route, timeline, routeError});
  }
  return results;
}

export interface MediaUrls {
  url: string;
  preview_url: string;
}

/** Serializes an analyzed trip into the TripData shape the UI consumes. */
export function tripPayload(
  analyzed: AnalyzedTrip,
  places: Record<string, string>,
  mediaUrls: (media: MediaPoint) => MediaUrls,
) {
  const {trip, route, timeline, routeError} = analyzed;
  const filenames = new Map(trip.media.map((item) => [item.id, item.filename]));
  const progresses = routeProgresses(route, trip.observations.length);
  return {
    id: trip.id,
    trip: {
      id: trip.id,
      started_at: trip.started_at,
      ended_at: trip.ended_at,
      stats: trip.stats,
      observations: trip.observations,
      media: trip.media.map((item) => ({...item, ...mediaUrls(item)})),
    },
    route: route ? routeAsGeoJson(route) : null,
    timeline,
    observations: trip.observations.map((observation, index) => ({
      id: observation.id,
      order: index + 1,
      latitude: observation.latitude,
      longitude: observation.longitude,
      arrival: observation.arrival,
      departure: observation.departure,
      place: places[observation.id] ?? "Unknown place",
      media_ids: observation.media_ids,
      media_files: observation.media_ids.map((id) => filenames.get(id)).filter((name): name is string => !!name),
      via: observation.via ?? [],
      progress: progresses[index] ?? 0,
    })),
    place_names: places,
    route_error: routeError,
    summary: {
      media_count: trip.stats.media_count,
      gps_media_count: trip.stats.gps_media_count,
      stop_count: trip.observations.length,
      segment_count: route ? route.segments.length : Math.max(trip.observations.length - 1, 0),
      distance_meters: route ? route.distance_meters : trip.stats.distance_meters,
      started_at: trip.started_at,
      ended_at: trip.ended_at,
    },
  };
}

/** A stop in a user-edited route: an existing observation, or a place the user added. */
export type StopEdit =
  | {kind: "observation"; id: string}
  | {kind: "custom"; latitude: number; longitude: number; name: string; id?: string};

export function customStopId(latitude: number, longitude: number, name: string): string {
  return uuid5(`custom:${latitude.toFixed(6)}:${longitude.toFixed(6)}:${name}`);
}

/**
 * Rebuilds a trip with stops in a new order and/or with added places, then re-routes and
 * re-times it. Added places carry no media and take their neighbour's time, so the timeline
 * falls back to a distance-based move for them.
 */
export async function applyStopEdits(
  analyzed: AnalyzedTrip,
  stops: StopEdit[],
  services: Pick<AnalyzeServices, "router" | "now">,
): Promise<AnalyzedTrip> {
  const byId = new Map(analyzed.trip.observations.map((item) => [item.id, item]));
  const previousId = new Map(analyzed.trip.observations.map((item, index) => [item.id, analyzed.trip.observations[index - 1]?.id]));
  const fallbackTime = analyzed.trip.started_at ?? analyzed.trip.observations[0]?.arrival ?? (services.now?.() ?? new Date()).toISOString();
  const observations: Observation[] = [];
  for (const stop of stops) {
    if (stop.kind === "observation") {
      const existing = byId.get(stop.id);
      // Waypoints belong to the leg they were photographed on; a stop with a new predecessor drops them.
      if (existing) {
        const sameLeg = previousId.get(existing.id) === observations[observations.length - 1]?.id;
        observations.push(sameLeg || !existing.via?.length ? existing : {...existing, via: []});
      }
      continue;
    }
    if (!Number.isFinite(stop.latitude) || !Number.isFinite(stop.longitude)) continue;
    const when = observations[observations.length - 1]?.departure ?? fallbackTime;
    observations.push({
      id: stop.id ?? customStopId(stop.latitude, stop.longitude, stop.name),
      arrival: when,
      departure: when,
      latitude: stop.latitude,
      longitude: stop.longitude,
      media_ids: [],
    });
  }
  const trip: Trip = {...analyzed.trip, observations, stats: {...analyzed.trip.stats}};
  trip.stats.distance_meters = observationDistance(observations);
  let route: Route | null = null;
  let routeError: string | null = null;
  if (observations.length >= 2) {
    try {
      route = await buildRoute(trip, services.router);
    } catch (error) {
      routeError = error instanceof Error ? error.message : String(error);
    }
  }
  const timeline = new TimelineBuilder().build(trip);
  return {trip, route, timeline, routeError};
}

/**
 * Builds a trip from places the user picked, with no media at all. Nothing is observed, so the
 * trip keeps no capture times or GPS media counts; every stop is a custom place and the timeline
 * paces the legs by distance.
 */
export async function analyzePlaces(
  stops: Extract<StopEdit, {kind: "custom"}>[],
  services: Pick<AnalyzeServices, "router" | "now">,
): Promise<AnalyzedTrip> {
  if (!stops.length) throw new Error("Add at least one place to build a route");
  const seed = stops.map((stop) => `${stop.latitude.toFixed(6)}:${stop.longitude.toFixed(6)}:${stop.name}`).join("|");
  const empty: Trip = {
    id: uuid5(`places:${seed}`),
    started_at: null,
    ended_at: null,
    media: [],
    observations: [],
    stats: {media_count: 0, photo_count: 0, video_count: 0, gps_media_count: 0, distance_meters: 0, real_duration_seconds: 0, video_duration_seconds: null},
  };
  return applyStopEdits({trip: empty, route: null, timeline: new TimelineBuilder().build(empty), routeError: null}, stops, services);
}
