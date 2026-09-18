from __future__ import annotations

import asyncio
import json
import shutil
from datetime import timedelta
from pathlib import Path
from uuid import uuid4

import streamlit as st
import streamlit.components.v1 as components

from app.config import settings
from app.geocoding import NominatimReverseGeocoder
from app.metadata.extractor import SUPPORTED_EXTENSIONS, ExifToolExtractor
from app.routing.builder import build_route, project_observation_progress
from app.routing.cache import RouteCache
from app.routing.osrm import OSRMRouter
from app.storage import TripStore
from app.timeline.builder import TimelineBuilder
from app.trip.builder import TripBuilder


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


def _analyze(files, *, keep_as_one_trip: bool = True) -> list[dict]:
    store = TripStore()
    store.cleanup_expired(settings.data_ttl_seconds)

    workspace_id = str(uuid4())
    workspace = store.workspace(workspace_id)
    upload_dir = workspace / "uploads"

    try:
        paths = _save_uploads(files, upload_dir)
        media = ExifToolExtractor().extract_sync(paths)
        trip_gap = timedelta(days=36500) if keep_as_one_trip else timedelta(hours=12)
        trips = TripBuilder(trip_gap=trip_gap).build(media)

        if not trips:
            raise ValueError("No supported media metadata could be analyzed.")

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

            geocoder = NominatimReverseGeocoder(store.root / "cache" / "places")
            place_names: dict[str, str] = {}
            for observation in trip.observations:
                try:
                    place_names[observation.id] = (
                        geocoder.reverse(observation.latitude, observation.longitude)
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
                }
            )

        return results
    finally:
        shutil.rmtree(workspace, ignore_errors=True)


