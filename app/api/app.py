from __future__ import annotations

import asyncio
import json
import mimetypes
import shutil
from datetime import datetime, timedelta
from io import BytesIO
from pathlib import Path
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5

import pillow_heif
from fastapi import (
    BackgroundTasks,
    FastAPI,
    File,
    Form,
    HTTPException,
    Query,
    Request,
    UploadFile,
)
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from PIL import Image, ImageOps
from pydantic import BaseModel

from app.config import settings
from app.geocoding import NominatimReverseGeocoder, PhotonPlaceSearch
from app.metadata.extractor import SUPPORTED_EXTENSIONS, ExifToolExtractor
from app.models.media import MediaPoint, MediaType
from app.renderer.service import RenderService
from app.routing.builder import build_route, project_observation_progress
from app.routing.cache import RouteCache
from app.routing.osrm import OSRMRouter
from app.storage import TripStore
from app.models.trip import Observation
from app.timeline.builder import TimelineBuilder
from app.trip.builder import TripBuilder, haversine_meters

pillow_heif.register_heif_opener()

WEB_DIR = Path(__file__).resolve().parents[1] / "web"
WEB_INDEX = WEB_DIR / "index.html"
FAVICON_PATH = WEB_DIR / "favicon.png"
PLACE_GRANULARITIES = {"specific", "neighborhood", "city", "region"}
IMAGE_PREVIEW_MAX_EDGE = 1920
IMAGE_PREVIEW_QUALITY = 82

api = FastAPI(
    title="Trip Recap",
    version="0.3.0",
    description="Metadata-driven road-trip reconstruction and recap generation.",
)


@api.exception_handler(Exception)
async def unhandled_exception_handler(
    request: Request,
    exc: Exception,
) -> JSONResponse:
    return JSONResponse(
        status_code=500,
        content={
            "detail": (
                f"Internal server error: "
                f"{type(exc).__name__}: {exc}"
            )
        },
    )


store = TripStore()
render_service = RenderService(store)


class AnalyzeSessionRequest(BaseModel):
    session_id: str
    upload_ids: list[str]
    keep_as_one_trip: bool = True
    start_location: str | None = None
    end_location: str | None = None
    return_to_start: bool = False


def _uuid(value: str, label: str) -> str:
    try:
        return str(UUID(value))
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=400, detail=f"Invalid {label}") from exc


def _session_dir(session_id: str) -> Path:
    return store.workspace(_uuid(session_id, "upload session id"))


def _metadata_dir(session_id: str) -> Path:
    path = _session_dir(session_id) / "metadata"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _status_path(session_id: str, upload_id: str) -> Path:
    return _metadata_dir(session_id) / f"{_uuid(upload_id, 'upload id')}.upload.json"


