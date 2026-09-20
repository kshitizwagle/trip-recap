export interface UploadedMedia {
  id: string;
  filename: string;
  state: "uploaded";
  size_bytes: number;
  stored_bytes: number;
  preview_url: string;
}

export interface RouteGeometry {
  type: "Feature";
  properties: {
    distance_meters?: number;
    duration_seconds?: number;
    inferred?: boolean;
  };
  geometry: {
    type: "LineString";
    coordinates: number[][];
  };
}

export interface TimelineEvent {
  video_time: number;
  type: string;
  payload: Record<string, unknown>;
}

export interface TimelineData {
  duration_seconds: number;
  events: TimelineEvent[];
}

export interface TripMedia {
  id: string;
  filename: string;
  media_type: string;
  url: string;
  preview_url: string;
}

export interface TripDocument {
  id: string;
  started_at: string | null;
  ended_at: string | null;
  media: TripMedia[];
}

export interface Observation {
  id: string;
  order: number;
  latitude: number;
  longitude: number;
  arrival: string;
  departure: string;
  place: string;
  media_ids: string[];
  media_files: string[];
  progress: number;
}

export interface TripSummary {
  media_count: number;
  gps_media_count: number;
  stop_count: number;
  segment_count: number;
  distance_meters: number;
  started_at: string | null;
  ended_at: string | null;
}

export interface TripData {
  id: string;
  trip: TripDocument;
  route: RouteGeometry | null;
  timeline: TimelineData | null;
  observations: Observation[];
  place_names: Record<string, string>;
  route_error: string | null;
  summary: TripSummary;
}

export interface AnalyzeSessionPayload {
  session_id: string;
  upload_ids: string[];
  keep_as_one_trip: boolean;
  start_location: string | null;
  end_location: string | null;
  return_to_start: boolean;
}

export interface AnalyzeSessionResponse {
  trips: TripData[];
}

export interface RenderJob {
  id: string;
  status: string;
  error?: string;
}
