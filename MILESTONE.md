# Milestones

| Milestone | Status | Result |
| --- | --- | --- |
| 0. Foundation | Complete | Plan, TODOs, agent rules, hosted bootstrap |
| 1. Metadata | Complete | ExifTool normalization and validation |
| 2. Trip analysis | Complete | chronology, clustering, segmentation, stats |
| 3. Routing | Complete | OSRM abstraction, cache, GeoJSON, progress |
| 4. Timeline | Complete | deterministic compressed event timeline |
| 5. API + preview | Complete | upload APIs and animated MapLibre preview |
| 6. Rendering | Complete | deterministic Chromium frames and FFmpeg MP4 |
| 7. Hardening | Complete for MVP | limits, retries, TTL cleanup, privacy/docs, synthetic E2E test |

## Current engineering target

The original first target, `media files -> trip.json + route.geojson`, is implemented. The repository now also contains preview and rendering layers.

## Next validation target

Run the pipeline against a real fixture set containing at least:

- iPhone HEIC photo
- iPhone MOV video
- Android JPEG
- Android MP4
- media with no GPS
- media with no capture timestamp
- edited media with rewritten metadata

Do not commit private personal fixtures or precise GPS data to the repository. Use sanitized fixtures or local-only test media.
