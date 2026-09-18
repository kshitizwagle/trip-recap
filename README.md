# Trip Recap

Metadata-driven road-trip reconstruction and recap generation.

Upload original photos/videos and Trip Recap uses capture times and GPS metadata to reconstruct chronological observations, infer the road route between them, animate the trip, and export a vertical MP4.

## Current architecture

The production container is a single-process FastAPI deployment with a statically exported Next.js frontend:

```text
Next.js 16 + React 19 + Sonner
  build-time static export only
        ↓
FastAPI / Uvicorn
  serves frontend/out + JSON APIs
        ↓
retryable 2 MiB chunk uploads in /tmp
        ↓
ExifTool metadata extraction at route time
        ↓
trip clustering + OSRM road routing
        ↓
Photon autocomplete + Nominatim reverse labels
        ↓
MapLibre Street / Satellite / Hybrid preview
        ↓
optional Playwright + FFmpeg MP4 render
```

There is **no Node.js server in production**. Node is used only in the Docker frontend build stage. The final container runs one Uvicorn process.

The frontend is componentized under `frontend/` and uses:
- Next.js 16 static export
- React 19
- MapLibre GL JS
- Sonner for transient notifications such as skipped files, upload failures, discarded media, stale uploads, route results, and render completion

Uploads begin immediately. Up to four files upload concurrently, while each file itself is sent sequentially in 2 MiB chunks. A failed chunk is retried up to three times without restarting the entire file. Files over 25 MB are rejected in the browser and again by FastAPI.

All runtime media and derived artifacts live under `/tmp/trip-recap`. Raw upload chunks and assembled source files live under `/tmp/trip-recap/workspaces`. After successful route processing, that raw workspace is deleted immediately. Persisted trip media, route data, renders, and caches are also temporary and are cleaned by a lightweight FastAPI lifespan cleanup loop according to the configured TTL.

Metadata extraction, GPS parsing, image optimization, clustering, and routing run inside the container only when the user clicks **Determine route**. Failed, skipped, discarded, expired, or otherwise missing uploads are filtered out and are never referenced during route generation.

Start and end points accept either a place name or `latitude, longitude`. Place-name inputs provide autocomplete suggestions and display the selected coordinates. The loop option can return to the chosen start point. Map style and place-name detail remain presentation controls and do not rerun OSRM routing.

## Run locally

Python 3.12 is pinned in `.python-version`. Python dependencies are managed with `uv`.

Install Python and sync the backend:

```bash
uv python install 3.12
uv sync --extra dev
```

Build the static frontend:

```bash
cd frontend
npm install
npm run build
cd ..
```

Then run FastAPI:

```bash
uv run fastapi dev
```

If `frontend/out` is missing, FastAPI keeps the legacy HTML fallback for development and tests. Production Docker builds always include the static Next export.

The metadata pipeline expects the `exiftool` executable. MP4 rendering expects Chromium and FFmpeg.

Then open:

```text
http://127.0.0.1:8000/
```

API docs are available at `/docs`.

## Docker

The Docker image uses three stages:

- frontend builder: `node:22-bookworm-slim`, used only to build the Next static export
- Python builder: `ghcr.io/astral-sh/uv:python3.12-bookworm-slim`
- runtime: `python:3.12-slim-bookworm`
- the runtime receives `frontend/out` and the finished Python `.venv`
- Node and `uv` are not required by the running application
- ExifTool, FFmpeg, Chromium, runtime libraries, and fonts are installed in the runtime image

Build:

```bash
docker build -t trip-recap .
```

Run:

```bash
docker run --rm -p 8000:8000 trip-recap
```

The builder image already contains Python 3.12, so Docker does not download or install Python with `uv`. The final image starts the prebuilt virtual environment directly:

```text
python -m uvicorn main:app --host 0.0.0.0 --port $PORT
```

`PORT` defaults to `8000`, so platforms that inject their own port can override it automatically. The container sets `CHROMIUM_PATH=/usr/bin/chromium` and stores temporary trip data under `/tmp/trip-recap`.

## FastAPI Cloud

The repository exposes `app` from the root `main.py` and also declares `[tool.fastapi] entrypoint = "main:app"` in `pyproject.toml`. FastAPI Cloud should use Python 3.12 and install the application dependencies directly from `pyproject.toml`.

Deploy with:

```bash
fastapi deploy
```

The dependency is `fastapi[standard]`, which includes the FastAPI CLI used by FastAPI Cloud.

### Runtime binary note

The Python/FastAPI deployment is configured for FastAPI Cloud, but Trip Recap still uses external binaries for some features:

- ExifTool for JPEG/HEIC/MOV/MP4 metadata extraction
- Chromium + Playwright for deterministic frame capture
- FFmpeg for MP4 encoding

FastAPI Cloud's documented dependency flow is Python-package based. Verify those binaries are available in the deployed runtime before relying on metadata extraction or MP4 export there. If they are not, the next step is replacing/vendoring those runtime dependencies or moving rendering to a worker that provides them.

## Configuration

Environment variables:

- `TRIP_RECAP_MAX_FILES` default `100`
- `TRIP_RECAP_MAX_FILE_BYTES` hard maximum `25 MiB`
- `TRIP_RECAP_DATA_TTL_SECONDS` default `3600`; expired `/tmp` workspaces, trips, renders, and caches are purged periodically
- `TRIP_RECAP_ROUTE_TIMEOUT_SECONDS` default `20`
- `TRIP_RECAP_ROUTE_ATTEMPTS` default `3`
- `TRIP_RECAP_MIN_ROUTE_POINT_DISTANCE_METERS` default `50`; consecutive route observations closer than this are merged as negligible GPS movement
- `TRIP_RECAP_RENDER_MAX_SECONDS` default `90`
- `TRIP_RECAP_RENDER_FPS` default `30`
- `CHROMIUM_PATH` optional explicit Chromium executable

## Tests

```bash
uv sync --extra dev
PYTHONPATH=. uv run pytest -q
```

Tests use synthetic metadata and mocked routing so they do not depend on live OSRM or private media fixtures.

## Privacy

Uploaded media may contain precise location data. See `PRIVACY.md`. Source media and derived GPS/route artifacts are temporary by default and are removed after the configured TTL.
