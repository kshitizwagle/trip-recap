# TODO

## MVP milestones
- [x] Milestone 0: project foundation
- [x] Milestone 1: metadata extraction
- [x] Milestone 2: trip analysis
- [x] Milestone 3: routing
- [x] Milestone 4: timeline
- [x] Milestone 5: API and MapLibre preview
- [x] Milestone 6: deterministic MP4 rendering
- [x] Milestone 7: MVP hardening

## Hosted demo
- [x] Keep vehicle upright while moving instead of rotating with route bearing
- [x] Add selectable scooter/car/motorcycle/bicycle/jeep animation vehicles
- [x] Render general place-name labels directly on map stops
- [x] Use distance-based route interpolation and slow/pause at stops
- [x] Slow down and pause the scooter at inferred stops
- [x] Reverse-geocode stop coordinates into general place names with caching
- [x] Use OpenFreeMap Liberty as the default basemap
- [x] Batch upload multiple photos/videos in one selection without filename collisions
- [x] Determine an inferred road route from valid GPS observations in capture-time order
- [x] Run upload, metadata extraction, trip analysis, routing, and MapLibre preview directly from the Streamlit root app
- [x] Remove Streamlit Community Cloud dependence on custom `/api/*` routes
- [ ] Validate hosted analysis with original iPhone HEIC/MOV files
- [ ] Validate hosted analysis with Android JPEG/MP4 files
- [ ] Verify ExifTool and OSRM behavior under Streamlit Community Cloud limits
- [ ] Reconnect MP4 export in the Streamlit UI after browser capture is validated on the host

## Follow-up validation
- [ ] Test with a sanitized real-device HEIC/MOV/JPEG/MP4 fixture set
- [ ] Verify ExifTool field variations across iPhone and Android samples
- [ ] Verify Chromium availability and memory usage on Streamlit Community Cloud
- [ ] Verify MP4 rendering duration/resource limits on the hosted instance
- [ ] Add richer handling for timestamp-only media between GPS observations
- [ ] Add user-selectable 30/60/90 second output duration
- [ ] Add audio/music only after the core renderer is stable

## MVP success criteria
A user can upload original trip photos/videos and, without entering coordinates or destinations, get normalized metadata, observations, an inferred route, a deterministic timeline, an animated browser preview, and a vertical MP4 recap.
