"use client";

import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {
  AppShell,
  Badge,
  Button,
  Card,
  CheckboxInput,
  FileInput,
  Heading,
  ProgressBar,
  Selector,
  Stack,
  Text,
} from "@astryxdesign/core";
import {Toaster, toast} from "sonner";
import LocationAutocomplete from "@/components/trip-recap/LocationAutocomplete";
import MapPreview, {type MapPreviewHandle} from "@/components/trip-recap/MapPreview";
import MediaQueue, {type MediaUploadRecord} from "@/components/trip-recap/MediaQueue";
import {
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
  MAX_FILE_BYTES,
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
      if (record.serverId && sessionId) {
        try {
          await discardUploadedMedia(sessionId, record.serverId);
        } catch {
          toast.error(`Could not discard ${record.file.name} on the server`);
        }
      }
      if (record.objectUrl) URL.revokeObjectURL(record.objectUrl);
      setRecords((current) => current.filter((item) => item.clientId !== record.clientId));
      clearResult();
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
    setStatus("Extracting metadata and tracing the route in the container…");
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
    if (!trip || rendering) return;
    setRendering(true);
    setStatus("Starting MP4 render…");
    setStatusTone("neutral");
    try {
      let job: RenderJob = await startRender(trip.id);
      for (let attempt = 0; attempt < 120; attempt += 1) {
        setStatus(`Render ${job.status}…`);
        if (job.status === "complete") {
          setVideoHref(`/api/renders/${job.id}/video`);
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
  }, [rendering, trip]);

  const jsonValues = useMemo<Record<JsonTab, unknown>>(
    () => ({trip: trip?.trip ?? null, route: trip?.route ?? null, timeline: trip?.timeline ?? null}),
    [trip],
  );

  const renderClass = renderMode ? "render-only" : "";

  return (
    <AppShell height="auto" contentPadding={0} variant="section" className={`trip-app ${renderClass}`}>
      <div className="trip-page workspace-page">
        {!renderMode && (
          <header className="workspace-header">
            <a className="workspace-back" href="/">← INTRO</a>
            <div className="workspace-header-copy">
              <Text as="p" type="label" className="eyebrow">TRIP RECAP / WORKSPACE</Text>
              <Heading level={1}>Build the recap.</Heading>
              <Text as="p" type="supporting" color="secondary">
                Retain the evidence, set the route context, and inspect what the camera actually saw.
              </Text>
            </div>
            <Badge variant="purple" label="TEMPORARY" />
          </header>
        )}

        {!renderMode && !trip && (
          <section id="upload-card" className="upload-section" aria-labelledby="upload-title">
            <div className="section-rail"><Text as="p" type="label" className="eyebrow">01 / INTAKE</Text><Text as="p" type="supporting">Original files only</Text></div>
            <Card padding={5} className="upload-card-body">
              <Stack gap={4} className="upload-card-content">
                <Stack direction="horizontal" hAlign="between" vAlign="end" gap={4} wrap="wrap">
                  <div>
                    <Heading level={2} id="upload-title">Drop the trip here.</Heading>
                    <Text as="p" type="supporting" color="secondary">Max 25 MB per file · up to {MAX_CONCURRENT_UPLOADS} uploads in parallel.</Text>
                  </div>
                  <Badge label={`${records.length} selected`} variant={records.length ? "purple" : "neutral"} />
                </Stack>

                <div id="drop-zone" className="drop-zone-shell">
                  <FileInput
                    ref={fileInputRef}
                    label="Drop photos and videos from the trip"
                    isLabelHidden
                    value={records.map((record) => record.file)}
                    onChange={handleFiles}
                    accept={ACCEPTED_MEDIA}
                    isMultiple
                    mode="dropzone"
                    description="JPG, HEIC, PNG, MOV, MP4 and M4V are welcome. Uploads start immediately."
                    placeholder="Choose photos and videos"
                  />
                  <div className="drop-zone-caption"><span>DROP / CHOOSE</span><span>25 MB LIMIT</span></div>
                </div>

                <MediaQueue records={records} onDiscard={discardRecord} />

                <div className="controls-grid">
                  <LocationAutocomplete id="start-point" label="START POINT" value={startLocation} onChange={setStartLocation} placeholder="Auto · first GPS point" />
                  <LocationAutocomplete id="end-point" label="END POINT" value={endLocation} onChange={setEndLocation} placeholder="Auto · last GPS point" isDisabled={returnToStart} />
                  <CheckboxInput ref={(input) => { if (input) input.id = "return-start"; }} aria-label="End at start point" label="End at start point" value={returnToStart} onChange={setReturnToStart} size="sm" />
                  <CheckboxInput ref={(input) => { if (input) input.id = "keep-one"; }} aria-label="Treat as one trip" label="Treat as one trip" value={keepAsOneTrip} onChange={setKeepAsOneTrip} size="sm" />
                  <Selector id="vehicle" label="ANIMATION VEHICLE" options={VEHICLES.map(vehicleLabel)} value={vehicleLabel(vehicle)} onChange={(value) => setVehicle(VEHICLES.find((item) => vehicleLabel(item) === value) ?? "🛵")} width="100%" />
                  <label className="text-control"><span>PLACE-NAME DETAIL</span><select id="place-detail" value={placeDetail} onChange={(event) => setPlaceDetail(event.target.value as PlaceDetail)}><option value="specific">Specific</option><option value="neighborhood">Neighborhood</option><option value="city">City / Town</option><option value="region">Region</option></select></label>
                </div>

                <Button
                  id="analyze"
                  label={analyzing ? "Tracing route…" : "Determine route from retained media"}
                  variant="primary"
                  width="100%"
                  isDisabled={!readyToAnalyze || analyzing}
                  isLoading={analyzing}
                  onClick={analyze}
                />
                <Text id="status" as="p" type="supporting" className={`status-line status-${statusTone}`} aria-live="polite">{status || ""}</Text>
              </Stack>
            </Card>
          </section>
        )}

        {trip && (
          <section id="result" className="result-section" aria-labelledby="result-title">
            <div className="section-rail"><Text as="p" type="label" className="eyebrow">02 / RECAP</Text><Text as="p" type="supporting">A route reconstructed from retained evidence</Text></div>
            <Card padding={0} className="result-card">
              <div className="result-top">
                <Stack direction="horizontal" hAlign="between" vAlign="end" gap={4} wrap="wrap">
                  <div>
                    <Text as="p" type="label" className="eyebrow">ROUTE READY / {trip.id.slice(0, 8)}</Text>
                    <Heading level={2} id="result-title">The road between the frames.</Heading>
                    <Text id="trip-status" as="p" type="supporting" color="secondary">{trip.summary.gps_media_count} geotagged media · {trip.summary.stop_count} observed points · {trip.route ? "OSRM road routing" : "straight GPS fallback"}</Text>
                  </div>
                  <Stack direction="horizontal" hAlign="end" vAlign="center" gap={2} wrap="wrap">
                    <Badge label={trip.route ? "INFERRED ROAD" : "GPS FALLBACK"} variant={trip.route ? "success" : "warning"} />
                    <Button id="edit-inputs" label="Edit intake" variant="ghost" size="sm" onClick={clearResult} />
                  </Stack>
                </Stack>
                {trip.route_error && <Text as="p" type="supporting" className="status-error">Routing note: {trip.route_error}</Text>}
              </div>

              <div className="metrics-strip" aria-label="Trip summary">
                <div className="metric"><Text as="span" type="label">MEDIA</Text><Text id="m-media" as="span" type="body" weight="bold" hasTabularNumbers>{trip.summary.media_count}</Text></div>
                <div className="metric"><Text as="span" type="label">GPS MEDIA</Text><Text id="m-gps" as="span" type="body" weight="bold" hasTabularNumbers>{trip.summary.gps_media_count}</Text></div>
                <div className="metric"><Text as="span" type="label">OBSERVED POINTS</Text><Text id="m-stops" as="span" type="body" weight="bold" hasTabularNumbers>{trip.summary.stop_count}</Text></div>
                <div className="metric"><Text as="span" type="label">SEGMENTS</Text><Text id="m-segments" as="span" type="body" weight="bold" hasTabularNumbers>{trip.summary.segment_count}</Text></div>
                <div className="metric metric-accent"><Text as="span" type="label">ROUTE</Text><Text id="m-route" as="span" type="body" weight="bold" hasTabularNumbers>{formatDistance(trip.summary.distance_meters)}</Text></div>
              </div>

              <div className="presentation-row">
                <div className="map-panel">
                  <MapPreview ref={mapRef} data={trip} mapStyle={mapStyle} vehicle={vehicle} playbackSpeed={Number(playbackSpeed)} slowPoints={slowPoints} />
                  <div id="map-controls" className="map-controls">
                    <Button id="replay" label="Replay route" variant="primary" size="sm" onClick={() => mapRef.current?.replayRoute()} />
                    <Selector id="playback-speed" label="Playback speed" isLabelHidden options={["0.5×", "1×", "1.5×", "2×", "3×"]} value={`${playbackSpeed}×`} onChange={(value) => setPlaybackSpeed(value.replace("×", ""))} size="sm" variant="ghost" />
                    <CheckboxInput id="slow-points" label="Slow at image points" value={slowPoints} onChange={setSlowPoints} size="sm" />
                    <Selector id="map-style" label="Map style" isLabelHidden options={[...MAP_STYLES]} value={mapStyle} onChange={(value) => setMapStyle(value as MapStyle)} size="sm" variant="ghost" />
                    {trip && <Selector id="place-detail" label="Place-name detail" isLabelHidden options={PLACE_DETAILS.map(placeDetailLabel)} value={placeDetailLabel(placeDetail)} onChange={(value) => setPlaceDetail(PLACE_DETAILS.find((item) => placeDetailLabel(item) === value) ?? "neighborhood")} size="sm" variant="ghost" />}
                    <Button id="fit" label="Fit route" variant="secondary" size="sm" onClick={() => mapRef.current?.fitRoute(500)} />
                    <Button id="render" label={rendering ? "Rendering…" : "Export MP4"} variant="secondary" size="sm" isDisabled={rendering} isLoading={rendering} onClick={requestRender} />
                    {videoHref && <Button id="video-download" label="Download MP4" href={videoHref} variant="ghost" size="sm" />}
                  </div>
                </div>
              </div>

              <div className="result-details">
                <details className="evidence-details"><summary>Route points / observed vs inferred</summary><div className="details-body"><table><thead><tr><th>#</th><th>Place</th><th>Media</th><th>Captured</th><th>Latitude</th><th>Longitude</th></tr></thead><tbody id="observations-body">{trip.observations.map((observation) => <tr key={observation.id}><td>{observation.order}</td><td>{observation.place}</td><td>{observation.media_files.join(", ") || "Inferred endpoint"}</td><td>{formatDate(observation.arrival)}</td><td>{observation.latitude.toFixed(5)}</td><td>{observation.longitude.toFixed(5)}</td></tr>)}</tbody></table></div></details>
                <details className="evidence-details"><summary>View generated JSON</summary><div className="details-body"><div className="json-tabs">{(["trip", "route", "timeline"] as JsonTab[]).map((tab) => <Button key={tab} data-json={tab} label={`${tab === "trip" ? "trip.json" : tab === "route" ? "route.geojson" : "timeline.json"}`} variant={jsonTab === tab ? "primary" : "ghost"} size="sm" onClick={() => setJsonTab(tab)} />)}</div><pre id="json-view">{JSON.stringify(jsonValues[jsonTab], null, 2)}</pre></div></details>
                <details className="evidence-details"><summary>Optional downloads</summary><div className="details-body download-row">{(["trip", "route", "timeline"] as JsonTab[]).map((kind) => <Button key={kind} data-download={kind} label={`Download ${kind === "route" ? "route.geojson" : `${kind}.json`}`} variant="secondary" size="sm" onClick={() => { const blob = new Blob([JSON.stringify(jsonValues[kind], null, 2)], {type: "application/json"}); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = kind === "route" ? "route.geojson" : `${kind}.json`; link.click(); URL.revokeObjectURL(url); }} />)}</div></details>
              </div>
            </Card>
          </section>
        )}

        {!renderMode && <div className="trip-footer"><Text as="p" type="label" className="eyebrow">TRIP RECAP / {new Date().getFullYear()}</Text><Text as="p" type="supporting">Temporary processing. No gallery, no invented coordinates.</Text></div>}
      </div>
      <Toaster position="bottom-right" theme="dark" richColors closeButton={!renderMode} />
    </AppShell>
  );
}
