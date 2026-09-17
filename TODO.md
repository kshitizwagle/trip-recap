# TODO

## Milestone 0: Project foundation
- [x] Project plan, milestone tracking, and agent guidance

## Milestone 1: Metadata extraction
- [x] Normalized models, ExifTool extraction, validation, and tests

## Milestone 2: Trip analysis
- [x] Chronology, speed checks, clustering, segmentation, stats, and tests

## Milestone 3: Routing
- [x] Router protocol and OSRM implementation
- [x] Pairwise route construction and validation
- [x] Filesystem route cache
- [x] Complete GeoJSON route and route progress
- [x] Routing tests

## Milestone 4: Timeline
- [ ] Timeline models and nonlinear time compression
- [ ] Movement, media, and camera events
- [ ] Timeline serialization and tests

## Milestone 5: API and preview
- [ ] Upload/analyze/result APIs
- [ ] MapLibre browser preview
- [ ] Progressive route and scooter animation
- [ ] Media overlays and basic controls

## Milestone 6: Rendering
- [ ] Deterministic playback capture
- [ ] Playwright and FFmpeg pipeline
- [ ] 1080x1920 MP4 export
- [ ] Temporary render workspace cleanup

## Milestone 7: Hardening
- [ ] Limits, retries, cleanup, and privacy safeguards
- [ ] Background render job abstraction
- [ ] End-to-end fixture coverage
- [ ] Deployment documentation

## MVP success criteria
A user can upload original trip photos/videos and, without entering coordinates or destinations, get normalized metadata, observations, an inferred route, a timeline, a browser preview, and a vertical MP4 recap.
