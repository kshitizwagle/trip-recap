import type {
  AnalyzeSessionPayload,
  AnalyzeSessionResponse,
  RenderJob,
  TripData,
  UploadedMedia,
} from "./trip-types";

export interface UploadRequest {
  promise: Promise<UploadedMedia>;
  abort: () => void;
}

export interface LocationSuggestion {
  latitude: number;
  longitude: number;
  display_name: string | null;
}

function responseError(payload: unknown, fallback: string): Error {
  if (typeof payload === "object" && payload !== null && "detail" in payload) {
    const detail = (payload as {detail?: unknown}).detail;
    if (typeof detail === "string" && detail) return new Error(detail);
  }
  return new Error(fallback);
}

async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) throw responseError(payload, `Request failed · HTTP ${response.status}`);
  return payload as T;
}

export function searchLocations(
  query: string,
  signal?: AbortSignal,
): Promise<{results: LocationSuggestion[]}> {
  return requestJson(
    `/api/locations/search?q=${encodeURIComponent(query)}&limit=5`,
    {signal},
  );
}

export function uploadMedia(
  sessionId: string,
  file: File,
  onProgress: (percent: number) => void,
): UploadRequest {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<UploadedMedia>((resolve, reject) => {
    xhr.open("POST", `/api/upload-sessions/${sessionId}/media`);
    xhr.responseType = "json";
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress((event.loaded / event.total) * 100);
    };
    xhr.onload = () => {
      const payload = xhr.response ?? {};
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(responseError(payload, `Upload failed · HTTP ${xhr.status}`));
        return;
      }
      resolve(payload as UploadedMedia);
    };
    xhr.onerror = () => reject(new Error("Upload failed"));
    xhr.onabort = () => reject(new DOMException("Upload aborted", "AbortError"));
    const form = new FormData();
    form.append("file", file, file.name);
    xhr.send(form);
  });

  return {promise, abort: () => xhr.abort()};
}

export function discardUploadedMedia(sessionId: string, uploadId: string): Promise<{status: string; id: string}> {
  return requestJson(`/api/upload-sessions/${sessionId}/media/${uploadId}`, {method: "DELETE"});
}

export function analyzeSession(payload: AnalyzeSessionPayload): Promise<AnalyzeSessionResponse> {
  return requestJson("/api/trips/analyze-session", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(payload),
  });
}

export function fetchTripData(tripId: string): Promise<TripData> {
  return requestJson(`/api/trips/${tripId}/data`);
}

export async function fetchPlaces(
  tripId: string,
  granularity: string,
): Promise<{places: Record<string, string>}> {
  return requestJson(`/api/trips/${tripId}/places?granularity=${encodeURIComponent(granularity)}`);
}

export function startRender(tripId: string): Promise<RenderJob> {
  return requestJson(`/api/trips/${tripId}/render`, {method: "POST"});
}

export function fetchRenderStatus(renderId: string): Promise<RenderJob> {
  return requestJson(`/api/renders/${renderId}`);
}
