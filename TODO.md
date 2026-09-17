# TODO

This file tracks implementation work for the metadata-driven trip recap MVP.

## Milestone 0: Project foundation
- [x] Define implementation plan
- [x] Add project tracking and agent guidance

## Milestone 1: Metadata extraction
- [x] Package structure and normalized media models
- [x] ExifTool JSON runner and metadata normalization
- [x] Timestamp/GPS provenance and validation
- [x] Unit tests

## Milestone 2: Trip analysis
- [x] Sort media chronologically
- [x] Calculate distance and implied speed
- [x] Mark suspicious GPS observations
- [x] Cluster nearby media into observations
- [x] Segment uploads into separate trips
- [x] Produce trip statistics
- [x] Serialize trips through the Pydantic model
- [x] Add clustering and segmentation tests

## Milestone 3: Routing
- [ ] Router protocol and OSRM implementation
- [ ] Pairwise route construction and validation
- [ ] Filesystem route cache
- [ ] Complete GeoJSON route and route progress
- [ ] Routing tests

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
