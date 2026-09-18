from __future__ import annotations

import asyncio
import json
import shutil
from datetime import timedelta
from io import BytesIO
from pathlib import Path
from uuid import uuid4

import pillow_heif
import streamlit as st
import streamlit.components.v1 as components
from PIL import Image, ImageOps, UnidentifiedImageError

from app.config import settings
from app.geocoding import NominatimReverseGeocoder
from app.metadata.extractor import SUPPORTED_EXTENSIONS, ExifToolExtractor
from app.routing.builder import build_route, project_observation_progress
from app.routing.cache import RouteCache
from app.routing.osrm import OSRMRouter
from app.storage import TripStore
from app.timeline.builder import TimelineBuilder
from app.trip.builder import TripBuilder

pillow_heif.register_heif_opener()

IMAGE_PREVIEW_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"}
VIDEO_PREVIEW_EXTENSIONS = {".mov", ".mp4", ".m4v"}

PLACE_GRANULARITY_OPTIONS = {
    "Specific": "specific",
    "Neighborhood": "neighborhood",
    "City / Town": "city",
    "Region": "region",
}

VEHICLE_ICONS = {
    "Scooter": "🛵",
    "Car": "🚗",
    "Motorcycle": "🏍️",
    "Bicycle": "🚲",
    "Jeep": "🚙",
}

