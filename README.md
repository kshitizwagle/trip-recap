# Trip Recap

Metadata-driven road-trip reconstruction and recap generation.

Upload original photos/videos and Trip Recap uses capture times and GPS metadata to reconstruct chronological observations, infer the road route between them, animate the trip, and export a vertical MP4.

## Current architecture

The hosted app is now FastAPI end to end:

```text
browser UI served by FastAPI
-> immediate concurrent per-file upload with discard support
-> ExifTool metadata normalization
-> trip clustering and segmentation
-> OSRM road routing
-> Nominatim place labels
-> MapLibre Street / Satellite / Hybrid preview
-> deterministic timeline
-> optional Playwright + FFmpeg MP4 render
```

No Streamlit runtime is used.

Route tracing and presentation controls are separated. Media uploads begin immediately with up to four concurrent uploads. Metadata is extracted from the original file first, then photos are optionally reduced to a smaller WebP display copy when that saves space. Discarded uploads disappear from the UI and are excluded from routing. Start/end points can be selected from geotagged media, including a loop that returns to the selected start. Map style and place-name granularity can change without rerunning OSRM. Playback has speed controls, optional slowdown at image-derived GPS points, and the vehicle flips to face its current route direction.

## Run locally

Python 3.12 is pinned in `.python-version`. Python and project dependencies are managed with `uv`.

Install Python and sync the project:

```bash
uv python install 3.12
uv sync --extra dev
```

The metadata pipeline currently also expects the `exiftool` executable. MP4 rendering expects Chromium and FFmpeg.

Run:

```bash
uv run fastapi dev
```

Then open:

```text
http://127.0.0.1:8000/
```

API docs are available at `/docs`.

## Docker

The Docker image uses a multi-stage build:

- builder: `ghcr.io/astral-sh/uv:python3.12-bookworm-slim`
- runtime: `python:3.12-slim-bookworm`
- `uv` builds the virtual environment only in the builder stage
- the runtime receives the finished `.venv`, not `uv`
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

- `TRIP_RECAP_DATA_DIR` default `/tmp/trip-recap`
- `TRIP_RECAP_MAX_FILES` default `100`
- `TRIP_RECAP_MAX_FILE_BYTES` default `250 MiB`
- `TRIP_RECAP_DATA_TTL_SECONDS` default `3600`
- `TRIP_RECAP_ROUTE_TIMEOUT_SECONDS` default `20`
- `TRIP_RECAP_ROUTE_ATTEMPTS` default `3`
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
