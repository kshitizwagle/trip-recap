from app.metadata.extractor import normalize_metadata_record, parse_exif_datetime
from app.models.media import GPSQuality, MediaType


def test_photo_metadata_normalization() -> None:
    media = normalize_metadata_record(
        {
            "SourceFile": "/tmp/IMG_0001.HEIC",
            "DateTimeOriginal": "2026:09:17 10:20:30",
            "GPSLatitude": 27.671,
            "GPSLongitude": 85.325,
            "GPSAltitude": 1324.5,
            "ImageWidth": 4032,
            "ImageHeight": 3024,
        }
    )
    assert media.media_type is MediaType.PHOTO
    assert media.timestamp_source == "DateTimeOriginal"
    assert media.captured_at == parse_exif_datetime("2026:09:17 10:20:30")
    assert media.gps_quality is GPSQuality.VALID
    assert media.has_gps


def test_video_timestamp_priority() -> None:
    media = normalize_metadata_record(
        {
            "SourceFile": "/tmp/clip.MOV",
            "CreateDate": "2026:09:17 10:00:00",
            "MediaCreateDate": "2026:09:17 10:05:00",
            "Duration": 12.5,
        }
    )
    assert media.media_type is MediaType.VIDEO
    assert media.timestamp_source == "MediaCreateDate"
    assert media.duration_seconds == 12.5
    assert media.gps_quality is GPSQuality.MISSING


def test_invalid_gps_is_not_treated_as_observed_location() -> None:
    media = normalize_metadata_record(
        {
            "SourceFile": "/tmp/photo.jpg",
            "DateTimeOriginal": "2026:09:17 10:20:30",
            "GPSLatitude": 127.0,
            "GPSLongitude": 85.0,
        }
    )
    assert media.latitude is None
    assert media.longitude is None
    assert media.gps_quality is GPSQuality.SUSPICIOUS
    assert "gps_out_of_range" in media.metadata_warnings


def test_missing_timestamp_is_explicit() -> None:
    media = normalize_metadata_record({"SourceFile": "/tmp/photo.jpg"})
    assert media.captured_at is None
    assert media.timestamp_source is None
    assert "missing_capture_time" in media.metadata_warnings
