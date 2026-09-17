from __future__ import annotations

import hashlib
from pathlib import Path

from app.models.route import Coordinate, RouteSegment


class RouteCache:
    def __init__(self, directory: Path) -> None:
        self.directory = directory
        self.directory.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def key(start: Coordinate, end: Coordinate, profile: str) -> str:
        raw = (
            f"{start.latitude:.5f},{start.longitude:.5f}:"
            f"{end.latitude:.5f},{end.longitude:.5f}:{profile}"
        )
        return hashlib.sha256(raw.encode()).hexdigest()

    def get(self, start: Coordinate, end: Coordinate, profile: str) -> RouteSegment | None:
        path = self.directory / f"{self.key(start, end, profile)}.json"
        if not path.exists():
            return None
        return RouteSegment.model_validate_json(path.read_text(encoding="utf-8"))

    def put(self, start: Coordinate, end: Coordinate, segment: RouteSegment) -> None:
        path = self.directory / f"{self.key(start, end, segment.routing_profile)}.json"
        path.write_text(segment.model_dump_json(indent=2), encoding="utf-8")
