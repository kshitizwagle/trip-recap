# Separate frontend and backend deployment

The Next.js frontend lives in `frontend/`. FastAPI, domain modules, Python tests,
dependencies, and the backend-only Dockerfile live in `backend/`.
FastAPI serves API endpoints and media; it does not serve HTML or Next.js assets.

## Cloudflare Pages

Connect this repository with these build settings:

| Setting | Value |
| --- | --- |
| Root directory | `frontend` |
| Framework | Next.js (Static HTML Export) |
| Build command | `npm run build` |
| Output directory | `out` |
| Node version | `22` (22.18 or newer) |
| Environment variable | `NEXT_PUBLIC_API_BASE_URL=https://api.example.com` |

Use the public HTTPS address of your home-server API, without `/api` appended.
The variable is embedded at build time: rebuild Pages after changing it.
Pages serves both `/` and `/recap`, including the favicon.

## Home server

Create a root `.env` file (not committed) containing:

```dotenv
TRIP_RECAP_CORS_ORIGINS=https://trip-recap.kshitizwagle.com.np,http://localhost:3000,http://127.0.0.1:3000
TRIP_RECAP_RENDER_PREVIEW_URL=https://trip-recap.kshitizwagle.com.np/recap
```

Then run from the repository root:

```sh
docker compose up --build -d
```

The container includes ExifTool, Chromium, and FFmpeg. The host port binds to
`127.0.0.1:8001`. Point a host-running Cloudflare Tunnel at
`http://127.0.0.1:8001` for `api.example.com`. A containerized tunnel must share
the Compose network and address `http://backend:8001` instead.
This repository does not create or configure your Cloudflare tunnel.

Add your exact custom frontend domain to `TRIP_RECAP_CORS_ORIGINS` if used.
Add individual preview origins explicitly when needed; no wildcard is enabled.
There is no login. CORS controls browser access, not caller authentication.
Requests come from the user's browser to the public API hostname, through
Cloudflare; a tunnel prevents direct connections to the home-server port but
does not make the public API private.

MP4 export opens `TRIP_RECAP_RENDER_PREVIEW_URL` in headless Chromium and loads
trip data from the frontend's configured API URL. The container therefore needs
outbound access to Pages, the API hostname, and map tiles. The same timeline
drives browser playback and exported video. Downloads and media URLs resolve
against the API origin.

## Local development

Backend terminal (Python 3.12; ExifTool, FFmpeg, and Chromium installed):

```sh
cd backend
uv sync --extra dev
uv run uvicorn main:app --reload --port 8001
```

Frontend terminal:

```sh
cd frontend
npm ci --ignore-scripts
npm run dev
```

Open `http://localhost:3000`; API documentation is at `http://localhost:8001/docs`.
Frontend requests default to `http://localhost:8001`. Set
`NEXT_PUBLIC_API_BASE_URL` in `frontend/.env.local` to override it.
Without Docker, the renderer defaults to `http://localhost:3000/recap`.
With Compose and a host-running frontend, its default is
`http://host.docker.internal:3000/recap` and that origin is allowed by default.

For a standalone backend image: `docker build -t trip-recap-api backend`.
Only the `backend/` directory is sent as the build context.

## Verification

```sh
cd backend
PYTHONPATH=. uv run pytest -q
```

```sh
cd frontend
npm test
npm run typecheck
npm run build
```

Test locations are synthetic points around New York or public landmark examples;
tests do not require personal media or live geocoding/routing services.
