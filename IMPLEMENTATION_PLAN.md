# Metadata-Driven Trip Recap App: Detailed Implementation Plan

Yes. I’d design it as a metadata-first trip reconstruction and video renderer, with the browser UI kept simple and the routing/rendering logic separated cleanly.

## 1. Product definition

The core user flow should be:

```text
Upload photos/videos
        ↓
Extract GPS + timestamps
        ↓
Automatically reconstruct trip
        ↓
Route between GPS observations
        ↓
Generate timeline
        ↓
Preview map animation
        ↓
Generate MP4
        ↓
Download
```

The normal workflow should require **zero manual coordinate or route entry**.

The media metadata is authoritative for observed locations and times. Roads between observations are inferred.

---

# 2. Architecture

I'd separate this into four layers.

```text
┌───────────────────────────────────────────────┐
│                    UI                         │
│ upload / preview / settings / export          │
└──────────────────────┬────────────────────────┘
                       │
┌──────────────────────▼────────────────────────┐
│              Trip reconstruction              │
│ metadata → observations → segments → routes   │
└──────────────────────┬────────────────────────┘
                       │
             ┌─────────┴─────────┐
             ▼                   ▼
┌─────────────────────┐  ┌─────────────────────┐
│      Routing        │  │    Media pipeline   │
│ OSRM / road network │  │ EXIF / video / GPS  │
└──────────┬──────────┘  └──────────┬──────────┘
           └─────────────┬───────────┘
                         ▼
┌───────────────────────────────────────────────┐
│                 Renderer                      │
│ map + route + vehicle + media → frames → MP4  │
└───────────────────────────────────────────────┘
```

Keep these independent. That will make it much easier to replace the Streamlit prototype with a proper web frontend later.

---

# 3. Recommended stack

For the first implementation:

```text
Python 3.12+
FastAPI
Pydantic
ExifTool
Pillow
ffprobe / FFmpeg
Shapely
GeoPandas
OSRM
MapLibre / OpenStreetMap
Playwright
FFmpeg
```

I would **not use OSMnx for production routing**.

OSMnx is useful for experimentation and analysis, but calling a routing engine such as OSRM is cleaner for this application.

For development:

```text
OSRM public API
```

Eventually:

```text
self-hosted OSRM
```

The public instance should not become infrastructure your app depends on at scale.

---

# 4. Project structure

I'd start with something like:

```text
trip-recap/
│
├── app/
│   ├── main.py
│   │
│   ├── models/
│   │   ├── media.py
│   │   ├── trip.py
│   │   ├── route.py
│   │   └── timeline.py
│   │
│   ├── metadata/
│   │   ├── extractor.py
│   │   ├── exiftool.py
│   │   ├── timestamps.py
│   │   └── gps.py
│   │
│   ├── trip/
│   │   ├── builder.py
│   │   ├── segmentation.py
│   │   ├── observations.py
│   │   └── validation.py
│   │
│   ├── routing/
│   │   ├── base.py
│   │   ├── osrm.py
│   │   ├── cache.py
│   │   └── geometry.py
│   │
│   ├── timeline/
│   │   ├── builder.py
│   │   ├── compression.py
│   │   └── events.py
│   │
│   ├── renderer/
│   │   ├── map.py
│   │   ├── camera.py
│   │   ├── media.py
│   │   ├── animation.py
│   │   └── ffmpeg.py
│   │
│   └── api/
│       ├── upload.py
│       ├── trips.py
│       └── render.py
│
├── frontend/
│
├── tests/
│
├── docker/
│
├── pyproject.toml
└── docker-compose.yml
```

That might look like overkill for the first prototype, but the domain boundaries are useful.

---

# 5. Phase 1: Metadata extraction

This should be the first thing implemented and tested thoroughly.

Don't start with video rendering.

Given:

```text
IMG_0012.HEIC
IMG_0013.JPG
IMG_0014.MOV
IMG_0015.JPG
```

produce normalized records.

```python
class MediaPoint(BaseModel):
    id: str

    filename: str
    path: Path

    media_type: Literal["photo", "video"]

    captured_at: datetime

    latitude: float | None
    longitude: float | None

    altitude: float | None = None
    direction: float | None = None

    duration_seconds: float | None = None

    width: int | None = None
    height: int | None = None
```

