"use client";

import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {
  AppShell,
  Badge,
  Button,
  CheckboxInput,
  FileInput,
  Heading,
  Selector,
  Stack,
  Text,
  Tab,
  TabList,
  Token,
} from "@astryxdesign/core";
import {Theme} from "@astryxdesign/core/theme";
import {recapEditorTheme} from "@/theme";
import {Toaster, toast} from "sonner";
import LocationAutocomplete from "@/components/trip-recap/LocationAutocomplete";
import MapPreview, {type MapPreviewHandle} from "@/components/trip-recap/MapPreview";
import MediaQueue, {type MediaUploadRecord} from "@/components/trip-recap/MediaQueue";
import {
  apiUrl,
  discardUploadedMedia,
  analyzeSession,
  fetchPlaces,
  fetchRenderStatus,
  fetchTripData,
  startRender,
  uploadMedia,
  type UploadRequest,
} from "@/lib/trip-api";
import {
  MAX_CONCURRENT_UPLOADS,
  canAnalyze,
  partitionFiles,
} from "@/lib/upload-queue";
import type {RenderJob, TripData} from "@/lib/trip-types";

const ACCEPTED_MEDIA = ".jpg,.jpeg,.heic,.heif,.png,.webp,.mov,.mp4,.m4v,image/*,video/*";
const MAP_STYLES = ["Street", "Satellite", "Hybrid"] as const;
const VEHICLES = ["🛵", "🚗", "🏍️", "🚲", "🚙"] as const;
const PLACE_DETAILS = ["specific", "neighborhood", "city", "region"] as const;
type MapStyle = (typeof MAP_STYLES)[number];
type Vehicle = (typeof VEHICLES)[number];
type PlaceDetail = (typeof PLACE_DETAILS)[number];
type JsonTab = "trip" | "route" | "timeline";

declare global {
  interface Window {
    tripData?: TripData["trip"] | null;
    routeData?: TripData["route"];
    timelineData?: TripData["timeline"];
  }
}

function updateRecord(
  setRecords: React.Dispatch<React.SetStateAction<MediaUploadRecord[]>>,
  clientId: string,
  patch: Partial<MediaUploadRecord>,
) {
  setRecords((current) =>
    current.map((record) =>
      record.clientId === clientId ? {...record, ...patch} : record,
    ),
  );
}

function formatDistance(meters: number): string {
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
}

function formatDate(value: string | null): string {
  if (!value) return "Not available";
  return new Date(value).toLocaleString([], {dateStyle: "medium", timeStyle: "short"});
}

function vehicleLabel(value: Vehicle): string {
  const labels: Record<Vehicle, string> = {
    "🛵": "Scooter",
    "🚗": "Car",
    "🏍️": "Motorcycle",
    "🚲": "Bicycle",
    "🚙": "Jeep",
  };
  return labels[value];
}

function placeDetailLabel(value: PlaceDetail): string {
  const labels: Record<PlaceDetail, string> = {
    specific: "Specific",
    neighborhood: "Neighborhood",
    city: "City / Town",
    region: "Region",
  };
  return labels[value];
}