def _map_html(trip, route, place_names: dict[str, str], vehicle: str) -> str:
    observations = []
    for index, observation in enumerate(trip.observations):
        if route is not None:
            progress = project_observation_progress(route, observation)
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
                "name": place_names.get(observation.id, "Unknown place"),
                "progress": progress,
            }
        )

    if route is not None:
        route_geojson = route.as_geojson()
    else:
        coordinates = [[item["lon"], item["lat"]] for item in observations]
        route_geojson = {
            "type": "Feature",
            "properties": {"inferred": False},
            "geometry": {"type": "LineString", "coordinates": coordinates},
        }

    route_json = json.dumps(route_geojson)
    observations_json = json.dumps(observations)
    vehicle_json = json.dumps(vehicle)

    return f"""
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <link href="https://unpkg.com/maplibre-gl@5/dist/maplibre-gl.css" rel="stylesheet">
  <script src="https://unpkg.com/maplibre-gl@5/dist/maplibre-gl.js"></script>
  <style>
    html, body, #map {{ height: 100%; margin: 0; background: #0b0d10; }}
    #map {{ position: absolute; inset: 0; }}
    #controls {{
      position: absolute;
      z-index: 5;
      top: 12px;
      left: 12px;
      display: flex;
      gap: 8px;
    }}
    button {{
      border: 0;
      border-radius: 8px;
      padding: 9px 13px;
      background: white;
      color: #111;
      font: 600 13px system-ui, sans-serif;
      cursor: pointer;
      box-shadow: 0 4px 18px #0004;
    }}
    .scooter {{
      font-size: 28px;
      line-height: 1;
      transform-origin: center;
    }}
    .observation {{
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: white;
      border: 3px solid #111827;
      box-shadow: 0 2px 8px #0008;
    }}
  </style>
</head>
<body>
  <div id="map"></div>
  <div id="controls"><button id="replay">Replay route</button></div>
  <script>
    const route = {route_json};
    const observations = {observations_json};
    const vehicleIcon = {vehicle_json};
    const coords = route.geometry.coordinates || [];

    const map = new maplibregl.Map({{
      container: "map",
      style: "https://tiles.openfreemap.org/styles/liberty",
      center: coords.length ? coords[0] : [85.324, 27.676],
      zoom: coords.length ? 8 : 6,
      attributionControl: true
    }});

    let scooter = null;
    let raf = null;

    function bearing(a, b) {{
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      return Math.atan2(dx, dy) * 180 / Math.PI;
    }}

    function positionAt(progress) {{
      if (!coords.length) return null;
      if (coords.length === 1) return coords[0];

      const raw = Math.max(0, Math.min(1, progress)) * (coords.length - 1);
      const index = Math.min(Math.floor(raw), coords.length - 2);
      const t = raw - index;
      const a = coords[index];
      const b = coords[index + 1];

      return {{
        point: [
          a[0] + (b[0] - a[0]) * t,
          a[1] + (b[1] - a[1]) * t
        ],
        a,
        b,
        index
      }};
    }}

    function setProgress(progress) {{
      const result = positionAt(progress);
      if (!result || !scooter) return;

      scooter
        .setLngLat(result.point)
        .setRotation(bearing(result.a, result.b));

      const traveled = coords
        .slice(0, result.index + 1)
        .concat([result.point]);

      const source = map.getSource("traveled");
      if (source) {{
        source.setData({{
          type: "Feature",
          properties: {{}},
          geometry: {{ type: "LineString", coordinates: traveled }}
        }});
      }}
    }}

    function replay() {{
      if (raf) cancelAnimationFrame(raf);
      if (coords.length < 2) return;

      const started = performance.now();
      const duration = 12000;

      function frame(now) {{
        const progress = Math.min(1, (now - started) / duration);
        setProgress(progress);
        if (progress < 1) raf = requestAnimationFrame(frame);
      }}

      raf = requestAnimationFrame(frame);
    }}

    map.on("load", () => {{
      map.addSource("route", {{ type: "geojson", data: route }});
      map.addLayer({{
        id: "route",
        type: "line",
        source: "route",
        paint: {{
          "line-color": "#6b7280",
          "line-width": 5,
          "line-opacity": 0.45
        }}
      }});

      map.addSource("traveled", {{
        type: "geojson",
        data: {{
          type: "Feature",
          properties: {{}},
          geometry: {{ type: "LineString", coordinates: [] }}
        }}
      }});
      map.addLayer({{
        id: "traveled",
        type: "line",
        source: "traveled",
        paint: {{
          "line-color": "#111827",
          "line-width": 7
        }}
      }});

      for (const observation of observations) {{
        const el = document.createElement("div");
        el.className = "observation";
        el.title = observation.media_count + " media";
        new maplibregl.Marker({{ element: el }})
          .setLngLat([observation.lon, observation.lat])
          .addTo(map);
      }}

      const boundsCoords = coords.length
        ? coords
        : observations.map(item => [item.lon, item.lat]);

      if (boundsCoords.length) {{
        const bounds = boundsCoords.reduce(
          (bounds, coordinate) => bounds.extend(coordinate),
          new maplibregl.LngLatBounds(boundsCoords[0], boundsCoords[0])
        );
        map.fitBounds(bounds, {{ padding: 60, duration: 0 }});
      }}

      if (coords.length) {{
        const el = document.createElement("div");
        el.className = "scooter";
        el.textContent = "🛵";
        scooter = new maplibregl.Marker({{
          element: el,
          rotationAlignment: "map"
        }})
          .setLngLat(coords[0])
          .addTo(map);

        replay();
      }}
    }});

    document.getElementById("replay").addEventListener("click", replay);
  </script>
</body>
</html>
"""


