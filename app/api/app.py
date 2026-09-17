from __future__ import annotations

import shutil
from pathlib import Path
from uuid import uuid4

from fastapi import BackgroundTasks, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse

from app.api.preview import PREVIEW_HTML
from app.config import settings
from app.metadata.extractor import SUPPORTED_EXTENSIONS, ExifToolExtractor
from app.renderer.service import RenderService
from app.routing.builder import build_route
from app.routing.cache import RouteCache
from app.routing.osrm import OSRMRouter
from app.storage import TripStore
from app.timeline.builder import TimelineBuilder
from app.trip.builder import TripBuilder

api=FastAPI(title="Trip Recap API",version="0.1.0"); store=TripStore(); render_service=RenderService(store)

@api.get("/",response_class=HTMLResponse)
async def root()->str: return '<h1>Trip Recap API</h1><p><a href="preview">Open preview</a></p>'
@api.get("/health")
async def health()->dict[str,str]: return {"status":"ok"}
@api.get("/preview",response_class=HTMLResponse)
async def preview()->str: return PREVIEW_HTML

async def _save_upload(upload:UploadFile,directory:Path)->Path:
    filename=Path(upload.filename or f"upload-{uuid4()}").name
    if Path(filename).suffix.lower() not in SUPPORTED_EXTENSIONS: raise HTTPException(status_code=415,detail=f"Unsupported media type: {filename}")
    target=directory/filename; size=0
    try:
        with target.open("wb") as handle:
            while chunk:=await upload.read(1024*1024):
                size+=len(chunk)
                if size>settings.max_file_bytes: raise HTTPException(status_code=413,detail=f"File too large: {filename}")
                handle.write(chunk)
        return target
    except Exception:
        target.unlink(missing_ok=True); raise
    finally: await upload.close()

@api.post("/trips/analyze")
async def analyze_trip(files:list[UploadFile]=File(...))->dict:
    store.cleanup_expired(settings.data_ttl_seconds)
    if not files: raise HTTPException(status_code=400,detail="No media files uploaded")
    if len(files)>settings.max_files: raise HTTPException(status_code=413,detail=f"Maximum {settings.max_files} files per trip")
    workspace_id=str(uuid4()); workspace=store.workspace(workspace_id)
    try:
        paths=[await _save_upload(upload,workspace/"uploads") for upload in files]; media=await ExifToolExtractor().extract(paths); trips=TripBuilder().build(media)
        if not trips: raise HTTPException(status_code=422,detail="No supported media metadata could be analyzed")
        summaries=[]
        for trip in trips:
            route=None; route_error=None
            if len(trip.observations)>=2:
                try:
                    router=OSRMRouter(cache=RouteCache(store.route_cache_dir),timeout_seconds=settings.route_timeout_seconds,max_attempts=settings.route_attempts); route=await build_route(trip,router)
                except Exception as exc: route_error=str(exc)
            timeline=TimelineBuilder().build(trip); store.persist_trip_media(trip); store.save_trip(trip)
            if route is not None: store.save_route(trip.id,route)
            store.save_timeline(trip.id,timeline)
            summaries.append({"id":trip.id,"media_count":trip.stats.media_count,"gps_media_count":trip.stats.gps_media_count,"distance_meters":route.distance_meters if route else trip.stats.distance_meters,"started_at":trip.started_at,"ended_at":trip.ended_at,"route_error":route_error})
        return {"workspace_id":workspace_id,"trips":summaries}
    except HTTPException: raise
    except Exception as exc: raise HTTPException(status_code=422,detail=str(exc)) from exc
    finally: shutil.rmtree(workspace,ignore_errors=True)

def _trip_or_404(trip_id:str):
    try: return store.load_trip(trip_id)
    except FileNotFoundError as exc: raise HTTPException(status_code=404,detail="Trip not found") from exc

@api.get("/trips/{trip_id}")
async def get_trip(trip_id:str): return _trip_or_404(trip_id)
@api.get("/trips/{trip_id}/route")
async def get_route(trip_id:str):
    _trip_or_404(trip_id); route=store.load_route_geojson(trip_id)
    if route is None: raise HTTPException(status_code=404,detail="Route not available")
    return route
@api.get("/trips/{trip_id}/timeline")
async def get_timeline(trip_id:str):
    _trip_or_404(trip_id)
    try: return store.load_timeline(trip_id)
    except FileNotFoundError as exc: raise HTTPException(status_code=404,detail="Timeline not available") from exc
@api.get("/trips/{trip_id}/media/{media_id}")
async def get_media(trip_id:str,media_id:str)->FileResponse:
    trip=_trip_or_404(trip_id); media=next((item for item in trip.media if item.id==media_id),None)
    if media is None or not media.path.exists(): raise HTTPException(status_code=404,detail="Media not found")
    return FileResponse(media.path)
@api.post("/trips/{trip_id}/render",status_code=202)
async def create_render(trip_id:str,request:Request,background_tasks:BackgroundTasks)->dict:
    _trip_or_404(trip_id); render_id=render_service.create_job(trip_id); background_tasks.add_task(render_service.run,render_id,trip_id,str(request.url_for("preview"))); return {"id":render_id,"status":"queued"}
@api.get("/renders/{render_id}")
async def get_render(render_id:str)->dict:
    try: return render_service.status(render_id)
    except FileNotFoundError as exc: raise HTTPException(status_code=404,detail="Render not found") from exc
@api.get("/renders/{render_id}/video")
async def get_render_video(render_id:str)->FileResponse:
    path=render_service.video_path(render_id)
    if not path.exists(): raise HTTPException(status_code=404,detail="Video not available")
    return FileResponse(path,media_type="video/mp4",filename="trip-recap.mp4")
