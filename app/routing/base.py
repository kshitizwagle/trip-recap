from __future__ import annotations

from typing import Protocol

from app.models.route import Coordinate, RouteSegment


class Router(Protocol):
    async def route(
        self,
        start: Coordinate,
        end: Coordinate,
        start_observation_id: str,
        end_observation_id: str,
    ) -> RouteSegment: ...
