# Trip Recap Next UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the inline vanilla Trip Recap page with a React/Astryx 0.6.2 Next.js frontend while preserving the FastAPI workflow and renderer contract.

**Architecture:** Add a static-export Next App Router under `src/app`, keep the FastAPI API unchanged, and make FastAPI serve `out/` after a frontend build. React owns uploads, controls, trip data, and map lifecycle; a small tested helper owns file acceptance rules.

**Tech Stack:** Next.js App Router, React 19, TypeScript, Astryx 0.6.2, MapLibre GL, FastAPI, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-20-trip-recap-next-ui-design.md`

## Global Constraints

- Use Astryx 0.6.2 components and tokens for the interface; do not mix a second component system or hand-maintain vanilla UI behavior.
- Preserve the existing FastAPI endpoint paths and request payloads.
- Preserve temporary-media behavior and explicit observed versus inferred route data.
- Keep MapLibre as the map renderer and keep final render output behavior unchanged.
- Follow the portfolio reference for palette, typography contrast, structural rules, and restrained shape.
- Do not commit generated frontend output, uploaded media, private GPS fixtures, or videos.

### Task 1: Lock the upload acceptance contract with a pure test

**Files:**
- Create: `src/lib/upload-queue.ts`
- Test: `src/lib/upload-queue.test.ts`

**Interfaces:**
- Produces `MAX_CONCURRENT_UPLOADS`, `MAX_FILE_BYTES`, `UploadRecord`, `partitionFiles`, and `canAnalyze` for the React workflow.

- [ ] **Step 1: Write the failing test**

Test that `partitionFiles` accepts files at or below 25 MiB, rejects larger files, and that `canAnalyze` is false while a retained upload is still queued or uploading.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --experimental-strip-types src/lib/upload-queue.test.ts`

Expected: FAIL because `src/lib/upload-queue.ts` does not exist yet.

- [ ] **Step 3: Write the minimal implementation**

