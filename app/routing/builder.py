from __future__ import annotations

from shapely.geometry import LineString, Point

from app.models.route import Coordinate, Route
from app.models.trip import Observation, Trip
from app.routing.base import Router


async def build_route(trip: Trip, router: Router) -> Route:
    segments = []
    for start, end in zip(trip.observations, trip.observations[1:]):
        segment = await router.route(
            Coordinate(latitude=start.latitude, longitude=start.longitude),
            Coordinate(latitude=end.latitude, longitude=end.longitude),
            start.id,
            end.id,
        )
        segments.append(segment)

    geometry: list[Coordinate] = []
    for index, segment in enumerate(segments):
        geometry.extend(segment.geometry if index == 0 else segment.geometry[1:])

    return Route(
        segments=segments,
        geometry=geometry,
        distance_meters=sum(segment.distance_meters for segment in segments),
        duration_seconds=sum(segment.duration_seconds for segment in segments),
    )


def project_observation_progress(route: Route, observation: Observation) -> float | None:
    if len(route.geometry) < 2:
        return None
    line = LineString([(point.longitude, point.latitude) for point in route.geometry])
    if line.length == 0:
        return None
    point = Point(observation.longitude, observation.latitude)
    return float(line.project(point) / line.length)
