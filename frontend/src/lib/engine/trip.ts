// Port of backend/app/trip/builder.py.

import {haversineMeters, pathMeters} from "./geo.ts";
import {uuid5} from "./ids.ts";
import {type MediaPoint, type Observation, type Trip, type TripStats, type Waypoint, hasGps, timeMs} from "./models.ts";

export interface TripBuilderOptions {
  clusterDistanceMeters?: number;
  clusterGapSeconds?: number;
  tripGapSeconds?: number;
  maxSpeedKph?: number;
  minRoutePointDistanceMeters?: number;
  /**
   * Photo spots closer than this to the last stop become waypoints the route passes through rather
   * than stops of their own. 0 keeps every spot as a stop.
   */
  stopDistanceMeters?: number;
}

export const DEFAULT_TRIP_GAP_SECONDS = 12 * 3600;

type Timed = MediaPoint & {captured_at: string};
type Located = Timed & {latitude: number; longitude: number};

const isTimed = (item: MediaPoint): item is Timed => item.captured_at !== null;

export function impliedSpeedKph(first: MediaPoint, second: MediaPoint): number | null {
  if (!hasGps(first) || !hasGps(second) || !first.captured_at || !second.captured_at) return null;
  const seconds = (timeMs(second.captured_at) - timeMs(first.captured_at)) / 1000;
  if (seconds <= 0) return null;
  return (haversineMeters(first.latitude, first.longitude, second.latitude, second.longitude) / seconds) * 3.6;
}

function markSpeedOutliers(media: MediaPoint[], maxSpeedKph: number): MediaPoint[] {
  const result = media.map((item) => ({...item, metadata_warnings: [...item.metadata_warnings]}));
  const located = result.filter((item) => hasGps(item) && item.captured_at !== null);
  located.sort((a, b) => timeMs(a.captured_at as string) - timeMs(b.captured_at as string));
  for (let i = 1; i < located.length; i += 1) {
    const speed = impliedSpeedKph(located[i - 1], located[i]);
    if (speed !== null && speed > maxSpeedKph) {
      located[i].gps_quality = "suspicious";
      if (!located[i].metadata_warnings.includes("implausible_travel_speed")) {
        located[i].metadata_warnings.push("implausible_travel_speed");
      }
    }
  }
  return result;
}

/** Straight-line length of the leg into `to`, through the photo spots it passes. */
export function legDistance(from: Observation, to: Observation): number {
  return pathMeters([from, ...(to.via ?? []), to]);
}

export function observationDistance(observations: Observation[]): number {
  let total = 0;
  for (let i = 1; i < observations.length; i += 1) total += legDistance(observations[i - 1], observations[i]);
  return total;
}

export class TripBuilder {
  readonly clusterDistanceMeters: number;
  readonly clusterGapSeconds: number;
  readonly tripGapSeconds: number;
  readonly maxSpeedKph: number;
  readonly minRoutePointDistanceMeters: number;
  readonly stopDistanceMeters: number;

  constructor(options: TripBuilderOptions = {}) {
    this.clusterDistanceMeters = options.clusterDistanceMeters ?? 150;
    this.clusterGapSeconds = options.clusterGapSeconds ?? 30 * 60;
    this.tripGapSeconds = options.tripGapSeconds ?? DEFAULT_TRIP_GAP_SECONDS;
    this.maxSpeedKph = options.maxSpeedKph ?? 250;
    this.minRoutePointDistanceMeters = options.minRoutePointDistanceMeters ?? 50;
    this.stopDistanceMeters = options.stopDistanceMeters ?? 0;
  }

  build(media: Iterable<MediaPoint>): Trip[] {
    const items = markSpeedOutliers([...media], this.maxSpeedKph);
    const timestamped = items.filter(isTimed).sort((a, b) => timeMs(a.captured_at) - timeMs(b.captured_at));
    if (!timestamped.length) return items.length ? [this.makeTrip(items)] : [];

    const groups: Timed[][] = [[]];
    for (const item of timestamped) {
      const group = groups[groups.length - 1];
      if (group.length) {
        const gap = (timeMs(item.captured_at) - timeMs(group[group.length - 1].captured_at)) / 1000;
        if (gap > this.tripGapSeconds) groups.push([]);
      }
      groups[groups.length - 1].push(item);
    }

    const untimestamped = items.filter((item) => item.captured_at === null);
    const trips = groups.filter((group) => group.length).map((group) => this.makeTrip(group));
    if (untimestamped.length) {
      if (trips.length) {
        trips[0].media.push(...untimestamped);
        trips[0].stats = TripBuilder.stats(trips[0].media, trips[0].observations);
      } else {
        trips.push(this.makeTrip(untimestamped));
      }
    }
    return trips;
  }

  private makeTrip(media: MediaPoint[]): Trip {
    const timed = media.filter(isTimed).sort((a, b) => timeMs(a.captured_at) - timeMs(b.captured_at));
    const untimed = media.filter((item) => item.captured_at === null).sort((a, b) => a.filename.localeCompare(b.filename));
    const ordered = [...timed, ...untimed];
    const observations = this.clusterObservations(timed);
    const seed = ordered.map((item) => item.id).join(":") || "empty";
    return {
      id: uuid5(seed),
      started_at: timed.length ? timed[0].captured_at : null,
      ended_at: timed.length ? timed[timed.length - 1].captured_at : null,
      media: ordered,
      observations,
      stats: TripBuilder.stats(ordered, observations),
    };
  }

