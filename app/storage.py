from __future__ import annotations

import json
import os
import shutil
import time
from pathlib import Path

from app.models.route import Route
from app.models.timeline import Timeline
from app.models.trip import Trip


class TripStore:
    def __init__(self, root: Path | None = None) -> None:
        self.root=root or Path(os.environ.get("TRIP_RECAP_DATA_DIR","/tmp/trip-recap"))
        for path in (self.root/"trips",self.root/"workspaces",self.root/"cache"/"routes",self.root/"renders"): path.mkdir(parents=True,exist_ok=True)

    def workspace(self, workspace_id: str) -> Path:
        path=self.root/"workspaces"/workspace_id; (path/"uploads").mkdir(parents=True,exist_ok=True); return path
    def trip_dir(self, trip_id: str) -> Path:
        path=self.root/"trips"/trip_id; path.mkdir(parents=True,exist_ok=True); return path
    def render_dir(self, render_id: str) -> Path:
        path=self.root/"renders"/render_id; path.mkdir(parents=True,exist_ok=True); return path
    @property
    def route_cache_dir(self) -> Path: return self.root/"cache"/"routes"

    def persist_trip_media(self, trip: Trip) -> None:
        media_dir=self.trip_dir(trip.id)/"media"; media_dir.mkdir(exist_ok=True)
        for item in trip.media:
            if not item.path.exists(): continue
            target=media_dir/f"{item.id}{item.path.suffix.lower()}"
            if item.path.resolve()!=target.resolve(): shutil.move(str(item.path),target)
            item.path=target

    def save_trip(self, trip: Trip) -> None: trip.write_json(self.trip_dir(trip.id)/"trip.json")
    def save_route(self, trip_id: str, route: Route) -> None:
        (self.trip_dir(trip_id)/"route.json").write_text(route.model_dump_json(indent=2),encoding="utf-8"); route.write_geojson(self.trip_dir(trip_id)/"route.geojson")
    def save_timeline(self, trip_id: str, timeline: Timeline) -> None: timeline.write_json(self.trip_dir(trip_id)/"timeline.json")
    def load_trip(self, trip_id: str) -> Trip: return Trip.model_validate_json((self.root/"trips"/trip_id/"trip.json").read_text(encoding="utf-8"))
    def load_route_geojson(self, trip_id: str) -> dict | None:
        path=self.root/"trips"/trip_id/"route.geojson"; return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None
    def load_timeline(self, trip_id: str) -> Timeline: return Timeline.model_validate_json((self.root/"trips"/trip_id/"timeline.json").read_text(encoding="utf-8"))

    def cleanup_expired(self, ttl_seconds: int) -> None:
        cutoff=time.time()-ttl_seconds
        for parent in (self.root/"workspaces",self.root/"trips",self.root/"renders"):
            if not parent.exists(): continue
            for child in parent.iterdir():
                try:
                    if child.stat().st_mtime<cutoff:
                        shutil.rmtree(child,ignore_errors=True) if child.is_dir() else child.unlink(missing_ok=True)
                except FileNotFoundError: pass
        cache=self.root/"cache"/"routes"
        if cache.exists():
            for child in cache.iterdir():
                try:
                    if child.stat().st_mtime<cutoff: child.unlink(missing_ok=True)
                except FileNotFoundError: pass
