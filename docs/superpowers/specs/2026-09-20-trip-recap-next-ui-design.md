# Trip Recap Next UI Design

## Goal

Replace the current inline vanilla UI with a single Next.js App Router frontend using React and Astryx 0.6.2, while preserving the FastAPI upload, analysis, map-preview, and render API behavior.

## Direction

The interface is a dark route-lab workspace inspired by the portfolio reference: plum-black surfaces, warm off-white text, violet accent, mint status color, mono utility text, serif editorial display text, thin structural rules, and restrained radii. The first viewport explains the metadata-first workflow, makes the upload action dominant, and keeps route assumptions secondary. The analyzed trip promotes the map to the primary output and treats route points and generated artifacts as inspectable evidence.

## Architecture

- `src/app/` owns the Next.js page shell, theme provider, global CSS, and the client trip workflow.
- `src/lib/` owns typed API calls and small pure queue helpers that can be tested without a browser.
- `app/api/app.py` continues to own HTTP behavior and serves the static Next export from `out/` when it exists, with a test-friendly fallback before a frontend build.
- Next static export keeps the existing FastAPI deployment model; Docker builds the frontend before the Python runtime image is assembled.
- MapLibre remains an imperative integration behind a React effect because it owns a canvas/map instance; React owns all UI state and controls around it.

## Preserved contracts

- Existing API paths and request payloads remain unchanged.
- Immediate per-file uploads, four concurrent uploads, 25 MiB client rejection, discard, retained-media analysis, place refresh, route replay, JSON downloads, and asynchronous MP4 rendering remain available.
- Renderer globals `window.tripReady`, `window.tripData`, `window.routeData`, `window.timelineData`, and `window.setTripTime` remain available in the static page.
- Stable IDs such as `map`, `result`, `render`, and `playback-speed` remain on the elements that browser rendering and focused tests need.

## Verification

- Pure upload partition behavior is tested first and remains covered by a Node test.
- `npm run typecheck` and `npm run build` verify the Next frontend.
- `PYTHONPATH=. uv run pytest -q` verifies the FastAPI/API regression suite.
- `agent-browser` checks the built page at desktop and mobile widths, including the upload dropzone, responsive layout, and absence of console errors.
