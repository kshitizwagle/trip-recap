from datetime import datetime, timedelta
from pathlib import Path

from app.models.media import GPSQuality, MediaPoint, MediaType
from app.trip.builder import TripBuilder, haversine_meters


def point(name: str, minute: int, lat: float | None, lon: float | None) -> MediaPoint:
    return MediaPoint(
        id=name,
        filename=f"{name}.jpg",
        path=Path(f"/tmp/{name}.jpg"),
        media_type=MediaType.PHOTO,
        captured_at=datetime(2026, 9, 17, 10, 0) + timedelta(minutes=minute),
        latitude=lat,
        longitude=lon,
        gps_quality=GPSQuality.VALID if lat is not None else GPSQuality.MISSING,
    )


def test_haversine_distance_is_reasonable() -> None:
    assert 900 < haversine_meters(27.67, 85.32, 27.679, 85.32) < 1100


def test_nearby_media_clusters_into_one_observation() -> None:
    trip = TripBuilder().build(
        [
            point("a", 0, 27.6700, 85.3200),
            point("b", 5, 27.6705, 85.3203),
            point("c", 45, 27.7000, 85.3500),
        ]
    )[0]
    assert len(trip.observations) == 2
    assert trip.observations[0].media_ids == ["a", "b"]


def test_large_time_gap_creates_two_trips() -> None:
    first = point("a", 0, 27.67, 85.32)
    second = point("b", 1, 27.68, 85.33)
    second.captured_at = first.captured_at + timedelta(hours=13)
    trips = TripBuilder().build([first, second])
    assert len(trips) == 2


def test_implausible_speed_is_flagged() -> None:
    first = point("a", 0, 27.67, 85.32)
    second = point("b", 1, 28.67, 86.32)
    trip = TripBuilder(max_speed_kph=200).build([first, second])[0]
    flagged = next(item for item in trip.media if item.id == "b")
    assert flagged.gps_quality is GPSQuality.SUSPICIOUS
    assert "implausible_travel_speed" in flagged.metadata_warnings