export default function TripRecapPage() {
  const mapRef = useRef<MapPreviewHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const activeUploadsRef = useRef(new Set<string>());
  const recordsRef = useRef<MediaUploadRecord[]>([]);
  const [sessionId, setSessionId] = useState("");
  const [records, setRecords] = useState<MediaUploadRecord[]>([]);
  const [trip, setTrip] = useState<TripData | null>(null);
  const [renderMode, setRenderMode] = useState(false);
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
  const [rendering, setRendering] = useState(false);
  const [videoHref, setVideoHref] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [statusTone, setStatusTone] = useState<"neutral" | "success" | "error">("neutral");
  const [editorTab, setEditorTab] = useState("Media");
  const [jsonTab, setJsonTab] = useState<JsonTab>("trip");

  recordsRef.current = records;

  useEffect(() => {
    setSessionId(crypto.randomUUID());
    setRenderMode(new URLSearchParams(window.location.search).get("render") === "1");
    if (fileInputRef.current) fileInputRef.current.id = "file-input";
  }, []);

  useEffect(() => {
    return () => {
      recordsRef.current.forEach((record) => {
        record.request?.abort();
        if (record.objectUrl) URL.revokeObjectURL(record.objectUrl);
      });
    };
  }, []);

  const clearResult = useCallback(() => {
    setTrip(null);
    setVideoHref(null);
    window.tripReady = false;
  }, []);

  const startUpload = useCallback(
    (record: MediaUploadRecord) => {
      if (!sessionId || record.discarded || activeUploadsRef.current.has(record.clientId)) return;
      activeUploadsRef.current.add(record.clientId);
      updateRecord(setRecords, record.clientId, {status: "uploading", progress: 1, message: "Uploading…"});

      const request: UploadRequest = uploadMedia(sessionId, record.file, (progress) => {
        updateRecord(setRecords, record.clientId, {progress, message: `${Math.round(progress)}% uploaded`});
      });
      updateRecord(setRecords, record.clientId, {request});

      request.promise
        .then((uploaded) => {
          updateRecord(setRecords, record.clientId, {
            status: "uploaded",
            serverId: uploaded.id,
            progress: 100,
            message: "Retained · ready for analysis",
          });
        })
        .catch((error: unknown) => {
          if (error instanceof Error && error.name === "AbortError") return;
          updateRecord(setRecords, record.clientId, {
            status: "failed",
            progress: 0,
            message: error instanceof Error ? error.message : "Upload failed",
          });
          toast.error(`${record.file.name}: upload failed`);
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
    records
      .filter((record) => record.status === "queued" && !record.discarded)
      .slice(0, slots)
      .forEach(startUpload);
  }, [records, sessionId, startUpload]);

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

      if (rejected.length) {
        setStatus("");
        setStatusTone("neutral");
        toast.error(`${rejected.map((file) => `"${file.name}"`).join(", ")} ${rejected.length === 1 ? "exceeds" : "exceed"} the 25 MB limit`);
      } else if (accepted.length) {
        setStatus("");
        setStatusTone("neutral");
        toast.success(`${accepted.length} file${accepted.length === 1 ? "" : "s"} queued for upload`);
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
      if (record.serverId && sessionId) {
        try {
          await discardUploadedMedia(sessionId, record.serverId);
        } catch {
          toast.error(`Could not discard ${record.file.name} on the server`);
        }
      }
      setStatus("Media discarded. It will not be used for route analysis.");
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
      if (!nextTrip) throw new Error("No trip could be built from the retained media");
      setTrip(nextTrip);
      setVideoHref(null);
      setJsonTab("trip");
      setStatus("Route ready. Change map style or place detail without retracing.");
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

  useEffect(() => {
    const tripId = new URLSearchParams(window.location.search).get("trip_id");
    if (!tripId) return;
    void fetchTripData(tripId)
      .then((loadedTrip) => setTrip(loadedTrip))
      .catch(() => toast.error("That trip could not be loaded"));
  }, []);

  useEffect(() => {
    window.tripData = trip?.trip ?? null;
    window.routeData = trip?.route ?? null;
    window.timelineData = trip?.timeline ?? null;
    if (!trip) window.tripReady = false;
  }, [trip]);

  const requestRender = useCallback(async () => {
    if (!trip || rendering || analyzing) return;
    setRendering(true);
    setStatus("Starting MP4 render…");
    setStatusTone("neutral");
    try {
      let job: RenderJob = await startRender(trip.id);
      for (let attempt = 0; attempt < 120; attempt += 1) {
        setStatus(`Render ${job.status}…`);
        if (job.status === "complete") {
          setVideoHref(apiUrl(`/api/renders/${job.id}/video`));
          setStatus("MP4 ready to download.");
          setStatusTone("success");
          toast.success("MP4 recap is ready");
          return;
        }
        if (job.status === "failed") throw new Error(job.error || "MP4 render failed");
        await new Promise((resolve) => setTimeout(resolve, 2000));
        job = await fetchRenderStatus(job.id);
      }
      throw new Error("Render timed out while waiting for the worker");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "MP4 render failed";
      setStatus(message);
      setStatusTone("error");
      toast.error(message);
    } finally {
      setRendering(false);
    }
  }, [analyzing, rendering, trip]);

  const jsonValues = useMemo<Record<JsonTab, unknown>>(
    () => ({trip: trip?.trip ?? null, route: trip?.route ?? null, timeline: trip?.timeline ?? null}),
    [trip],
  );

  return (
    <Theme theme={recapEditorTheme} mode="dark">
      <AppShell height="auto" contentPadding={0} variant="section" className={`recap-editor ${renderMode ? "render-only" : ""}`}>
        <Stack className="editor-shell" gap={0}>
          {!renderMode && (
            <Stack as="header" direction="horizontal" hAlign="between" vAlign="center" paddingInline={6} paddingBlock={4} className="editor-header">
              <Stack direction="horizontal" gap={3} vAlign="center">
                <Text className="editor-logo" aria-hidden="true">↗</Text>
                <Heading level={1}>Trip Recap</Heading>
                <Text className="editor-header-label" color="secondary">Travel map studio</Text>
              </Stack>
              <Button href="/" label="← Home" variant="ghost" size="sm" />
            </Stack>
          )}
          <Stack direction="horizontal" gap={0} className="editor-body">
            {!renderMode && (
              <Stack as="aside" className="editor-sidebar" gap={0} aria-label="Recap settings">
                <Stack padding={5} gap={3}>
                  <Button id="replay" label="Play route" icon={<Text aria-hidden="true">▶</Text>} variant="primary" size="lg" width="100%" isDisabled={!trip} onClick={() => mapRef.current?.replayRoute()} />
                </Stack>
                <TabList role="tablist" aria-label="Editor settings" value={editorTab} onChange={setEditorTab} layout="fill" size="sm" hasDivider>
                  {["Media", "Route", "Style", "Animation", "Export"].map((tab) => (
                    <Tab key={tab} id={`tab-${tab}`} value={tab} label={tab} panelId={`panel-${tab}`} />
                  ))}
                </TabList>
                <Stack className="editor-settings" padding={5} gap={5} isScrollable>
                  <Stack id="panel-Media" role="tabpanel" aria-labelledby="tab-Media" hidden={editorTab !== "Media"} gap={5}>
                    <Stack gap={2}>
                      <Heading level={2}>Every trip starts with a memory.</Heading>
                      <Text color="secondary">Add your original photos and videos. Their GPS and capture times bring your journey to life.</Text>
                    </Stack>
                    <FileInput isDisabled={analyzing || rendering} ref={fileInputRef} label="Trip photos and videos" isLabelHidden value={records.map((record) => record.file)} onChange={handleFiles} accept={ACCEPTED_MEDIA} isMultiple mode="dropzone" placeholder="Drop or choose your media" description="JPG, HEIC, PNG, MOV & MP4 · up to 25 MB each" />
                    <MediaQueue records={records} onDiscard={discardRecord} isDisabled={analyzing || rendering} />
                    <Stack className="editor-note" padding={4} gap={2}>
                      <Text weight="medium">Your camera roll knows the way</Text>
                      <Text type="supporting">No need to enter destinations. Missing GPS or capture times stay unknown. Roads between recorded points are inferred.</Text>
                    </Stack>
                  </Stack>
                  <Stack id="panel-Route" role="tabpanel" aria-labelledby="tab-Route" hidden={editorTab !== "Route"} gap={5}>
                    <Stack gap={2}>
                      <Heading level={2}>Your route</Heading>
                      <Text color="secondary">We use the first and last GPS points by default. Adjust the endpoints only if you need to.</Text>
                    </Stack>
                    <LocationAutocomplete id="start-point" label="Start point (optional)" value={startLocation} onChange={setStartLocation} placeholder="Auto · first GPS point" />
                    <LocationAutocomplete id="end-point" label="End point (optional)" value={endLocation} onChange={setEndLocation} placeholder="Auto · last GPS point" isDisabled={returnToStart} />
                    <CheckboxInput id="return-start" label="Return to the start" value={returnToStart} onChange={setReturnToStart} size="sm" />
                    <CheckboxInput id="keep-one" label="Keep media together as one trip" value={keepAsOneTrip} onChange={setKeepAsOneTrip} size="sm" />
                    <Text type="supporting">Use Build route below to apply route changes.</Text>
                    {trip && <Stack gap={3}>
                      <Text weight="semibold">{trip.summary.stop_count} observed points</Text>
                      <Stack as="ol" gap={0} className="editor-stops">
                        {trip.observations.map((observation) => <Stack as="li" key={observation.id} paddingBlock={3} gap={1}>
                          <Text weight="medium">{observation.order}. {observation.place}</Text>
                          <Text type="supporting">{observation.media_files.join(", ") || "Inferred endpoint"}</Text>
                          <Text type="supporting">{formatDate(observation.arrival)}</Text>
                        </Stack>)}
                      </Stack>
                    </Stack>}
                  </Stack>
                  <Stack id="panel-Style" role="tabpanel" aria-labelledby="tab-Style" hidden={editorTab !== "Style"} gap={5}>
                    <Stack gap={2}><Heading level={2}>Set the scene</Heading><Text color="secondary">Choose the backdrop for your browser preview.</Text></Stack>
                    <Selector id="map-style" label="Map style" options={[...MAP_STYLES]} value={mapStyle} onChange={(value) => setMapStyle(value as MapStyle)} width="100%" />
                    <Selector id="place-detail" label="Place-name detail" options={PLACE_DETAILS.map(placeDetailLabel)} value={placeDetailLabel(placeDetail)} onChange={(value) => setPlaceDetail(PLACE_DETAILS.find((item) => placeDetailLabel(item) === value) ?? "neighborhood")} width="100%" />
                    <Text type="supporting">Street shows roads and landmarks. Satellite shows imagery. Hybrid combines both.</Text>
                  </Stack>
                  <Stack id="panel-Animation" role="tabpanel" aria-labelledby="tab-Animation" hidden={editorTab !== "Animation"} gap={5}>
                    <Stack gap={2}><Heading level={2}>Make it move</Heading><Text color="secondary">Fine-tune how your journey plays in the preview.</Text></Stack>
                    <Selector id="vehicle" label="Animation vehicle" options={VEHICLES.map(vehicleLabel)} value={vehicleLabel(vehicle)} onChange={(value) => setVehicle(VEHICLES.find((item) => vehicleLabel(item) === value) ?? "🛵")} width="100%" />
                    <Selector id="playback-speed" label="Playback speed" options={["0.5×", "1×", "1.5×", "2×", "3×"]} value={`${playbackSpeed}×`} onChange={(value) => setPlaybackSpeed(value.replace("×", ""))} width="100%" />
                    <CheckboxInput id="slow-points" label="Slow down at photo stops" value={slowPoints} onChange={setSlowPoints} size="sm" />
                    <Text type="supporting">Press Play route to replay with your settings.</Text>
                  </Stack>
                  <Stack id="panel-Export" role="tabpanel" aria-labelledby="tab-Export" hidden={editorTab !== "Export"} gap={5}>
                    <Stack gap={2}><Heading level={2}>Take your trip with you</Heading><Text color="secondary">Render your recap as a vertical MP4, ready to share.</Text></Stack>
                    <Stack className="editor-note" padding={4} gap={2}>
                      <Text weight="medium">Portrait · 9:16</Text>
                      <Text type="supporting">1080 × 1920 · 30 FPS · MP4</Text>
                      <Text type="supporting">Export uses the saved timeline and default map appearance. Preview style and playback settings apply only in this editor.</Text>
                    </Stack>
                    <Button id="render" label={rendering ? "Rendering your recap…" : "Export MP4"} variant="primary" width="100%" isDisabled={!trip || rendering || analyzing} isLoading={rendering} onClick={requestRender} />
                    {!trip && <Text type="supporting">Add media and build your route to unlock export.</Text>}
                    {videoHref && <Button id="video-download" label="Download MP4" href={videoHref} width="100%" />}
                    {trip && <details className="editor-details"><summary>Trip data downloads</summary><Stack paddingBlock={3} gap={2}>
                      {(["trip", "route", "timeline"] as JsonTab[]).map((kind) => <Button key={kind} label={`Download ${kind === "route" ? "route.geojson" : `${kind}.json`}`} variant="secondary" size="sm" onClick={() => { const blob = new Blob([JSON.stringify(jsonValues[kind], null, 2)], {type: "application/json"}); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = kind === "route" ? "route.geojson" : `${kind}.json`; link.click(); URL.revokeObjectURL(url); }} />)}
                    </Stack></details>}
                  </Stack>
                </Stack>
                <Stack as="footer" padding={5} gap={3} className="editor-sidebar-footer">
                  <Text id="status" as="p" type="supporting" className={`status-${statusTone}`} aria-live="polite">{status}</Text>
                  <Button id="analyze" label={analyzing ? "Tracing your route…" : trip ? "Rebuild route" : "Build route"} variant="secondary" width="100%" isDisabled={!readyToAnalyze || analyzing || rendering} isLoading={analyzing} onClick={analyze} />
                  <Stack direction="horizontal" hAlign="between" vAlign="center" gap={2}>
                    <Badge label={`${retainedRecords.length} media ready`} variant="neutral" />
                    <Text type="supporting">Temporary processing</Text>
                  </Stack>
                </Stack>
              </Stack>
            )}
            <Stack as="section" className="editor-preview" gap={4} padding={6} aria-label="Trip preview">
              {!renderMode && <Stack direction="horizontal" hAlign="between" vAlign="center" gap={3} wrap="wrap">
                <Stack gap={1}><Text weight="semibold">Your journey, in motion</Text><Text type="supporting">{trip ? `${trip.summary.stop_count} points · ${formatDistance(trip.summary.distance_meters)} · ${trip.summary.gps_media_count} geotagged media` : "From camera roll to the road ahead"}</Text></Stack>
                <Token label={trip ? (trip.route ? "Inferred road" : "GPS fallback") : "Preview"} color={trip ? "teal" : "purple"} size="sm" />
              </Stack>}
              <Stack className="editor-stage" gap={0}>
                {trip ? <MapPreview ref={mapRef} data={trip} mapStyle={mapStyle} vehicle={vehicle} playbackSpeed={Number(playbackSpeed)} slowPoints={slowPoints} /> : (
                  <Stack className="editor-empty" hAlign="center" vAlign="center" gap={4} padding={6}>
                    <Text className="editor-empty-icon" aria-hidden="true">⌁</Text>
                    <Stack gap={2} hAlign="center">
                      <Heading level={2}>Your map starts here</Heading>
                      <Text color="secondary" justify="center">Add photos and videos, then build your route.<br />We’ll connect the places you captured.</Text>
                    </Stack>
                    <Text type="supporting">01 Add media　 →　 02 Build route　 →　 03 Play</Text>
                  </Stack>
                )}
              </Stack>
              {!renderMode && <>
                <Stack direction="horizontal" hAlign="between" vAlign="center" gap={3} wrap="wrap">
                  <Text type="supporting">{trip ? "Recorded GPS points · inferred connections" : "Real memories. A route drawn from your metadata."}</Text>
                  <Button id="fit" label="Fit route" variant="ghost" size="sm" isDisabled={!trip} onClick={() => mapRef.current?.fitRoute(500)} />
                </Stack>
                {trip?.route_error && <Text type="supporting" className="status-error">Routing note: {trip.route_error}</Text>}
                {trip && <details className="editor-details"><summary>Inspect route evidence</summary><Stack gap={3} paddingBlock={3} isScrollable>
                  <table><thead><tr><th>Point</th><th>Media</th><th>Captured</th><th>Latitude</th><th>Longitude</th></tr></thead><tbody>{trip.observations.map((observation) => <tr key={observation.id}><td>{observation.place}</td><td>{observation.media_files.join(", ") || "Inferred endpoint"}</td><td>{formatDate(observation.arrival)}</td><td>{observation.latitude.toFixed(5)}</td><td>{observation.longitude.toFixed(5)}</td></tr>)}</tbody></table>
                  <Stack direction="horizontal" gap={2}>{(["trip", "route", "timeline"] as JsonTab[]).map((tab) => <Button key={tab} label={tab === "route" ? "route.geojson" : `${tab}.json`} variant={jsonTab === tab ? "primary" : "ghost"} size="sm" onClick={() => setJsonTab(tab)} />)}</Stack>
                  <pre>{JSON.stringify(jsonValues[jsonTab], null, 2)}</pre>
                </Stack></details>}
              </>}
            </Stack>
          </Stack>
        </Stack>
        {!renderMode && <Toaster position="bottom-right" theme="dark" richColors closeButton />}
      </AppShell>
    </Theme>
  );
}
