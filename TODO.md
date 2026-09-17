# TODO

## Milestone 0: Project foundation
- [x] Project plan, milestone tracking, and agent guidance

## Milestone 1: Metadata extraction
- [x] Normalized models, ExifTool extraction, validation, and tests

## Milestone 2: Trip analysis
- [x] Chronology, speed checks, clustering, segmentation, stats, and tests

## Milestone 3: Routing
- [x] Router protocol, OSRM, caching, GeoJSON, progress projection, and tests

## Milestone 4: Timeline
- [x] Deterministic compressed timeline with movement, media, and camera events

## Milestone 5: API and preview
- [x] Upload/analyze/result APIs and MapLibre animated preview

## Milestone 6: Rendering
- [x] Deterministic frame control
- [x] Playwright Chromium capture
- [x] FFmpeg H.264 MP4 encoding at 1080x1920/30fps
- [x] Background render endpoints and frame cleanup

## Milestone 7: Hardening
- [ ] Limits, retries, cleanup, and privacy safeguards
- [ ] Background job/status hardening
- [ ] End-to-end fixture coverage
- [ ] Deployment documentation

## MVP success criteria
A user can upload original trip photos/videos and, without entering coordinates or destinations, get normalized metadata, observations, an inferred route, a timeline, a browser preview, and a vertical MP4 recap.
