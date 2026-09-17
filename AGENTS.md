# AGENTS.md

This file defines implementation rules for humans and coding agents working in this repository.

## Product contract

Trip Recap is metadata-first. The normal workflow must not require users to manually enter coordinates, destinations, or route stops.

Observed facts come from uploaded media metadata. Roads between observations are inferred and must remain distinguishable from observed GPS data.

Missing GPS or timestamps must be represented explicitly. Do not invent metadata to make the pipeline look complete.

## MVP scope

Build the pipeline in this order:

1. metadata extraction
2. trip analysis
3. routing
4. timeline generation
5. browser preview
6. video rendering
7. hardening

Do not add AI, image recognition, automatic music selection, place-name generation, accounts, persistent galleries, or elaborate transition systems unless the milestone plan is explicitly changed.

## Architecture

Keep domain boundaries separate:

- `app/models/`: shared Pydantic/domain models
- `app/metadata/`: EXIF/QuickTime extraction and normalization
- `app/trip/`: validation, observations, segmentation, trip construction
- `app/routing/`: routing abstraction, OSRM, caching, geometry
- `app/timeline/`: deterministic video timeline generation
- `app/api/`: HTTP endpoints only
- `app/renderer/`: browser/video rendering concerns

HTTP handlers should remain thin. Business logic belongs in services/modules, not route functions.

## Python rules

- Target Python 3.12+ unless hosting constraints require otherwise.
- Use type hints on public functions and models.
- Prefer Pydantic models for serialized domain data.
- Prefer `pathlib.Path` over string path manipulation.
- Prefer `httpx` for HTTP clients.
- Keep I/O async where it provides real benefit.
- Do not hide blocking subprocess calls inside async code. Use a thread/process boundary when needed.
- Avoid global mutable application state.

## Metadata rules

Use ExifTool as the primary metadata reader because the app must support JPEG, HEIC, MOV, and MP4 metadata consistently.

Timestamp priority:

Photos:

1. `DateTimeOriginal`
2. `CreateDate`
3. `MediaCreateDate`

Videos:

1. `MediaCreateDate`
2. `TrackCreateDate`
3. `CreateDate`

Filesystem modification time is not a normal capture-time source.

Preserve metadata provenance such as `timestamp_source` so incorrect device metadata can be debugged.

GPS validation must reject impossible coordinate ranges and flag implausible travel speeds rather than silently deleting points.

## Trip analysis rules

- Sort by normalized capture time.
- Cluster nearby media instead of routing between every file.
- Default initial clustering thresholds may use roughly 150 m and 30 minutes, but keep them configurable.
- Trip segmentation should consider both time gaps and geographic discontinuity.
- Timestamp-only media can be associated with a time interval, but its location must remain inferred/unknown.

## Routing rules

- Route pairwise between consecutive observations.
- Use a `Router` abstraction instead of coupling trip code directly to OSRM.
- Initial profile is `driving`.
- Cache route responses using rounded start/end coordinates plus profile.
- Public OSRM is acceptable for development only.
- Preserve `inferred=True` on reconstructed route segments.

## Timeline rules

The timeline must be deterministic and separate from real-world timestamps.

Use nonlinear time compression so long travel gaps remain visible without dominating the video. Keep compression parameters configurable.

Browser preview and video rendering must consume the same timeline model.

## Rendering rules

MapLibre is the preferred map renderer. FFmpeg is the preferred final composition/encoding tool.

Target final output:

- 1080x1920
- 30 FPS
- H.264 video
- AAC audio when audio exists
- MP4 container

Do not make final video generation a synchronous HTTP request once rendering becomes non-trivial.

## Privacy rules

GPS metadata is sensitive.

Default behavior for hosted use should be temporary processing only. Do not persist source media or extracted GPS data beyond what is needed for the requested output unless the user explicitly opts into persistence.

## Testing rules

Every milestone should add focused tests for its domain logic.

Prefer deterministic unit tests and mocked routing responses over live network tests.

Important fixture classes eventually include:

- iPhone HEIC photo
- iPhone MOV video
- Android JPEG
- Android MP4
- media without GPS
- media without capture time
- edited media with changed metadata

## Git rules

- Commit at each milestone boundary.
- Keep commits scoped to the milestone.
- Update `TODO.md` and `MILESTONE.md` when milestone status changes.
- Do not mix visual polish into metadata/routing commits.
- Do not commit uploaded user media, extracted private GPS fixtures, secrets, or generated videos.

## Definition of done

A milestone is complete only when its core implementation is present, its important behavior is testable, and serialized output remains explicit about observed versus inferred data.