def _render_result(result: dict, index: int, vehicle: str) -> None:
    trip = result["trip"]
    route = result["route"]
    timeline = result["timeline"]
    route_error = result["route_error"]
    place_names = result["place_names"]

    st.subheader(f"Trip {index + 1}")

    distance_meters = route.distance_meters if route is not None else trip.stats.distance_meters
    distance_km = distance_meters / 1000

    segment_count = len(route.segments) if route is not None else max(len(trip.observations) - 1, 0)

    col1, col2, col3, col4, col5 = st.columns(5)
    col1.metric("Media", trip.stats.media_count)
    col2.metric("GPS media", trip.stats.gps_media_count)
    col3.metric("Stops", len(trip.observations))
    col4.metric("Segments", segment_count)
    col5.metric("Route", f"{distance_km:.1f} km")

    if len(trip.observations) >= 2:
        source = "OSRM road routing" if route is not None else "straight GPS fallback"
        st.success(
            f"Route determined from {trip.stats.gps_media_count} geotagged media, "
            f"ordered by capture time, across {len(trip.observations)} stops using {source}."
        )
    elif len(trip.observations) == 1:
        st.info("Only one distinct GPS stop was found. At least two stops are needed to determine a route.")

    if trip.started_at and trip.ended_at:
        st.caption(f"{trip.started_at} to {trip.ended_at}")

    if route_error:
        st.warning(
            "Road routing failed, so the preview falls back to observed GPS points. "
            f"Routing error: {route_error}"
        )

    if len(trip.observations) == 0:
        st.warning("No usable GPS observations were found in this trip.")
    else:
        components.html(_map_html(trip, route, place_names, vehicle), height=700, scrolling=False)

        with st.expander("Route observations"):
            rows = [
                {
                    "order": index + 1,
                    "place": place_names.get(observation.id, "Unknown place"),
                    "captured_at": observation.arrival,
                    "latitude": round(observation.latitude, 6),
                    "longitude": round(observation.longitude, 6),
                    "media": len(observation.media_ids),
                }
                for index, observation in enumerate(trip.observations)
            ]
            st.dataframe(rows, use_container_width=True, hide_index=True)

    warnings = [
        f"{item.filename}: {', '.join(item.metadata_warnings)}"
        for item in trip.media
        if item.metadata_warnings
    ]
    if warnings:
        with st.expander("Metadata warnings"):
            for warning in warnings:
                st.write(warning)

    downloads = st.columns(3)
    downloads[0].download_button(
        "Download trip.json",
        trip.model_dump_json(indent=2),
        file_name=f"{trip.id}-trip.json",
        mime="application/json",
        key=f"trip-json-{trip.id}",
    )

    if route is not None:
        downloads[1].download_button(
            "Download route.geojson",
            json.dumps(route.as_geojson(), indent=2),
            file_name=f"{trip.id}-route.geojson",
            mime="application/geo+json",
            key=f"route-json-{trip.id}",
        )

    downloads[2].download_button(
        "Download timeline.json",
        timeline.model_dump_json(indent=2),
        file_name=f"{trip.id}-timeline.json",
        mime="application/json",
        key=f"timeline-json-{trip.id}",
    )


def render_app() -> None:
    st.set_page_config(page_title="Trip Recap", page_icon="🛵", layout="wide")

    st.title("Trip Recap")
    st.write(
        "Upload original photos or videos. The app reads capture time and GPS metadata, "
        "reconstructs the road trip, and builds an animated route automatically."
    )

    uploaded_files = st.file_uploader(
        "Drop all photos and videos from the trip",
        type=["jpg", "jpeg", "heic", "heif", "png", "webp", "mov", "mp4", "m4v"],
        accept_multiple_files=True,
        help="Use original files when possible so GPS and capture metadata are preserved.",
    )

    if uploaded_files:
        st.caption(f"{len(uploaded_files)} media files selected. They will be ordered by capture timestamp.")

    controls_left, controls_right = st.columns(2)

    with controls_left:
        keep_as_one_trip = st.toggle(
            "Treat all selected media as one trip",
            value=True,
            help="Turn this off to split uploads into separate trips when there is a gap longer than 12 hours.",
        )

    with controls_right:
        vehicle_label = st.selectbox(
            "Animation vehicle",
            options=["Scooter", "Car", "Motorcycle", "Bicycle", "Jeep"],
            index=0,
        )

    vehicle_icons = {
        "Scooter": "🛵",
        "Car": "🚗",
        "Motorcycle": "🏍️",
        "Bicycle": "🚲",
        "Jeep": "🚙",
    }
    vehicle = vehicle_icons[vehicle_label]

    analyze = st.button(
        "Determine route",
        type="primary",
        disabled=not uploaded_files,
        use_container_width=True,
    )

    if analyze:
        if len(uploaded_files) > settings.max_files:
            st.error(f"Maximum {settings.max_files} files per trip.")
        else:
            try:
                with st.spinner("Reading metadata and reconstructing the trip..."):
                    st.session_state["trip_results"] = _analyze(uploaded_files, keep_as_one_trip=keep_as_one_trip)
            except Exception as exc:
                st.session_state.pop("trip_results", None)
                st.exception(exc)

    results = st.session_state.get("trip_results")
    if results:
        st.divider()
        for index, result in enumerate(results):
            _render_result(result, index, vehicle)

    st.caption(
        "GPS metadata is processed temporarily. No manual coordinates or route stops are required."
    )


if __name__ == "__main__":
    render_app()
