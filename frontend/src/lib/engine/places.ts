// Port of backend/app/geocoding/nominatim.py for browser use.
// Results are cached in memory only, so GPS-derived lookups do not outlive the tab.

import type {FetchLike} from "./routing.ts";

export type PlaceGranularity = "specific" | "neighborhood" | "city" | "region";
export const PLACE_GRANULARITIES: PlaceGranularity[] = ["specific", "neighborhood", "city", "region"];

type Address = Record<string, unknown>;
export interface NominatimPayload {
  name?: unknown;
  display_name?: unknown;
  address?: Address;
}

export interface LocationSuggestion {
  latitude: number;
  longitude: number;
  display_name: string | null;
}

function first(address: Address, keys: string[]): string | null {
  for (const key of keys) {
    const value = address[key];
    if (value) return String(value);
  }
  return null;
}

function beforeComma(value: string | null): string | null {
  if (!value) return null;
  return value.split(",", 1)[0].trim() || null;
}

export function formatPlaceName(payload: NominatimPayload, granularity: PlaceGranularity = "neighborhood"): string | null {
  const address = payload.address ?? {};
  const city = first(address, ["city", "town", "village", "municipality"]);
  const neighborhood = first(address, ["neighbourhood", "quarter", "suburb", "hamlet", "village"]);
  const district = first(address, ["state_district", "county", "district"]);
  const region = first(address, ["state", "region"]);

  if (granularity === "specific") {
    const specific = payload.name
      ? String(payload.name)
      : first(address, [
          "amenity", "tourism", "shop", "leisure", "building", "road", "pedestrian",
          "residential", "path", "neighbourhood", "quarter", "suburb",
        ]);
    return beforeComma(specific || neighborhood || city || district || region);
  }
  if (granularity === "neighborhood") return beforeComma(neighborhood || city || district || region);
  if (granularity === "city") return beforeComma(city || neighborhood || district || region);
  if (granularity === "region") return beforeComma(district || region || city || neighborhood);
  return payload.display_name ? beforeComma(String(payload.display_name)) : null;
}

export interface NominatimOptions {
  baseUrl?: string;
  minIntervalSeconds?: number;
  timeoutSeconds?: number;
  fetch?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Nominatim client honouring the 1 request/second usage policy. */
export class NominatimGeocoder {
  private readonly baseUrl: string;
  private readonly minIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly fetcher: FetchLike;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly reverseCache = new Map<string, Promise<NominatimPayload>>();
  private readonly searchCache = new Map<string, Promise<LocationSuggestion[]>>();
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequestAt = -Infinity;

  constructor(options: NominatimOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "https://nominatim.openstreetmap.org").replace(/\/+$/, "");
    this.minIntervalMs = (options.minIntervalSeconds ?? 1.05) * 1000;
    this.timeoutMs = (options.timeoutSeconds ?? 10) * 1000;
    this.fetcher = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private throttled<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const wait = this.minIntervalMs - (this.now() - this.lastRequestAt);
      if (wait > 0) await this.sleep(wait);
      try {
        return await task();
      } finally {
        this.lastRequestAt = this.now();
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async getJson(url: string, signal?: AbortSignal): Promise<unknown> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, {once: true});
    const timer = setTimeout(abort, this.timeoutMs);
    try {
      const response = await this.fetcher(url, {signal: controller.signal});
      if (!response.ok) throw new Error(`Nominatim HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  static cacheKey(latitude: number, longitude: number): string {
    return `${latitude.toFixed(5)}_${longitude.toFixed(5)}`;
  }

  payload(latitude: number, longitude: number): Promise<NominatimPayload> {
    const key = NominatimGeocoder.cacheKey(latitude, longitude);
    let cached = this.reverseCache.get(key);
    if (!cached) {
      const params = new URLSearchParams({
        lat: String(latitude),
        lon: String(longitude),
        format: "jsonv2",
        addressdetails: "1",
        zoom: "18",
        "accept-language": "en",
      });
      cached = this.throttled(() => this.getJson(`${this.baseUrl}/reverse?${params}`)) as Promise<NominatimPayload>;
      cached.catch(() => this.reverseCache.delete(key));
      this.reverseCache.set(key, cached);
    }
    return cached;
  }

  async reverse(latitude: number, longitude: number, granularity: PlaceGranularity = "neighborhood"): Promise<string | null> {
    return formatPlaceName(await this.payload(latitude, longitude), granularity);
  }

  search(query: string, limit = 5, signal?: AbortSignal): Promise<LocationSuggestion[]> {
    const normalized = query.split(/\s+/).filter(Boolean).join(" ");
    if (!normalized) return Promise.resolve([]);
    const safeLimit = Math.max(1, Math.min(limit, 5));
    const key = `${normalized.toLowerCase()}:${safeLimit}`;
    const cached = this.searchCache.get(key);
    if (cached) return cached;
    const params = new URLSearchParams({
      q: normalized,
      format: "jsonv2",
      addressdetails: "1",
      limit: String(safeLimit),
      "accept-language": "en",
    });
    const request = this.throttled(async () => {
      if (signal?.aborted) throw new DOMException("Search aborted", "AbortError");
      const payload = await this.getJson(`${this.baseUrl}/search?${params}`, signal);
      const results: LocationSuggestion[] = [];
      for (const item of Array.isArray(payload) ? payload : []) {
        const latitude = Number((item as {lat?: unknown}).lat);
        const longitude = Number((item as {lon?: unknown}).lon);
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
        const displayName = (item as {display_name?: unknown}).display_name;
        results.push({latitude, longitude, display_name: typeof displayName === "string" ? displayName : null});
      }
      return results;
    });
    request.then(
      () => undefined,
      () => this.searchCache.delete(key),
    );
    this.searchCache.set(key, request);
    return request;
  }

  async forward(query: string): Promise<LocationSuggestion | null> {
    const [result] = await this.search(query, 1);
    return result ?? null;
  }
}
