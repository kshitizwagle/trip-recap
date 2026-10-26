"use client";

import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {CheckboxInput, FileInput, Stack, Text} from "@astryxdesign/core";
import {Theme} from "@astryxdesign/core/theme";
import {tripRecapTheme} from "@/theme";
import {Toaster, toast} from "sonner";
import LocationAutocomplete from "@/components/trip-recap/LocationAutocomplete";
import MapPreview, {type MapPreviewHandle} from "@/components/trip-recap/MapPreview";
import MediaQueue, {type MediaUploadRecord} from "@/components/trip-recap/MediaQueue";
import Segmented from "@/components/trip-recap/Segmented";
import StopEditor from "@/components/trip-recap/StopEditor";
import {ARROW, FRAME_IDS, FRAMES, type FrameId, MAP_STYLE_IDS, MAP_STYLES, type MapStyleId} from "@/lib/recap-scene";
import {
  analyzeSession,
  discardUploadedMedia,
  fetchPlaces,
  renameStop,
  updateStops,
  type RouteStopInput,
  uploadMedia,
  type UploadRequest,
} from "@/lib/trip-api";
import {canExportVideo, EXPORT_FRAME_RATES, EXPORT_QUALITIES, exportDimensions, exportRecapVideo, type ExportFrameRate, type ExportProgress, type ExportQuality} from "@/lib/recap-export";
import {
  MAX_CONCURRENT_UPLOADS,
  MAX_FILE_LABEL,
  canAnalyze,
  partitionFiles,
  resetUploadForRetry,
} from "@/lib/upload-queue";
import type {TripData} from "@/lib/trip-types";

const ACCEPTED_MEDIA = ".jpg,.jpeg,.heic,.heif,.png,.webp,.mov,.mp4,.m4v,image/*,video/*";
const VEHICLES = [ARROW, "🛵", "🚗", "🏍️", "🚲"] as const;
const PLACE_DETAILS = ["specific", "neighborhood", "city", "region"] as const;
const SPEEDS = [0.5, 1, 2] as const;
type Vehicle = (typeof VEHICLES)[number];
type PlaceDetail = (typeof PLACE_DETAILS)[number];
type JsonTab = "trip" | "route" | "timeline";

function updateRecord(
  setRecords: React.Dispatch<React.SetStateAction<MediaUploadRecord[]>>,
  clientId: string,
  patch: Partial<MediaUploadRecord>,
) {
  setRecords((current) => current.map((record) => (record.clientId === clientId ? {...record, ...patch} : record)));
}

function formatDistance(meters: number): string {
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
}

function formatSpan(start: string | null, end: string | null): string {
  if (!start || !end) return "—";
  const hours = (Date.parse(end) - Date.parse(start)) / 3_600_000;
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 48) return `${hours.toFixed(1)} h`;
  return `${Math.round(hours / 24)} days`;
}

