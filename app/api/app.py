from __future__ import annotations

import asyncio
import mimetypes
import shutil
from datetime import timedelta
from io import BytesIO
from pathlib import Path
from uuid import uuid4

import pillow_heif
from fastapi import (
    BackgroundTasks,
    FastAPI,
    File,
    Form,
    HTTPException,
    Request,
    UploadFile,
)
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from PIL import Image, ImageOps

from app.config import settings
from app.geocoding import NominatimReverseGeocoder
from app.metadata.extractor import SUPPORTED_EXTENSIONS, ExifToolExtractor
from app.renderer.service import RenderService
from app.routing.builder import build_route, project_observation_progress
from app.routing.cache import RouteCache
from app.routing.osrm import OSRMRouter
from app.storage import TripStore
from app.timeline.builder import TimelineBuilder
from app.trip.builder import TripBuilder

pillow_heif.register_heif_opener()

WEB_INDEX = Path(__file__).resolve().parents[1] / "web" / "index.html"
PLACE_GRANULARITIES = {"specific", "neighborhood", "city", "region"}

api = FastAPI(
    title="Trip Recap",
    version="0.2.0",
    description="Metadata-driven road-trip reconstruction and recap generation.",
)
store = TripStore()
render_service = RenderService(store)


def _web_html() -> str:
    return WEB_INDEX.read_text(encoding="utf-8")


@api.get("/", response_class=HTMLResponse, include_in_schema=False)
async def root() -> str:
    return _web_html()


@api.get("/preview", response_class=HTMLResponse, include_in_schema=False)
async def preview() -> str:
    return _web_html()


@api.get("/health")
@api.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


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

    places = store.load_places(trip_id)
    media_by_id = {item.id: item.filename for item in trip.media}

    observations = []
    for index, observation in enumerate(trip.observations):
        if route_model is not None:
            progress = project_observation_progress(
                route_model,
                observation,
            )
        elif len(trip.observations) > 1:
            progress = index / (len(trip.observations) - 1)
        else:
            progress = 0.0

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
        mimetypes.guess_type(media.filename)[0]
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
                mimetypes.guess_type(media.filename)[0]
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
