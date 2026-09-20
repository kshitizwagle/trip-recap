from __future__ import annotations

from app.models.timeline import EventType, Timeline, TimelineEvent
from app.models.trip import Observation, Trip
from .compression import compress_gap_seconds


class TimelineBuilder:
    def __init__(
        self,
        media_fade_seconds: float = 0.4,
        media_hold_seconds: float = 2.5,
    ) -> None:
        self.media_fade_seconds = media_fade_seconds
        self.media_hold_seconds = media_hold_seconds

    def build(self, trip: Trip) -> Timeline:
        events: list[TimelineEvent] = [
            TimelineEvent(video_time=0, type=EventType.ROUTE_START),
            TimelineEvent(video_time=0, type=EventType.CAMERA_OVERVIEW),
        ]
        cursor = 1.0
        observations = trip.observations
        media_by_id = {item.id: item for item in trip.media}

        if observations:
            cursor = self._emit_observation(events, observations[0], media_by_id, cursor)

        for previous, current in zip(observations, observations[1:]):
            real_gap = max((current.arrival - previous.departure).total_seconds(), 0)
            move_duration = compress_gap_seconds(real_gap)
            events.append(
                TimelineEvent(
                    video_time=cursor,
                    type=EventType.LOCATION_DEPARTURE,
                    payload={"observation_id": previous.id},
                )
            )
            events.append(
                TimelineEvent(
                    video_time=cursor,
                    type=EventType.CAMERA_FOLLOW,
                    payload={"from_observation_id": previous.id, "to_observation_id": current.id},
                )
            )
            events.append(
                TimelineEvent(
                    video_time=cursor,
                    type=EventType.MOVE,
                    payload={
                        "from_observation_id": previous.id,
                        "to_observation_id": current.id,
                        "duration_seconds": move_duration,
                    },
                )
            )
            cursor += move_duration
            cursor = self._emit_observation(events, current, media_by_id, cursor)

        events.append(TimelineEvent(video_time=cursor, type=EventType.CAMERA_OVERVIEW))
        events.append(TimelineEvent(video_time=cursor + 1.0, type=EventType.ROUTE_END))
        duration = cursor + 1.0
        trip.stats.video_duration_seconds = duration
        return Timeline(duration_seconds=duration, events=events)

    def _emit_observation(
        self,
        events: list[TimelineEvent],
        observation: Observation,
        media_by_id: dict,
        cursor: float,
    ) -> float:
        events.append(
            TimelineEvent(
                video_time=cursor,
                type=EventType.LOCATION_ARRIVAL,
                payload={"observation_id": observation.id},
            )
        )
        events.append(
            TimelineEvent(
                video_time=cursor,
                type=EventType.CAMERA_ZOOM,
                payload={"observation_id": observation.id},
            )
        )
        for media_id in observation.media_ids:
            media = media_by_id.get(media_id)
            if media is None:
                continue
            events.append(
                TimelineEvent(
                    video_time=cursor,
                    type=EventType.MEDIA_SHOW,
                    payload={
                        "media_id": media.id,
                        "filename": media.filename,
                        "fade_seconds": self.media_fade_seconds,
                    },
                )
            )
            cursor += self.media_fade_seconds + self.media_hold_seconds
            events.append(
                TimelineEvent(
                    video_time=cursor,
                    type=EventType.MEDIA_HIDE,
                    payload={"media_id": media.id, "fade_seconds": self.media_fade_seconds},
                )
            )
            cursor += self.media_fade_seconds
        return cursor
