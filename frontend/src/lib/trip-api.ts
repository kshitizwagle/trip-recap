// In-browser replacement for the old FastAPI client. Same function names and shapes, but files never
// leave the device: metadata is read locally, OSRM and Nominatim are called directly, and media URLs
// are object URLs that live only as long as the tab.

import {analyzeMedia, analyzePlaces, applyStopEdits, type AnalyzedTrip, resolveLocation, type StopEdit, tripPayload} from "./engine/analyze.ts";
import {randomId} from "./engine/ids.ts";
import {extractMetadata} from "./engine/metadata/extract.ts";
import type {MediaPoint} from "./engine/models.ts";
import {type LocationSuggestion, NominatimGeocoder, PhotonGeocoder, PLACE_GRANULARITIES, type PlaceGranularity} from "./engine/places.ts";
import {OSRMRouter, RouteCache} from "./engine/routing.ts";
import type {AnalyzeSessionPayload, AnalyzeSessionResponse, TripData, UploadedMedia} from "./trip-types";

export type {LocationSuggestion};

export const PLACE_PENDING = "Looking up…";
export const PLACE_UNKNOWN = "Unknown place";

/** A stop in the route editor: an existing point, or a place the user added by search. */
export type RouteStopInput = {id: string} | {query: string; name?: string} | {latitude: number; longitude: number; name: string};

export interface UploadRequest {
  promise: Promise<UploadedMedia>;
  abort: () => void;
}

interface StoredMedia {
  id: string;
  file: File;
  url: string;
  media: MediaPoint;
}

interface StoredTrip {
  analyzed: AnalyzedTrip;
  places: Map<PlaceGranularity, Record<string, string>>;
  /** Names the user typed or picked; they win over looked-up names at every granularity. */
  customNames: Record<string, string>;
  /** Stops created from the start/end/return options at build time. */
  endpoints: Record<string, "start" | "end" | "return">;
}

const geocoder = new NominatimGeocoder();
const photon = new PhotonGeocoder();
const router = new OSRMRouter({cache: new RouteCache()});
const sessions = new Map<string, Map<string, StoredMedia>>();
const trips = new Map<string, StoredTrip>();
const mediaById = new Map<string, StoredMedia>();

function session(sessionId: string): Map<string, StoredMedia> {
  let uploads = sessions.get(sessionId);
  if (!uploads) {
    uploads = new Map();
    sessions.set(sessionId, uploads);
  }
  return uploads;
}

function urlsFor(media: MediaPoint) {
  const stored = mediaById.get(media.id);
  return {url: stored?.url ?? "", preview_url: stored?.url ?? ""};
}

function payload(tripId: string, granularity: PlaceGranularity = "neighborhood"): TripData {
  const stored = trips.get(tripId);
  if (!stored) throw new Error("Trip not found. Trips live only in this browser tab; build the route again.");
  const looked = stored.places.get(granularity) ?? {};
  const places: Record<string, string> = {};
  for (const observation of stored.analyzed.trip.observations) {
    places[observation.id] = stored.customNames[observation.id] ?? looked[observation.id] ?? PLACE_PENDING;
  }
  const data = tripPayload(stored.analyzed, places, urlsFor) as TripData;
  data.observations = data.observations.map((observation) => ({...observation, endpoint: stored.endpoints[observation.id] ?? null}));
  return data;
}

export function searchLocations(query: string, signal?: AbortSignal): Promise<{results: LocationSuggestion[]}> {
  const normalized = query.split(/\s+/).filter(Boolean).join(" ");
  if (normalized.length < 2) return Promise.reject(new Error("Location query must contain at least 2 characters"));
  return geocoder.search(normalized, 5, signal).then((results) => ({results}));
}

