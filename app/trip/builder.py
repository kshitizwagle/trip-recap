from __future__ import annotations

from datetime import timedelta
from math import asin, cos, radians, sin, sqrt
from typing import Iterable
from uuid import NAMESPACE_URL, uuid5

from app.models.media import GPSQuality, MediaPoint, MediaType
from app.config import settings
from app.models.trip import Observation, Trip, TripStats

EARTH_RADIUS_METERS = 6_371_008.8


def haversine_meters(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    phi1, phi2 = radians(lat1), radians(lat2)
    d_phi = radians(lat2 - lat1)
    d_lambda = radians(lon2 - lon1)
    a = sin(d_phi / 2) ** 2 + cos(phi1) * cos(phi2) * sin(d_lambda / 2) ** 2
    return 2 * EARTH_RADIUS_METERS * asin(sqrt(a))


def implied_speed_kph(first: MediaPoint, second: MediaPoint) -> float | None:
    if not first.has_gps or not second.has_gps or first.captured_at is None or second.captured_at is None:
        return None
    seconds = (second.captured_at - first.captured_at).total_seconds()
    if seconds <= 0:
        return None
    meters = haversine_meters(first.latitude, first.longitude, second.latitude, second.longitude)
    return meters / seconds * 3.6


def _mark_speed_outliers(media: list[MediaPoint], max_speed_kph: float) -> list[MediaPoint]:
    result = [item.model_copy(deep=True) for item in media]
    located = [item for item in result if item.has_gps and item.captured_at is not None]
    located.sort(key=lambda item: item.captured_at)
    for previous, current in zip(located, located[1:]):
        speed = implied_speed_kph(previous, current)
        if speed is not None and speed > max_speed_kph:
            current.gps_quality = GPSQuality.SUSPICIOUS
            if "implausible_travel_speed" not in current.metadata_warnings:
                current.metadata_warnings.append("implausible_travel_speed")
    return result


class TripBuilder:
    def __init__(
        self,
        cluster_distance_meters: float = 150,
        cluster_gap: timedelta = timedelta(minutes=30),
        trip_gap: timedelta = timedelta(hours=12),
        max_speed_kph: float = 250,
        min_route_point_distance_meters: float | None = None,
    ) -> None:
        self.cluster_distance_meters = cluster_distance_meters
        self.cluster_gap = cluster_gap
        self.trip_gap = trip_gap
        self.max_speed_kph = max_speed_kph
        self.min_route_point_distance_meters = (
            settings.min_route_point_distance_meters
            if min_route_point_distance_meters is None
            else min_route_point_distance_meters
        )

    def build(self, media: Iterable[MediaPoint]) -> list[Trip]:
        items = _mark_speed_outliers(list(media), self.max_speed_kph)
        timestamped = sorted(
            (item for item in items if item.captured_at is not None),
            key=lambda item: item.captured_at,
        )
        if not timestamped:
            return [self._make_trip(items)] if items else []

        groups: list[list[MediaPoint]] = [[]]
        for item in timestamped:
            if groups[-1]:
                gap = item.captured_at - groups[-1][-1].captured_at
                if gap > self.trip_gap:
                    groups.append([])
            groups[-1].append(item)

        untimestamped = [item for item in items if item.captured_at is None]
        trips = [self._make_trip(group) for group in groups if group]
        if untimestamped:
            if trips:
                trips[0].media.extend(untimestamped)
                trips[0].stats = self._stats(trips[0].media, trips[0].observations)
            else:
                trips.append(self._make_trip(untimestamped))
        return trips

    def _make_trip(self, media: list[MediaPoint]) -> Trip:
        ordered = sorted(media, key=lambda item: item.captured_at or item.path.name)
        timed = [item for item in ordered if item.captured_at is not None]
        observations = self._cluster_observations(timed)
        seed = ":".join(item.id for item in ordered) or "empty"
        return Trip(
            id=str(uuid5(NAMESPACE_URL, seed)),
            started_at=timed[0].captured_at if timed else None,
            ended_at=timed[-1].captured_at if timed else None,
            media=ordered,
            observations=observations,
            stats=self._stats(ordered, observations),
        )

    def _cluster_observations(self, media: list[MediaPoint]) -> list[Observation]:
        located = [
            item
            for item in media
            if item.has_gps and item.gps_quality is not GPSQuality.SUSPICIOUS
        ]
        clusters: list[list[MediaPoint]] = []
        for item in located:
            if not clusters:
                clusters.append([item])
                continue
            previous = clusters[-1][-1]
            gap = item.captured_at - previous.captured_at
            distance = haversine_meters(
                previous.latitude,
                previous.longitude,
                item.latitude,
                item.longitude,
            )
            if gap <= self.cluster_gap and distance <= self.cluster_distance_meters:
                clusters[-1].append(item)
            else:
                clusters.append([item])

        observations: list[Observation] = []
        for cluster in clusters:
            latitude = sum(item.latitude for item in cluster) / len(cluster)
            longitude = sum(item.longitude for item in cluster) / len(cluster)
            seed = ":".join(item.id for item in cluster)
            observations.append(
                Observation(
                    id=str(uuid5(NAMESPACE_URL, seed)),
                    arrival=cluster[0].captured_at,
                    departure=cluster[-1].captured_at,
                    latitude=latitude,
                    longitude=longitude,
                    media_ids=[item.id for item in cluster],
                )
            )
        return self._dedupe_negligible_route_points(observations)

    def _dedupe_negligible_route_points(
        self,
        observations: list[Observation],
    ) -> list[Observation]:
        if (
            len(observations) < 2
            or self.min_route_point_distance_meters <= 0
        ):
            return observations

        deduped: list[Observation] = [observations[0]]

        for current in observations[1:]:
            previous = deduped[-1]
            distance = haversine_meters(
                previous.latitude,
                previous.longitude,
                current.latitude,
                current.longitude,
            )

            if distance >= self.min_route_point_distance_meters:
                deduped.append(current)
                continue

            previous_count = max(len(previous.media_ids), 1)
            current_count = max(len(current.media_ids), 1)
            total_count = previous_count + current_count

            media_ids = [
                *previous.media_ids,
                *[
                    media_id
                    for media_id in current.media_ids
                    if media_id not in previous.media_ids
                ],
            ]
            seed = ":".join(media_ids) or f"{previous.id}:{current.id}"

            deduped[-1] = Observation(
                id=str(uuid5(NAMESPACE_URL, seed)),
                arrival=min(previous.arrival, current.arrival),
                departure=max(previous.departure, current.departure),
                latitude=(
                    previous.latitude * previous_count
                    + current.latitude * current_count
                )
                / total_count,
                longitude=(
                    previous.longitude * previous_count
                    + current.longitude * current_count
                )
                / total_count,
                media_ids=media_ids,
            )

        return deduped

    @staticmethod
    def _stats(media: list[MediaPoint], observations: list[Observation]) -> TripStats:
        distance = sum(
            haversine_meters(a.latitude, a.longitude, b.latitude, b.longitude)
            for a, b in zip(observations, observations[1:])
        )
        timed = [item for item in media if item.captured_at is not None]
        timed.sort(key=lambda item: item.captured_at)
        duration = (
            (timed[-1].captured_at - timed[0].captured_at).total_seconds()
            if len(timed) > 1
            else 0
        )
        return TripStats(
            media_count=len(media),
            photo_count=sum(item.media_type is MediaType.PHOTO for item in media),
            video_count=sum(item.media_type is MediaType.VIDEO for item in media),
            gps_media_count=sum(item.has_gps for item in media),
            distance_meters=distance,
            real_duration_seconds=max(duration, 0),
        )
