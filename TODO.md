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