/** "Uploading" is local now: the file is kept in memory and its metadata read on the device. */
export function uploadMedia(sessionId: string, file: File, onProgress: (percent: number) => void): UploadRequest {
  let aborted = false;
  const id = randomId();
  const promise = (async (): Promise<UploadedMedia> => {
    onProgress(15);
    const media = await extractMetadata(file, file.name, id);
    if (aborted) throw new DOMException("Upload aborted", "AbortError");
    const stored: StoredMedia = {id, file, url: URL.createObjectURL(file), media};
    session(sessionId).set(id, stored);
    mediaById.set(id, stored);
    onProgress(100);
    return {
      id,
      filename: file.name,
      state: "uploaded",
      size_bytes: file.size,
      stored_bytes: 0,
      preview_url: stored.url,
      captured_at: media.captured_at,
      has_gps: media.latitude !== null && media.longitude !== null,
      metadata_warnings: media.metadata_warnings,
    };
  })();
  return {promise, abort: () => { aborted = true; }};
}

export async function discardUploadedMedia(sessionId: string, uploadId: string): Promise<{status: string; id: string}> {
  const uploads = session(sessionId);
  const stored = uploads.get(uploadId);
  if (stored) {
    uploads.delete(uploadId);
    const inUse = [...trips.values()].some((trip) => trip.analyzed.trip.media.some((item) => item.id === uploadId));
    if (!inUse) {
      URL.revokeObjectURL(stored.url);
      mediaById.delete(uploadId);
    }
  }
  return {status: "discarded", id: uploadId};
}

export async function analyzeSession(request: AnalyzeSessionPayload): Promise<AnalyzeSessionResponse> {
  const uploads = session(request.session_id);
  const media = [...new Set(request.upload_ids)]
    .map((id) => uploads.get(id)?.media)
    .filter((item): item is MediaPoint => item !== undefined)
    .map((item) => structuredClone(item));
  if (!media.length) throw new Error("No available media to analyze. Add photos or videos first.");

  const analyzed = await analyzeMedia(
    media,
    {
      keepAsOneTrip: request.keep_as_one_trip,
      startLocation: request.start_location,
      endLocation: request.end_location,
      returnToStart: request.return_to_start,
    },
    {router, forwardGeocode: (query) => geocoder.forward(query)},
  );
  for (const item of analyzed) {
    const endpoints: StoredTrip["endpoints"] = {};
    const stops = item.trip.observations;
    const fromOptions = (index: number) => stops[index] && stops[index].media_ids.length === 0;
    if (request.start_location && fromOptions(0)) endpoints[stops[0].id] = "start";
    const last = stops.length - 1;
    if (last > 0 && fromOptions(last)) {
      if (request.return_to_start) endpoints[stops[last].id] = "return";
      else if (request.end_location) endpoints[stops[last].id] = "end";
    }
    trips.set(item.trip.id, {analyzed: item, places: new Map(), customNames: {}, endpoints});
  }
  return {trips: analyzed.map((item) => payload(item.trip.id))};
}

export async function fetchTripData(tripId: string): Promise<TripData> {
  return payload(tripId);
}

async function lookUpPlace(latitude: number, longitude: number, level: PlaceGranularity): Promise<string> {
  try {
    const name = await geocoder.reverse(latitude, longitude, level);
    if (name) return name;
  } catch {
    // Nominatim failed or rate-limited; Photon is the fallback.
  }
  try {
    return (await photon.reverse(latitude, longitude, level)) ?? PLACE_UNKNOWN;
  } catch {
    return PLACE_UNKNOWN;
  }
}

/**
 * Looks up a name for every point at the given detail level. `onUpdate` receives the names found
 * so far after each lookup, so labels fill in one by one instead of all at the end.
 */