def _write_upload_status(
    session_id: str,
    upload_id: str,
    payload: dict,
) -> None:
    _status_path(session_id, upload_id).write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _read_upload_status(session_id: str, upload_id: str) -> dict:
    path = _status_path(session_id, upload_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Upload not found")
    return json.loads(path.read_text(encoding="utf-8"))


def _public_upload_status(payload: dict) -> dict:
    return {key: value for key, value in payload.items() if key != "_path"}


def _load_upload_record(session_id: str, upload_id: str) -> dict:
    payload = _read_upload_status(session_id, upload_id)
    raw_path = payload.get("_path")
    if payload.get("state") != "uploaded" or not raw_path:
        raise HTTPException(status_code=409, detail="Upload is not ready")
    path = Path(raw_path)
    if not path.exists():
        raise HTTPException(
            status_code=404,
            detail="Uploaded media file is no longer available",
        )
    payload["_path"] = str(path)
    return payload


def _compress_photo_after_metadata(media: MediaPoint) -> tuple[Path, bool]:
    """Create a smaller display copy only after metadata extraction is complete."""
    source = media.path
    if media.media_type is not MediaType.PHOTO or not source.exists():
        return source, False

    original_size = source.stat().st_size
    target = source.with_name(f"{source.stem}.display.webp")

    try:
        with Image.open(source) as image:
            image = ImageOps.exif_transpose(image)
            if max(image.size) > IMAGE_PREVIEW_MAX_EDGE:
                image.thumbnail(
                    (IMAGE_PREVIEW_MAX_EDGE, IMAGE_PREVIEW_MAX_EDGE),
                    Image.Resampling.LANCZOS,
                )

            if image.mode == "P":
                image = image.convert(
                    "RGBA" if "transparency" in image.info else "RGB"
                )
            elif image.mode not in {"RGB", "RGBA", "L", "LA"}:
                image = image.convert("RGB")

            image.save(
                target,
                format="WEBP",
                quality=IMAGE_PREVIEW_QUALITY,
                method=6,
            )

        if target.stat().st_size >= original_size:
            target.unlink(missing_ok=True)
            return source, False

        return target, True
    except Exception:
        target.unlink(missing_ok=True)
        return source, False


def _parse_coordinates(value: str) -> tuple[float, float] | None:
    parts = [part.strip() for part in value.split(",")]
    if len(parts) != 2:
        return None
    try:
        latitude = float(parts[0])
        longitude = float(parts[1])
    except ValueError:
        return None
    if not -90 <= latitude <= 90 or not -180 <= longitude <= 180:
        raise HTTPException(
            status_code=400,
            detail="Coordinates must be valid latitude, longitude values",
        )
    return latitude, longitude


async def _resolve_location(value: str | None) -> tuple[float, float] | None:
    text = (value or "").strip()
    if not text:
        return None

    coordinates = _parse_coordinates(text)
    if coordinates is not None:
        return coordinates

    geocoder = NominatimReverseGeocoder(
        store.root / "cache" / "places"
    )
    try:
        result = await asyncio.to_thread(
            geocoder.forward,
            text,
        )
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Location lookup failed for '{text}': {exc}",
        ) from exc

    if result is None:
        raise HTTPException(
            status_code=422,
            detail=f"Could not find location: {text}",
        )
    return result["latitude"], result["longitude"]


def _endpoint_observation(
    kind: str,
    coordinate: tuple[float, float],
    when: datetime,
) -> Observation:
    latitude, longitude = coordinate
    return Observation(
        id=str(
            uuid5(
                NAMESPACE_URL,
                f"{kind}:{latitude:.7f}:{longitude:.7f}:{when.isoformat()}",
            )
        ),
        arrival=when,
        departure=when,
        latitude=latitude,
        longitude=longitude,
        media_ids=[],
    )


def _same_point(
    observation: Observation,
    coordinate: tuple[float, float],
) -> bool:
    return haversine_meters(
        observation.latitude,
        observation.longitude,
        coordinate[0],
        coordinate[1],
    ) < 1.0


def _apply_route_endpoints(
    trip,
    start_coordinate: tuple[float, float] | None,
    end_coordinate: tuple[float, float] | None,
    return_to_start: bool,
) -> None:
    observations = list(trip.observations)
    fallback_time = trip.started_at or trip.ended_at or datetime.now()

    if start_coordinate is not None:
        start_time = observations[0].arrival if observations else fallback_time
        if not observations or not _same_point(observations[0], start_coordinate):
            observations.insert(
                0,
                _endpoint_observation(
                    "start",
                    start_coordinate,
                    start_time,
                ),
            )

    if return_to_start:
        if observations:
            loop_coordinate = (
                start_coordinate
                if start_coordinate is not None
                else (
                    observations[0].latitude,
                    observations[0].longitude,
                )
            )
            if len(observations) > 1 or not _same_point(
                observations[-1],
                loop_coordinate,
            ):
                observations.append(
                    _endpoint_observation(
                        "return",
                        loop_coordinate,
                        observations[-1].departure,
                    )
                )
    elif end_coordinate is not None:
        end_time = observations[-1].departure if observations else fallback_time
        if not observations or not _same_point(observations[-1], end_coordinate):
            observations.append(
                _endpoint_observation(
                    "end",
                    end_coordinate,
                    end_time,
                )
            )

    trip.observations = observations
    trip.stats.distance_meters = sum(
        haversine_meters(
            first.latitude,
            first.longitude,
            second.latitude,
            second.longitude,
        )
        for first, second in zip(observations, observations[1:])
    )