### Use ExifTool

Run something equivalent to:

```bash
exiftool -json -n files...
```

`-n` is important because we want numeric GPS values rather than formatted strings.

Extract candidates including:

```text
GPSLatitude
GPSLongitude
GPSAltitude

DateTimeOriginal
CreateDate
MediaCreateDate
TrackCreateDate

Duration
ImageWidth
ImageHeight
```

Then normalize the differences between JPEG, HEIC, MOV and MP4.

---

# 6. Timestamp normalization

This is more complicated than it initially appears.

Different devices/files can contain:

```text
DateTimeOriginal
CreateDate
MediaCreateDate
TrackCreateDate
FileModifyDate
```

Define an explicit priority.

For photos:

```text
DateTimeOriginal
    ↓
CreateDate
    ↓
MediaCreateDate
```

For videos:

```text
MediaCreateDate
    ↓
TrackCreateDate
    ↓
CreateDate
```

Avoid using filesystem modification time unless there is absolutely nothing else.

Also preserve:

```python
timestamp_source = "DateTimeOriginal"
```

so debugging metadata problems is possible.

---

# 7. GPS validation

Don't blindly trust EXIF.

Validate:

```python
-90 <= latitude <= 90
-180 <= longitude <= 180
```

Then perform sanity checks between chronological observations.

Calculate:

```text
distance
elapsed time
implied speed
```

For example:

```text
Photo A
27.67, 85.32
10:00

Photo B
28.21, 84.01
10:02
```

If that implies hundreds or thousands of km/h, one of the observations is probably bad.

Mark it:

```python
gps_quality = "suspicious"
```

rather than immediately deleting it.

---

# 8. Build observations

After extraction:

```python
media.sort(key=lambda x: x.captured_at)
```

You now have:

```text
T0  GPS0
T1  GPS1
T2  GPS2
T3  GPS3
...
```

But several photos may have nearly identical GPS coordinates.

Don't route between every single photo.

Cluster nearby observations.

Example:

```text
10:03 photo
10:05 photo
10:07 video
10:09 photo
```

all within 100 metres.

Turn that into:

```text
Observation A

arrival: 10:03
departure: 10:09
location: centroid
media:
    photo
    photo
    video
    photo
```

This makes routing and animation much cleaner.

---

# 9. Observation clustering

Initially use simple thresholds.

Something like:

```python
MAX_CLUSTER_DISTANCE = 150  # metres
MAX_CLUSTER_GAP = 30 * 60   # seconds
```

If consecutive media is:

```text
distance < 150m
AND
time difference < 30m
```

consider it the same location.

Later this can become smarter.

---

# 10. Trip segmentation

Do not assume every uploaded media item belongs to one continuous journey.

Example:

```text
Sep 10  Kathmandu
Sep 10  Charikot
Sep 10  Jiri

Sep 15  Kathmandu
Sep 15  Pokhara
```

Those should probably become separate trips.

Detect boundaries based on:

```text
large timestamp gap
+
location discontinuity
```

For example:

```python
if time_gap > timedelta(hours=12):
    maybe_new_trip()
```

Don't make this one rigid threshold. Eventually calculate a confidence score.

Output:

```python
Trip(
    observations=[...],
    started_at=...,
    ended_at=...,
)
```

---

# 11. Route reconstruction

Now take consecutive observations:

```text
A → B
B → C
C → D
```

Request a route for each pair.

Why pairwise instead of one massive request?

Because you want each section independently cached, validated and replaceable.

```python
route_ab = await router.route(A.location, B.location)
route_bc = await router.route(B.location, C.location)
```

Each segment:

```python
class RouteSegment(BaseModel):
    start_observation_id: str
    end_observation_id: str

    geometry: list[Coordinate]

    distance_meters: float
    duration_seconds: float

    routing_profile: str

    inferred: bool = True
```

The `inferred` distinction matters.

The GPS observations are factual metadata.

The road between them is **our reconstruction**.

---

# 12. OSRM integration

Create an abstraction immediately.

```python
class Router(Protocol):

    async def route(
        self,
        start: Coordinate,
        end: Coordinate,
    ) -> RouteSegment:
        ...
```

Then:

```python
class OSRMRouter:
    ...
```

This allows you to later replace OSRM with:

