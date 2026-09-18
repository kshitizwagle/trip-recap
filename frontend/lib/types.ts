export type MediaType = 'photo' | 'video';

export interface TripMedia {
  id: string;
  filename: string;
  media_type: MediaType;
  url: string;
  preview_url: string;
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

export interface TimelineEvent {
  type: string;
  video_time: number;
  payload?: Record<string, unknown>;
}

export interface Timeline {
  duration_seconds: number;
  events: TimelineEvent[];
}

export interface TripPayload {
  id: string;
  trip: {
    id: string;
    media: TripMedia[];
    [key: string]: unknown;
  };
  route: { geometry?: { coordinates?: number[][] }; [key: string]: unknown } | null;
  timeline: Timeline | null;
  observations: Observation[];
  place_names: Record<string, string>;
  route_error: string | null;
  summary: {
    media_count: number;
    gps_media_count: number;
    stop_count: number;
    segment_count: number;
    distance_meters: number;
    started_at: string | null;
    ended_at: string | null;
  };
}

export interface UploadRecord {
  clientId: string;
  file: File;
  status: 'queued' | 'uploading' | 'uploaded' | 'failed';
  progress: number;
  progressText: string;
  serverId: string | null;
  controller: AbortController | null;
  objectUrl: string;
  error?: string;
}

export interface LocationSuggestion {
  label: string;
  latitude: number;
  longitude: number;
  type?: string;
}
