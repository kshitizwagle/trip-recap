from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    max_files: int = int(os.environ.get("TRIP_RECAP_MAX_FILES", "100"))
    max_file_bytes: int = int(os.environ.get("TRIP_RECAP_MAX_FILE_BYTES", str(1024 * 1024 * 1024)))
    data_ttl_seconds: int = int(os.environ.get("TRIP_RECAP_DATA_TTL_SECONDS", "3600"))
    route_timeout_seconds: float = float(os.environ.get("TRIP_RECAP_ROUTE_TIMEOUT_SECONDS", "20"))
    route_attempts: int = int(os.environ.get("TRIP_RECAP_ROUTE_ATTEMPTS", "3"))
    render_max_seconds: float = float(os.environ.get("TRIP_RECAP_RENDER_MAX_SECONDS", "90"))
    render_fps: int = int(os.environ.get("TRIP_RECAP_RENDER_FPS", "30"))


settings = Settings()
