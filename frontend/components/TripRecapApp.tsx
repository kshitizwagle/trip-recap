'use client';

import {
  ChangeEvent,
  DragEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Toaster, toast } from 'sonner';
import LocationAutocomplete from '@/components/LocationAutocomplete';
import MapPreview from '@/components/MapPreview';
import {
  humanSize,
  MAX_FILE_BYTES,
  readApiResponse,
  UPLOAD_CHUNK_BYTES,
  UPLOAD_CHUNK_RETRIES,
} from '@/lib/api';
import type { TripPayload, UploadRecord } from '@/lib/types';

const MAX_CONCURRENT_UPLOADS = 4;

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export default function TripRecapApp({
  renderOnly = false,
}: {
  renderOnly?: boolean;
}) {
  const [sessionId] = useState(() => crypto.randomUUID());
  const [uploads, setUploads] = useState<UploadRecord[]>([]);
  const uploadsRef = useRef<UploadRecord[]>([]);
  const activeUploadsRef = useRef(0);
  const queueRef = useRef<string[]>([]);
  const pumpQueueRef = useRef<() => void>(() => {});
  const [current, setCurrent] = useState<TripPayload | null>(null);
  const [startLocation, setStartLocation] = useState<string | null>(null);
  const [endLocation, setEndLocation] = useState<string | null>(null);
  const [returnToStart, setReturnToStart] = useState(false);
  const [keepOne, setKeepOne] = useState(true);
  const [vehicle, setVehicle] = useState('🛵');
  const [placeDetail, setPlaceDetail] = useState('neighborhood');
  const [mapStyle, setMapStyle] =
    useState<'Street' | 'Satellite' | 'Hybrid'>('Street');
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [slowAtPoints, setSlowAtPoints] = useState(true);
  const [replayToken, setReplayToken] = useState(0);
  const [fitToken, setFitToken] = useState(0);
  const [jsonTab, setJsonTab] =
    useState<'trip' | 'route' | 'timeline'>('trip');
  const [busy, setBusy] = useState(false);
  const [renderBusy, setRenderBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    uploadsRef.current = uploads;
  }, [uploads]);

  const mutateUpload = useCallback(
    (clientId: string, patch: Partial<UploadRecord>) => {
      setUploads((items) =>
        items.map((item) =>
          item.clientId === clientId ? { ...item, ...patch } : item,
        ),
      );
    },
    [],
  );

  const removeUploadLocal = useCallback((clientId: string) => {
    setUploads((items) => {
      const record = items.find((item) => item.clientId === clientId);
      if (record?.objectUrl) URL.revokeObjectURL(record.objectUrl);
      return items.filter((item) => item.clientId !== clientId);
    });
    queueRef.current = queueRef.current.filter((id) => id !== clientId);
  }, []);

  const uploadChunkWithRetry = useCallback(
    async (
      record: UploadRecord,
      uploadId: string,
      chunkIndex: number,
      totalChunks: number,
    ) => {
      const start = chunkIndex * UPLOAD_CHUNK_BYTES;
      const end = Math.min(
        record.file.size,
        start + UPLOAD_CHUNK_BYTES,
      );
      const chunk = record.file.slice(start, end);
      let lastError: Error | null = null;

      for (
        let attempt = 1;
        attempt <= UPLOAD_CHUNK_RETRIES;
        attempt += 1
      ) {
        try {
          const response = await fetch(
            `/api/upload-sessions/${sessionId}/media/${uploadId}/chunks/${chunkIndex}`,
            {
              method: 'PUT',
              headers: {
                'Content-Type': 'application/octet-stream',
              },
              body: chunk,
              signal: record.controller?.signal,
            },
          );
          if (!response.ok) {
            const parsed = await readApiResponse<unknown>(response);
            throw new Error(
              parsed.detail ||
                `Chunk upload failed · HTTP ${response.status}`,
            );
          }

          const progress = record.file.size
            ? (end / record.file.size) * 100
            : 100;
          mutateUpload(record.clientId, {
            progress,
            progressText:
              `Uploading chunk ${chunkIndex + 1}/${totalChunks} · ` +
              `${Math.round(progress)}%`,
          });
          return;
        } catch (error) {
          const err = error as Error;
          if (err.name === 'AbortError') throw err;
          lastError = err;

          if (attempt < UPLOAD_CHUNK_RETRIES) {
            mutateUpload(record.clientId, {
              progress: record.file.size
                ? (start / record.file.size) * 100
                : 0,
              progressText:
                `Retrying chunk ${chunkIndex + 1} · attempt ` +
                `${attempt + 1}/${UPLOAD_CHUNK_RETRIES}`,
            });
            await sleep(350 * attempt);
          }
        }
      }

      throw lastError ?? new Error('Chunk upload failed');
    },
    [mutateUpload, sessionId],
  );

  const uploadRecord = useCallback(
    async (clientId: string) => {
      const record = uploadsRef.current.find(
        (item) => item.clientId === clientId,
      );
      if (!record) return;

      activeUploadsRef.current += 1;
      const controller = new AbortController();
      const liveRecord = { ...record, controller };

      mutateUpload(clientId, {
        status: 'uploading',
        controller,
        progress: 1,
        progressText: 'Preparing chunked upload…',
      });

      try {
        const initResponse = await fetch(
          `/api/upload-sessions/${sessionId}/media/init`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              filename: record.file.name,
              size_bytes: record.file.size,
              chunk_size_bytes: UPLOAD_CHUNK_BYTES,
            }),
            signal: controller.signal,
          },
        );
        const initParsed = await readApiResponse<{
          id: string;
          total_chunks: number;
        }>(initResponse);

        if (!initParsed.ok || !initParsed.data) {
          throw new Error(
            initParsed.detail || 'Could not start upload',
          );
        }

        const uploadId = initParsed.data.id;
        mutateUpload(clientId, { serverId: uploadId });
        liveRecord.serverId = uploadId;

        for (
          let chunkIndex = 0;
          chunkIndex < initParsed.data.total_chunks;
          chunkIndex += 1
        ) {
          await uploadChunkWithRetry(
            liveRecord,
            uploadId,
            chunkIndex,
            initParsed.data.total_chunks,
          );
        }

        mutateUpload(clientId, {
          progress: 100,
          progressText: 'Finalizing upload…',
        });

        const completeResponse = await fetch(
          `/api/upload-sessions/${sessionId}/media/${uploadId}/complete`,
          {
            method: 'POST',
            signal: controller.signal,
          },
        );
        const completeParsed = await readApiResponse<{
          stored_bytes: number;
        }>(completeResponse);

        if (!completeParsed.ok || !completeParsed.data) {
          throw new Error(
            completeParsed.detail || 'Could not finalize upload',
          );
        }

        mutateUpload(clientId, {
          status: 'uploaded',
          progress: 100,
          progressText:
            `Uploaded · ` +
            `${humanSize(
              completeParsed.data.stored_bytes ||
                record.file.size,
            )} temporary`,
        });
      } catch (error) {
        const err = error as Error;
        if (err.name !== 'AbortError') {
          mutateUpload(clientId, {
            status: 'failed',
            progress: 0,
            progressText: err.message,
            error: err.message,
          });
          toast.error(
            `Upload failed: ${record.file.name}`,
            { description: err.message },
          );
        }

        const uploadId = liveRecord.serverId;
        if (uploadId) {
          try {
            await fetch(
              `/api/upload-sessions/${sessionId}/media/${uploadId}`,
              { method: 'DELETE' },
            );
          } catch {}
        }
        mutateUpload(clientId, { serverId: null });
      } finally {
        activeUploadsRef.current = Math.max(
          0,
          activeUploadsRef.current - 1,
        );
        pumpQueueRef.current();
      }
    },
    [
      mutateUpload,
      sessionId,
      uploadChunkWithRetry,
    ],
  );

  const pumpQueue = useCallback(() => {
    while (
      activeUploadsRef.current <
        MAX_CONCURRENT_UPLOADS &&
      queueRef.current.length
    ) {
      const nextId = queueRef.current.shift();
      if (!nextId) continue;

      const record = uploadsRef.current.find(
        (item) => item.clientId === nextId,
      );
      if (!record || record.status !== 'queued') continue;

      void uploadRecord(nextId);
    }
  }, [uploadRecord]);

  useEffect(() => {
    pumpQueueRef.current = pumpQueue;
    pumpQueue();
  }, [uploads.length, pumpQueue]);

  function addFiles(fileList: FileList | File[]) {
    const files = Array.from(fileList);
    const accepted = files.filter(
      (file) => file.size <= MAX_FILE_BYTES,
    );
    const rejected = files.filter(
      (file) => file.size > MAX_FILE_BYTES,
    );

    if (rejected.length) {
      toast.warning(
        `${rejected.length} file${
          rejected.length === 1 ? '' : 's'
        } skipped`,
        {
          description:
            rejected
              .map(
                (file) =>
                  `${file.name} (${humanSize(file.size)})`,
              )
              .join(', ') + ' · 25 MB max',
          duration: 7000,
        },
      );
    }

    if (!accepted.length) return;

    const records: UploadRecord[] = accepted.map(
      (file) => ({
        clientId: crypto.randomUUID(),
        file,
        status: 'queued',
        progress: 0,
        progressText: 'Queued',
        serverId: null,
        controller: null,
        objectUrl: URL.createObjectURL(file),
      }),
    );

    queueRef.current.push(
      ...records.map((record) => record.clientId),
    );
    setUploads((items) => [...items, ...records]);
  }

  async function discard(record: UploadRecord) {
    record.controller?.abort();

    if (record.serverId) {
      try {
        await fetch(
          `/api/upload-sessions/${sessionId}/media/${record.serverId}`,
          { method: 'DELETE' },
        );
      } catch {}
    }

    removeUploadLocal(record.clientId);
    setCurrent(null);
    toast('Media discarded', {
      description: record.file.name,
    });
  }

  async function availableUploads() {
    const retained = uploadsRef.current.filter(
      (item) =>
        item.status === 'uploaded' && item.serverId,
    );

    const checks = await Promise.all(
      retained.map(async (record) => {
        try {
          const response = await fetch(
            `/api/upload-sessions/${sessionId}/media/${record.serverId}/status`,
            { cache: 'no-store' },
          );
          const parsed = await readApiResponse<{
            state?: string;
          }>(response);

          return {
            record,
            available:
              parsed.ok &&
              parsed.data?.state === 'uploaded',
          };
        } catch {
          return { record, available: true };
        }
      }),
    );

    const missing = checks
      .filter((item) => !item.available)
      .map((item) => item.record);

    if (missing.length) {
      missing.forEach((record) =>
        removeUploadLocal(record.clientId),
      );
      toast.warning(
        `${missing.length} unavailable upload${
          missing.length === 1 ? '' : 's'
        } removed`,
      );
    }

    return checks
      .filter((item) => item.available)
      .map((item) => item.record);
  }

  async function analyze() {
    if (
      uploads.some(
        (item) =>
          item.status === 'queued' ||
          item.status === 'uploading',
      )
    ) {
      return;
    }

    setBusy(true);
    const toastId = toast.loading(
      'Checking retained uploads…',
    );

    try {
      const retained = await availableUploads();
      if (!retained.length) {
        throw new Error(
          'No available uploaded media to analyze.',
        );
      }

      toast.loading(
        'Extracting metadata and tracing route…',
        { id: toastId },
      );

      const response = await fetch(
        '/api/trips/analyze-session',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            session_id: sessionId,
            upload_ids: retained.map(
              (item) => item.serverId,
            ),
            keep_as_one_trip: keepOne,
            start_location: startLocation,
            end_location: returnToStart
              ? null
              : endLocation,
            return_to_start: returnToStart,
          }),
        },
      );

      const parsed = await readApiResponse<{
        trips: TripPayload[];
        ignored_upload_ids?: string[];
      }>(response);

      if (!parsed.ok || !parsed.data) {
        throw new Error(
          parsed.detail || 'Route analysis failed',
        );
      }

      const trip = parsed.data.trips?.[0];
      if (!trip) {
        throw new Error(
          'Route analysis returned no trips',
        );
      }

      setCurrent(trip);

      const ignored = new Set(
        parsed.data.ignored_upload_ids ?? [],
      );
      retained.forEach((record) => {
        if (
          record.serverId &&
          ignored.has(record.serverId)
        ) {
          removeUploadLocal(record.clientId);
          return;
        }
        mutateUpload(record.clientId, {
          progressText:
            'Processed · raw upload removed',
          serverId: null,
        });
      });

      if (ignored.size) {
        toast.warning(
          `${ignored.size} unavailable upload${
            ignored.size === 1 ? '' : 's'
          } ignored`,
        );
      }

      toast.success('Route ready', {
        id: toastId,
        description:
          `${trip.summary.stop_count} points · ` +
          `${(
            trip.summary.distance_meters / 1000
          ).toFixed(1)} km`,
      });
    } catch (error) {
      toast.error('Could not generate route', {
        id: toastId,
        description: (error as Error).message,
      });
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!current) return;

    let cancelled = false;
    const refresh = async () => {
      const response = await fetch(
        `/api/trips/${current.id}/places?granularity=${encodeURIComponent(
          placeDetail,
        )}`,
      );
      const parsed = await readApiResponse<{
        places: Record<string, string>;
      }>(response);

      if (
        !parsed.ok ||
        !parsed.data ||
        cancelled
      ) {
        return;
      }

      setCurrent((value) =>
        value
          ? {
              ...value,
              place_names: parsed.data!.places,
              observations:
                value.observations.map(
                  (observation) => ({
                    ...observation,
                    place:
                      parsed.data!.places[
                        observation.id
                      ] ?? 'Unknown place',
                  }),
                ),
            }
          : value,
      );
    };

    void refresh();
    return () => {
      cancelled = true;
    };
  }, [placeDetail, current?.id]);

  useEffect(() => {
    if (!renderOnly) return;

    const tripId = new URLSearchParams(
      window.location.search,
    ).get('trip_id');

    if (!tripId) return;

    const load = async () => {
      const response = await fetch(
        `/api/trips/${tripId}/data`,
      );
      const parsed =
        await readApiResponse<TripPayload>(response);

      if (parsed.ok && parsed.data) {
        setCurrent(parsed.data);
      }
    };

    void load();
  }, [renderOnly]);

  async function startRender() {
    if (!current || renderBusy) return;

    setRenderBusy(true);
    const toastId = toast.loading(
      'Starting MP4 render…',
    );

    try {
      const response = await fetch(
        `/api/trips/${current.id}/render`,
        { method: 'POST' },
      );
      const parsed = await readApiResponse<{
        id: string;
      }>(response);

      if (!parsed.ok || !parsed.data) {
        throw new Error(
          parsed.detail || 'Render failed to start',
        );
      }

      for (;;) {
        await sleep(2000);

        const statusResponse = await fetch(
          `/api/renders/${parsed.data.id}`,
        );
        const statusParsed =
          await readApiResponse<{
            status: string;
            error?: string;
          }>(statusResponse);

        if (!statusParsed.ok || !statusParsed.data) {
          throw new Error(
            statusParsed.detail ||
              'Render status failed',
          );
        }

        if (
          statusParsed.data.status === 'complete'
        ) {
          toast.success('MP4 ready', {
            id: toastId,
          });

          const link =
            document.createElement('a');
          link.href =
            `/api/renders/${parsed.data.id}/video`;
          link.download = 'trip-recap.mp4';
          link.click();
          break;
        }

        if (
          statusParsed.data.status === 'failed'
        ) {
          throw new Error(
            statusParsed.data.error ||
              'Render failed',
          );
        }
      }
    } catch (error) {
      toast.error('Render failed', {
        id: toastId,
        description: (error as Error).message,
      });
    } finally {
      setRenderBusy(false);
    }
  }

  const canAnalyze = useMemo(
    () =>
      !busy &&
      uploads.some(
        (item) =>
          item.status === 'uploaded' &&
          item.serverId,
      ) &&
      !uploads.some(
        (item) =>
          item.status === 'queued' ||
          item.status === 'uploading',
      ),
    [uploads, busy],
  );

  const jsonValue = current
    ? current[jsonTab]
    : null;

  if (renderOnly) {
    return current ? (
      <main className="render-page">
        <MapPreview
          data={current}
          mapStyle="Street"
          vehicle="🛵"
          playbackSpeed={1}
          slowAtPoints
          renderOnly
          replayToken={0}
          fitToken={0}
        />
      </main>
    ) : (
      <main className="render-page loading-screen">
        Loading trip…
      </main>
    );
  }

  return (
    <>
      <Toaster
        richColors
        theme="dark"
        position="top-right"
        closeButton
      />

      <main className="page-shell">
        <header className="hero">
          <img
            src="/favicon.png"
            alt=""
            className="app-icon"
          />
          <div>
            <h1>Trip Recap</h1>
            <p>
              Upload trip media. GPS and capture
              metadata reconstruct the road route
              automatically.
            </p>
          </div>
        </header>

        <section className="panel upload-panel">
          <button
            type="button"
            className="drop-zone"
            onClick={() =>
              fileInputRef.current?.click()
            }
            onDragOver={(
              event: DragEvent<HTMLButtonElement>,
            ) => event.preventDefault()}
            onDrop={(
              event: DragEvent<HTMLButtonElement>,
            ) => {
              event.preventDefault();
              addFiles(event.dataTransfer.files);
            }}
          >
            <strong>
              Drop photos and videos from the trip
            </strong>
            <span>
              or click to choose files · 25 MB max
              each · 2 MiB retryable chunks
            </span>
          </button>

          <input
            ref={fileInputRef}
            className="visually-hidden"
            type="file"
            multiple
            accept=".jpg,.jpeg,.heic,.heif,.png,.webp,.mov,.mp4,.m4v,image/*,video/*"
            onChange={(
              event: ChangeEvent<HTMLInputElement>,
            ) => {
              if (event.target.files) {
                addFiles(event.target.files);
              }
              event.target.value = '';
            }}
          />

          {uploads.length > 0 && (
            <div className="media-grid">
              {uploads.map((record) => (
                <article
                  className="media-card"
                  key={record.clientId}
                >
                  <div className="media-thumb">
                    {record.file.type.startsWith(
                      'video/',
                    ) ||
                    /\.(mov|mp4|m4v)$/i.test(
                      record.file.name,
                    ) ? (
                      <video
                        src={record.objectUrl}
                        muted
                        playsInline
                        preload="metadata"
                      />
                    ) : /\.(heic|heif)$/i.test(
                        record.file.name,
                      ) ? (
                      <span>HEIC</span>
                    ) : (
                      <img
                        src={record.objectUrl}
                        alt={record.file.name}
                      />
                    )}
                  </div>

                  <div className="media-body">
                    <strong
                      title={record.file.name}
                    >
                      {record.file.name}
                    </strong>
                    <small>
                      {humanSize(record.file.size)}
                    </small>

                    <div className="progress-track">
                      <span
                        style={{
                          width:
                            `${record.progress}%`,
                        }}
                      />
                    </div>

                    <small
                      className={
                        record.status === 'failed'
                          ? 'danger-text'
                          : ''
                      }
                    >
                      {record.progressText}
                    </small>

                    <button
                      className="ghost danger-button"
                      type="button"
                      onClick={() =>
                        void discard(record)
                      }
                    >
                      Discard
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}

          <div className="settings-grid">
            <LocationAutocomplete
              label="Start point"
              placeholder="Auto, place name, or lat, lon"
              onChange={setStartLocation}
            />

            <LocationAutocomplete
              label="End point"
              placeholder="Auto, place name, or lat, lon"
              disabled={returnToStart}
              onChange={setEndLocation}
            />

            <label className="field toggle-field">
              <span>Loop route</span>
              <div className="toggle-row">
                <input
                  type="checkbox"
                  checked={returnToStart}
                  onChange={(event) =>
                    setReturnToStart(
                      event.target.checked,
                    )
                  }
                />
                End at start point
              </div>
            </label>

            <label className="field toggle-field">
              <span>Trip splitting</span>
              <div className="toggle-row">
                <input
                  type="checkbox"
                  checked={keepOne}
                  onChange={(event) =>
                    setKeepOne(
                      event.target.checked,
                    )
                  }
                />
                Treat media as one trip
              </div>
            </label>
          </div>

          <button
            className="primary full-width"
            type="button"
            disabled={!canAnalyze}
            onClick={() => void analyze()}
          >
            {busy
              ? 'Generating route…'
              : 'Determine route from retained media'}
          </button>
        </section>

        {current && (
          <section className="panel result-panel">
            <div className="metrics">
              <Metric
                label="Media"
                value={current.summary.media_count}
              />
              <Metric
                label="GPS media"
                value={
                  current.summary.gps_media_count
                }
              />
              <Metric
                label="Points"
                value={current.summary.stop_count}
              />
              <Metric
                label="Segments"
                value={
                  current.summary.segment_count
                }
              />
              <Metric
                label="Route"
                value={`${(
                  current.summary.distance_meters /
                  1000
                ).toFixed(1)} km`}
              />
            </div>

            <div className="map-toolbar">
              <button
                type="button"
                onClick={() =>
                  setReplayToken(
                    (value) => value + 1,
                  )
                }
              >
                Replay route
              </button>

              <select
                value={playbackSpeed}
                onChange={(event) =>
                  setPlaybackSpeed(
                    Number(event.target.value),
                  )
                }
              >
                <option value={0.5}>0.5×</option>
                <option value={1}>1×</option>
                <option value={1.5}>1.5×</option>
                <option value={2}>2×</option>
                <option value={3}>3×</option>
              </select>

              <label className="toolbar-toggle">
                <input
                  type="checkbox"
                  checked={slowAtPoints}
                  onChange={(event) =>
                    setSlowAtPoints(
                      event.target.checked,
                    )
                  }
                />
                Slow at image points
              </label>

              <button
                type="button"
                className="secondary"
                onClick={() =>
                  setFitToken(
                    (value) => value + 1,
                  )
                }
              >
                Fit route
              </button>

              <button
                type="button"
                className="secondary"
                disabled={renderBusy}
                onClick={() =>
                  void startRender()
                }
              >
                Export MP4
              </button>

              <select
                value={vehicle}
                onChange={(event) =>
                  setVehicle(event.target.value)
                }
              >
                <option value="🛵">Scooter</option>
                <option value="🚗">Car</option>
                <option value="🏍️">
                  Motorcycle
                </option>
                <option value="🚲">Bicycle</option>
                <option value="🚙">Jeep</option>
              </select>

              <select
                value={placeDetail}
                onChange={(event) =>
                  setPlaceDetail(
                    event.target.value,
                  )
                }
              >
                <option value="specific">
                  Specific
                </option>
                <option value="neighborhood">
                  Neighborhood
                </option>
                <option value="city">
                  City / Town
                </option>
                <option value="region">
                  Region
                </option>
              </select>

              <select
                value={mapStyle}
                onChange={(event) =>
                  setMapStyle(
                    event.target.value as
                      | 'Street'
                      | 'Satellite'
                      | 'Hybrid',
                  )
                }
              >
                <option>Street</option>
                <option>Satellite</option>
                <option>Hybrid</option>
              </select>
            </div>

            <MapPreview
              data={current}
              mapStyle={mapStyle}
              vehicle={vehicle}
              playbackSpeed={playbackSpeed}
              slowAtPoints={slowAtPoints}
              renderOnly={false}
              replayToken={replayToken}
              fitToken={fitToken}
            />

            <details>
              <summary>Route points</summary>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Place</th>
                      <th>Media</th>
                      <th>Captured</th>
                      <th>Latitude</th>
                      <th>Longitude</th>
                    </tr>
                  </thead>
                  <tbody>
                    {current.observations.map(
                      (observation) => (
                        <tr key={observation.id}>
                          <td>
                            {observation.order}
                          </td>
                          <td>
                            {observation.place}
                          </td>
                          <td>
                            {observation.media_files.join(
                              ', ',
                            )}
                          </td>
                          <td>
                            {observation.arrival}
                          </td>
                          <td>
                            {observation.latitude.toFixed(
                              6,
                            )}
                          </td>
                          <td>
                            {observation.longitude.toFixed(
                              6,
                            )}
                          </td>
                        </tr>
                      ),
                    )}
                  </tbody>
                </table>
              </div>
            </details>

            <details>
              <summary>
                View generated JSON
              </summary>

              <div className="details-content">
                <div className="tab-row">
                  {(
                    [
                      'trip',
                      'route',
                      'timeline',
                    ] as const
                  ).map((tab) => (
                    <button
                      type="button"
                      key={tab}
                      className={
                        jsonTab === tab
                          ? 'active'
                          : 'secondary'
                      }
                      onClick={() =>
                        setJsonTab(tab)
                      }
                    >
                      {tab}.json
                    </button>
                  ))}
                </div>

                <pre>
                  {JSON.stringify(
                    jsonValue,
                    null,
                    2,
                  )}
                </pre>
              </div>
            </details>
          </section>
        )}
      </main>
    </>
  );
}

function Metric({
  label,
  value,
}: {
  label: string;
  value: string | number;
}) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