def _route_progresses(route_model, observation_count: int) -> list[float]:
    if observation_count <= 0:
        return []
    if observation_count == 1:
        return [0.0]
    if route_model is None or not route_model.segments:
        return [
            index / (observation_count - 1)
            for index in range(observation_count)
        ]

    total = sum(
        max(segment.distance_meters, 0)
        for segment in route_model.segments
    )
    if total <= 0:
        return [
            index / (observation_count - 1)
            for index in range(observation_count)
        ]

    progresses = [0.0]
    distance = 0.0
    for segment in route_model.segments:
        distance += max(segment.distance_meters, 0)
        progresses.append(min(1.0, distance / total))

    while len(progresses) < observation_count:
        progresses.append(1.0)
    return progresses[:observation_count]


def _web_html() -> str:
    return WEB_INDEX.read_text(encoding="utf-8")


@api.get("/", response_class=HTMLResponse, include_in_schema=False)
async def root() -> str:
    return _web_html()


@api.get("/preview", response_class=HTMLResponse, include_in_schema=False)
async def preview() -> str:
    return _web_html()


@api.get("/favicon.png", include_in_schema=False)
@api.get("/favicon.ico", include_in_schema=False)
async def favicon() -> FileResponse:
    return FileResponse(FAVICON_PATH, media_type="image/png")


@api.get("/health")
@api.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@api.get("/api/locations/suggest")
async def suggest_locations(
    q: str = Query(..., min_length=3, max_length=120),
    limit: int = Query(5, ge=1, le=8),
) -> dict:
    search = PhotonPlaceSearch(
        store.root / "cache" / "places"
    )
    try:
        suggestions = await asyncio.to_thread(
            search.search,
            q,
            limit=limit,
        )
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Location suggestions failed: {exc}",
        ) from exc

    return {"suggestions": suggestions}


def _unique_target(directory: Path, filename: str) -> Path:
    safe_name = Path(filename).name
    target = directory / safe_name
    if not target.exists():
        return target

    stem = Path(safe_name).stem
    suffix = Path(safe_name).suffix
    counter = 2
    while True:
        target = directory / f"{stem}-{counter}{suffix}"
        if not target.exists():
            return target
        counter += 1


async def _save_upload(upload: UploadFile, directory: Path) -> Path:
    filename = Path(upload.filename or f"upload-{uuid4()}").name
    if Path(filename).suffix.lower() not in SUPPORTED_EXTENSIONS:
        raise HTTPException(
            status_code=415,
            detail=f"Unsupported media type: {filename}",
        )

    target = _unique_target(directory, filename)
    size = 0
    try:
        with target.open("wb") as handle:
            while chunk := await upload.read(1024 * 1024):
                size += len(chunk)
                if size > settings.max_file_bytes:
                    raise HTTPException(
                        status_code=413,
                        detail=f"File too large: {filename}",
                    )
                handle.write(chunk)
        return target
    except Exception:
        target.unlink(missing_ok=True)
        raise
    finally:
        await upload.close()


def _trip_or_404(trip_id: str):
    try:
        return store.load_trip(trip_id)
    except FileNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail="Trip not found",
        ) from exc


def _public_trip(trip) -> dict:
    payload = trip.model_dump(mode="json")
    for media in payload["media"]:
        media.pop("path", None)
        media["url"] = f"/api/trips/{trip.id}/media/{media['id']}"
        media["preview_url"] = (
            f"/api/trips/{trip.id}/media/{media['id']}/preview"
        )
    return payload