export async function fetchPlaces(
  tripId: string,
  granularity: string,
  onUpdate?: (places: Record<string, string>) => void,
): Promise<{places: Record<string, string>}> {
  if (!PLACE_GRANULARITIES.includes(granularity as PlaceGranularity)) throw new Error("Invalid place granularity");
  const stored = trips.get(tripId);
  if (!stored) throw new Error("Trip not found");
  const level = granularity as PlaceGranularity;
  const looked = {...(stored.places.get(level) ?? {})};
  const merged = () => {
    const out: Record<string, string> = {};
    for (const observation of stored.analyzed.trip.observations) {
      out[observation.id] = stored.customNames[observation.id] ?? looked[observation.id] ?? PLACE_PENDING;
    }
    return out;
  };
  for (const observation of stored.analyzed.trip.observations) {
    if (looked[observation.id] || stored.customNames[observation.id]) continue;
    looked[observation.id] = await lookUpPlace(observation.latitude, observation.longitude, level);
    stored.places.set(level, {...looked});
    onUpdate?.(merged());
  }
  stored.places.set(level, looked);
  return {places: merged()};
}

/** Gives a point a name of the user's choosing; an empty name restores the looked-up one. */
export async function renameStop(tripId: string, observationId: string, name: string): Promise<TripData> {
  const stored = trips.get(tripId);
  if (!stored) throw new Error("Trip not found");
  const trimmed = name.trim();
  if (trimmed) stored.customNames[observationId] = trimmed;
  else delete stored.customNames[observationId];
  return payload(tripId);
}

function shortName(displayName: string): string {
  return displayName.split(",")[0]?.trim() || displayName.trim();
}

type CustomStop = Extract<StopEdit, {kind: "custom"}>;

/** Resolves an added place (search text or coordinates) into a custom stop with a fresh id. */
async function resolvePlace(stop: Exclude<RouteStopInput, {id: string}>): Promise<CustomStop> {
  let latitude: number;
  let longitude: number;
  let name: string;
  if ("query" in stop) {
    const resolved = await resolveLocation(stop.query, {router, forwardGeocode: (query) => geocoder.forward(query)});
    if (!resolved) throw new Error(`Could not find location: ${stop.query}`);
    [latitude, longitude] = resolved;
    name = stop.name?.trim() || shortName(stop.query);
  } else {
    ({latitude, longitude, name} = stop);
  }
  // Each added place gets its own id, so the same place can be added twice and removed one at a time.
  return {kind: "custom", latitude, longitude, name, id: randomId()};
}

function rememberNames(stored: StoredTrip, stops: CustomStop[]) {
  for (const stop of stops) if (stop.id) stored.customNames[stop.id] = stop.name;
}

/**
 * Re-orders the route and/or adds places, then re-routes and re-times the trip. Existing points
 * are passed by id; new places by search text (resolved through Nominatim) or coordinates.
 */
export async function updateStops(tripId: string, stops: RouteStopInput[]): Promise<TripData> {
  const stored = trips.get(tripId);
  if (!stored) throw new Error("Trip not found");
  const edits: StopEdit[] = [];
  const added: CustomStop[] = [];
  for (const stop of stops) {
    if ("id" in stop) {
      edits.push({kind: "observation", id: stop.id});
      continue;
    }
    const place = await resolvePlace(stop);
    added.push(place);
    edits.push(place);
  }
  const updated = await applyStopEdits(stored.analyzed, edits, {router});
  rememberNames(stored, added);
  stored.analyzed = updated;
  return payload(tripId);
}

/** Builds a trip from places alone, for people with no geotagged photos or videos. */
export async function planTrip(stops: Exclude<RouteStopInput, {id: string}>[]): Promise<TripData> {
  const places: CustomStop[] = [];
  for (const stop of stops) places.push(await resolvePlace(stop));
  const analyzed = await analyzePlaces(places, {router});
  const stored: StoredTrip = {analyzed, places: new Map(), customNames: {}, endpoints: {}};
  rememberNames(stored, places);
  trips.set(analyzed.trip.id, stored);
  return payload(analyzed.trip.id);
}

/** Original media for a trip, used by the in-browser MP4 export. */
export function tripMediaFile(mediaId: string): File | null {
  return mediaById.get(mediaId)?.file ?? null;
}
