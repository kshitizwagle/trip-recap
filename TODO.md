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
- [x] Milestone 8: hosted UX polish
- [x] Milestone 9: migrate hosted app from Streamlit to FastAPI

## FastAPI hosted app
- [x] Deduplicate negligible consecutive GPS route points while preserving their media
- [x] Upload up to four media files concurrently as soon as they are selected
- [x] Extract metadata before optionally compressing photos to smaller WebP display copies
- [x] Allow uploaded media to be discarded and exclude discarded media from routing
- [x] Add selectable start/end GPS points and loop back to the same start point
- [x] Decouple map style and place-name detail from route tracing
- [x] Add playback speed controls and optional slowdown at image-derived GPS points
- [x] Flip the vehicle glyph based on current route direction
- [x] Add the Trip Recap favicon
- [x] Add FastAPI Cloud pyproject configuration with explicit `main:app`, Python 3.12, and FastAPI CLI dependencies
- [x] Serve the complete browser UI from FastAPI at `/`\n- [x] Use one multipart FastAPI request with browser-side per-file upload progress\n- [x] Preserve media preview, place labels, vehicle animation, map styles, observations, inline JSON, and optional downloads\n- [x] Expose root `main.py:app` for FastAPI Cloud auto-detection\n- [x] Remove Streamlit runtime dependency and Streamlit-specific app files\n- [ ] Validate ExifTool availability in FastAPI Cloud runtime\n- [ ] Validate Chromium and FFmpeg availability in FastAPI Cloud runtime\n\n## Legacy hosted-demo work\n- [x] Show an upload progress bar for every selected media file and per-file intake progress during analysis
- [x] Add Street, Satellite, and Hybrid map styles using MapLibre with EOX Sentinel-2 imagery
- [x] Force reverse-geocoded stop names to English and display only the first location segment before a comma
- [x] Preview uploaded photos and videos before analysis, including HEIC/HEIF where supported
- [x] Lock the map against dragging and prevent zooming out beyond the fitted route extent
- [x] Keep the selected vehicle upright and animate movement with easing and stop pauses
- [x] Show place labels directly on map stops with selectable granularity
- [x] Show media filenames in route-observation order
- [x] View trip, route, and timeline JSON directly in the app with downloads optional
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