def _trip_payload(
    trip_id: str,
    *,
    route_error: str | None = None,
) -> dict:
    trip = _trip_or_404(trip_id)
    route_model = store.load_route(trip_id)
    route = route_model.as_geojson() if route_model is not None else None
    try:
        timeline = store.load_timeline(trip_id).model_dump(mode="json")
    except FileNotFoundError:
        timeline = None

    places = store.load_places(trip_id, "neighborhood")
    media_by_id = {item.id: item.filename for item in trip.media}
    progresses = _route_progresses(route_model, len(trip.observations))

    observations = []
    for index, observation in enumerate(trip.observations):
        progress = progresses[index] if index < len(progresses) else 0.0

        observations.append(
            {
                "id": observation.id,
                "order": index + 1,
                "latitude": observation.latitude,
                "longitude": observation.longitude,
                "arrival": observation.arrival.isoformat(),
                "departure": observation.departure.isoformat(),
                "place": places.get(observation.id, "Unknown place"),
                "media_ids": observation.media_ids,
                "media_files": [
                    media_by_id[media_id]
                    for media_id in observation.media_ids
                    if media_id in media_by_id
                ],
                "progress": progress,
            }
        )

    distance_meters = (
        route_model.distance_meters
        if route_model is not None
        else trip.stats.distance_meters
    )

    return {
        "id": trip.id,
        "trip": _public_trip(trip),
        "route": route,
        "timeline": timeline,
        "observations": observations,
        "place_names": places,
        "route_error": route_error,
        "summary": {
            "media_count": trip.stats.media_count,
            "gps_media_count": trip.stats.gps_media_count,
            "stop_count": len(trip.observations),
            "segment_count": (
                len(route_model.segments)
                if route_model is not None
                else max(len(trip.observations) - 1, 0)
            ),
            "distance_meters": distance_meters,
            "started_at": (
                trip.started_at.isoformat()
                if trip.started_at
                else None
            ),
            "ended_at": (
                trip.ended_at.isoformat()
                if trip.ended_at
                else None
            ),
        },
    }




@api.post("/api/upload-sessions/{session_id}/media", status_code=201)
async def upload_media(
    session_id: str,
    file: UploadFile = File(...),
) -> dict:
    store.cleanup_expired(settings.data_ttl_seconds)
    session_id = _uuid(session_id, "upload session id")
    workspace = _session_dir(session_id)
    filename = Path(file.filename or f"upload-{uuid4()}").name

    target = await _save_upload(file, workspace / "uploads")
    upload_id = str(uuid4())
    size_bytes = target.stat().st_size
    uploaded = {
        "id": upload_id,
        "filename": filename,
        "state": "uploaded",
        "size_bytes": size_bytes,
        "stored_bytes": size_bytes,
        "preview_url": (
            f"/api/upload-sessions/{session_id}/media/{upload_id}/preview"
        ),
        "_path": str(target),
    }
    _write_upload_status(session_id, upload_id, uploaded)
    return _public_upload_status(uploaded)


@api.get("/api/upload-sessions/{session_id}/media/{upload_id}/status")
async def uploaded_media_status(
    session_id: str,
    upload_id: str,
) -> dict:
    session_id = _uuid(session_id, "upload session id")
    return _public_upload_status(
        _read_upload_status(session_id, upload_id)
    )


@api.delete("/api/upload-sessions/{session_id}/media/{upload_id}")
async def discard_uploaded_media(session_id: str, upload_id: str) -> dict:
    session_id = _uuid(session_id, "upload session id")
    status_path = _status_path(session_id, upload_id)
    if status_path.exists():
        try:
            status = json.loads(status_path.read_text(encoding="utf-8"))
            raw_path = status.get("_path")
            if raw_path:
                Path(raw_path).unlink(missing_ok=True)
        finally:
            status_path.unlink(missing_ok=True)
    return {"status": "discarded", "id": upload_id}