MAP_TEMPLATE = r"""<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <link href="https://unpkg.com/maplibre-gl@5/dist/maplibre-gl.css" rel="stylesheet">
  <script src="https://unpkg.com/maplibre-gl@5/dist/maplibre-gl.js"></script>
  <style>
    html, body, #map {
      height: 100%;
      margin: 0;
      background: #0b0d10;
      overflow: hidden;
    }
    #map {
      position: absolute;
      inset: 0;
    }
    #controls {
      position: absolute;
      z-index: 5;
      top: 12px;
      left: 12px;
      display: flex;
      gap: 8px;
    }
    button {
      border: 0;
      border-radius: 8px;
      padding: 9px 13px;
      background: white;
      color: #111;
      font: 600 13px system-ui, sans-serif;
      cursor: pointer;
      box-shadow: 0 4px 18px #0004;
    }
    .vehicle {
      font-size: 30px;
      line-height: 1;
      animation: vehicle-bob .55s ease-in-out infinite alternate;
      filter: drop-shadow(0 3px 4px rgba(0,0,0,.45));
      user-select: none;
    }
    @keyframes vehicle-bob {
      from { transform: translateY(0); }
      to { transform: translateY(-2px); }
    }
    .observation-wrap {
      display: flex;
      align-items: center;
      gap: 6px;
      white-space: nowrap;
      pointer-events: none;
    }
    .observation-dot {
      width: 11px;
      height: 11px;
      border-radius: 50%;
      background: white;
      border: 3px solid #111827;
      box-shadow: 0 2px 8px #0008;
      flex: 0 0 auto;
    }
    .place-label {
      background: rgba(17,24,39,.92);
      color: white;
      border-radius: 7px;
      padding: 4px 8px;
      font: 600 11px system-ui, sans-serif;
      box-shadow: 0 2px 8px rgba(0,0,0,.4);
      max-width: 190px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  </style>
</head>
<body>
  <div id="map"></div>
  <div id="controls">
    <button id="replay">Replay route</button>
    <button id="fit">Fit route</button>
  </div>

  <script>
    const route = __ROUTE_JSON__;
    const observations = __OBSERVATIONS_JSON__;
    const vehicleIcon = __VEHICLE_JSON__;
    const coords = route.geometry.coordinates || [];

    const initialCenter = coords.length ? coords[0] : [85.324, 27.676];

    const map = new maplibregl.Map({
      container: "map",
      style: "https://tiles.openfreemap.org/styles/liberty",
      center: initialCenter,
      zoom: coords.length ? 8 : 6,
      attributionControl: true,
      dragPan: true,
      dragRotate: false,
      keyboard: true,
      boxZoom: true,
      scrollZoom: true,
      touchPitch: false,
      pitchWithRotate: false
    });

    map.dragPan.enable();
    map.scrollZoom.enable();
    map.touchZoomRotate.enable();
    map.touchZoomRotate.disableRotation();
    map.addControl(
      new maplibregl.NavigationControl({ showCompass: false, visualizePitch: false }),
      "top-right"
    );

    let vehicleMarker = null;
    let raf = null;
    let routeBounds = null;
    let fittedZoom = null;

    function segmentDistance(a, b) {
      const toRad = value => value * Math.PI / 180;
      const lat1 = toRad(a[1]);
      const lat2 = toRad(b[1]);
      const dLat = toRad(b[1] - a[1]);
      const dLon = toRad(b[0] - a[0]);
      const h =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
      return 6371008.8 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
    }

    const cumulative = [0];
    for (let index = 1; index < coords.length; index++) {
      cumulative.push(
        cumulative[index - 1] + segmentDistance(coords[index - 1], coords[index])
      );
    }
    const totalDistance = cumulative[cumulative.length - 1] || 0;

    function positionAt(progress) {
      if (!coords.length) return null;
      if (coords.length === 1) return { point: coords[0], index: 0 };

      const target = Math.max(0, Math.min(1, progress)) * totalDistance;
      let index = 0;

      while (
        index < cumulative.length - 2 &&
        cumulative[index + 1] < target
      ) {
        index += 1;
      }

      const a = coords[index];
      const b = coords[index + 1];
      const segmentStart = cumulative[index];
      const segmentEnd = cumulative[index + 1];
      const segmentLength = Math.max(segmentEnd - segmentStart, 0.000001);
      const t = Math.max(
        0,
        Math.min(1, (target - segmentStart) / segmentLength)
      );

      return {
        point: [
          a[0] + (b[0] - a[0]) * t,
          a[1] + (b[1] - a[1]) * t
        ],
        index
      };
    }

    function setProgress(progress) {
      const result = positionAt(progress);
      if (!result || !vehicleMarker) return;

      vehicleMarker.setLngLat(result.point);

      const traveled = coords
        .slice(0, result.index + 1)
        .concat([result.point]);

      const source = map.getSource("traveled");
      if (source) {
        source.setData({
          type: "Feature",
          properties: {},
          geometry: {
            type: "LineString",
            coordinates: traveled
          }
        });
      }
    }

    function easeInOut(t) {
      return t < 0.5
        ? 2 * t * t
        : 1 - Math.pow(-2 * t + 2, 2) / 2;
    }

    function routeStops() {
      const values = observations
        .map(item => Number(item.progress))
        .filter(value => Number.isFinite(value))
        .map(value => Math.max(0, Math.min(1, value)))
        .sort((a, b) => a - b);

      const unique = [];
      for (const value of values) {
        if (
          !unique.length ||
          Math.abs(value - unique[unique.length - 1]) > 0.003
        ) {
          unique.push(value);
        }
      }

      if (!unique.length || unique[0] > 0.001) unique.unshift(0);
      if (unique[unique.length - 1] < 0.999) unique.push(1);
      return unique;
    }

    function animationPhases() {
      const stops = routeStops();
      const phases = [];
      const travelMs = 14000;
      const pauseMs = 1800;

      for (let index = 0; index < stops.length - 1; index++) {
        const from = stops[index];
        const to = stops[index + 1];

        phases.push({
          type: "move",
          from,
          to,
          duration: Math.max(
            700,
            travelMs * Math.max(to - from, 0.035)
          )
        });

        if (index + 1 < stops.length - 1) {
          phases.push({
            type: "pause",
            at: to,
            duration: pauseMs
          });
        }
      }

      return phases;
    }

    function replay() {
      if (raf) cancelAnimationFrame(raf);
      if (coords.length < 2) return;

      const phases = animationPhases();
      const totalDuration = phases.reduce(
        (sum, phase) => sum + phase.duration,
        0
      );
      const started = performance.now();

      function frame(now) {
        let remaining = Math.min(totalDuration, now - started);
        let progress = 0;

        for (const phase of phases) {
          if (remaining > phase.duration) {
            remaining -= phase.duration;
            progress = phase.type === "move" ? phase.to : phase.at;
            continue;
          }

          if (phase.type === "pause") {
            progress = phase.at;
          } else {
            const t = Math.max(
              0,
              Math.min(1, remaining / phase.duration)
            );
            progress =
              phase.from +
              (phase.to - phase.from) * easeInOut(t);
          }
          break;
        }

        setProgress(progress);

        if (now - started < totalDuration) {
          raf = requestAnimationFrame(frame);
        }
      }

      raf = requestAnimationFrame(frame);
    }

    function paddedBounds(bounds) {
      const west = bounds.getWest();
      const east = bounds.getEast();
      const south = bounds.getSouth();
      const north = bounds.getNorth();

      const lonPad = Math.max((east - west) * 0.35, 0.01);
      const latPad = Math.max((north - south) * 0.35, 0.01);

      return [
        [west - lonPad, south - latPad],
        [east + lonPad, north + latPad]
      ];
    }

    function fitRoute() {
      if (!routeBounds) return;
      map.resize();
      map.fitBounds(routeBounds, {
        padding: {
          top: 90,
          right: 90,
          bottom: 110,
          left: 90
        },
        duration: 350
      });
    }

    map.on("load", () => {
      map.addSource("route", {
        type: "geojson",
        data: route
      });

      map.addLayer({
        id: "route",
        type: "line",
        source: "route",
        paint: {
          "line-color": "#6b7280",
          "line-width": 5,
          "line-opacity": 0.45
        }
      });

      map.addSource("traveled", {
        type: "geojson",
        data: {
          type: "Feature",
          properties: {},
          geometry: {
            type: "LineString",
            coordinates: []
          }
        }
      });

      map.addLayer({
        id: "traveled",
        type: "line",
        source: "traveled",
        paint: {
          "line-color": "#111827",
          "line-width": 7
        }
      });

      for (const observation of observations) {
        const wrap = document.createElement("div");
        wrap.className = "observation-wrap";

        const dot = document.createElement("div");
        dot.className = "observation-dot";

        const label = document.createElement("div");
        label.className = "place-label";
        label.textContent = observation.name;

        wrap.appendChild(dot);
        wrap.appendChild(label);

        new maplibregl.Marker({
          element: wrap,
          anchor: "left"
        })
          .setLngLat([observation.lon, observation.lat])
          .addTo(map);
      }

      const boundsCoords = coords.length
        ? coords
        : observations.map(item => [item.lon, item.lat]);

      if (boundsCoords.length > 1) {
        routeBounds = boundsCoords.reduce(
          (bounds, coordinate) => bounds.extend(coordinate),
          new maplibregl.LngLatBounds(boundsCoords[0], boundsCoords[0])
        );

        map.setMaxBounds(paddedBounds(routeBounds));

        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            map.resize();
            map.fitBounds(routeBounds, {
              padding: {
                top: 90,
                right: 90,
                bottom: 110,
                left: 90
              },
              duration: 0
            });

            fittedZoom = map.getZoom();
            map.setMinZoom(Math.max(2, fittedZoom - 1.5));
          });
        });
      } else if (boundsCoords.length === 1) {
        routeBounds = new maplibregl.LngLatBounds(
          boundsCoords[0],
          boundsCoords[0]
        );
        map.setCenter(boundsCoords[0]);
        map.setZoom(14);
        map.setMinZoom(11);

        const [lon, lat] = boundsCoords[0];
        map.setMaxBounds([
          [lon - 0.08, lat - 0.08],
          [lon + 0.08, lat + 0.08]
        ]);
      }

      if (coords.length) {
        const el = document.createElement("div");
        el.className = "vehicle";
        el.textContent = vehicleIcon;

        vehicleMarker = new maplibregl.Marker({
          element: el,
          rotationAlignment: "viewport",
          pitchAlignment: "viewport"
        })
          .setLngLat(coords[0])
          .addTo(map);

        replay();
      }
    });

    document
      .getElementById("replay")
      .addEventListener("click", replay);

    document
      .getElementById("fit")
      .addEventListener("click", fitRoute);
  </script>
</body>
</html>
"""


