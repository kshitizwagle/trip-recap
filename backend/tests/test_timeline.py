from datetime import datetime, timedelta
from pathlib import Path

from app.models.media import GPSQuality, MediaPoint, MediaType
from app.models.trip import Observation, Trip, TripStats
from app.timeline.builder import TimelineBuilder
from app.timeline.compression import compress_gap_seconds


def test_compression_matches_expected_shape() -> None:
    assert 0.9 <= compress_gap_seconds(120) <= 1.1
    assert 2.8 <= compress_gap_seconds(1800) <= 3.2
    assert 4.8 <= compress_gap_seconds(7200) <= 5.2
    assert 6.8 <= compress_gap_seconds(28800) <= 7.2


def test_timeline_is_deterministic() -> None:
    start = datetime(2026, 9, 17, 8, 0)
    media = [
        MediaPoint(
            id="m1",
            filename="one.jpg",
            path=Path("/tmp/one.jpg"),
            media_type=MediaType.PHOTO,
            captured_at=start,
            latitude=40.75,
            longitude=-74.0,
            gps_quality=GPSQuality.VALID,
        ),
        MediaPoint(
            id="m2",
            filename="two.jpg",
            path=Path("/tmp/two.jpg"),
            media_type=MediaType.PHOTO,
            captured_at=start + timedelta(hours=2),
            latitude=40.78,
            longitude=-73.97,
            gps_quality=GPSQuality.VALID,
        ),
    ]
    observations = [
        Observation(id="o1", arrival=start, departure=start, latitude=40.75, longitude=-74.0, media_ids=["m1"]),
        Observation(id="o2", arrival=start + timedelta(hours=2), departure=start + timedelta(hours=2), latitude=40.78, longitude=-73.97, media_ids=["m2"]),
    ]
    trip = Trip(
        id="t1",
        started_at=start,
        ended_at=start + timedelta(hours=2),
        media=media,
        observations=observations,
        stats=TripStats(media_count=2, photo_count=2, video_count=0, gps_media_count=2),
    )
    builder = TimelineBuilder()
    first = builder.build(trip.model_copy(deep=True))
    second = builder.build(trip.model_copy(deep=True))
    assert first == second
    assert first.duration_seconds > 0
