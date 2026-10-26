"use client";

import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {
  AppShell,
  Button,
  CheckboxInput,
  FileInput,
  Heading,
  ProgressBar,
  Selector,
  Stack,
  Tab,
  TabList,
  Text,
  Token,
} from "@astryxdesign/core";
import {Theme} from "@astryxdesign/core/theme";
import {tripRecapTheme} from "@/theme";
import {Toaster, toast} from "sonner";
import LocationAutocomplete from "@/components/trip-recap/LocationAutocomplete";
import MapPreview, {type MapPreviewHandle} from "@/components/trip-recap/MapPreview";
import MediaQueue, {type MediaUploadRecord} from "@/components/trip-recap/MediaQueue";
import {
  analyzeSession,
  discardUploadedMedia,
  fetchPlaces,
  uploadMedia,
  type UploadRequest,
} from "@/lib/trip-api";
import {canExportVideo, EXPORT_FPS, EXPORT_HEIGHT, EXPORT_MAX_SECONDS, EXPORT_WIDTH, exportRecapVideo, type ExportProgress} from "@/lib/recap-export";
import {
  MAX_CONCURRENT_UPLOADS,
  MAX_FILE_LABEL,
  canAnalyze,
  partitionFiles,
  resetUploadForRetry,
} from "@/lib/upload-queue";
import type {TripData} from "@/lib/trip-types";

const ACCEPTED_MEDIA = ".jpg,.jpeg,.heic,.heif,.png,.webp,.mov,.mp4,.m4v,image/*,video/*";
const MAP_STYLES = ["Street", "Satellite", "Hybrid"] as const;
const VEHICLES = ["🛵", "🚗", "🏍️", "🚲", "🚙"] as const;
const PLACE_DETAILS = ["specific", "neighborhood", "city", "region"] as const;
const STEPS = [
  {id: "Media", number: "01", title: "Media"},
  {id: "Route", number: "02", title: "Route"},
  {id: "Look", number: "03", title: "Look"},
  {id: "Export", number: "04", title: "Export"},
] as const;
type MapStyle = (typeof MAP_STYLES)[number];
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

function formatDate(value: string | null): string {
  if (!value) return "Not available";
  return new Date(value).toLocaleString([], {dateStyle: "medium", timeStyle: "short"});
}

function formatSpan(start: string | null, end: string | null): string {
  if (!start || !end) return "—";
  const hours = (Date.parse(end) - Date.parse(start)) / 3_600_000;
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 48) return `${hours.toFixed(1)} h`;
  return `${Math.round(hours / 24)} days`;
}

function vehicleLabel(value: Vehicle): string {
  const labels: Record<Vehicle, string> = {"🛵": "Scooter", "🚗": "Car", "🏍️": "Motorcycle", "🚲": "Bicycle", "🚙": "Jeep"};
  return labels[value];
}