def _unique_upload_target(upload_dir: Path, original_name: str) -> Path:
    name = Path(original_name).name
    candidate = upload_dir / name
    if not candidate.exists():
        return candidate

    stem = Path(name).stem
    suffix = Path(name).suffix
    counter = 2
    while True:
        candidate = upload_dir / f"{stem}-{counter}{suffix}"
        if not candidate.exists():
            return candidate
        counter += 1


def _save_uploads(files, upload_dir: Path) -> list[Path]:
    paths: list[Path] = []
    for uploaded in files:
        name = Path(uploaded.name).name
        suffix = Path(name).suffix.lower()
        if suffix not in SUPPORTED_EXTENSIONS:
            raise ValueError(f"Unsupported media type: {name}")

        data = uploaded.getbuffer()
        if len(data) > settings.max_file_bytes:
            raise ValueError(f"File too large: {name}")

        target = _unique_upload_target(upload_dir, name)
        target.write_bytes(data)
        paths.append(target)

    return paths


def _human_size(num_bytes: int) -> str:
    size = float(num_bytes)
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return f"{size:.1f} {unit}"
        size /= 1024
    return f"{num_bytes} B"


def _render_media_previews(files) -> None:
    if not files:
        return

    with st.expander("Media preview", expanded=True):
        columns = st.columns(4)

        for index, uploaded in enumerate(files):
            suffix = Path(uploaded.name).suffix.lower()
            data = uploaded.getvalue()

            with columns[index % len(columns)]:
                st.caption(
                    f"{uploaded.name} · {_human_size(len(data))}"
                )

                if suffix in IMAGE_PREVIEW_EXTENSIONS:
                    try:
                        image = Image.open(BytesIO(data))
                        image = ImageOps.exif_transpose(image)
                        st.image(
                            image,
                            use_container_width=True,
                        )
                    except (
                        UnidentifiedImageError,
                        OSError,
                        ValueError,
                    ):
                        st.info("Image preview unavailable")
                elif suffix in VIDEO_PREVIEW_EXTENSIONS:
                    st.video(data)
                else:
                    st.info("Preview unavailable")


