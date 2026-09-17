# Trip Recap

Metadata-driven road-trip reconstruction and recap generation.

Upload original photos/videos and Trip Recap uses their capture times and GPS metadata to reconstruct chronological observations, infer the road route between them, animate the trip, and export a vertical MP4.

## Current MVP

Implemented pipeline:

```text
media upload
-> ExifTool metadata normalization
-> trip clustering and segmentation
-> OSRM road routing
-> route.geojson
-> compressed timeline
-> MapLibre preview
-> Playwright frame capture
-> FFmpeg MP4
```

No manual coordinates or route stops are required.

## Run locally

System dependencies:

- ExifTool
- FFmpeg
- Chromium

Python dependencies:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Run:

```bash
streamlit run main.py
```

The Streamlit landing page links to the trip builder. FastAPI is mounted under `/api` through Streamlit's ASGI app support.

Useful paths:

- `/` Streamlit landing page
- `/api/preview` upload and animated MapLibre preview
- `/api/docs` FastAPI OpenAPI UI
- `/api/health` health check

## Tests

```bash
pytest -q
```

Tests use synthetic metadata and mocked routing so they do not depend on live OSRM or private media fixtures.

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

## Streamlit Community Cloud

The repository includes `requirements.txt` and `packages.txt`. Configure `main.py` as the Streamlit entry point. The hosted app uses Streamlit for the process/landing page and mounts FastAPI at `/api`.

Rendering is resource intensive. Community Cloud is useful for the MVP, but production rendering should eventually move to a dedicated worker/runtime.

## Privacy

Uploaded media may contain precise location data. See `PRIVACY.md`. The default implementation stores media and derived GPS/route artifacts temporarily and cleans expired data on later requests.

## Development

Read `AGENTS.md`, `MILESTONE.md`, and `TODO.md` before changing architecture or milestone scope.
