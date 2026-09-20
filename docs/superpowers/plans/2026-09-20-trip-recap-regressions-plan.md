# Trip Recap Control Regressions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore place-name autocomplete for start/end locations and restore the transportation-mode control without changing the existing analyze payload or upload behavior.

**Architecture:** Reuse the existing FastAPI/Nominatim boundary for location suggestions instead of calling Nominatim directly from the browser. Add a small React autocomplete control around the existing `start-point` and `end-point` IDs, and put the existing vehicle state in the intake controls so it is available before analysis; keep `MapPreview` as the consumer of that state.

**Tech Stack:** FastAPI, `httpx`, Nominatim, Next.js App Router, React, TypeScript, Astryx Core `Selector`, native input/listbox semantics, Sonner.

**Spec:** `docs/superpowers/specs/2026-09-20-trip-recap-next-ui-design.md`, plus the approved regression request in this conversation.

## Global Constraints

- Preserve existing API paths and the `AnalyzeSessionRequest` payload shape.
- Preserve stable IDs: `start-point`, `end-point`, `vehicle`, `place-detail`, `analyze`, and the upload queue IDs.
- Keep missing coordinates explicit; autocomplete only supplies a user-selected place string and must not invent media metadata.
- Do not add a new dependency; use the existing Nominatim client, Astryx components, native input/listbox semantics, and Sonner.
- Do not call Nominatim from the browser; suggestions go through FastAPI and use the existing cache/user-agent/rate-limit path.
- Do not add persistence for suggestions or uploaded media beyond the existing temporary store/cache behavior.

## Current Root Cause

- The original vanilla intake controls included `id="vehicle"`; the React page only renders the vehicle selector after a trip exists inside map controls, so transportation mode is unavailable during intake.
- The current frontend has no autocomplete component or location-search API. The backend only exposes `_resolve_location`, which accepts a complete string during analysis and calls `NominatimReverseGeocoder.forward()` with `limit=1`.
- Existing tests cover build/API serving and geocoder forwarding, but none assert the missing controls, suggestion endpoint, keyboard selection, or the rendered queue interaction. That is why the current suite passes while these UI regressions remain.

## File Map

- Modify `app/geocoding/nominatim.py`: add cached multi-result search while preserving `forward()` behavior.
- Modify `app/api/app.py`: add a small `/api/locations/search` HTTP endpoint with query length and result-count limits.
- Test `tests/test_geocoding.py` and `tests/test_api.py`: prove normalized/cached suggestions and endpoint validation without live Nominatim calls.
- Create `src/components/trip-recap/LocationAutocomplete.tsx`: own debounce, abort, keyboard navigation, and accessible suggestion list.
- Modify `src/lib/trip-api.ts`: add the typed location-search request.
- Modify `src/components/trip-recap/TripRecapPage.tsx`: wire start/end autocomplete and restore the single intake vehicle selector; remove the duplicate result-only vehicle control.
- Modify `src/app/globals.css`: style the suggestion list and preserve the current editorial control treatment.
- Browser verification: exercise autocomplete, vehicle selection, preview fill, discard icon, oversize toast, and axe audit.

### Task 1: Add a cached multi-result geocoder search

**Files:**
- Modify: `app/geocoding/nominatim.py`
- Test: `tests/test_geocoding.py`

**Interfaces:**
- Produces `NominatimReverseGeocoder.search(query: str, limit: int = 5) -> list[dict[str, float | str | None]]` returning only `latitude`, `longitude`, and `display_name`.
- Keeps `forward(query)` returning the first result and its current dictionary shape.

- [x] **Step 1: Write the failing test**

Add a mocked Nominatim test that returns three search results, calls `geocoder.search("Mahalaxmi", limit=3)` twice, and asserts:

```python
assert results == [
    {
        "latitude": 27.6939,
        "longitude": 85.3161,
        "display_name": "Mahalaxmi, Lalitpur, Nepal",
    },
    {
        "latitude": 27.7000,
        "longitude": 85.3200,
        "display_name": "Mahalaxmi Temple, Kathmandu, Nepal",
    },
    {
        "latitude": 27.7100,
        "longitude": 85.3300,
        "display_name": "Mahalaxmi Municipality, Nepal",
    },
]
assert calls == 1
```

Assert the request uses `/search`, normalized `q`, `limit=3`, `format=jsonv2`, `addressdetails=1`, and `accept-language=en`.

- [x] **Step 2: Run the focused test and verify it fails**

Run: `PYTHONPATH=. .venv/bin/pytest tests/test_geocoding.py -q`

Expected: FAIL because `NominatimReverseGeocoder.search` does not exist.

- [x] **Step 3: Implement the minimal search method**

Extract the existing forward-search request/caching path into a private normalized search helper or add a sibling `search()` method. Cache by normalized query and limit, clamp the public limit to a small safe range, normalize malformed Nominatim rows by skipping rows without parseable `lat`/`lon`, and return the three-field result shape. Make `forward()` call the same search path with `limit=1` so the existing analysis flow remains unchanged.

- [x] **Step 4: Run the focused tests**

Run: `PYTHONPATH=. .venv/bin/pytest tests/test_geocoding.py -q`

Expected: all geocoding tests pass, including the existing `forward()` cache test.

### Task 2: Expose location suggestions through FastAPI

**Files:**
- Modify: `app/api/app.py`
- Test: `tests/test_api.py`

**Interfaces:**
- Adds `GET /api/locations/search?q=<text>&limit=<n>`.
- Returns `{ "results": [{"latitude": number, "longitude": number, "display_name": string | null}] }`.

- [x] **Step 1: Write failing endpoint tests**

Add a monkeypatched API test for `GET /api/locations/search?q=Mahalaxmi&limit=3` returning the normalized results from Task 1. Add validation tests for a one-character query and a limit above the server cap; both must return HTTP 422.