def _analyze(
    files,
    *,
    keep_as_one_trip: bool = True,
    place_granularity: str = "neighborhood",
) -> list[dict]:
    store = TripStore()
    store.cleanup_expired(settings.data_ttl_seconds)

    workspace_id = str(uuid4())
    workspace = store.workspace(workspace_id)
    upload_dir = workspace / "uploads"

    try:
        paths = _save_uploads(files, upload_dir)
        media = ExifToolExtractor().extract_sync(paths)

        trip_gap = (
            timedelta(days=36500)
            if keep_as_one_trip
            else timedelta(hours=12)
        )
        trips = TripBuilder(trip_gap=trip_gap).build(media)

        if not trips:
            raise ValueError(
                "No supported media metadata could be analyzed."
            )

        results: list[dict] = []

        for trip in trips:
            route = None
            route_error = None

            if len(trip.observations) >= 2:
                router = OSRMRouter(
                    cache=RouteCache(store.route_cache_dir),
                    timeout_seconds=settings.route_timeout_seconds,
                    max_attempts=settings.route_attempts,
                )
                try:
                    route = asyncio.run(build_route(trip, router))
                except Exception as exc:
                    route_error = str(exc)

            geocoder = NominatimReverseGeocoder(
                store.root / "cache" / "places"
            )
            place_names: dict[str, str] = {}

            for observation in trip.observations:
                try:
                    place_names[observation.id] = (
                        geocoder.reverse(
                            observation.latitude,
                            observation.longitude,
                            granularity=place_granularity,
                        )
                        or "Unknown place"
                    )
                except Exception:
                    place_names[observation.id] = "Unknown place"

            timeline = TimelineBuilder().build(trip)

            store.persist_trip_media(trip)
            store.save_trip(trip)
            store.save_timeline(trip.id, timeline)

            if route is not None:
                store.save_route(trip.id, route)

            results.append(
                {
                    "trip": trip,
                    "route": route,
                    "timeline": timeline,
                    "route_error": route_error,
                    "place_names": place_names,
                    "place_granularity": place_granularity,
                }
            )

        return results
    finally:
        shutil.rmtree(workspace, ignore_errors=True)