```text
Valhalla
GraphHopper
Google Directions
Mapbox
self-hosted routing
```

without rewriting trip reconstruction.

---

# 13. Routing profile detection

Initially just assume:

```text
driving
```

since your use case is scooter/road trips.

Later you could infer:

```text
walking
cycling
driving
flight
```

from speed and distance.

But don't build this in V1.

---

# 14. Route cache

Very important.

If:

```text
A → B
```

has already been routed, don't ask OSRM again every time the user changes the video style.

Cache based on rounded coordinates:

```text
route:
27.67431,85.31827
→
27.66295,86.05842
```

Hash:

```python
sha256(
    f"{start}:{end}:{profile}"
)
```

Store resulting GeoJSON.

---

# 15. Construct the complete trip geometry

Once all segments exist:

```text
Observation A
      │
      ╰─────────────╮
                    │
                route AB
                    │
                    ▼
              Observation B
                    │
                route BC
                    │
                    ▼
              Observation C
```

Combine them into a `LineString`.

Shapely is ideal here.

```python
from shapely.geometry import LineString
```

Now the trip has:

```python
trip.route_geometry
trip.total_distance
trip.bounds
```

---

# 16. Match media to route

Even though the media created the route, explicitly project every media location onto the resulting route.

With Shapely:

```python
distance_along_route = route.project(photo_point)
```

Normalize it:

```python
progress = distance_along_route / route.length
```

Now every media item gets:

```text
photo A → 0.00
photo B → 0.18
video C → 0.31
photo D → 0.67
photo E → 1.00
```

This becomes extremely useful for animation.

---

# 17. Build a trip timeline

This should be a separate representation from geographic distance.

Example real trip:

```text
08:00 Kathmandu
10:00 photo
12:30 Charikot
13:00 lunch
16:00 Jiri
```

You don't want a 1:1 real-time video.

Define:

```python
class TimelineEvent:
    video_time: float
    type: EventType
    payload: dict
```

Events:

```text
ROUTE_START
MOVE
MEDIA_SHOW
MEDIA_HIDE
LOCATION_ARRIVAL
LOCATION_DEPARTURE
CAMERA_ZOOM
ROUTE_END
```

---

# 18. Time compression

This is one of the most important pieces for making the result feel good.

Don't simply do:

```python
video_time = real_time / 100
```

Instead use nonlinear compression.

For example:

```text
2 minute gap       → 1 sec
30 minute gap      → 3 sec
2 hour gap         → 5 sec
8 hour gap         → 7 sec
```

You could use something like:

```python
video_duration = a * log(1 + real_duration)
```

Then clamp:

```python
MIN_SEGMENT_DURATION = 1.5
MAX_SEGMENT_DURATION = 8
```

That keeps long drives visible without making the video boring.

---

# 19. Media display rules

Photos:

```text
fade in
hold
fade out
```

Maybe:

```text
0.4s fade in
2.5s display
0.4s fade out
```

Videos:

Don't necessarily play the entire video.

For V1:

```text
maximum clip length = 5 seconds
```

If the source is 30 seconds:

```text
take first 5 sec
```

Later you can add automatic highlight selection.

---

# 20. Multiple media at one location

If five pictures were taken within a few minutes:

Don't do:

```text
map
photo
map
photo
map
photo
```

Instead treat it as a media cluster.

Example:

```text
         📷
      📷 📷
        📷
         │
         ●
```

Animation:

```text
arrive
↓
photo 1
↓
photo 2
↓
short video
↓
continue trip
```

Or use a quick collage.

---

# 21. Map renderer

For the final app I'd use **MapLibre GL JS**.

The Python backend sends:

```json
{
  "route": {
    "type": "LineString",
    "coordinates": []
  },
  "observations": [],
  "timeline": []
}
```

MapLibre handles:

```text
map
route
vehicle marker
camera
zoom
bearing
location markers
```

This is much better visually than rendering maps with Matplotlib.

---

# 22. Route drawing animation

Don't show the complete route immediately.

At progress `p`:

```text
0%  ●

20% ●════🛵

50% ●════════════════🛵

100%●════════════════════════════🏁
```

The traveled route is visible.

The future route can either be hidden or shown very faintly.

I prefer hidden for the recap effect.

---

# 23. Vehicle movement

Interpolate over the GeoJSON route.