const PLACE_DETAIL_LABELS: Record<PlaceDetail, string> = {specific: "Exact", neighborhood: "Area", city: "Town", region: "Region"};
const SHORT_FRAME: Record<FrameId, string> = {portrait: "9:16", landscape: "16:9", square: "1:1"};

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export default function TripRecapPage() {
  const mapRef = useRef<MapPreviewHandle>(null);
  const activeUploadsRef = useRef(new Set<string>());
  const recordsRef = useRef<MediaUploadRecord[]>([]);
  const exportAbortRef = useRef<AbortController | null>(null);
  const [sessionId, setSessionId] = useState("");
  const [records, setRecords] = useState<MediaUploadRecord[]>([]);
  const [trip, setTrip] = useState<TripData | null>(null);
  const [keepAsOneTrip, setKeepAsOneTrip] = useState(true);
  const [returnToStart, setReturnToStart] = useState(false);
  const [startLocation, setStartLocation] = useState("");
  const [endLocation, setEndLocation] = useState("");
  const [styleId, setStyleId] = useState<MapStyleId>("dark");
  const [frame, setFrame] = useState<FrameId>("portrait");
  const [quality, setQuality] = useState<ExportQuality>(1080);
  const [fps, setFps] = useState<ExportFrameRate>(30);
  const [editingRoute, setEditingRoute] = useState(false);
  const [vehicle, setVehicle] = useState<Vehicle>(ARROW);
  const [placeDetail, setPlaceDetail] = useState<PlaceDetail>("neighborhood");
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(1);
  const [analyzing, setAnalyzing] = useState(false);
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);
  const [video, setVideo] = useState<{url: string; blob: Blob} | null>(null);
  const [exportSupported, setExportSupported] = useState(true);
  const [status, setStatus] = useState("");
  const [statusTone, setStatusTone] = useState<"neutral" | "success" | "error">("neutral");
  const [optionsOpen, setOptionsOpen] = useState(false);
  const exporting = exportProgress !== null;

  recordsRef.current = records;

  useEffect(() => {
    setSessionId(crypto.randomUUID());
    setExportSupported(canExportVideo());
  }, []);

  useEffect(() => {
    return () => {
      exportAbortRef.current?.abort();
      recordsRef.current.forEach((record) => {
        record.request?.abort();
        if (record.objectUrl) URL.revokeObjectURL(record.objectUrl);
      });
    };
  }, []);

  useEffect(() => () => {
    if (video) URL.revokeObjectURL(video.url);
  }, [video]);

  const clearResult = useCallback(() => {
    setTrip(null);
    setVideo(null);
  }, []);

  const startUpload = useCallback(
    (record: MediaUploadRecord) => {
      if (!sessionId || record.discarded || activeUploadsRef.current.has(record.clientId)) return;
      activeUploadsRef.current.add(record.clientId);
      updateRecord(setRecords, record.clientId, {status: "uploading", progress: 5, message: "Reading metadata…"});

      const request: UploadRequest = uploadMedia(sessionId, record.file, (progress) => {
        updateRecord(setRecords, record.clientId, {progress});
      });
      updateRecord(setRecords, record.clientId, {request});

      request.promise
        .then((uploaded) => {
          updateRecord(setRecords, record.clientId, {
            status: "uploaded",
            serverId: uploaded.id,
            progress: 100,
            message: "Ready",
            evidence: {capturedAt: uploaded.captured_at, hasGps: uploaded.has_gps},
          });
        })
        .catch((error: unknown) => {
          if (error instanceof Error && error.name === "AbortError") return;
          updateRecord(setRecords, record.clientId, {
            status: "failed",
            progress: 0,
            message: error instanceof Error ? error.message : "Could not read this file",
          });
          toast.error(`${record.file.name}: could not read metadata`);
        })
        .finally(() => {
          activeUploadsRef.current.delete(record.clientId);
        });
    },
    [sessionId],
  );

  useEffect(() => {
    if (!sessionId) return;
    const slots = Math.max(0, MAX_CONCURRENT_UPLOADS - activeUploadsRef.current.size);
    records.filter((record) => record.status === "queued" && !record.discarded).slice(0, slots).forEach(startUpload);
  }, [records, sessionId, startUpload]);

  const retryRecord = useCallback(
    (record: MediaUploadRecord) => {
      activeUploadsRef.current.delete(record.clientId);
      clearResult();
      updateRecord(setRecords, record.clientId, {...resetUploadForRetry(record), request: undefined});
      setStatus("");
      setStatusTone("neutral");
    },
    [clearResult],
  );

  const handleFiles = useCallback(
    (value: File | File[] | null) => {
      const files = value ? (Array.isArray(value) ? value : [value]) : [];
      if (!files.length) return;
      clearResult();
      const {accepted, rejected} = partitionFiles(files);
      const nextRecords: MediaUploadRecord[] = accepted.map((file) => ({
        clientId: crypto.randomUUID(),
        file,
        status: "queued",
        discarded: false,
        serverId: null,
        progress: 0,
        message: "Queued",
        objectUrl: URL.createObjectURL(file),
      }));
      setRecords((current) => [...current, ...nextRecords]);
      setStatus("");
      setStatusTone("neutral");
      if (rejected.length) {
        toast.error(`${rejected.map((file) => `"${file.name}"`).join(", ")} ${rejected.length === 1 ? "exceeds" : "exceed"} the ${MAX_FILE_LABEL} limit`);
      } else if (accepted.length) {
        toast.success(`${accepted.length} file${accepted.length === 1 ? "" : "s"} added`);
      }
    },
    [clearResult],
  );

  const discardRecord = useCallback(
    async (record: MediaUploadRecord) => {
      activeUploadsRef.current.delete(record.clientId);
      record.request?.abort();
      clearResult();
      if (record.objectUrl) URL.revokeObjectURL(record.objectUrl);
      setRecords((current) => current.filter((item) => item.clientId !== record.clientId));
      if (record.serverId && sessionId) await discardUploadedMedia(sessionId, record.serverId);
      setStatus("Removed. It will not be used for the route.");
      setStatusTone("success");
    },
    [clearResult, sessionId],
  );

  const retainedRecords = useMemo(
    () => records.filter((record) => !record.discarded && record.status === "uploaded" && record.serverId),
    [records],
  );
  const readyToAnalyze = canAnalyze(records);

  const analyze = useCallback(async () => {
    if (!sessionId || !readyToAnalyze) return;
    setAnalyzing(true);
    setStatus("Reading capture times and tracing your route…");
    setStatusTone("neutral");
    try {
      const response = await analyzeSession({
        session_id: sessionId,
        upload_ids: retainedRecords.map((record) => record.serverId as string),
        keep_as_one_trip: keepAsOneTrip,
        start_location: startLocation.trim() || null,
        end_location: returnToStart ? null : endLocation.trim() || null,
        return_to_start: returnToStart,
      });
      const nextTrip = response.trips[0];
      if (!nextTrip) throw new Error("No trip could be built from this media");
      setTrip(nextTrip);
      setVideo(null);
      window.scrollTo({top: 0});
      setStatus("Route ready. Style and place detail update without retracing.");
      setStatusTone("success");
      toast.success("Route traced from your media metadata");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Route analysis failed";
      setStatus(message);
      setStatusTone("error");
      toast.error(message);
    } finally {
      setAnalyzing(false);
    }
  }, [endLocation, keepAsOneTrip, readyToAnalyze, retainedRecords, returnToStart, sessionId, startLocation]);

  const refreshPlaces = useCallback(async (target: TripData, granularity: PlaceDetail) => {
    try {
      const apply = (places: Record<string, string>) =>
        setTrip((current) => {
          if (!current || current.id !== target.id) return current;
          return {
            ...current,
            place_names: places,
            observations: current.observations.map((observation) => ({...observation, place: places[observation.id] ?? observation.place})),
          };
        });
      const response = await fetchPlaces(target.id, granularity, apply);
      setTrip((current) => {
        if (!current || current.id !== target.id) return current;
        return {
          ...current,
          place_names: response.places,
          observations: current.observations.map((observation) => ({
            ...observation,
            place: response.places[observation.id] ?? "Unknown place",
          })),
        };
      });
    } catch {
      toast.error("Place labels could not be refreshed");
    }
  }, []);

  useEffect(() => {
    if (!trip) return;
    void refreshPlaces(trip, placeDetail);
  }, [placeDetail, refreshPlaces, trip?.id, trip?.observations.length]);

  const editStops = useCallback(
    async (stops: RouteStopInput[], message: string) => {
      if (!trip) return;
      setEditingRoute(true);
      setStatus("Re-tracing the route…");
      setStatusTone("neutral");
      try {
        const next = await updateStops(trip.id, stops);
        setTrip(next);
        setVideo(null);
        setStatus(message);
        setStatusTone("success");
      } catch (error: unknown) {
        const text = error instanceof Error ? error.message : "Could not update the route";
        setStatus(text);
        setStatusTone("error");
        toast.error(text);
      } finally {
        setEditingRoute(false);
      }
    },
    [trip],
  );

  const moveStop = useCallback(
    (index: number, delta: -1 | 1) => {
      if (!trip) return;
      const ids = trip.observations.map((item) => ({id: item.id}));
      const target = index + delta;
      if (target < 0 || target >= ids.length) return;
      [ids[index], ids[target]] = [ids[target], ids[index]];
      void editStops(ids, "Stops reordered.");
    },
    [editStops, trip],
  );

  const removeStop = useCallback(
    (index: number) => {
      if (!trip) return;
      void editStops(trip.observations.filter((_, i) => i !== index).map((item) => ({id: item.id})), "Stop removed from the route.");
    },
    [editStops, trip],
  );

  const addStop = useCallback(
    (query: string, position: number) => {
      if (!trip) return;
      const stops: RouteStopInput[] = trip.observations.map((item) => ({id: item.id}));
      stops.splice(Math.max(0, Math.min(position, stops.length)), 0, {query});
      void editStops(stops, "Place added to the route.");
    },
    [editStops, trip],
  );

  const renamePoint = useCallback(
    async (observationId: string, name: string) => {
      if (!trip) return;
      try {
        const next = await renameStop(trip.id, observationId, name);
        setTrip((current) => (current && current.id === next.id ? {...current, observations: current.observations.map((item) => ({...item, place: next.observations.find((o) => o.id === item.id)?.place ?? item.place}))} : current));
        if (!name.trim()) void refreshPlaces(next, placeDetail);
      } catch {
        toast.error("Could not rename that stop");
      }
    },
    [placeDetail, refreshPlaces, trip],
  );

  const requestExport = useCallback(async () => {
    if (!trip || exporting || analyzing) return;
    const controller = new AbortController();
    exportAbortRef.current = controller;
    setVideo(null);
    setExportProgress({stage: "preparing", frame: 0, frames: 0});
    setStatus("Rendering your recap in this browser…");
    setStatusTone("neutral");
    try {
      const blob = await exportRecapVideo(trip, {vehicle, styleId, frame, quality, fps, signal: controller.signal, onProgress: setExportProgress});
      setVideo({url: URL.createObjectURL(blob), blob});
      setStatus("MP4 ready to download.");
      setStatusTone("success");
      toast.success("MP4 recap is ready");
    } catch (error: unknown) {
      const cancelled = error instanceof DOMException && error.name === "AbortError";
      const message = cancelled ? "Export cancelled" : error instanceof Error ? error.message : "MP4 export failed";
      setStatus(message);
      setStatusTone(cancelled ? "neutral" : "error");
      if (!cancelled) toast.error(message);
    } finally {
      exportAbortRef.current = null;
      setExportProgress(null);
    }
  }, [analyzing, exporting, fps, frame, quality, styleId, trip, vehicle]);

  const jsonValues = useMemo<Record<JsonTab, unknown>>(
    () => ({trip: trip?.trip ?? null, route: trip?.route ?? null, timeline: trip?.timeline ?? null}),
    [trip],
  );

  const exportPercent = exportProgress?.frames ? Math.round((exportProgress.frame / exportProgress.frames) * 100) : 0;
  const busy = analyzing || exporting;

  const addFiles = (event: React.ChangeEvent<HTMLInputElement>) => {
    handleFiles(Array.from(event.target.files ?? []));
    event.target.value = "";
  };

  const summary = trip
    ? `${trip.summary.stop_count} stops · ${formatDistance(trip.summary.distance_meters)} · ${formatSpan(trip.summary.started_at, trip.summary.ended_at)} · ${trip.summary.gps_media_count}/${trip.summary.media_count} geotagged`
    : retainedRecords.length
      ? `${retainedRecords.length} of ${records.length} files read · build the route when ready`
      : "Photos and videos in, animated route map out";

  const buildButton = (
    <button type="button" id="analyze" className={trip ? "btn" : "btn primary"} disabled={!readyToAnalyze || busy} onClick={analyze}>
      {analyzing ? "Tracing route…" : trip ? "Rebuild route" : "Build route"}
    </button>
  );

  const routeOptions = (
    <div className="option-grid">
      <LocationAutocomplete id="start-point" label="Start point" value={startLocation} onChange={setStartLocation} placeholder="Auto · first GPS point" />
      <LocationAutocomplete id="end-point" label="End point" value={endLocation} onChange={setEndLocation} placeholder="Auto · last GPS point" isDisabled={returnToStart} />
      <Stack gap={2}>
        <CheckboxInput id="return-start" label="Return to the start" value={returnToStart} onChange={setReturnToStart} size="sm" />
        <CheckboxInput id="keep-one" label="Keep media together as one trip" value={keepAsOneTrip} onChange={setKeepAsOneTrip} size="sm" />
      </Stack>
    </div>
  );

  const exportText = exporting
    ? exportProgress?.stage === "preparing"
      ? "Loading map and media…"
      : exportProgress?.stage === "finishing"
        ? "Writing MP4…"
        : `Rendering ${exportPercent}%`
    : video
      ? `Ready · ${(video.blob.size / 1_048_576).toFixed(1)} MB`
      : `${exportDimensions(frame, quality).join("×")} · H.264 MP4`;

  return (
    <Theme theme={tripRecapTheme} mode="dark">
      <div className="studio">
        <header className="studio-head">
          <span className="studio-mark" aria-hidden="true">↗</span>
          <div className="studio-title">
            <h1>Trip Recap</h1>
            <p>{summary}</p>
          </div>
          <div className="studio-actions">
            <label className={busy ? "btn is-disabled" : "btn"}>
              Add media
              <input type="file" className="visually-hidden" accept={ACCEPTED_MEDIA} multiple disabled={busy} onChange={addFiles} />
            </label>
            {trip && buildButton}
          </div>
        </header>

        {trip ? (
          <>
            <div className="stage-holder">
              <MapPreview ref={mapRef} data={trip} styleId={styleId} frame={frame} vehicle={vehicle} playbackSpeed={playbackSpeed}>
                <Segmented label="Map" value={styleId} options={MAP_STYLE_IDS.map((id) => ({value: id, label: MAP_STYLES[id].label}))} onChange={setStyleId} />
                <Segmented label="Speed" value={playbackSpeed} options={SPEEDS.map((value) => ({value, label: value === 0.5 ? "½×" : `${value}×`}))} onChange={setPlaybackSpeed} />
                <Segmented label="Frame" value={frame} options={FRAME_IDS.map((id) => ({value: id, label: SHORT_FRAME[id] ?? FRAMES[id].label}))} onChange={setFrame} />
                <Segmented label="Marker" value={vehicle} options={VEHICLES.map((value) => ({value, label: value === ARROW ? "Arrow" : value}))} onChange={(value) => setVehicle(value as Vehicle)} />
              </MapPreview>
            </div>

            <div className="controls">
              {exporting ? (
                <button type="button" className="btn" onClick={() => exportAbortRef.current?.abort()}>Cancel</button>
              ) : (
                <button type="button" id="render" className="btn primary" disabled={busy || !exportSupported} onClick={requestExport}>Export video</button>
              )}
              <Segmented label="Quality" value={quality} options={EXPORT_QUALITIES.map((value) => ({value, label: `${value}p`}))} onChange={setQuality} isDisabled={exporting} />
              <Segmented label="FPS" value={fps} options={EXPORT_FRAME_RATES.map((value) => ({value, label: String(value)}))} onChange={setFps} isDisabled={exporting} />
              {exporting && <progress className="export-progress" max={100} value={exportPercent} aria-label="Export progress" />}
              <span className="exp-status" role="status">{exportText}</span>
              {video && (
                <button type="button" id="video-download" className="btn primary" onClick={() => download(video.blob, "trip-recap.mp4")}>Download MP4</button>
              )}
            </div>

            {!exportSupported && <p className="note status-error">This browser cannot encode video. Use a recent Chrome, Edge or Safari.</p>}
            {trip.route_error && <p className="note status-error">Routing note: {trip.route_error}</p>}
            {status && <p id="status" className={`note status-${statusTone}`} aria-live="polite">{status}</p>}

            <details className="drawer">
              <summary>Stops <span>{trip.observations.length}</span></summary>
              <div className="drawer-body">
                <StopEditor trip={trip} busy={busy || editingRoute} onMove={moveStop} onRemove={removeStop} onRename={renamePoint} onAdd={addStop} />
              </div>
            </details>

            <details className="drawer" open={optionsOpen} onToggle={(event) => setOptionsOpen((event.target as HTMLDetailsElement).open)}>
              <summary>Media &amp; options <span>{retainedRecords.length}</span></summary>
              <div className="drawer-body">
                <Segmented label="Place names" value={placeDetail} options={PLACE_DETAILS.map((value) => ({value, label: PLACE_DETAIL_LABELS[value]}))} onChange={setPlaceDetail} />
                {routeOptions}
                <MediaQueue records={records} onDiscard={discardRecord} onRetry={retryRecord} isDisabled={busy} />
                <div className="controls">
                  {(["trip", "route", "timeline"] as JsonTab[]).map((kind) => (
                    <button key={kind} type="button" className="btn small" onClick={() => download(new Blob([JSON.stringify(jsonValues[kind], null, 2)], {type: "application/json"}), kind === "route" ? "route.geojson" : `${kind}.json`)}>
                      {kind === "route" ? "route.geojson" : `${kind}.json`}
                    </button>
                  ))}
                </div>
              </div>
            </details>
          </>
        ) : (
          <section className="empty-stage" aria-label="Add media">
            <div className="empty-copy">
              <h2>Make a trip out of the camera roll.</h2>
              <p>Drop the photos and videos from a trip. Their GPS and capture times draw the route, then it plays as a map you can export.</p>
            </div>
            <div className="empty-drop">
              <FileInput
                className="editor-upload-input"
                isDisabled={busy}
                label="Trip photos and videos"
                isLabelHidden
                value={null}
                onChange={handleFiles}
                accept={ACCEPTED_MEDIA}
                isMultiple
                mode="dropzone"
                placeholder="Drop photos and videos, or choose files"
                description={`JPG, HEIC, PNG, WebP, MOV & MP4 · up to ${MAX_FILE_LABEL} each`}
              />
            </div>
            {records.length > 0 && (
              <div className="empty-setup">
                <MediaQueue records={records} onDiscard={discardRecord} onRetry={retryRecord} isDisabled={busy} />
                {routeOptions}
                <div className="controls">
                  {buildButton}
                  {status && <span id="status" className={`exp-status status-${statusTone}`} aria-live="polite">{status}</span>}
                </div>
              </div>
            )}
            <p className="note">Everything runs in this browser. Files never leave your device; only point coordinates go to the road router (OSRM) and place names (OpenStreetMap).</p>
          </section>
        )}
        <Toaster position="bottom-right" theme="dark" richColors closeButton />
      </div>
    </Theme>
  );
}
