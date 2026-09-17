# Milestones

Implementation is intentionally split into independently testable milestones. Each milestone should land as its own commit on `main`.

## Milestone 0: Project foundation

**Goal:** establish project direction and contributor rules.

Deliverables:

- `IMPLEMENTATION_PLAN.md`
- `TODO.md`
- `MILESTONE.md`
- `AGENTS.md`
- working deployment/bootstrap files

Exit criteria:

- architecture and MVP boundaries are documented
- subsequent work can be implemented without redefining core domain rules

## Milestone 1: Metadata extraction

**Goal:** turn supported media files into normalized metadata records.

Deliverables:

- `MediaPoint` and metadata-related models
- ExifTool integration
- timestamp normalization
- GPS validation
- media-type detection
- metadata tests

Exit criteria:

Given JPEG, HEIC, MOV, or MP4 files, the application can produce deterministic normalized metadata with explicit missing fields and source provenance.

## Milestone 2: Trip analysis

**Goal:** convert normalized media into chronological trip observations.

Deliverables:

- chronological sorting
- distance/speed validation
- observation clustering
- trip segmentation
- trip statistics
- `trip.json` serialization

Exit criteria:

A set of normalized media points can be transformed into one or more stable trip models without routing or rendering.

## Milestone 3: Routing

**Goal:** reconstruct an inferred road path between observed locations.

Deliverables:

- router protocol
- OSRM implementation
- pairwise route construction
- route cache
- combined geometry
- `route.geojson`
- route progress projection

Exit criteria:

A trip with located observations produces cached, serializable road geometry while preserving the distinction between observed GPS data and inferred road segments.

## Milestone 4: Timeline

**Goal:** convert real trip time into a watchable video timeline.

Deliverables:

- timeline models
- nonlinear time compression
- movement/media/camera events
- clustered media timing
- timeline serialization

Exit criteria:

The same analyzed trip always produces a deterministic timeline suitable for both browser preview and video rendering.

## Milestone 5: API and browser preview

**Goal:** expose the pipeline through HTTP and provide an interactive visual preview.

Deliverables:

- upload/analyze/result endpoints
- route endpoint
- MapLibre preview
- progressive route drawing
- scooter movement/bearing
- media overlays

Exit criteria:

A user can upload media, analyze a trip, and preview the reconstructed journey in a browser without generating a video.

## Milestone 6: Video rendering

**Goal:** export the deterministic preview as a social-media-friendly MP4.

Deliverables:

- deterministic playback mode
- Playwright capture
- FFmpeg composition
- photo/video handling
- 1080x1920 MP4 export

Exit criteria:

The app can export a valid H.264/AAC MP4 matching the browser timeline.

## Milestone 7: Hardening

**Goal:** make the MVP safe and reliable enough for hosted use.

Deliverables:

- limits and validation
- timeout/retry behavior
- temporary-file cleanup
- render job abstraction
- privacy safeguards
- end-to-end fixture coverage
- deployment documentation

Exit criteria:

The MVP handles ordinary failure modes predictably and does not retain uploaded GPS/media data longer than required.

## Current target

The first major engineering target is:

```text
media files -> trip.json + route.geojson
```

Visual polish and video export come after this pipeline is trustworthy.