Don't interpolate simply between the observation GPS points.

Use:

```text
OSRM geometry
```

so the scooter follows turns in the road.

Calculate heading from consecutive coordinates and rotate the scooter accordingly.

```python
bearing(p1, p2)
```

Then:

```text
🛵 →
🛵 ↗
🛵 ↑
```

depending on direction.

---

# 24. Camera system

A static camera will look boring.

Implement three camera modes.

### Follow

Camera follows the scooter.

### Arrival

When approaching important media clusters:

```text
zoom in
slow movement
show media
```

### Overview

At the beginning/end:

```text
zoom out
show complete route
```

Timeline:

```text
overview
   ↓
zoom into start
   ↓
follow vehicle
   ↓
arrival
   ↓
media
   ↓
follow vehicle
   ↓
...
   ↓
final overview
```

---

# 25. Media presentation

I wouldn't permanently pin every photo on the map.

It becomes cluttered.

Instead:

```text
┌───────────────────────┐
│                       │
│        PHOTO          │
│                       │
└───────────────────────┘
           │
           │
           ●
      ═════🛵════
```

Animate the photo from its GPS location into a larger card.

After display:

```text
fade/shrink back
```

Then continue.

---

# 26. Rendering strategy

There are two viable approaches.

For V1 I'd use:

```text
MapLibre web renderer
        ↓
Playwright
        ↓
capture frames
        ↓
FFmpeg
        ↓
MP4
```

This gives you a browser-quality map.

Resolution:

```text
1080 × 1920
```

FPS:

```text
30
```

Output:

```text
H.264
AAC
MP4
```

Ideal for Instagram/Reels/TikTok.

---

# 27. Don't screenshot every frame individually

That will be painfully slow.

Eventually use browser video capture or render sequences efficiently.

For the initial prototype screenshots are acceptable.

Then optimize once the animation is correct.

---

# 28. FFmpeg composition

FFmpeg should handle:

```text
video clips
photo scaling
transitions
music
audio normalization
final encoding
```

The map renderer should primarily produce the animated geographic layer.

Think:

```text
Layer 1    Map
Layer 2    Route
Layer 3    Scooter
Layer 4    Photo/video
Layer 5    Location/date text
Layer 6    Music
```

Then composite.

---

# 29. Metadata privacy

This is especially important because GPS metadata is sensitive.

Default behavior:

```text
upload
↓
temporary processing
↓
render
↓
download
↓
delete source files
↓
delete extracted GPS
```

Don't create a database of people's photo locations unless persistence is explicitly enabled.

---

# 30. Missing GPS

You'll encounter this immediately.

WhatsApp, Instagram, screenshots and edited photos frequently don't contain GPS.

Represent that explicitly:

```python
location = None
```

Don't invent one.

But timestamp-only media can still be useful.

Example:

```text
10:00 GPS photo A

10:05 screenshot
10:07 photo without GPS

10:15 GPS photo B
```

You can attach the timestamp-only media to the trip interval:

```text
A ─────────────── B
       ↑    ↑
      IMG  IMG
```

But mark location as inferred rather than known.

---

# 31. Missing timestamps

Same principle.

If no reliable capture timestamp exists:

```text
metadata_status = incomplete
```

Don't silently substitute file modification date and pretend it's capture time.

The UI can show:

```text
37 media files

34 located
35 timestamped
2 missing GPS
1 missing capture time
```

---

# 32. API design

I would expose something roughly like:

```text
POST /trips
POST /trips/{id}/media

POST /trips/{id}/analyze
GET  /trips/{id}

POST /trips/{id}/route
GET  /trips/{id}/route

POST /trips/{id}/render
GET  /renders/{id}

GET  /renders/{id}/video
```

But internally analysis should probably perform:

```text
metadata
↓
observations
↓
segmentation
↓
routing
↓
timeline
```

as one pipeline.

---

# 33. Job processing

Rendering should **not happen inside an HTTP request**.

Eventually:

```text
FastAPI
   │
   ▼
Job queue
   │
   ▼
Renderer worker
   │
   ├── Playwright
   └── FFmpeg
```

For your prototype you can use:

```python
asyncio.create_task()
```

or a simple process worker.

Later:

```text
Redis
+
ARQ / Dramatiq / Celery
```

