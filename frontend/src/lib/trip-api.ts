// In-browser replacement for the old FastAPI client. Same function names and shapes, but files never
// leave the device: metadata is read locally, OSRM and Nominatim are called directly, and media URLs
// are object URLs that live only as long as the tab.

import {analyzeMedia, type AnalyzedTrip, tripPayload} from "./engine/analyze.ts";
import {randomId} from "./engine/ids.ts";
import {extension, extractMetadata, SUPPORTED_EXTENSIONS} from "./engine/metadata/extract.ts";
import type {MediaPoint} from "./engine/models.ts";
import {type LocationSuggestion, NominatimGeocoder, PLACE_GRANULARITIES, type PlaceGranularity} from "./engine/places.ts";
import {OSRMRouter, RouteCache} from "./engine/routing.ts";
import type {AnalyzeSessionPayload, AnalyzeSessionResponse, TripData, UploadedMedia} from "./trip-types";

export type {LocationSuggestion};

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
}

const geocoder = new NominatimGeocoder();
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
  return tripPayload(stored.analyzed, stored.places.get(granularity) ?? {}, urlsFor) as TripData;
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
    if (!SUPPORTED_EXTENSIONS.has(extension(file.name))) throw new Error(`Unsupported media type: ${file.name}`);
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
  for (const item of analyzed) trips.set(item.trip.id, {analyzed: item, places: new Map()});
  return {trips: analyzed.map((item) => payload(item.trip.id))};
}

export async function fetchTripData(tripId: string): Promise<TripData> {
  return payload(tripId);
}

export async function fetchPlaces(tripId: string, granularity: string): Promise<{places: Record<string, string>}> {
  if (!PLACE_GRANULARITIES.includes(granularity as PlaceGranularity)) throw new Error("Invalid place granularity");
  const stored = trips.get(tripId);
  if (!stored) throw new Error("Trip not found");
  const level = granularity as PlaceGranularity;
  const existing = stored.places.get(level);
  const observations = stored.analyzed.trip.observations;
  if (existing && observations.every((item) => item.id in existing)) return {places: existing};
  const places: Record<string, string> = {};
  for (const observation of observations) {
    try {
      places[observation.id] = (await geocoder.reverse(observation.latitude, observation.longitude, level)) ?? "Unknown place";
    } catch {
      places[observation.id] = "Unknown place";
    }
  }
  stored.places.set(level, places);
  return {places};
}

/** Original media for a trip, used by the in-browser MP4 export. */
export function tripMediaFile(mediaId: string): File | null {
  return mediaById.get(mediaId)?.file ?? null;
}
