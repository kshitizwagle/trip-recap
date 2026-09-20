from __future__ import annotations

from enum import StrEnum
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field


class EventType(StrEnum):
    ROUTE_START = "route_start"
    MOVE = "move"
    MEDIA_SHOW = "media_show"
    MEDIA_HIDE = "media_hide"
    LOCATION_ARRIVAL = "location_arrival"
    LOCATION_DEPARTURE = "location_departure"
    CAMERA_OVERVIEW = "camera_overview"
    CAMERA_FOLLOW = "camera_follow"
    CAMERA_ZOOM = "camera_zoom"
    ROUTE_END = "route_end"


class TimelineEvent(BaseModel):
    video_time: float
    type: EventType
    payload: dict[str, Any] = Field(default_factory=dict)


class Timeline(BaseModel):
    duration_seconds: float
    events: list[TimelineEvent] = Field(default_factory=list)

    def write_json(self, path: Path) -> None:
        path.write_text(self.model_dump_json(indent=2), encoding="utf-8")
