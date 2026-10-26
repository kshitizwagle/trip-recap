// Port of backend/app/timeline.

import type {MediaPoint, Observation, Timeline, TimelineEvent, Trip} from "./models.ts";
import {timeMs} from "./models.ts";

const ANCHORS: Array<[number, number]> = [
  [120, 1],
  [1800, 3],
  [7200, 5],
  [28800, 7],
];

/** Map real travel time to a compact video duration using log interpolation. */
export function compressGapSeconds(realSeconds: number): number {
  if (realSeconds <= 0) return 0;
  if (realSeconds <= ANCHORS[0][0]) return Math.max(0.5, (realSeconds / ANCHORS[0][0]) * ANCHORS[0][1]);
  const last = ANCHORS[ANCHORS.length - 1];
  if (realSeconds > last[0]) return Math.min(8, last[1] + 0.5 * Math.log(realSeconds / last[0] + 1));
  for (let i = 1; i < ANCHORS.length; i += 1) {
    const [leftS, leftV] = ANCHORS[i - 1];
    const [rightS, rightV] = ANCHORS[i];
    if (leftS <= realSeconds && realSeconds <= rightS) {
      const ratio = (Math.log(realSeconds) - Math.log(leftS)) / (Math.log(rightS) - Math.log(leftS));
      return leftV + ratio * (rightV - leftV);
    }
  }
  throw new Error("unreachable");
}

export class TimelineBuilder {
  readonly mediaFadeSeconds: number;
  readonly mediaHoldSeconds: number;

  constructor(mediaFadeSeconds = 0.4, mediaHoldSeconds = 2.5) {
    this.mediaFadeSeconds = mediaFadeSeconds;
    this.mediaHoldSeconds = mediaHoldSeconds;
  }

  build(trip: Trip): Timeline {
    const events: TimelineEvent[] = [
      {video_time: 0, type: "route_start", payload: {}},
      {video_time: 0, type: "camera_overview", payload: {}},
    ];
    let cursor = 1;
    const observations = trip.observations;
    const mediaById = new Map(trip.media.map((item) => [item.id, item]));

    if (observations.length) cursor = this.emitObservation(events, observations[0], mediaById, cursor);

    for (let i = 1; i < observations.length; i += 1) {
      const previous = observations[i - 1];
      const current = observations[i];
      const realGap = Math.max((timeMs(current.arrival) - timeMs(previous.departure)) / 1000, 0);
      const moveDuration = compressGapSeconds(realGap);
      events.push({video_time: cursor, type: "location_departure", payload: {observation_id: previous.id}});
      events.push({
        video_time: cursor,
        type: "camera_follow",
        payload: {from_observation_id: previous.id, to_observation_id: current.id},
      });
      events.push({
        video_time: cursor,
        type: "move",
        payload: {from_observation_id: previous.id, to_observation_id: current.id, duration_seconds: moveDuration},
      });
      cursor += moveDuration;
      cursor = this.emitObservation(events, current, mediaById, cursor);
    }

    events.push({video_time: cursor, type: "camera_overview", payload: {}});
    events.push({video_time: cursor + 1, type: "route_end", payload: {}});
    const duration = cursor + 1;
    trip.stats.video_duration_seconds = duration;
    return {duration_seconds: duration, events};
  }

  private emitObservation(
    events: TimelineEvent[],
    observation: Observation,
    mediaById: Map<string, MediaPoint>,
    start: number,
  ): number {
    let cursor = start;
    events.push({video_time: cursor, type: "location_arrival", payload: {observation_id: observation.id}});
    events.push({video_time: cursor, type: "camera_zoom", payload: {observation_id: observation.id}});
    for (const mediaId of observation.media_ids) {
      const media = mediaById.get(mediaId);
      if (!media) continue;
      events.push({
        video_time: cursor,
        type: "media_show",
        payload: {media_id: media.id, filename: media.filename, fade_seconds: this.mediaFadeSeconds},
      });
      cursor += this.mediaFadeSeconds + this.mediaHoldSeconds;
      events.push({video_time: cursor, type: "media_hide", payload: {media_id: media.id, fade_seconds: this.mediaFadeSeconds}});
      cursor += this.mediaFadeSeconds;
    }
    return cursor;
  }
}

/** Which media is visible at a timeline time (shared by preview and export). */
export function visibleMediaAt(timeline: Timeline, time: number): {mediaId: string; shownAt: number} | null {
  let visible: {mediaId: string; shownAt: number} | null = null;
  for (const event of timeline.events) {
    if (event.video_time > time) break;
    const mediaId = event.payload.media_id;
    if (typeof mediaId !== "string") continue;
    if (event.type === "media_show") visible = {mediaId, shownAt: event.video_time};
    if (event.type === "media_hide" && visible?.mediaId === mediaId) visible = null;
  }
  return visible;
}