def _map_html(
    trip,
    route,
    place_names: dict[str, str],
    vehicle: str,
) -> str:
    observations = []

    for index, observation in enumerate(trip.observations):
        if route is not None:
            progress = project_observation_progress(
                route,
                observation,
            )
        elif len(trip.observations) > 1:
            progress = index / (len(trip.observations) - 1)
        else:
            progress = 0.0

        observations.append(
            {
                "id": observation.id,
                "lat": observation.latitude,
                "lon": observation.longitude,
                "media_count": len(observation.media_ids),
                "name": place_names.get(
                    observation.id,
                    "Unknown place",
                ),
                "progress": progress,
            }
        )

    if route is not None:
        route_geojson = route.as_geojson()
    else:
        coordinates = [
            [item["lon"], item["lat"]]
            for item in observations
        ]
        route_geojson = {
            "type": "Feature",
            "properties": {"inferred": False},
            "geometry": {
                "type": "LineString",
                "coordinates": coordinates,
            },
        }

    return (
        MAP_TEMPLATE
        .replace(
            "__ROUTE_JSON__",
            json.dumps(route_geojson),
        )
        .replace(
            "__OBSERVATIONS_JSON__",
            json.dumps(observations),
        )
        .replace(
            "__VEHICLE_JSON__",
            json.dumps(vehicle),
        )
    )


def _render_json_viewer(trip, route, timeline) -> None:
    with st.expander("View generated JSON", expanded=False):
        trip_tab, route_tab, timeline_tab = st.tabs(
            [
                "trip.json",
                "route.geojson",
                "timeline.json",
            ]
        )

        with trip_tab:
            st.json(trip.model_dump(mode="json"))

        with route_tab:
            if route is None:
                st.info("No routed GeoJSON is available.")
            else:
                st.json(route.as_geojson())

        with timeline_tab:
            st.json(timeline.model_dump(mode="json"))


def _render_optional_downloads(trip, route, timeline) -> None:
    with st.expander("Optional downloads", expanded=False):
        columns = st.columns(3)

        columns[0].download_button(
            "Download trip.json",
            trip.model_dump_json(indent=2),
            file_name=f"{trip.id}-trip.json",
            mime="application/json",
            key=f"trip-json-{trip.id}",
            use_container_width=True,
        )

        if route is not None:
            columns[1].download_button(
                "Download route.geojson",
                json.dumps(route.as_geojson(), indent=2),
                file_name=f"{trip.id}-route.geojson",
                mime="application/geo+json",
                key=f"route-json-{trip.id}",
                use_container_width=True,
            )

        columns[2].download_button(
            "Download timeline.json",
            timeline.model_dump_json(indent=2),
            file_name=f"{trip.id}-timeline.json",
            mime="application/json",
            key=f"timeline-json-{trip.id}",
            use_container_width=True,
        )


def _render_result(
    result: dict,
    index: int,
    vehicle: str,
) -> None:
    trip = result["trip"]
    route = result["route"]
    timeline = result["timeline"]
    route_error = result["route_error"]
    place_names = result["place_names"]

    st.subheader(f"Trip {index + 1}")

    distance_meters = (
        route.distance_meters
        if route is not None
        else trip.stats.distance_meters
    )
    distance_km = distance_meters / 1000

    segment_count = (
        len(route.segments)
        if route is not None
        else max(len(trip.observations) - 1, 0)
    )

    col1, col2, col3, col4, col5 = st.columns(5)
    col1.metric("Media", trip.stats.media_count)
    col2.metric("GPS media", trip.stats.gps_media_count)
    col3.metric("Stops", len(trip.observations))
    col4.metric("Segments", segment_count)
    col5.metric("Route", f"{distance_km:.1f} km")

    if len(trip.observations) >= 2:
        source = (
            "OSRM road routing"
            if route is not None
            else "straight GPS fallback"
        )
        st.success(
            f"Route determined from "
            f"{trip.stats.gps_media_count} geotagged media, "
            f"ordered by capture time, across "
            f"{len(trip.observations)} stops using {source}."
        )
    elif len(trip.observations) == 1:
        st.info(
            "Only one distinct GPS stop was found. "
            "At least two stops are needed to determine a route."
        )

    if trip.started_at and trip.ended_at:
        st.caption(
            f"{trip.started_at} to {trip.ended_at}"
        )

    if route_error:
        st.warning(
            "Road routing failed, so the preview falls back "
            "to observed GPS points. "
            f"Routing error: {route_error}"
        )

    if len(trip.observations) == 0:
        st.warning(
            "No usable GPS observations were found in this trip."
        )
    else:
        components.html(
            _map_html(
                trip,
                route,
                place_names,
                vehicle,
            ),
            height=700,
            scrolling=False,
        )

        media_by_id = {
            item.id: item.filename
            for item in trip.media
        }

        with st.expander("Route observations"):
            rows = []

            for observation_index, observation in enumerate(
                trip.observations
            ):
                filenames = [
                    media_by_id[media_id]
                    for media_id in observation.media_ids
                    if media_id in media_by_id
                ]

                rows.append(
                    {
                        "order": observation_index + 1,
                        "place": place_names.get(
                            observation.id,
                            "Unknown place",
                        ),
                        "media_files": ", ".join(filenames),
                        "captured_at": observation.arrival,
                        "latitude": round(
                            observation.latitude,
                            6,
                        ),
                        "longitude": round(
                            observation.longitude,
                            6,
                        ),
                        "media_count": len(
                            observation.media_ids
                        ),
                    }
                )

            st.dataframe(
                rows,
                use_container_width=True,
                hide_index=True,
            )

    warnings = [
        f"{item.filename}: "
        f"{', '.join(item.metadata_warnings)}"
        for item in trip.media
        if item.metadata_warnings
    ]

    if warnings:
        with st.expander("Metadata warnings"):
            for warning in warnings:
                st.write(warning)

    _render_json_viewer(
        trip,
        route,
        timeline,
    )
    _render_optional_downloads(
        trip,
        route,
        timeline,
    )


