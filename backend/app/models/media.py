from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from pathlib import Path

from pydantic import BaseModel, Field, model_validator


class MediaType(StrEnum):
    PHOTO = "photo"
    VIDEO = "video"


class GPSQuality(StrEnum):
    VALID = "valid"
    MISSING = "missing"
    SUSPICIOUS = "suspicious"


class MediaPoint(BaseModel):
    id: str
    filename: str
    path: Path
    media_type: MediaType
    captured_at: datetime | None = None
    timestamp_source: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    altitude: float | None = None
    direction: float | None = None
    duration_seconds: float | None = None
    width: int | None = None
    height: int | None = None
    gps_quality: GPSQuality = GPSQuality.MISSING
    metadata_warnings: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_coordinate_pair(self) -> "MediaPoint":
        if (self.latitude is None) != (self.longitude is None):
            raise ValueError("latitude and longitude must either both be present or both be absent")
        return self

    @property
    def has_gps(self) -> bool:
        return self.latitude is not None and self.longitude is not None
