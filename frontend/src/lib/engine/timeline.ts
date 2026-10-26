// Port of backend/app/timeline.

import type {MediaPoint, Observation, Timeline, TimelineEvent, Trip} from "./models.ts";
import {timeMs} from "./models.ts";
import {haversineMeters} from "./geo.ts";

/** Assumed speed when stops are out of time order (reordered or added by hand). */
export const FALLBACK_SPEED_KPH = 40;

/** How long the overview shows before the traveller sets off. */
export const INTRO_SECONDS = 0.8;

/** Real travel time → video seconds. Tuned so a short hop takes ~1.5 s and a long drive ~10 s. */
const ANCHORS: Array<[number, number]> = [
  [120, 1.5],
  [1800, 4],
  [7200, 6.5],
  [28800, 9],
];
const MAX_MOVE_SECONDS = 14;
/** Long legs also get at least this many video seconds per straight-line km, so they don't race past. */
const SECONDS_PER_KM = 1 / 25;

/** Video seconds for a leg: compressed travel time, with a distance-based floor for long drives. */
export function moveSeconds(realSeconds: number, meters: number): number {
  const byTime = compressGapSeconds(realSeconds);
  const byDistance = (meters / 1000) * SECONDS_PER_KM;
  return Math.min(MAX_MOVE_SECONDS, Math.max(byTime, byDistance));
}

/** Map real travel time to a compact video duration using log interpolation. */
export function compressGapSeconds(realSeconds: number): number {
  if (realSeconds <= 0) return 0;
  if (realSeconds <= ANCHORS[0][0]) return Math.max(0.75, (realSeconds / ANCHORS[0][0]) * ANCHORS[0][1]);
  const last = ANCHORS[ANCHORS.length - 1];
  if (realSeconds > last[0]) return Math.min(MAX_MOVE_SECONDS - 2, last[1] + Math.log(realSeconds / last[0] + 1));
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
    let cursor = INTRO_SECONDS;
    const observations = trip.observations;
    const mediaById = new Map(trip.media.map((item) => [item.id, item]));

    // The first stop's media plays while the traveller sets off, so the trip starts moving right away.
    if (observations.length) this.emitObservation(events, observations[0], mediaById, cursor);

    for (let i = 1; i < observations.length; i += 1) {
      const previous = observations[i - 1];
      const current = observations[i];
      let realGap = (timeMs(current.arrival) - timeMs(previous.departure)) / 1000;
      const meters = haversineMeters(previous.latitude, previous.longitude, current.latitude, current.longitude);
      if (!(realGap > 0)) {
        // No usable clock gap (same moment, or stops reordered/added by hand): estimate from distance.
        realGap = meters > 1 ? Math.max(60, (meters / 1000 / FALLBACK_SPEED_KPH) * 3600) : 0;
      }
      const moveDuration = moveSeconds(realGap, meters);
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

    // First-stop media can outlast the first move; keep the end after every event.
    cursor = Math.max(cursor, ...events.map((event) => event.video_time));
    events.push({video_time: cursor, type: "camera_overview", payload: {}});
    events.push({video_time: cursor + 1.5, type: "route_end", payload: {}});
    events.sort((a, b) => a.video_time - b.video_time);
    const duration = cursor + 1.5;
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

export interface PlaybackState {
  /** 0..1 distance progress along the route. */
  progress: number;
  /** Index of the observation the traveller last reached (-1 before the first). */
  atIndex: number;
  /** Index of the observation being travelled to, or null while stopped. */
  toIndex: number | null;
  /** 0..1 eased progress through the current move. */
  moveProgress: number;
  /** "intro" before the first move, "move", "stop" at an observation, "outro" after the last arrival. */
  phase: "intro" | "move" | "stop" | "outro";
}

export function easeInOutCubic(value: number): number {
  const x = Math.max(0, Math.min(1, value));
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}

/**
 * Where the traveller is at a timeline time. Moves ease between observation progresses during
 * `move` events and hold still while media shows, so preview and export animate identically.
 */
export function playbackStateAt(
  timeline: Timeline,
  observations: Array<{id: string; progress: number}>,
  time: number,
): PlaybackState {
  const index = new Map(observations.map((item, i) => [item.id, i]));
  const progressOf = (id: unknown) => {
    const i = typeof id === "string" ? index.get(id) : undefined;
    return i === undefined ? null : Math.max(0, Math.min(1, observations[i].progress));
  };
  const moves = timeline.events.filter((event) => event.type === "move");
  const lastOverview = [...timeline.events].reverse().find((event) => event.type === "camera_overview");
  const endTime = moves.length && lastOverview ? lastOverview.video_time : Infinity;
  let state: PlaybackState = {progress: 0, atIndex: observations.length ? 0 : -1, toIndex: null, moveProgress: 0, phase: "intro"};
  if (!moves.length) return {...state, phase: time > 0 ? "stop" : "intro"};
  if (time < moves[0].video_time) return state;

  for (const move of moves) {
    if (time < move.video_time) break;
    const from = progressOf(move.payload.from_observation_id) ?? state.progress;
    const to = progressOf(move.payload.to_observation_id) ?? from;
    const duration = Math.max(Number(move.payload.duration_seconds) || 0, 0.001);
    const toIndex = index.get(String(move.payload.to_observation_id)) ?? state.atIndex;
    const fromIndex = index.get(String(move.payload.from_observation_id)) ?? state.atIndex;
    const raw = (time - move.video_time) / duration;
    if (raw < 1) {
      const eased = easeInOutCubic(raw);
      return {progress: from + (to - from) * eased, atIndex: fromIndex, toIndex, moveProgress: eased, phase: "move"};
    }
    state = {progress: to, atIndex: toIndex, toIndex: null, moveProgress: 1, phase: "stop"};
  }
  return time >= endTime ? {...state, phase: "outro"} : state;
}
