# Trip Recap

Turn original photos and videos into a route preview and vertical MP4 using capture
times and GPS metadata. Missing metadata stays explicit; roads between observations
are inferred.

- `frontend/`: Next.js static export with Astryx, Sonner, and MapLibre, deployed to Cloudflare Pages.
- `backend/`: FastAPI metadata, routing, timeline, media, and rendering API, deployed on your home server.
- `compose.yaml`: backend-only deployment, including ExifTool, Chromium, and FFmpeg.

See [deployment instructions](docs/deployment.md) for Cloudflare Pages settings,
API URLs, CORS, Docker, local development, and verification commands.

Uploads, discard, location autocomplete, route controls, playback, and MP4 export
use the backend API. No login is required. Source media and derived GPS data are
temporary by default; see [PRIVACY.md](PRIVACY.md).

Backend limits can be configured using `TRIP_RECAP_MAX_FILES` (100),
`TRIP_RECAP_MAX_FILE_BYTES` (hard maximum 25 MiB),
`TRIP_RECAP_DATA_TTL_SECONDS` (3600), `TRIP_RECAP_ROUTE_TIMEOUT_SECONDS` (20),
`TRIP_RECAP_ROUTE_ATTEMPTS` (3), `TRIP_RECAP_MIN_ROUTE_POINT_DISTANCE_METERS` (50),
`TRIP_RECAP_RENDER_MAX_SECONDS` (90), and `TRIP_RECAP_RENDER_FPS` (30).
`TRIP_RECAP_DATA_DIR` defaults to `/tmp/trip-recap`; `CHROMIUM_PATH` can select a browser.