I'd personally use Dramatiq or ARQ rather than introducing Celery unless necessary.

---

# 34. Storage

For the free/self-contained version:

```text
/tmp/trip-{uuid}/

    uploads/
    metadata.json
    route.geojson
    timeline.json
    render/
    trip.mp4
```

Delete the directory after:

```text
1 hour
```

or after download.

For hosted persistence later:

```text
Cloudflare R2
```

would be a reasonable object-store choice.

---

# 35. UI

I'd keep V1 extremely small.

### Screen 1

```text
Create Trip

┌──────────────────────────────┐
│                              │
│  Drop photos & videos here   │
│                              │
└──────────────────────────────┘

          Continue
```

### Screen 2

Analysis:

```text
Analyzing your trip...

✓ 87 media files
✓ 82 GPS locations
✓ Sep 12 → Sep 14
✓ Road route reconstructed
✓ 412 km

[ map preview ]
```

### Screen 3

Basic controls:

```text
Video length
○ 30 sec
● 60 sec
○ 90 sec

Vehicle
🛵

Photos
● Cards
○ Full screen

[ Generate Video ]
```

Don't expose twenty animation settings initially.

---

# 36. Preview before rendering

Generating a full MP4 is expensive.

The browser should be able to play the timeline directly:

```text
MapLibre
+
timeline JSON
+
local media
```

So:

```text
Generate preview
```

costs almost nothing.

Only:

```text
Export MP4
```

starts the renderer.

---

# 37. Data model

At the center I'd have:

```python
class Trip(BaseModel):
    id: UUID

    started_at: datetime
    ended_at: datetime

    media: list[MediaPoint]
    observations: list[Observation]
    segments: list[RouteSegment]

    route: Route
    timeline: Timeline

    stats: TripStats
```

And:

```python
class TripStats(BaseModel):
    media_count: int
    photo_count: int
    video_count: int

    gps_media_count: int

    distance_meters: float
    real_duration_seconds: float
    video_duration_seconds: float
```

---

# 38. Important intermediate artifact

Make the whole pipeline serializable.

After analysis, produce:

```text
trip.json
```

Containing everything except binary media.

That means you can debug:

```text
metadata
observations
routes
timeline
```

without rerunning EXIF extraction or routing.

This will save a huge amount of development time.

---

# 39. Testing strategy

Metadata extraction deserves a fixture library.

Have:

```text
tests/media/

iphone-photo.heic
iphone-video.mov
android-photo.jpg
android-video.mp4
no-gps.jpg
no-date.jpg
edited-photo.jpg
```

Then unit-test normalization.

Also test trip reconstruction with synthetic data.

```text
A → B → C
```

where expected ordering and segmentation are known.

---

# 40. Implementation sequence

I would build it in this exact order:

1. **Metadata extractor**: JPEG/HEIC/MOV/MP4 → normalized `MediaPoint`.
2. **Trip analyzer**: chronological sorting, validation, clustering, trip segmentation.
3. **Routing engine**: OSRM pairwise routing, caching, complete GeoJSON.
4. **Timeline generator**: map real timestamps into compressed video time and generate media events.
5. **Browser preview**: MapLibre route, moving 🛵, progressive route drawing, photo/video overlays.
6. **Video renderer**: deterministic playback, Playwright capture, FFmpeg composition, 1080×1920 MP4.
7. **Web app**: upload, analysis summary, preview, render, download.
8. **Deployment hardening**: temporary storage cleanup, upload limits, routing limits, job queue, privacy controls.

---

## MVP boundary

I'd resist adding AI, automatic music selection, image recognition, place-name generation, highlight detection, fancy transitions, user accounts, or persistent galleries yet.

The MVP is successful when you can drop **50 original iPhone photos/videos from a road trip** into the app and, without entering a single coordinate or destination, get:

```text
original media
      ↓
GPS + timestamp metadata
      ↓
chronological observations
      ↓
inferred road route
      ↓
🛵 animated journey
      ↓
photos/videos appear where they were captured
      ↓
1080 × 1920 MP4
```

Once that works reliably, the fancy MapRecap-style presentation is mostly a rendering problem rather than a trip-reconstruction problem.

The first engineering milestone I'd target is therefore **`media files → trip.json + route.geojson`**. Once that output is correct for a real trip, everything visual can be iterated independently.
