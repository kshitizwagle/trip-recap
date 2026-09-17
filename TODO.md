# TODO

This file tracks implementation work for the metadata-driven trip recap MVP.

## Milestone 0: Project foundation

- [x] Define implementation plan
- [x] Add `TODO.md`
- [x] Add `MILESTONE.md`
- [x] Add `AGENTS.md`
- [x] Keep milestone status updated as work lands

## Milestone 1: Metadata extraction

- [x] Create package structure under `app/`
- [x] Add normalized media models
- [x] Add ExifTool JSON runner
- [x] Normalize photo/video capture timestamps
- [x] Normalize GPS, altitude, dimensions, duration, and direction
- [x] Preserve metadata source fields for debugging
- [x] Validate GPS ranges
- [x] Represent missing metadata explicitly
- [x] Add metadata extraction service entry point
- [x] Add unit tests for normalization

## Milestone 2: Trip analysis

- [ ] Sort media chronologically
- [ ] Calculate haversine distance and implied speed
- [ ] Mark suspicious GPS observations
- [ ] Cluster nearby media into observations
- [ ] Segment uploads into separate trips
- [ ] Produce trip statistics
- [ ] Serialize analyzed trip data to `trip.json`
- [ ] Add unit tests for clustering and segmentation

## Milestone 3: Routing

- [ ] Define routing protocol
- [ ] Implement OSRM router
- [ ] Route pairwise between observations
- [ ] Add route response validation
- [ ] Add filesystem route cache
- [ ] Combine segments into complete route geometry
- [ ] Produce `route.geojson`
- [ ] Project media/observations onto route progress
- [ ] Add routing tests with mocked HTTP responses

## Milestone 4: Timeline

- [ ] Define timeline event models
- [ ] Implement nonlinear real-time compression
- [ ] Add movement events
- [ ] Add arrival/departure events
- [ ] Add media show/hide events
- [ ] Add overview/follow/arrival camera events
- [ ] Handle media clusters
- [ ] Serialize timeline data
- [ ] Add timeline tests

## Milestone 5: API and preview

- [ ] Add upload endpoint
- [ ] Add analyze endpoint
- [ ] Add trip status/result endpoint
- [ ] Add route endpoint
- [ ] Add browser preview page
- [ ] Render route with MapLibre
- [ ] Animate progressive route drawing
- [ ] Animate scooter position and bearing
- [ ] Show media overlays at timeline events
- [ ] Add basic preview controls

## Milestone 6: Rendering

- [ ] Add deterministic browser playback mode
- [ ] Add Playwright capture pipeline
- [ ] Add FFmpeg composition wrapper
- [ ] Support photos and short video clips
- [ ] Export 1080x1920 H.264/AAC MP4
- [ ] Add temporary render workspace management
- [ ] Clean up temporary source media and extracted GPS data

## Milestone 7: Hardening

- [ ] Add upload/media limits
- [ ] Add failure reporting for unsupported/corrupt metadata
- [ ] Add route-service timeout/retry behavior
- [ ] Add cleanup policy
- [ ] Add background render job abstraction
- [ ] Add privacy documentation
- [ ] Add end-to-end fixture test
- [ ] Update README with local and hosted usage

## MVP success criteria

A user can upload original trip photos/videos and, without entering coordinates or destinations, get normalized metadata, observations, an inferred route, a timeline, a browser preview, and a vertical MP4 recap.
