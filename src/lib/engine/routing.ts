// Router abstraction, OSRM client, cache, route assembly.

import {haversineMeters} from "./geo.ts";
import type {Coordinate, Route, RouteSegment, Trip} from "./models.ts";

export interface Router {
  /** One leg between two stops. `via` are observed points the road must pass through, in order. */
  route(start: Coordinate, end: Coordinate, startObservationId: string, endObservationId: string, via?: Coordinate[]): Promise<RouteSegment>;
}

/** Most waypoints sent with one leg; the public OSRM demo rejects very long coordinate lists. */
export const MAX_VIA_POINTS = 25;
/** Waypoints closer than this to the previous point on the leg add nothing to the road's shape. */
export const MIN_VIA_SPACING_METERS = 100;

/** The leg's waypoints thinned for routing: no near-duplicates, and at most MAX_VIA_POINTS, spread evenly. */
export function routingVia(start: Coordinate, via: Coordinate[], end: Coordinate): Coordinate[] {
  const spaced: Coordinate[] = [];
  let previous = start;
  for (const point of via) {
    if (haversineMeters(previous.latitude, previous.longitude, point.latitude, point.longitude) < MIN_VIA_SPACING_METERS) continue;
    spaced.push(point);
    previous = point;
  }
  while (spaced.length && haversineMeters(spaced[spaced.length - 1].latitude, spaced[spaced.length - 1].longitude, end.latitude, end.longitude) < MIN_VIA_SPACING_METERS) {
    spaced.pop();
  }
  if (spaced.length <= MAX_VIA_POINTS) return spaced;
  return Array.from({length: MAX_VIA_POINTS}, (_, index) => spaced[Math.round(((index + 0.5) * spaced.length) / MAX_VIA_POINTS - 0.5)]);
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** In-memory only: GPS-derived routes are not persisted beyond the tab (see PRIVACY.md). */
export class RouteCache {
  private readonly entries = new Map<string, RouteSegment>();

  static key(start: Coordinate, end: Coordinate, profile: string, via: Coordinate[] = []): string {
    return [start, ...via, end].map((point) => `${point.latitude.toFixed(5)},${point.longitude.toFixed(5)}`).join(":") + `:${profile}`;
  }

  get(start: Coordinate, end: Coordinate, profile: string, via: Coordinate[] = []): RouteSegment | undefined {
    return this.entries.get(RouteCache.key(start, end, profile, via));
  }

  put(start: Coordinate, end: Coordinate, segment: RouteSegment, via: Coordinate[] = []): void {
    this.entries.set(RouteCache.key(start, end, segment.routing_profile, via), segment);
  }
}

export interface OSRMRouterOptions {
  baseUrl?: string;
  profile?: string;
  cache?: RouteCache;
  timeoutSeconds?: number;
  maxAttempts?: number;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class OSRMRouter implements Router {
  readonly baseUrl: string;
  readonly profile: string;
  private readonly cache?: RouteCache;
  private readonly timeoutSeconds: number;
  private readonly maxAttempts: number;
  private readonly fetcher: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: OSRMRouterOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "https://router.project-osrm.org").replace(/\/+$/, "");
    this.profile = options.profile ?? "driving";
    this.cache = options.cache;
    this.timeoutSeconds = options.timeoutSeconds ?? 20;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.fetcher = options.fetch ?? ((input, init) => fetch(input, init));
    this.sleep = options.sleep ?? defaultSleep;
  }

  async route(start: Coordinate, end: Coordinate, startObservationId: string, endObservationId: string, via: Coordinate[] = []): Promise<RouteSegment> {
    const cached = this.cache?.get(start, end, this.profile, via);
    if (cached) return {...cached, start_observation_id: startObservationId, end_observation_id: endObservationId};

    const coordinates = [start, ...via, end].map((point) => `${point.longitude},${point.latitude}`).join(";");
    const url = `${this.baseUrl}/route/v1/${this.profile}/${coordinates}?overview=full&geometries=geojson&steps=false`;
    let payload: {code?: string; routes?: Array<{geometry?: {coordinates?: number[][]}; distance?: number; duration?: number}>} | null = null;

    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutSeconds * 1000);
      try {
        const response = await this.fetcher(url, {signal: controller.signal});
        if (!response.ok) throw new Error(`OSRM HTTP ${response.status}`);
        payload = await response.json();
        break;
      } catch (error) {
        if (attempt + 1 >= this.maxAttempts) throw error;
        await this.sleep(500 * 2 ** attempt);
      } finally {
        clearTimeout(timer);
      }
    }

    const routes = payload?.routes ?? [];
    if (payload?.code !== "Ok" || !routes.length) throw new Error(`OSRM did not return a route: ${payload?.code}`);
    const route = routes[0];
    const line = route.geometry?.coordinates ?? [];
    if (line.length < 2) throw new Error("OSRM returned an invalid route geometry");
    const segment: RouteSegment = {
      start_observation_id: startObservationId,
      end_observation_id: endObservationId,
      geometry: line.map(([longitude, latitude]) => ({latitude, longitude})),
      distance_meters: Number(route.distance ?? 0),
      duration_seconds: Number(route.duration ?? 0),
      routing_profile: this.profile,
      inferred: true,
    };
    this.cache?.put(start, end, segment, via);
    return segment;
  }
}

export async function buildRoute(trip: Trip, router: Router): Promise<Route> {
  const segments: RouteSegment[] = [];
  for (let i = 1; i < trip.observations.length; i += 1) {
    const start = trip.observations[i - 1];
    const end = trip.observations[i];
    const from = {latitude: start.latitude, longitude: start.longitude};
    const to = {latitude: end.latitude, longitude: end.longitude};
    const via = routingVia(from, (end.via ?? []).map(({latitude, longitude}) => ({latitude, longitude})), to);
    segments.push(await router.route(from, to, start.id, end.id, via));
  }
  const geometry: Coordinate[] = [];
  segments.forEach((segment, index) => geometry.push(...(index === 0 ? segment.geometry : segment.geometry.slice(1))));
  return {
    segments,
    geometry,
    distance_meters: segments.reduce((sum, segment) => sum + segment.distance_meters, 0),
    duration_seconds: segments.reduce((sum, segment) => sum + segment.duration_seconds, 0),
  };
}

/** Length of a segment's drawn line, in metres. */
function geometryMeters(geometry: Coordinate[]): number {
  let total = 0;
  for (let i = 1; i < geometry.length; i += 1) {
    total += haversineMeters(geometry[i - 1].latitude, geometry[i - 1].longitude, geometry[i].latitude, geometry[i].longitude);
  }
  return total;
}

/**
 * Progress of each observation along the route, measured on the drawn line itself (not the router's
 * reported road distance), so a stop's progress lands exactly where its segment joins the next and
 * the traveller reaches each stop where the line passes it.
 */
export function routeProgresses(route: Route | null, observationCount: number): number[] {
  if (observationCount <= 0) return [];
  if (observationCount === 1) return [0];
  const even = () => Array.from({length: observationCount}, (_, index) => index / (observationCount - 1));
  if (!route || !route.segments.length) return even();
  const lengths = route.segments.map((segment) => geometryMeters(segment.geometry));
  const total = lengths.reduce((sum, length) => sum + length, 0);
  if (total <= 0) return even();
  const progresses = [0];
  let distance = 0;
  for (const length of lengths) {
    distance += length;
    progresses.push(Math.min(1, distance / total));
  }
  while (progresses.length < observationCount) progresses.push(1);
  return progresses.slice(0, observationCount);
}