@api.get(
    "/api/upload-sessions/{session_id}/media/{upload_id}/preview",
    include_in_schema=False,
)
async def uploaded_media_preview(session_id: str, upload_id: str):
    session_id = _uuid(session_id, "upload session id")
    record = _load_upload_record(session_id, upload_id)
    path = Path(record["_path"])
    media_type = mimetypes.guess_type(record["filename"])[0] or ""

    if media_type.startswith("video/") or path.suffix.lower() in {".mov", ".mp4", ".m4v"}:
        return FileResponse(
            path,
            media_type=media_type or "video/mp4",
            content_disposition_type="inline",
        )

    try:
        with Image.open(path) as image:
            image = ImageOps.exif_transpose(image)
            image.thumbnail((1280, 1280))
            if image.mode not in {"RGB", "L"}:
                image = image.convert("RGB")
            buffer = BytesIO()
            image.save(buffer, format="JPEG", quality=88, optimize=True)
        return Response(content=buffer.getvalue(), media_type="image/jpeg")
    except Exception as exc:
        raise HTTPException(
            status_code=422,
            detail=f"Preview unavailable: {exc}",
        ) from exc


@api.post("/api/trips/analyze-session")
async def analyze_uploaded_session(request: AnalyzeSessionRequest) -> dict:
    store.cleanup_expired(settings.data_ttl_seconds)

    if not request.upload_ids:
        raise HTTPException(status_code=400, detail="No retained media to analyze")
    if len(request.upload_ids) > settings.max_files:
        raise HTTPException(
            status_code=413,
            detail=f"Maximum {settings.max_files} files per trip",
        )

    upload_ids = list(dict.fromkeys(request.upload_ids))
    records: list[dict] = []
    ignored_upload_ids: list[str] = []

    for upload_id in upload_ids:
        try:
            record = _load_upload_record(
                request.session_id,
                upload_id,
            )
        except HTTPException as exc:
            if exc.status_code in {404, 409}:
                ignored_upload_ids.append(upload_id)
                continue
            raise
        records.append(record)

    if not records:
        raise HTTPException(
            status_code=400,
            detail=(
                "No available retained uploads to analyze. "
                "Missing, failed, discarded, or expired uploads were ignored."
            ),
        )

    paths = [Path(record["_path"]) for record in records]

    try:
        extracted = await ExifToolExtractor().extract(paths)
    except Exception as exc:
        raise HTTPException(
            status_code=422,
            detail=f"Metadata extraction failed: {exc}",
        ) from exc

    extracted_by_path = {
        str(item.path.resolve()): item
        for item in extracted
    }
    media: list[MediaPoint] = []
    for record, path in zip(records, paths):
        item = extracted_by_path.get(str(path.resolve()))
        if item is None:
            continue
        item.id = record["id"]
        item.filename = record["filename"]
        item.path = path

        if item.media_type is MediaType.PHOTO:
            item.path, _ = await asyncio.to_thread(
                _compress_photo_after_metadata,
                item,
            )

        media.append(item)

    if not media:
        raise HTTPException(
            status_code=422,
            detail="No supported media metadata could be analyzed",
        )

    start_coordinate = await _resolve_location(request.start_location)
    end_coordinate = (
        None
        if request.return_to_start
        else await _resolve_location(request.end_location)
    )

    trip_gap = (
        timedelta(days=36500)
        if request.keep_as_one_trip or request.return_to_start
        else timedelta(hours=12)
    )
    trips = TripBuilder(trip_gap=trip_gap).build(media)

    if not trips:
        raise HTTPException(
            status_code=422,
            detail="No supported media metadata could be analyzed",
        )

    results = []
    for trip in trips:
        trip_index = trips.index(trip)
        is_first_trip = trip_index == 0
        is_last_trip = trip_index == len(trips) - 1

        _apply_route_endpoints(
            trip,
            start_coordinate if is_first_trip else None,
            end_coordinate if is_last_trip else None,
            request.return_to_start and len(trips) == 1,
        )

        route = None
        route_error = None
        if len(trip.observations) >= 2:
            router = OSRMRouter(
                cache=RouteCache(store.route_cache_dir),
                timeout_seconds=settings.route_timeout_seconds,
                max_attempts=settings.route_attempts,
            )
            try:
                route = await build_route(trip, router)
            except Exception as exc:
                route_error = str(exc)

        timeline = TimelineBuilder().build(trip)
        store.persist_trip_media(trip)
        store.save_trip(trip)
        store.save_timeline(trip.id, timeline)
        store.save_places(trip.id, {}, "neighborhood")
        if route is not None:
            store.save_route(trip.id, route)

        results.append(
            _trip_payload(
                trip.id,
                route_error=route_error,
            )
        )

    return {
        "session_id": request.session_id,
        "trips": results,
        "ignored_upload_ids": ignored_upload_ids,
        "ignored_upload_count": len(ignored_upload_ids),
    }


