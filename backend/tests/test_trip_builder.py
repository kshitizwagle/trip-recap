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
    assert 900 < haversine_meters(40.75, -74.0, 40.759, -74.0) < 1100


def test_nearby_media_clusters_into_one_observation() -> None:
    trip = TripBuilder().build(
        [
            point("a", 0, 40.75, -74.0),
            point("b", 5, 40.7505, -73.9997),
            point("c", 45, 40.78, -73.97),
        ]
    )[0]
    assert len(trip.observations) == 2
    assert trip.observations[0].media_ids == ["a", "b"]


def test_large_time_gap_creates_two_trips() -> None:
    first = point("a", 0, 40.75, -74.0)
    second = point("b", 1, 40.76, -73.99)
    second.captured_at = first.captured_at + timedelta(hours=13)
    trips = TripBuilder().build([first, second])
    assert len(trips) == 2


def test_implausible_speed_is_flagged() -> None:
    first = point("a", 0, 40.75, -74.0)
    second = point("b", 1, 28.67, 86.32)
    trip = TripBuilder(max_speed_kph=200).build([first, second])[0]
    flagged = next(item for item in trip.media if item.id == "b")
    assert flagged.gps_quality is GPSQuality.SUSPICIOUS
    assert "implausible_travel_speed" in flagged.metadata_warnings


def test_negligible_consecutive_route_points_are_merged_even_with_large_time_gap() -> None:
    first = point("a", 0, 40.75, -74.0)
    second = point("b", 45, 40.75018, -74.0)
    third = point("c", 50, 40.76, -73.99)

    trip = TripBuilder(
        cluster_distance_meters=0,
        min_route_point_distance_meters=50,
    ).build([first, second, third])[0]

    assert len(trip.observations) == 2
    assert trip.observations[0].media_ids == ["a", "b"]
    assert trip.observations[1].media_ids == ["c"]


def test_nearby_point_after_real_movement_is_preserved() -> None:
    first = point("a", 0, 40.75, -74.0)
    far = point("b", 10, 40.76, -73.99)
    back_near_start = point("c", 20, 40.7501, -74.0)

    trip = TripBuilder(
        cluster_distance_meters=0,
        min_route_point_distance_meters=50,
    ).build([first, far, back_near_start])[0]

    assert len(trip.observations) == 3