def render_app() -> None:
    st.set_page_config(
        page_title="Trip Recap",
        page_icon="🛵",
        layout="wide",
    )

    st.title("Trip Recap")
    st.write(
        "Upload original photos or videos. "
        "The app reads capture time and GPS metadata, "
        "reconstructs the road trip, and builds an "
        "animated route automatically."
    )

    uploaded_files = st.file_uploader(
        "Drop all photos and videos from the trip",
        type=[
            "jpg",
            "jpeg",
            "heic",
            "heif",
            "png",
            "webp",
            "mov",
            "mp4",
            "m4v",
        ],
        accept_multiple_files=True,
        help=(
            "Use original files when possible so GPS "
            "and capture metadata are preserved."
        ),
    )

    if uploaded_files:
        st.caption(
            f"{len(uploaded_files)} media files selected. "
            "They will be ordered by capture timestamp."
        )
        _render_media_previews(uploaded_files)

    control_1, control_2, control_3 = st.columns(3)

    with control_1:
        keep_as_one_trip = st.toggle(
            "Treat all selected media as one trip",
            value=True,
            help=(
                "Turn this off to split uploads into "
                "separate trips when there is a gap "
                "longer than 12 hours."
            ),
        )

    with control_2:
        vehicle_label = st.selectbox(
            "Animation vehicle",
            options=list(VEHICLE_ICONS),
            index=0,
        )

    with control_3:
        place_detail_label = st.selectbox(
            "Place-name detail",
            options=list(PLACE_GRANULARITY_OPTIONS),
            index=1,
            help=(
                "Specific favors roads or named places. "
                "Neighborhood favors local areas. "
                "City / Town and Region are broader."
            ),
        )

    vehicle = VEHICLE_ICONS[vehicle_label]
    place_granularity = (
        PLACE_GRANULARITY_OPTIONS[place_detail_label]
    )

    analyze = st.button(
        "Determine route",
        type="primary",
        disabled=not uploaded_files,
        use_container_width=True,
    )

    if analyze:
        if len(uploaded_files) > settings.max_files:
            st.error(
                f"Maximum {settings.max_files} files per trip."
            )
        else:
            try:
                with st.spinner(
                    "Reading metadata and reconstructing "
                    "the trip..."
                ):
                    st.session_state["trip_results"] = _analyze(
                        uploaded_files,
                        keep_as_one_trip=keep_as_one_trip,
                        place_granularity=place_granularity,
                    )
            except Exception as exc:
                st.session_state.pop(
                    "trip_results",
                    None,
                )
                st.exception(exc)

    results = st.session_state.get("trip_results")

    if results:
        st.divider()
        for result_index, result in enumerate(results):
            _render_result(
                result,
                result_index,
                vehicle,
            )

    st.caption(
        "GPS metadata is processed temporarily. "
        "No manual coordinates or route stops are required."
    )


if __name__ == "__main__":
    render_app()
