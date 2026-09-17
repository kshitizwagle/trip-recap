from __future__ import annotations

import json
import os
from pathlib import Path

from app.models.route import Route
from app.models.timeline import Timeline
from app.models.trip import Trip


class TripStore:
    def __init__(self, root: Path | None = None) -> None:
        self.root = root or Path(os.environ.get("TRIP_RECAP_DATA_DIR", "/tmp/trip-recap"))
        self.root.mkdir(parents=True, exist_ok=True)
        (self.root / "trips").mkdir(exist_ok=True)
        (self.root / "workspaces").mkdir(exist_ok=True)
        (self.root / "cache" / "routes").mkdir(parents=True, exist_ok=True)

    def workspace(self, workspace_id: str) -> Path:
        path = self.root / "workspaces" / workspace_id
        (path / "uploads").mkdir(parents=True, exist_ok=True)
        return path

    def trip_dir(self, trip_id: str) -> Path:
        path = self.root / "trips" / trip_id
        path.mkdir(parents=True, exist_ok=True)
        return path

    @property
    def route_cache_dir(self) -> Path:
        return self.root / "cache" / "routes"

    def save_trip(self, trip: Trip) -> None:
        trip.write_json(self.trip_dir(trip.id) / "trip.json")

    def save_route(self, trip_id: str, route: Route) -> None:
        (self.trip_dir(trip_id) / "route.json").write_text(
            route.model_dump_json(indent=2), encoding="utf-8"
        )
        route.write_geojson(self.trip_dir(trip_id) / "route.geojson")

    def save_timeline(self, trip_id: str, timeline: Timeline) -> None:
        timeline.write_json(self.trip_dir(trip_id) / "timeline.json")

    def load_trip(self, trip_id: str) -> Trip:
        return Trip.model_validate_json((self.root / "trips" / trip_id / "trip.json").read_text(encoding="utf-8"))

    def load_route(self, trip_id: str) -> Route | None:
        path = self.root / "trips" / trip_id / "route.json"
        return Route.model_validate_json(path.read_text(encoding="utf-8")) if path.exists() else None

    def load_route_geojson(self, trip_id: str) -> dict | None:
        path = self.root / "trips" / trip_id / "route.geojson"
        return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None

    def load_timeline(self, trip_id: str) -> Timeline:
        return Timeline.model_validate_json((self.root / "trips" / trip_id / "timeline.json").read_text(encoding="utf-8"))
