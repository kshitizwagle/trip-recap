from __future__ import annotations

import asyncio
import json
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable
from uuid import NAMESPACE_URL, uuid5

from app.models.media import GPSQuality, MediaPoint, MediaType

PHOTO_EXTENSIONS = {".jpg", ".jpeg", ".heic", ".heif", ".png", ".webp"}
VIDEO_EXTENSIONS = {".mov", ".mp4", ".m4v"}

PHOTO_TIMESTAMP_FIELDS = ("DateTimeOriginal", "CreateDate", "MediaCreateDate")
VIDEO_TIMESTAMP_FIELDS = ("MediaCreateDate", "TrackCreateDate", "CreateDate")


def detect_media_type(path: Path) -> MediaType:
    suffix = path.suffix.lower()
    if suffix in PHOTO_EXTENSIONS:
        return MediaType.PHOTO
    if suffix in VIDEO_EXTENSIONS:
        return MediaType.VIDEO
    raise ValueError(f"unsupported media type: {path.name}")


def parse_exif_datetime(value: Any) -> datetime | None:
    if value in (None, ""):
        return None
    if isinstance(value, datetime):
        return value
    text = str(value).strip()
    candidates = [text]
    if len(text) >= 10 and text[4] == ":" and text[7] == ":":
        candidates.insert(0, f"{text[:4]}-{text[5:7]}-{text[8:]}")
    for candidate in candidates:
        try:
            return datetime.fromisoformat(candidate.replace("Z", "+00:00"))
        except ValueError:
            continue
    return None


def _number(value: Any, cast: type[float] | type[int]) -> float | int | None:
    if value in (None, ""):
        return None
    try:
        return cast(float(value)) if cast is int else cast(value)
    except (TypeError, ValueError):
        return None


def _timestamp(record: dict[str, Any], media_type: MediaType) -> tuple[datetime | None, str | None]:
    fields = PHOTO_TIMESTAMP_FIELDS if media_type is MediaType.PHOTO else VIDEO_TIMESTAMP_FIELDS
    for field in fields:
        parsed = parse_exif_datetime(record.get(field))
        if parsed is not None:
            return parsed, field
    return None, None


def _gps(record: dict[str, Any]) -> tuple[float | None, float | None, GPSQuality, list[str]]:
    warnings: list[str] = []
    lat = _number(record.get("GPSLatitude"), float)
    lon = _number(record.get("GPSLongitude"), float)
    if lat is None or lon is None:
        return None, None, GPSQuality.MISSING, warnings
    if not -90 <= lat <= 90 or not -180 <= lon <= 180:
        warnings.append("gps_out_of_range")
        return None, None, GPSQuality.SUSPICIOUS, warnings
    return lat, lon, GPSQuality.VALID, warnings


def normalize_metadata_record(record: dict[str, Any]) -> MediaPoint:
    source = Path(str(record.get("SourceFile") or record.get("FileName") or "unknown"))
    media_type = detect_media_type(source)
    captured_at, timestamp_source = _timestamp(record, media_type)
    lat, lon, gps_quality, warnings = _gps(record)
    if captured_at is None:
        warnings.append("missing_capture_time")
    return MediaPoint(
        id=str(uuid5(NAMESPACE_URL, str(source.resolve()))),
        filename=source.name,
        path=source,
        media_type=media_type,
        captured_at=captured_at,
        timestamp_source=timestamp_source,
        latitude=lat,
        longitude=lon,
        altitude=_number(record.get("GPSAltitude"), float),
        direction=_number(record.get("GPSImgDirection") or record.get("GPSDestBearing"), float),
        duration_seconds=_number(record.get("Duration"), float),
        width=_number(record.get("ImageWidth") or record.get("SourceImageWidth"), int),
        height=_number(record.get("ImageHeight") or record.get("SourceImageHeight"), int),
        gps_quality=gps_quality,
        metadata_warnings=warnings,
    )


class ExifToolExtractor:
    def __init__(self, executable: str = "exiftool") -> None:
        self.executable = executable

    def extract_sync(self, files: Iterable[Path]) -> list[MediaPoint]:
        paths = [Path(path) for path in files]
        if not paths:
            return []
        result = subprocess.run(
            [self.executable, "-json", "-n", *map(str, paths)],
            check=True,
            capture_output=True,
            text=True,
        )
        records = json.loads(result.stdout)
        return [normalize_metadata_record(record) for record in records]

    async def extract(self, files: Iterable[Path]) -> list[MediaPoint]:
        return await asyncio.to_thread(self.extract_sync, list(files))
