// Port of backend/app/routing: Router abstraction, OSRM client, cache, route assembly.

import type {Coordinate, Route, RouteSegment, Trip} from "./models.ts";

export interface Router {
  route(start: Coordinate, end: Coordinate, startObservationId: string, endObservationId: string): Promise<RouteSegment>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** In-memory only: GPS-derived routes are not persisted beyond the tab (see PRIVACY.md). */
export class RouteCache {
  private readonly entries = new Map<string, RouteSegment>();

  static key(start: Coordinate, end: Coordinate, profile: string): string {
    return `${start.latitude.toFixed(5)},${start.longitude.toFixed(5)}:${end.latitude.toFixed(5)},${end.longitude.toFixed(5)}:${profile}`;
  }

  get(start: Coordinate, end: Coordinate, profile: string): RouteSegment | undefined {
    return this.entries.get(RouteCache.key(start, end, profile));
  }

  put(start: Coordinate, end: Coordinate, segment: RouteSegment): void {
    this.entries.set(RouteCache.key(start, end, segment.routing_profile), segment);
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

  async route(start: Coordinate, end: Coordinate, startObservationId: string, endObservationId: string): Promise<RouteSegment> {
    const cached = this.cache?.get(start, end, this.profile);
    if (cached) return {...cached, start_observation_id: startObservationId, end_observation_id: endObservationId};

    const url =
      `${this.baseUrl}/route/v1/${this.profile}/${start.longitude},${start.latitude};${end.longitude},${end.latitude}` +
      "?overview=full&geometries=geojson&steps=false";
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
    const coordinates = route.geometry?.coordinates ?? [];
    if (coordinates.length < 2) throw new Error("OSRM returned an invalid route geometry");
    const segment: RouteSegment = {
      start_observation_id: startObservationId,
      end_observation_id: endObservationId,
      geometry: coordinates.map(([longitude, latitude]) => ({latitude, longitude})),
      distance_meters: Number(route.distance ?? 0),
      duration_seconds: Number(route.duration ?? 0),
      routing_profile: this.profile,
      inferred: true,
    };
    this.cache?.put(start, end, segment);
    return segment;
  }
}

export async function buildRoute(trip: Trip, router: Router): Promise<Route> {
  const segments: RouteSegment[] = [];
  for (let i = 1; i < trip.observations.length; i += 1) {
    const start = trip.observations[i - 1];
    const end = trip.observations[i];
    segments.push(
      await router.route(
        {latitude: start.latitude, longitude: start.longitude},
        {latitude: end.latitude, longitude: end.longitude},
        start.id,
        end.id,
      ),
    );
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

/** Distance-based progress of each observation along the route (backend `_route_progresses`). */
export function routeProgresses(route: Route | null, observationCount: number): number[] {
  if (observationCount <= 0) return [];
  if (observationCount === 1) return [0];
  const even = () => Array.from({length: observationCount}, (_, index) => index / (observationCount - 1));
  if (!route || !route.segments.length) return even();
  const total = route.segments.reduce((sum, segment) => sum + Math.max(segment.distance_meters, 0), 0);
  if (total <= 0) return even();
  const progresses = [0];
  let distance = 0;
  for (const segment of route.segments) {
    distance += Math.max(segment.distance_meters, 0);
    progresses.push(Math.min(1, distance / total));
  }
  while (progresses.length < observationCount) progresses.push(1);
  return progresses.slice(0, observationCount);
}