@api.get("/api/trips/{trip_id}/places")
async def get_places(
    trip_id: str,
    granularity: str = Query("neighborhood"),
) -> dict:
    if granularity not in PLACE_GRANULARITIES:
        raise HTTPException(
            status_code=400,
            detail="Invalid place granularity",
        )

    trip = _trip_or_404(trip_id)
    existing = store.load_places(trip.id, granularity)
    if existing and all(
        observation.id in existing
        for observation in trip.observations
    ):
        return {
            "granularity": granularity,
            "places": existing,
        }

    geocoder = NominatimReverseGeocoder(
        store.root / "cache" / "places"
    )
    places: dict[str, str] = {}

    for observation in trip.observations:
        try:
            label = await asyncio.to_thread(
                geocoder.reverse,
                observation.latitude,
                observation.longitude,
                granularity=granularity,
            )
            places[observation.id] = (
                label or "Unknown place"
            )
        except Exception:
            places[observation.id] = "Unknown place"

    store.save_places(
        trip.id,
        places,
        granularity,
    )
    return {
        "granularity": granularity,
        "places": places,
    }


@api.post("/api/trips/analyze")
async def analyze_trip(
    files: list[UploadFile] = File(...),
    keep_as_one_trip: bool = Form(True),
    place_granularity: str = Form("neighborhood"),
) -> dict:
    store.cleanup_expired(settings.data_ttl_seconds)

    if not files:
        raise HTTPException(
            status_code=400,
            detail="No media files uploaded",
        )
    if len(files) > settings.max_files:
        raise HTTPException(
            status_code=413,
            detail=f"Maximum {settings.max_files} files per trip",
        )
    if place_granularity not in PLACE_GRANULARITIES:
        raise HTTPException(
            status_code=400,
            detail="Invalid place granularity",
        )

    workspace_id = str(uuid4())
    workspace = store.workspace(workspace_id)
    upload_dir = workspace / "uploads"

    try:
        paths = [
            await _save_upload(upload, upload_dir)
            for upload in files
        ]
        media = await ExifToolExtractor().extract(paths)

        trip_gap = (
            timedelta(days=36500)
            if keep_as_one_trip
            else timedelta(hours=12)
        )
        trips = TripBuilder(trip_gap=trip_gap).build(media)
        if not trips:
            raise HTTPException(
                status_code=422,
                detail="No supported media metadata could be analyzed",
            )

        results = []
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
                    route = await build_route(trip, router)
                except Exception as exc:
                    route_error = str(exc)

            geocoder = NominatimReverseGeocoder(
                store.root / "cache" / "places"
            )
            place_names: dict[str, str] = {}
            for observation in trip.observations:
                try:
                    label = await asyncio.to_thread(
                        geocoder.reverse,
                        observation.latitude,
                        observation.longitude,
                        granularity=place_granularity,
                    )
                    place_names[observation.id] = (
                        label or "Unknown place"
                    )
                except Exception:
                    place_names[observation.id] = "Unknown place"

            timeline = TimelineBuilder().build(trip)
            store.persist_trip_media(trip)
            store.save_trip(trip)
            store.save_places(trip.id, place_names)
            store.save_timeline(trip.id, timeline)
            if route is not None:
                store.save_route(trip.id, route)

            results.append(
                _trip_payload(
                    trip.id,
                    route_error=route_error,
                )
            )

        return {
            "workspace_id": workspace_id,
            "trips": results,
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=422,
            detail=str(exc),
        ) from exc
    finally:
        shutil.rmtree(workspace, ignore_errors=True)


