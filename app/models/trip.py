from __future__ import annotations

from datetime import datetime
from pathlib import Path

from pydantic import BaseModel, Field

from .media import MediaPoint


class Observation(BaseModel):
    id: str
    arrival: datetime
    departure: datetime
    latitude: float
    longitude: float
    media_ids: list[str] = Field(default_factory=list)


class TripStats(BaseModel):
    media_count: int
    photo_count: int
    video_count: int
    gps_media_count: int
    distance_meters: float = 0
    real_duration_seconds: float = 0
    video_duration_seconds: float | None = None


class Trip(BaseModel):
    id: str
    started_at: datetime | None = None
    ended_at: datetime | None = None
    media: list[MediaPoint] = Field(default_factory=list)
    observations: list[Observation] = Field(default_factory=list)
    stats: TripStats

    def write_json(self, path: Path) -> None:
        path.write_text(self.model_dump_json(indent=2), encoding="utf-8")