Implement the constants, a file-like input type, `partitionFiles(files, maxBytes = MAX_FILE_BYTES)`, and `canAnalyze(records)` without browser APIs or React dependencies.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --experimental-strip-types src/lib/upload-queue.test.ts`

Expected: PASS with the boundary and pending-upload assertions.

### Task 2: Add the Next/Astryx frontend foundation

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `next.config.ts`
- Create: `tsconfig.json`
- Create: `src/theme.ts`
- Create: `src/app/layout.tsx`
- Create: `src/app/page.tsx`
- Create: `src/app/globals.css`

**Interfaces:**
- Produces a static-exportable Next page at `/` with a dark `trip-recap` Astryx theme and no API behavior yet.

- [ ] **Step 1: Add declared frontend dependencies and scripts**

Declare `next`, `react`, `react-dom`, `maplibre-gl`, TypeScript, and React/Node types. Add `dev`, `build`, `start`, and `typecheck` scripts. Keep the existing Astryx dependencies at 0.6.2.

- [ ] **Step 2: Configure static export**

Set `output: 'export'` and `images.unoptimized: true` in `next.config.ts`; keep the output directory at the repository root `out/` so FastAPI can serve it.

- [ ] **Step 3: Add the theme provider and page shell**

Use `Theme` from Astryx with a `trip-recap` theme extending Neutral. Set a warm neutral dark mode, violet accent, mono body role, serif heading role, and restrained radius scale. Import Astryx reset/base CSS before app CSS. Render `AppShell` with `height="auto"` and `contentPadding={0}` around the page.

- [ ] **Step 4: Add the portfolio-inspired global styles**

Define only app-level custom properties (`--trip-*`) in CSS, scope layout styles to `.trip-app`, and use Astryx component props/tokens for controls. Add responsive breakpoints for the editorial hero, upload workspace, route summary, and map panel. Do not add a second UI library.

- [ ] **Step 5: Verify the empty page builds**

Run: `npm run typecheck && npm run build`

Expected: Next emits `out/index.html` and type checking/build finish with exit code 0.

### Task 3: Move API contracts and map data into typed frontend modules

**Files:**
- Create: `src/lib/trip-types.ts`
- Create: `src/lib/trip-api.ts`

**Interfaces:**
- `trip-api.ts` exports `uploadMedia`, `discardUploadedMedia`, `analyzeSession`, `fetchPlaces`, `startRender`, `fetchRenderStatus`, and `tripDataUrl` with typed inputs/outputs.
- `trip-types.ts` exports the upload/trip/route/timeline summary shapes consumed by the page and map.

- [ ] **Step 1: Define types from the existing API payloads**

Model upload status, observations, route GeoJSON, timeline data, trip summary, and analysis response from the current `index.html` consumers and FastAPI `_trip_payload` output.

- [ ] **Step 2: Implement thin `fetch` wrappers**

Keep paths exactly as the existing page uses them: `/api/upload-sessions/{sessionId}/media`, `/api/upload-sessions/{sessionId}/media/{uploadId}`, `/api/trips/analyze-session`, `/api/trips/{tripId}/places`, `/api/trips/{tripId}/render`, and `/api/renders/{renderId}`.

- [ ] **Step 3: Typecheck the modules**

Run: `npm run typecheck`

Expected: PASS with no implicit-any errors.

### Task 4: Build the React upload queue and route-lab UI

**Files:**
- Create: `src/components/trip-recap/TripRecapPage.tsx`
- Create: `src/components/trip-recap/MediaQueue.tsx`
- Create: `src/components/trip-recap/MapPreview.tsx`
- Modify: `src/app/page.tsx`
- Modify: `src/app/globals.css`

**Interfaces:**
- `TripRecapPage` owns session state, queue state, analysis/render actions, and user-facing status.
- `MediaQueue` renders local previews, progress, discard actions, and upload states without direct DOM mutation.
- `MapPreview` accepts typed trip data and presentation controls, exposes `onReady`, and updates `window.setTripTime` for the renderer.

- [ ] **Step 1: Render the page shell and stable hooks**

Build the portfolio-inspired brand rail, metadata-first hero, Astryx `Card`, `FileInput`, `Button`, `Badge`, `ProgressBar`, `TextInput`, `CheckboxInput`, `Selector`, `Divider`, `Stack`, and `AppShell` composition. Preserve stable IDs `file-input`, `drop-zone`, `media-grid`, `analyze`, `status`, `result`, `map`, `map-controls`, `replay`, `playback-speed`, `slow-points`, `fit`, `render`, `video-download`, `observations-body`, `json-view`, and `media-overlay` where they remain useful.

- [ ] **Step 2: Wire immediate uploads through React state**

Use `partitionFiles` in the `FileInput` change handler, keep `uploads`, `uploadQueue`, and `activeUploads` in React state, limit starts to four concurrent requests, use `XMLHttpRequest` progress events, and preserve discard cancellation plus DELETE behavior.

- [ ] **Step 3: Wire analysis and presentation controls**

Build the exact existing analyze payload, render returned summary values, refresh place names without retracing, support map style/vehicle/place detail/speed/slow-point controls, and keep download actions for trip JSON, route GeoJSON, and timeline JSON.

- [ ] **Step 4: Wire asynchronous MP4 rendering**

Preserve the POST/poll flow, disable export while queued/rendering, expose the finished video link, and surface failures through the existing status area and Sonner if available.

- [ ] **Step 5: Typecheck and build**

Run: `npm run typecheck && npm run build`

Expected: PASS and a static `out/` page that includes the rendered React UI.

### Task 5: Keep FastAPI serving and Docker compatible with the Next export

**Files:**
- Modify: `app/api/app.py`
- Modify: `Dockerfile`
- Modify: `tests/test_api.py`
- Modify: `README.md`

**Interfaces:**
- FastAPI serves `out/index.html` and `out/_next/*` after a frontend build, while retaining a clear fallback response before the build exists.
- Docker builds the Next export before copying the Python application into the runtime image.

- [ ] **Step 1: Add a failing API contract test**

Update the root/preview test to assert the new frontend marker and renderer globals rather than implementation details from the deleted vanilla script.

- [ ] **Step 2: Run the API test to verify the expected failure**

Run: `PYTHONPATH=. uv run pytest -q tests/test_api.py`

Expected: FAIL because FastAPI still reads the old inline page.

- [ ] **Step 3: Serve the static export and assets**

Resolve `out/index.html` when present, mount `/_next` from `out/_next`, keep the existing favicon endpoint, and return a short build-required fallback when no export exists. Keep `/preview` as the renderer alias.

- [ ] **Step 4: Build the frontend in Docker**

Add a Node builder stage that runs `npm ci` and `npm run build`, then copy `out/` into the Python builder/runtime filesystem. Keep the Python runtime command and API port unchanged.

- [ ] **Step 5: Update the run instructions**

Document `npm run dev` for frontend work alongside FastAPI and the production sequence `npm run build` then `uv run fastapi dev`; document that Docker performs the frontend build automatically.

- [ ] **Step 6: Run the API tests**

Run: `PYTHONPATH=. uv run pytest -q tests/test_api.py`

Expected: PASS.

### Task 6: Full verification and browser QA

**Files:**
- Modify only files needed to fix verified failures.

- [ ] **Step 1: Run frontend checks**

Run: `npm run typecheck && npm run build`

Expected: both commands exit 0.

- [ ] **Step 2: Run the Python suite**

Run: `PYTHONPATH=. uv run pytest -q`

Expected: all tests pass.

- [ ] **Step 3: Start FastAPI against the built export**

Run: `uv run fastapi dev --host 127.0.0.1 --port 8000`

Expected: `/` serves the exported Next page and `/api/health` returns `{"status":"ok"}`.

- [ ] **Step 4: Inspect desktop and mobile with agent-browser**

Open `http://127.0.0.1:8000/`, capture desktop and mobile screenshots, check the upload input is reachable, check no console errors, and confirm the route-lab layout collapses cleanly.

- [ ] **Step 5: Re-run all checks after any visual fixes**

Run: `npm run typecheck && npm run build && PYTHONPATH=. uv run pytest -q`

Expected: exit 0 for all commands before reporting completion.