  private clusterObservations(media: Timed[]): Observation[] {
    const located = media.filter((item): item is Located => hasGps(item) && item.gps_quality !== "suspicious");
    const clusters: Located[][] = [];
    for (const item of located) {
      const cluster = clusters[clusters.length - 1];
      if (!cluster) {
        clusters.push([item]);
        continue;
      }
      const previous = cluster[cluster.length - 1];
      const gap = (timeMs(item.captured_at) - timeMs(previous.captured_at)) / 1000;
      const distance = haversineMeters(previous.latitude, previous.longitude, item.latitude, item.longitude);
      if (gap <= this.clusterGapSeconds && distance <= this.clusterDistanceMeters) cluster.push(item);
      else clusters.push([item]);
    }

    const observations = clusters.map((cluster): Observation => ({
      id: uuid5(cluster.map((item) => item.id).join(":")),
      arrival: cluster[0].captured_at,
      departure: cluster[cluster.length - 1].captured_at,
      latitude: cluster.reduce((sum, item) => sum + item.latitude, 0) / cluster.length,
      longitude: cluster.reduce((sum, item) => sum + item.longitude, 0) / cluster.length,
      media_ids: cluster.map((item) => item.id),
    }));
    return this.selectStops(this.dedupeNegligibleRoutePoints(observations));
  }

  /**
   * Keeps a spot as a stop only when it is at least `stopDistanceMeters` from the previous stop.
   * The spots in between stay on the leg as waypoints, so the photos still shape the route.
   * Spots after the last stop are all within reach of it and count as its photos, except when
   * that would leave a single stop: then the last spot ends the route.
   */
  private selectStops(spots: Observation[]): Observation[] {
    if (this.stopDistanceMeters <= 0 || spots.length < 3) return spots;
    const asWaypoint = ({arrival, departure, latitude, longitude, media_ids}: Observation): Waypoint => ({arrival, departure, latitude, longitude, media_ids});
    const stops: Observation[] = [spots[0]];
    let pending: Observation[] = [];
    for (const spot of spots.slice(1)) {
      const last = stops[stops.length - 1];
      if (haversineMeters(last.latitude, last.longitude, spot.latitude, spot.longitude) >= this.stopDistanceMeters) {
        stops.push({...spot, via: pending.map(asWaypoint)});
        pending = [];
      } else {
        pending.push(spot);
      }
    }
    if (!pending.length) return stops;
    if (stops.length === 1) {
      const end = pending[pending.length - 1];
      stops.push({...end, via: pending.slice(0, -1).map(asWaypoint)});
      return stops;
    }
    const last = stops[stops.length - 1];
    const mediaIds = [...last.media_ids, ...pending.flatMap((spot) => spot.media_ids)];
    stops[stops.length - 1] = {...last, id: uuid5(mediaIds.join(":")), departure: pending[pending.length - 1].departure, media_ids: mediaIds};
    return stops;
  }

  private dedupeNegligibleRoutePoints(observations: Observation[]): Observation[] {
    if (observations.length < 2 || this.minRoutePointDistanceMeters <= 0) return observations;
    const deduped: Observation[] = [observations[0]];
    for (const current of observations.slice(1)) {
      const previous = deduped[deduped.length - 1];
      const distance = haversineMeters(previous.latitude, previous.longitude, current.latitude, current.longitude);
      if (distance >= this.minRoutePointDistanceMeters) {
        deduped.push(current);
        continue;
      }
      const previousCount = Math.max(previous.media_ids.length, 1);
      const currentCount = Math.max(current.media_ids.length, 1);
      const total = previousCount + currentCount;
      const mediaIds = [...previous.media_ids, ...current.media_ids.filter((id) => !previous.media_ids.includes(id))];
      deduped[deduped.length - 1] = {
        id: uuid5(mediaIds.join(":") || `${previous.id}:${current.id}`),
        arrival: timeMs(previous.arrival) <= timeMs(current.arrival) ? previous.arrival : current.arrival,
        departure: timeMs(previous.departure) >= timeMs(current.departure) ? previous.departure : current.departure,
        latitude: (previous.latitude * previousCount + current.latitude * currentCount) / total,
        longitude: (previous.longitude * previousCount + current.longitude * currentCount) / total,
        media_ids: mediaIds,
      };
    }
    return deduped;
  }

  static stats(media: MediaPoint[], observations: Observation[]): TripStats {
    const timed = media.filter(isTimed).map((item) => timeMs(item.captured_at)).sort((a, b) => a - b);
    const duration = timed.length > 1 ? (timed[timed.length - 1] - timed[0]) / 1000 : 0;
    return {
      media_count: media.length,
      photo_count: media.filter((item) => item.media_type === "photo").length,
      video_count: media.filter((item) => item.media_type === "video").length,
      gps_media_count: media.filter(hasGps).length,
      distance_meters: observationDistance(observations),
      real_duration_seconds: Math.max(duration, 0),
      video_duration_seconds: null,
    };
  }
}