function placeDetailLabel(value: PlaceDetail): string {
  const labels: Record<PlaceDetail, string> = {specific: "Specific", neighborhood: "Neighborhood", city: "City / Town", region: "Region"};
  return labels[value];
}

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
  const [mapStyle, setMapStyle] = useState<MapStyle>("Street");
  const [vehicle, setVehicle] = useState<Vehicle>("🛵");
  const [placeDetail, setPlaceDetail] = useState<PlaceDetail>("neighborhood");
  const [playbackSpeed, setPlaybackSpeed] = useState("1");
  const [slowPoints, setSlowPoints] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);
  const [video, setVideo] = useState<{url: string; blob: Blob} | null>(null);
  const [exportSupported, setExportSupported] = useState(true);
  const [status, setStatus] = useState("");
  const [statusTone, setStatusTone] = useState<"neutral" | "success" | "error">("neutral");
  const [step, setStep] = useState<string>("Media");
  const [jsonTab, setJsonTab] = useState<JsonTab>("trip");
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
      setStep("Media");
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
      setJsonTab("trip");
      setStep("Route");
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
      const response = await fetchPlaces(target.id, granularity);
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
  }, [placeDetail, refreshPlaces, trip?.id]);

  const requestExport = useCallback(async () => {
    if (!trip || exporting || analyzing) return;
    const controller = new AbortController();
    exportAbortRef.current = controller;
    setVideo(null);
    setExportProgress({stage: "preparing", frame: 0, frames: 0});
    setStatus("Rendering your recap in this browser…");
    setStatusTone("neutral");
    try {
      const blob = await exportRecapVideo(trip, {vehicle, signal: controller.signal, onProgress: setExportProgress});
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
  }, [analyzing, exporting, trip, vehicle]);

  const jsonValues = useMemo<Record<JsonTab, unknown>>(
    () => ({trip: trip?.trip ?? null, route: trip?.route ?? null, timeline: trip?.timeline ?? null}),
    [trip],
  );

  const exportPercent = exportProgress?.frames ? Math.round((exportProgress.frame / exportProgress.frames) * 100) : 0;
  const busy = analyzing || exporting;

  const uploadInput = (
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
  );

  return (
    <Theme theme={tripRecapTheme} mode="dark">
      <AppShell height="auto" contentPadding={0} variant="section" className="recap-editor">
        <Stack className="editor-shell" gap={0}>
          <Stack as="header" direction="horizontal" hAlign="between" vAlign="center" paddingInline={6} paddingBlock={3} className="editor-header">
            <Stack direction="horizontal" gap={3} vAlign="center">
              <Text className="editor-logo" aria-hidden="true">↗</Text>
              <Stack gap={0}>
                <Heading level={1}>Trip Recap</Heading>
                <Text className="eyebrow">camera roll → route</Text>
              </Stack>
            </Stack>
            <Stack direction="horizontal" gap={2} vAlign="center">
              <Token label="runs in your browser" color="teal" size="sm" />
              <Button href="https://github.com/kshitizwagle/trip-recap" label="Source" variant="ghost" size="sm" />
            </Stack>
          </Stack>

          <Stack direction="horizontal" gap={0} className="editor-body">
            <Stack as="aside" className="editor-sidebar" gap={0} aria-label="Recap settings">
              <TabList role="tablist" aria-label="Steps" value={step} onChange={setStep} layout="fill" size="sm" hasDivider>
                {STEPS.map((item) => (
                  <Tab key={item.id} id={`tab-${item.id}`} value={item.id} label={`${item.number} ${item.title}`} panelId={`panel-${item.id}`} />
                ))}
              </TabList>

              <Stack className="editor-settings" padding={5} gap={5} isScrollable>
                <Stack id="panel-Media" role="tabpanel" aria-labelledby="tab-Media" hidden={step !== "Media"} gap={5}>
                  <Stack gap={2}>
                    <Heading level={2}>Start with the camera roll</Heading>
                    <Text color="secondary">Add original photos and videos. Their GPS and capture times draw the route.</Text>
                  </Stack>
                  {uploadInput}
                  <MediaQueue records={records} onDiscard={discardRecord} onRetry={retryRecord} isDisabled={busy} />
                  <Stack className="editor-note" padding={4} gap={2}>
                    <Text className="eyebrow">private by design</Text>
                    <Text type="supporting">Files never leave this device. Only rounded coordinates go to the public road router and place-name service.</Text>
                  </Stack>
                </Stack>

                <Stack id="panel-Route" role="tabpanel" aria-labelledby="tab-Route" hidden={step !== "Route"} gap={5}>
                  <Stack gap={2}>
                    <Heading level={2}>Your route</Heading>
                    <Text color="secondary">The first and last GPS points are used by default. Change the endpoints only if you need to.</Text>
                  </Stack>
                  <LocationAutocomplete id="start-point" label="Start point (optional)" value={startLocation} onChange={setStartLocation} placeholder="Auto · first GPS point" />
                  <LocationAutocomplete id="end-point" label="End point (optional)" value={endLocation} onChange={setEndLocation} placeholder="Auto · last GPS point" isDisabled={returnToStart} />
                  <CheckboxInput id="return-start" label="Return to the start" value={returnToStart} onChange={setReturnToStart} size="sm" />
                  <CheckboxInput id="keep-one" label="Keep media together as one trip" value={keepAsOneTrip} onChange={setKeepAsOneTrip} size="sm" />
                  {trip ? (
                    <Stack gap={3}>
                      <Text className="eyebrow">{trip.summary.stop_count} observed points</Text>
                      <Stack as="ol" gap={0} className="editor-stops">
                        {trip.observations.map((observation) => (
                          <Stack as="li" key={observation.id} direction="horizontal" gap={3} paddingBlock={3}>
                            <Text className="editor-stop-number">{String(observation.order).padStart(2, "0")}</Text>
                            <Stack gap={1}>
                              <Text weight="medium">{observation.place}</Text>
                              <Text type="supporting">{observation.media_files.join(", ") || "Endpoint you entered"}</Text>
                              <Text type="supporting">{formatDate(observation.arrival)}</Text>
                            </Stack>
                          </Stack>
                        ))}
                      </Stack>
                    </Stack>
                  ) : (
                    <Text type="supporting">Build the route to see the points your media recorded.</Text>
                  )}
                </Stack>

                <Stack id="panel-Look" role="tabpanel" aria-labelledby="tab-Look" hidden={step !== "Look"} gap={5}>
                  <Stack gap={2}>
                    <Heading level={2}>Set the scene</Heading>
                    <Text color="secondary">These change the preview right away.</Text>
                  </Stack>
                  <Selector id="map-style" label="Map style" options={[...MAP_STYLES]} value={mapStyle} onChange={(value) => setMapStyle(value as MapStyle)} width="100%" />
                  <Selector id="place-detail" label="Place-name detail" options={PLACE_DETAILS.map(placeDetailLabel)} value={placeDetailLabel(placeDetail)} onChange={(value) => setPlaceDetail(PLACE_DETAILS.find((item) => placeDetailLabel(item) === value) ?? "neighborhood")} width="100%" />
                  <Selector id="vehicle" label="Vehicle" options={VEHICLES.map(vehicleLabel)} value={vehicleLabel(vehicle)} onChange={(value) => setVehicle(VEHICLES.find((item) => vehicleLabel(item) === value) ?? "🛵")} width="100%" />
                  <Selector id="playback-speed" label="Playback speed" options={["0.5×", "1×", "1.5×", "2×", "3×"]} value={`${playbackSpeed}×`} onChange={(value) => setPlaybackSpeed(value.replace("×", ""))} width="100%" />
                  <CheckboxInput id="slow-points" label="Slow down at photo stops" value={slowPoints} onChange={setSlowPoints} size="sm" />
                </Stack>

                <Stack id="panel-Export" role="tabpanel" aria-labelledby="tab-Export" hidden={step !== "Export"} gap={5}>
                  <Stack gap={2}>
                    <Heading level={2}>Take it with you</Heading>
                    <Text color="secondary">Render a vertical MP4 here in the browser, ready to share.</Text>
                  </Stack>
                  <Stack className="editor-note" padding={4} gap={1}>
                    <Text className="eyebrow">portrait · 9:16</Text>
                    <Text type="supporting">{EXPORT_WIDTH} × {EXPORT_HEIGHT} · {EXPORT_FPS} FPS · H.264 MP4 · up to {EXPORT_MAX_SECONDS} s</Text>
                    <Text type="supporting">Uses the saved timeline, the street map and your chosen vehicle. Keep this tab open while it renders.</Text>
                  </Stack>
                  {!exportSupported && <Text type="supporting" className="status-error">This browser cannot encode video. Use a recent Chrome, Edge or Safari.</Text>}
                  {exporting ? (
                    <Stack gap={3}>
                      <ProgressBar value={exportPercent} label="Export progress" variant="accent" />
                      <Text type="supporting">
                        {exportProgress?.stage === "preparing" ? "Loading map tiles and media…" : exportProgress?.stage === "finishing" ? "Writing the MP4…" : `Frame ${exportProgress?.frame} of ${exportProgress?.frames}`}
                      </Text>
                      <Button label="Cancel export" variant="secondary" width="100%" onClick={() => exportAbortRef.current?.abort()} />
                    </Stack>
                  ) : (
                    <Button id="render" label="Export MP4" variant="primary" width="100%" isDisabled={!trip || busy || !exportSupported} onClick={requestExport} />
                  )}
                  {!trip && <Text type="supporting">Build your route to unlock export.</Text>}
                  {video && (
                    <Stack gap={3}>
                      <video className="editor-result-video" src={video.url} controls playsInline muted aria-label="Exported recap" />
                      <Button id="video-download" label={`Download MP4 · ${(video.blob.size / 1_048_576).toFixed(1)} MB`} variant="primary" width="100%" onClick={() => download(video.blob, "trip-recap.mp4")} />
                    </Stack>
                  )}
                  {trip && (
                    <details className="editor-details">
                      <summary>Trip data downloads</summary>
                      <Stack paddingBlock={3} gap={2}>
                        {(["trip", "route", "timeline"] as JsonTab[]).map((kind) => (
                          <Button key={kind} label={`Download ${kind === "route" ? "route.geojson" : `${kind}.json`}`} variant="secondary" size="sm" onClick={() => download(new Blob([JSON.stringify(jsonValues[kind], null, 2)], {type: "application/json"}), kind === "route" ? "route.geojson" : `${kind}.json`)} />
                        ))}
                      </Stack>
                    </details>
                  )}
                </Stack>
              </Stack>

              <Stack as="footer" padding={5} gap={3} className="editor-sidebar-footer">
                <Text id="status" as="p" type="supporting" className={`status-${statusTone}`} aria-live="polite">{status}</Text>
                <Button id="analyze" label={analyzing ? "Tracing your route…" : trip ? "Rebuild route" : "Build route"} variant={trip ? "secondary" : "primary"} width="100%" isDisabled={!readyToAnalyze || busy} isLoading={analyzing} onClick={analyze} />
                <Text type="supporting">{retainedRecords.length} media ready · nothing uploaded</Text>
              </Stack>
            </Stack>

            <Stack as="section" className="editor-preview" gap={4} padding={6} aria-label="Trip preview">
              {trip && (
                <Stack direction="horizontal" gap={0} className="editor-stats" wrap="wrap">
                  {[
                    ["points", String(trip.summary.stop_count)],
                    ["distance", formatDistance(trip.summary.distance_meters)],
                    ["geotagged", `${trip.summary.gps_media_count} / ${trip.summary.media_count}`],
                    ["span", formatSpan(trip.summary.started_at, trip.summary.ended_at)],
                  ].map(([label, value]) => (
                    <Stack key={label} gap={1} className="editor-stat" padding={4}>
                      <Text className="eyebrow">{label}</Text>
                      <Text className="editor-stat-value">{value}</Text>
                    </Stack>
                  ))}
                </Stack>
              )}

              <Stack className="editor-stage" gap={0}>
                {trip ? (
                  <MapPreview ref={mapRef} data={trip} mapStyle={mapStyle} vehicle={vehicle} playbackSpeed={Number(playbackSpeed)} slowPoints={slowPoints} />
                ) : (
                  <Stack className="editor-empty" hAlign="center" vAlign="center" gap={6} padding={8}>
                    <Stack gap={3} hAlign="center" className="editor-empty-copy">
                      <Text className="eyebrow">trip recap</Text>
                      <Heading level={2}>Make a trip out of the camera roll.</Heading>
                      <Text color="secondary" justify="center">Drop the photos and videos from a day out. Their GPS and capture times draw the route, then it plays as a map you can export.</Text>
                    </Stack>
                    <Stack className="editor-empty-drop">{uploadInput}</Stack>
                    <Stack as="ol" direction="horizontal" gap={0} className="editor-empty-steps" wrap="wrap">
                      {[
                        ["01", "Add media", "Read on this device"],
                        ["02", "Build route", "Roads inferred between points"],
                        ["03", "Play & export", "Vertical MP4"],
                      ].map(([number, title, detail]) => (
                        <Stack as="li" key={number} gap={1} padding={4} className="editor-empty-step">
                          <Text className="editor-stop-number">{number}</Text>
                          <Text weight="medium">{title}</Text>
                          <Text type="supporting">{detail}</Text>
                        </Stack>
                      ))}
                    </Stack>
                  </Stack>
                )}
              </Stack>

              {trip && (
                <>
                  <Stack direction="horizontal" hAlign="between" vAlign="center" gap={3} wrap="wrap">
                    <Stack direction="horizontal" gap={2} vAlign="center" wrap="wrap">
                      <Button id="replay" label="Play route" icon={<Text aria-hidden="true">▶</Text>} variant="primary" size="sm" onClick={() => mapRef.current?.replayRoute()} />
                      <Button id="fit" label="Fit route" variant="ghost" size="sm" onClick={() => mapRef.current?.fitRoute(500)} />
                    </Stack>
                    <Stack direction="horizontal" gap={3} vAlign="center" className="editor-legend">
                      <Text type="supporting"><span className="legend-swatch legend-observed" aria-hidden="true" /> recorded point</Text>
                      <Text type="supporting"><span className="legend-swatch legend-inferred" aria-hidden="true" /> {trip.route ? "inferred road" : "straight line (no road found)"}</Text>
                    </Stack>
                  </Stack>
                  {trip.route_error && <Text type="supporting" className="status-error">Routing note: {trip.route_error}</Text>}
                  <details className="editor-details">
                    <summary>Inspect route evidence</summary>
                    <Stack gap={3} paddingBlock={3} isScrollable>
                      <table>
                        <thead><tr><th>Point</th><th>Media</th><th>Captured</th><th>Latitude</th><th>Longitude</th></tr></thead>
                        <tbody>
                          {trip.observations.map((observation) => (
                            <tr key={observation.id}>
                              <td>{observation.place}</td>
                              <td>{observation.media_files.join(", ") || "Endpoint you entered"}</td>
                              <td>{formatDate(observation.arrival)}</td>
                              <td>{observation.latitude.toFixed(5)}</td>
                              <td>{observation.longitude.toFixed(5)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <Stack direction="horizontal" gap={2}>
                        {(["trip", "route", "timeline"] as JsonTab[]).map((tab) => (
                          <Button key={tab} label={tab === "route" ? "route.geojson" : `${tab}.json`} variant={jsonTab === tab ? "primary" : "ghost"} size="sm" onClick={() => setJsonTab(tab)} />
                        ))}
                      </Stack>
                      <pre>{JSON.stringify(jsonValues[jsonTab], null, 2)}</pre>
                    </Stack>
                  </details>
                </>
              )}
            </Stack>
          </Stack>
        </Stack>
        <Toaster position="bottom-right" theme="dark" richColors closeButton />
      </AppShell>
    </Theme>
  );
}
