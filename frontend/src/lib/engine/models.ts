// Domain models mirroring backend/app/models. Timestamps are ISO-8601 strings;
// naive strings (no offset) come from EXIF clocks and are compared as local time.

export type MediaType = "photo" | "video";
export type GPSQuality = "valid" | "missing" | "suspicious";

export interface MediaPoint {
  id: string;
  filename: string;
  media_type: MediaType;
  captured_at: string | null;
  timestamp_source: string | null;
  latitude: number | null;
  longitude: number | null;
  altitude: number | null;
  direction: number | null;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  gps_quality: GPSQuality;
  metadata_warnings: string[];
}

export interface Observation {
  id: string;
  arrival: string;
  departure: string;
  latitude: number;
  longitude: number;
  media_ids: string[];
}

export interface TripStats {
  media_count: number;
  photo_count: number;
  video_count: number;
  gps_media_count: number;
  distance_meters: number;
  real_duration_seconds: number;
  video_duration_seconds: number | null;
}

export interface Trip {
  id: string;
  started_at: string | null;
  ended_at: string | null;
  media: MediaPoint[];
  observations: Observation[];
  stats: TripStats;
}

export interface Coordinate {
  latitude: number;
  longitude: number;
}

export interface RouteSegment {
  start_observation_id: string;
  end_observation_id: string;
  geometry: Coordinate[];
  distance_meters: number;
  duration_seconds: number;
  routing_profile: string;
  inferred: true;
}

export interface Route {
  segments: RouteSegment[];
  geometry: Coordinate[];
  distance_meters: number;
  duration_seconds: number;
}

export type EventType =
  | "route_start"
  | "move"
  | "media_show"
  | "media_hide"
  | "location_arrival"
  | "location_departure"
  | "camera_overview"
  | "camera_follow"
  | "camera_zoom"
  | "route_end";

export interface TimelineEvent {
  video_time: number;
  type: EventType;
  payload: Record<string, unknown>;
}

export interface Timeline {
  duration_seconds: number;
  events: TimelineEvent[];
}

export function hasGps(media: MediaPoint): media is MediaPoint & {latitude: number; longitude: number} {
  return media.latitude !== null && media.longitude !== null;
}

/** Milliseconds for ordering and gaps. Naive ISO strings are read as local time, consistently. */
export function timeMs(value: string): number {
  return Date.parse(value);
}

export function routeAsGeoJson(route: Route) {
  return {
    type: "Feature" as const,
    properties: {
      distance_meters: route.distance_meters,
      duration_seconds: route.duration_seconds,
      inferred: true,
    },
    geometry: {
      type: "LineString" as const,
      coordinates: route.geometry.map((point) => [point.longitude, point.latitude]),
    },
  };
}