@api.get("/api/trips/{trip_id}/data")
async def get_trip_data(trip_id: str) -> dict:
    return _trip_payload(trip_id)


@api.get("/api/trips/{trip_id}")
async def get_trip(trip_id: str) -> dict:
    return _public_trip(_trip_or_404(trip_id))


@api.get("/api/trips/{trip_id}/route")
async def get_route(trip_id: str):
    _trip_or_404(trip_id)
    route = store.load_route_geojson(trip_id)
    if route is None:
        raise HTTPException(
            status_code=404,
            detail="Route not available",
        )
    return route


@api.get("/api/trips/{trip_id}/timeline")
async def get_timeline(trip_id: str):
    _trip_or_404(trip_id)
    try:
        return store.load_timeline(trip_id)
    except FileNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail="Timeline not available",
        ) from exc


@api.get("/api/trips/{trip_id}/media/{media_id}")
async def get_media(
    trip_id: str,
    media_id: str,
) -> FileResponse:
    trip = _trip_or_404(trip_id)
    media = next(
        (item for item in trip.media if item.id == media_id),
        None,
    )
    if media is None or not media.path.exists():
        raise HTTPException(
            status_code=404,
            detail="Media not found",
        )

    media_type = (
        mimetypes.guess_type(media.path.name)[0]
        or "application/octet-stream"
    )
    return FileResponse(
        media.path,
        media_type=media_type,
        filename=media.filename,
        content_disposition_type="inline",
    )


@api.get("/api/trips/{trip_id}/media/{media_id}/preview")
async def get_media_preview(
    trip_id: str,
    media_id: str,
) -> Response:
    trip = _trip_or_404(trip_id)
    media = next(
        (item for item in trip.media if item.id == media_id),
        None,
    )
    if media is None or not media.path.exists():
        raise HTTPException(
            status_code=404,
            detail="Media not found",
        )

    if media.media_type.value == "video":
        return FileResponse(
            media.path,
            media_type=(
                mimetypes.guess_type(media.path.name)[0]
                or "video/mp4"
            ),
            content_disposition_type="inline",
        )

    try:
        with Image.open(media.path) as image:
            image = ImageOps.exif_transpose(image)
            image.thumbnail((1280, 1280))
            if image.mode not in {"RGB", "L"}:
                image = image.convert("RGB")
            buffer = BytesIO()
            image.save(
                buffer,
                format="JPEG",
                quality=88,
                optimize=True,
            )
        return Response(
            content=buffer.getvalue(),
            media_type="image/jpeg",
        )
    except Exception as exc:
        raise HTTPException(
            status_code=422,
            detail=f"Preview unavailable: {exc}",
        ) from exc


@api.post("/api/trips/{trip_id}/render", status_code=202)
async def create_render(
    trip_id: str,
    request: Request,
    background_tasks: BackgroundTasks,
) -> dict:
    _trip_or_404(trip_id)
    render_id = render_service.create_job(trip_id)
    background_tasks.add_task(
        render_service.run,
        render_id,
        trip_id,
        str(request.url_for("preview")),
    )
    return {
        "id": render_id,
        "status": "queued",
    }


@api.get("/api/renders/{render_id}")
async def get_render(render_id: str) -> dict:
    try:
        return render_service.status(render_id)
    except FileNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail="Render not found",
        ) from exc


@api.get("/api/renders/{render_id}/video")
async def get_render_video(
    render_id: str,
) -> FileResponse:
    path = render_service.video_path(render_id)
    if not path.exists():
        raise HTTPException(
            status_code=404,
            detail="Video not available",
        )
    return FileResponse(
        path,
        media_type="video/mp4",
        filename="trip-recap.mp4",
    )