- [x] **Step 2: Run the focused API tests and verify they fail**

Run: `PYTHONPATH=. .venv/bin/pytest tests/test_api.py -q`

Expected: the success case returns 404 because the route does not exist.

- [x] **Step 3: Implement the endpoint**

Use FastAPI `Query` constraints (`min_length=2`, bounded `limit`) and run the blocking geocoder search in `asyncio.to_thread`, matching `_resolve_location` and `/api/trips/{trip_id}/places`. Do not expose the raw Nominatim response or add a client-side external request.

- [x] **Step 4: Run the API tests**

Run: `PYTHONPATH=. .venv/bin/pytest tests/test_api.py -q`

Expected: the new endpoint and existing API regression tests pass.

### Task 3: Build the accessible React autocomplete control

**Files:**
- Create: `src/components/trip-recap/LocationAutocomplete.tsx`
- Modify: `src/lib/trip-api.ts`
- Modify: `src/app/globals.css`

**Interfaces:**
- `searchLocations(query: string, signal?: AbortSignal): Promise<{results: LocationSuggestion[]}>` in `src/lib/trip-api.ts`.
- `LocationAutocomplete` props:

```ts
interface LocationAutocompleteProps {
  id: string;
  label: string;
  value: string;
  placeholder: string;
  isDisabled?: boolean;
  onChange: (value: string) => void;
}
```

- [x] **Step 1: Add the typed API client and a focused URL test/check**

Add `LocationSuggestion` and call `/api/locations/search` with `encodeURIComponent(query)` and an optional `AbortSignal`. Keep `requestJson` as the shared error/parser path.

- [x] **Step 2: Implement the control with native accessible semantics**

Use a labeled text input with `role="combobox"`, `aria-autocomplete="list"`, `aria-expanded`, and `aria-controls`. Debounce non-empty queries by 250ms, abort the prior request on each change/unmount, show at most five results, support ArrowDown/ArrowUp/Enter/Escape, and select a suggestion by writing its `display_name` into the existing string state. Keep the dropdown closed when fewer than two characters are entered or when there are no results.

- [x] **Step 3: Style only the new suggestion surface**

Add a positioned suggestion list beneath the existing `.text-control` field, matching the plum surface, violet focus state, mono utility text, and existing borders. Do not change the input IDs or the surrounding upload-card layout.

- [x] **Step 4: Run frontend verification**

Run: `npm run typecheck && npm run build`

Expected: the new client component compiles in the static export.

### Task 4: Restore intake controls and wire the page

**Files:**
- Modify: `src/components/trip-recap/TripRecapPage.tsx`
- Modify: `tests/test_api.py`

**Interfaces:**
- `startLocation` and `endLocation` remain strings sent unchanged as `start_location` and `end_location` in `AnalyzeSessionRequest`.
- `vehicle` remains the existing `Vehicle` union consumed by `MapPreview`.

- [x] **Step 1: Add regression assertions before wiring**

Extend the static-page assertions to require `id="vehicle"`, `START POINT`, `END POINT`, and the autocomplete-related text. In the browser smoke checklist, record that the vehicle selector must be visible before any trip is analyzed.

- [x] **Step 2: Wire the two location fields**

Replace the two plain text-control inputs with `LocationAutocomplete` using `id="start-point"` and `id="end-point"`. Pass `isDisabled={returnToStart}` to the end control. Keep the current state strings and analyze payload exactly as-is.

- [x] **Step 3: Restore one intake vehicle selector**

Add an Astryx `Selector` with `id="vehicle"` to the intake controls using the existing `VEHICLES`, `vehicleLabel`, and `setVehicle` logic. Remove the duplicate result-only vehicle selector so only one `vehicle` ID exists; `MapPreview` continues receiving the same state.

- [x] **Step 4: Run the page/API checks**

Run: `PYTHONPATH=. .venv/bin/pytest tests/test_api.py -q && npm run typecheck && npm run build`

Expected: the static page exposes the restored control IDs and both backend/frontend checks pass.

### Task 5: Verify the regressions and recent media feedback end to end

**Files:**
- No production files unless a verification defect is found.
- Test artifacts only under `/private/tmp` or the browser session.

- [x] **Step 1: Start the FastAPI-served built page**

Run: `.venv/bin/python -m uvicorn main:app --host 127.0.0.1 --port 8000`

- [x] **Step 2: Verify location autocomplete**

In agent-browser, type `Mah` into `#start-point`, wait for the suggestion list, verify a `listbox` appears, select a result with the keyboard, and assert `#start-point` contains the selected display name. Repeat the disabled-end behavior with `#return-start` checked.

- [x] **Step 3: Verify transportation mode**

Assert `#vehicle` exists before analysis, select Scooter/Car/Bicycle, and confirm the selected state is reflected in the control without changing upload queue state.

- [x] **Step 4: Verify the media UI fixes**

Upload a valid image and assert its preview fills the media frame, the discard action is an icon-only button with an accessible label, and clicking it removes the card. Dispatch a synthetic 25 MiB-plus `.MOV` `File` through `#file-input` and assert the inline size error is absent while the Sonner notification contains the filename and 25 MB limit.

- [x] **Step 5: Run accessibility and final checks**

Run `agent-browser a11y --json`, `git diff --check`, `npm run typecheck`, `npm run build`, and `PYTHONPATH=. .venv/bin/pytest -q`.

Expected: zero axe violations, all frontend checks pass, all Python tests pass, and no live Nominatim request is required by automated tests.

## Handoff

Implementation complete. “Region autocomplete” was treated as suggestions for the start/end place-name fields; the existing `place-detail` region selector remains unchanged. Backend, frontend, and browser verification were run against the current build.
