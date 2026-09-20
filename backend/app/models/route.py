from __future__ import annotations

from pathlib import Path

from pydantic import BaseModel, Field


class Coordinate(BaseModel):
    latitude: float
    longitude: float

    def as_geojson(self) -> list[float]:
        return [self.longitude, self.latitude]


class RouteSegment(BaseModel):
    start_observation_id: str
    end_observation_id: str
    geometry: list[Coordinate]
    distance_meters: float
    duration_seconds: float
    routing_profile: str = "driving"
    inferred: bool = True


class Route(BaseModel):
    segments: list[RouteSegment] = Field(default_factory=list)
    geometry: list[Coordinate] = Field(default_factory=list)
    distance_meters: float = 0
    duration_seconds: float = 0

    def as_geojson(self) -> dict:
        return {
            "type": "Feature",
            "properties": {
                "distance_meters": self.distance_meters,
                "duration_seconds": self.duration_seconds,
                "inferred": True,
            },
            "geometry": {
                "type": "LineString",
                "coordinates": [point.as_geojson() for point in self.geometry],
            },
        }

    def write_geojson(self, path: Path) -> None:
        import json

        path.write_text(json.dumps(self.as_geojson(), indent=2), encoding="utf-8")
