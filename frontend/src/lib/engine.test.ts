import assert from "node:assert/strict";
import test from "node:test";
import {sha1, uuid5} from "./engine/ids.ts";
import {haversineMeters} from "./engine/geo.ts";
import {extractMetadata, parseExifDatetime} from "./engine/metadata/extract.ts";
import {parseIso6709} from "./engine/metadata/quicktime.ts";
import {buildHeic, buildJpeg, buildMp4, buildTiff} from "./engine/test-fixtures.ts";
import type {MediaPoint} from "./engine/models.ts";
import {TripBuilder} from "./engine/trip.ts";
import {compressGapSeconds, moveSeconds, TimelineBuilder, visibleMediaAt} from "./engine/timeline.ts";
import {buildRoute, OSRMRouter, RouteCache, routeProgresses} from "./engine/routing.ts";
import {formatPlaceName, NominatimGeocoder} from "./engine/places.ts";
import {analyzeMedia, applyRouteEndpoints, parseCoordinates, tripPayload} from "./engine/analyze.ts";
import {buildMp4File} from "./engine/mp4.ts";
import {childBoxes, findBox} from "./engine/metadata/isobmff.ts";
import {readQuickTime} from "./engine/metadata/quicktime.ts";
import {bytesSource} from "./engine/metadata/bytes.ts";

test("MP4 writer produces a fast-start file with consistent sample tables", async () => {
  const samples = Array.from({length: 61}, (_, index) => ({
    data: new Uint8Array(10 + (index % 7)).fill(index),
    isKey: index % 30 === 0,
    duration: 3000,
  }));
  const file = buildMp4File({width: 1080, height: 1920, timescale: 90000, avcC: new Uint8Array([1, 0x64, 0, 0x28, 0xff, 0xe1])}, samples);
  assert.deepEqual(childBoxes(file).map((item) => item.type), ["ftyp", "moov", "mdat"]);
  const moovBox = findBox(file, ["moov"]);
  const mdat = findBox(file, ["mdat"]);
  assert.ok(moovBox && mdat);
  const view = new DataView(file.buffer);
  const stbl = ["trak", "mdia", "minf", "stbl"];
  const stco = findBox(file, [...stbl, "stco"], moovBox.start, moovBox.end);
  assert.equal(view.getUint32(stco!.start + 8), mdat.start);
  const stsz = findBox(file, [...stbl, "stsz"], moovBox.start, moovBox.end);
  assert.equal(view.getUint32(stsz!.start + 8), 61);
  const stss = findBox(file, [...stbl, "stss"], moovBox.start, moovBox.end);
  assert.equal(view.getUint32(stss!.start + 4), 3);
  assert.equal(file[mdat.start + 10], 1); // second sample follows the first
  const record = await readQuickTime(bytesSource(file));
  close(Number(record.Duration), 61 * 3000 / 90000, 1e-3);
  assert.equal(record.ImageWidth, 1080);
  assert.equal(record.ImageHeight, 1920);
  assert.throws(() => buildMp4File({width: 2, height: 2, timescale: 30, avcC: new Uint8Array(1)}, []), /No video frames/);
});

const close = (actual: number | null, expected: number, epsilon = 1e-4) =>
  assert.ok(actual !== null && Math.abs(actual - expected) < epsilon, `${actual} ≉ ${expected}`);

test("uuid5 and sha1 match Python's uuid.uuid5(NAMESPACE_URL, ...)", () => {
  const hex = Array.from(sha1(new TextEncoder().encode("abc")), (b) => b.toString(16).padStart(2, "0")).join("");
  assert.equal(hex, "a9993e364706816aba3e25717850c26c9cd0d89d");
  assert.equal(uuid5("a:b"), "b45a9d79-db1e-526a-9c11-593809785ca4");
  assert.equal(uuid5("trip-recap"), "5afa2661-8faa-5b55-b236-2644483cfe20");
  assert.equal(uuid5("héllo"), "102d6fae-a0b0-5a7a-b980-5e8cfb1690db");
});

test("haversine distance is reasonable", () => {
  const meters = haversineMeters(40.75, -74.0, 40.759, -74.0);
  assert.ok(meters > 900 && meters < 1100);
});

test("EXIF datetimes normalize like the backend, keeping recorded offsets", () => {
  assert.equal(parseExifDatetime("2026:09:17 10:00:00"), "2026-09-17T10:00:00");
  assert.equal(parseExifDatetime("2026:09:17 10:00:00", "+05:45"), "2026-09-17T10:00:00+05:45");
  assert.equal(parseExifDatetime("2026-09-17T04:15:00Z"), "2026-09-17T04:15:00Z");
  assert.equal(parseExifDatetime("0000:00:00 00:00:00"), null);
  assert.equal(parseExifDatetime("garbage"), null);
  assert.equal(parseExifDatetime(""), null);
});

test("JPEG EXIF: capture time, provenance and GPS (little-endian)", async () => {
  const file = new Blob([buildJpeg(buildTiff({
    dateTimeOriginal: "2026:10:24 09:30:00",
    createDate: "2026:10:24 09:31:00",
    offsetTimeOriginal: "+05:45",
    latitude: 27.6587525,
    longitude: 85.3247183,
    altitude: 1325.5,
  })) as BlobPart]);
  const media = await extractMetadata(file, "IMG_0001.JPG");
  assert.equal(media.media_type, "photo");
  assert.equal(media.captured_at, "2026-10-24T09:30:00+05:45");
  assert.equal(media.timestamp_source, "DateTimeOriginal");
  close(media.latitude, 27.6587525);
  close(media.longitude, 85.3247183);
  close(media.altitude, 1325.5, 0.01);
  assert.equal(media.gps_quality, "valid");
  assert.deepEqual(media.metadata_warnings, []);
});

test("JPEG EXIF: big-endian, southern/western hemispheres, CreateDate fallback", async () => {
  const file = new Blob([buildJpeg(buildTiff({createDate: "2026:01:02 03:04:05", latitude: -33.8688, longitude: -151.2093, littleEndian: false})) as BlobPart]);
  const media = await extractMetadata(file, "photo.jpeg");
  assert.equal(media.captured_at, "2026-01-02T03:04:05");
  assert.equal(media.timestamp_source, "CreateDate");
  close(media.latitude, -33.8688);
  close(media.longitude, -151.2093);
});

test("HEIC: EXIF item located through iinf/iloc", async () => {
  const file = new Blob([buildHeic(buildTiff({dateTimeOriginal: "2026:10:25 18:00:00", latitude: 27.4696334, longitude: 83.2758452})) as BlobPart]);
  const media = await extractMetadata(file, "IMG_1234.HEIC");
  assert.equal(media.captured_at, "2026-10-25T18:00:00");
  close(media.latitude, 27.4696334);
  close(media.longitude, 83.2758452);
});

test("photos without metadata keep explicit gaps", async () => {
  const media = await extractMetadata(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) as BlobPart]), "blank.jpg");
  assert.equal(media.captured_at, null);
  assert.equal(media.latitude, null);
  assert.equal(media.gps_quality, "missing");
  assert.deepEqual(media.metadata_warnings, ["missing_capture_time"]);
});

test("out-of-range GPS is rejected and flagged", async () => {
  const media = await extractMetadata(new Blob([buildJpeg(buildTiff({dateTimeOriginal: "2026:10:24 09:30:00", latitude: 95, longitude: 85})) as BlobPart]), "bad.jpg");
  assert.equal(media.latitude, null);
  assert.equal(media.gps_quality, "suspicious");
  assert.ok(media.metadata_warnings.includes("gps_out_of_range"));
});

test("ISO 6709 strings parse", () => {
  assert.deepEqual(parseIso6709("+27.6588+085.3247+1300.000/"), {latitude: 27.6588, longitude: 85.3247, altitude: 1300});
  assert.deepEqual(parseIso6709("-33.8688+151.2093/"), {latitude: -33.8688, longitude: 151.2093, altitude: undefined});
  assert.equal(parseIso6709("nope"), null);
});

test("Android MP4: MediaCreateDate priority, duration and ©xyz GPS", async () => {
  const created = Date.UTC(2026, 9, 24, 3, 0, 0) / 1000;
  const file = new Blob([buildMp4({createdUnix: created - 60, mediaCreatedUnix: created, durationSeconds: 12.5, xyz: "+27.6588+085.3247/"}) as BlobPart]);
  const media = await extractMetadata(file, "VID_20261024.mp4");
  assert.equal(media.media_type, "video");
  assert.equal(media.captured_at, "2026-10-24T03:00:00Z");
  assert.equal(media.timestamp_source, "MediaCreateDate");
  close(media.duration_seconds, 12.5);
  close(media.latitude, 27.6588);
  close(media.longitude, 85.3247);
  assert.equal(media.width, 1920);
  assert.equal(media.height, 1080);
});

test("iPhone MOV: Apple keys location and TrackCreateDate fallback", async () => {
  const created = Date.UTC(2026, 9, 25, 12, 30, 0) / 1000;
  const file = new Blob([buildMp4({createdUnix: created, appleLocation: "+27.5175+083.4535+100.000/"}) as BlobPart]);
  const media = await extractMetadata(file, "IMG_0002.MOV");
  assert.equal(media.timestamp_source, "TrackCreateDate");
  assert.equal(media.captured_at, "2026-10-25T12:30:00Z");
  close(media.latitude, 27.5175);
  close(media.longitude, 83.4535);
});

function point(name: string, minute: number, lat: number | null, lon: number | null, start = Date.UTC(2026, 8, 17, 10, 0)): MediaPoint {
  return {
    id: name,
    filename: `${name}.jpg`,
    media_type: "photo",
    captured_at: new Date(start + minute * 60_000).toISOString(),
    timestamp_source: "DateTimeOriginal",
    latitude: lat,
    longitude: lon,
    altitude: null,
    direction: null,
    duration_seconds: null,
    width: null,
    height: null,
    gps_quality: lat === null ? "missing" : "valid",
    metadata_warnings: [],
  };
}

test("nearby media clusters into one observation", () => {
  const [trip] = new TripBuilder().build([point("a", 0, 40.75, -74.0), point("b", 5, 40.7505, -73.9997), point("c", 45, 40.78, -73.97)]);
  assert.equal(trip.observations.length, 2);
  assert.deepEqual(trip.observations[0].media_ids, ["a", "b"]);
  assert.equal(trip.observations[0].id, uuid5("a:b"));
});

test("large time gap creates two trips", () => {
  assert.equal(new TripBuilder().build([point("a", 0, 40.75, -74.0), point("b", 13 * 60, 40.76, -73.99)]).length, 2);
});

test("implausible speed is flagged, not deleted", () => {
  const [trip] = new TripBuilder({maxSpeedKph: 200}).build([point("a", 0, 40.75, -74.0), point("b", 1, 28.67, 86.32)]);
  const flagged = trip.media.find((item) => item.id === "b");
  assert.equal(flagged?.gps_quality, "suspicious");
  assert.ok(flagged?.metadata_warnings.includes("implausible_travel_speed"));
  assert.equal(trip.observations.length, 1);
});

test("negligible consecutive route points merge; returning near the start is kept", () => {
  const merged = new TripBuilder({clusterDistanceMeters: 0, minRoutePointDistanceMeters: 50}).build([
    point("a", 0, 40.75, -74.0), point("b", 45, 40.75018, -74.0), point("c", 50, 40.76, -73.99),
  ])[0];
  assert.deepEqual(merged.observations.map((item) => item.media_ids), [["a", "b"], ["c"]]);
  const loop = new TripBuilder({clusterDistanceMeters: 0, minRoutePointDistanceMeters: 50}).build([
    point("a", 0, 40.75, -74.0), point("b", 10, 40.76, -73.99), point("c", 20, 40.7501, -74.0),
  ])[0];
  assert.equal(loop.observations.length, 3);
});

test("timestamp-only media joins the trip without a location", () => {
  const untimed = {...point("u", 0, null, null), captured_at: null};
  const [trip] = new TripBuilder().build([point("a", 0, 40.75, -74.0), untimed]);
  assert.equal(trip.media.length, 2);
  assert.equal(trip.observations.length, 1);
  assert.equal(trip.stats.gps_media_count, 1);
});

test("gap compression grows with travel time and long legs get a distance floor", () => {
  const values = [30, 120, 600, 1800, 7200, 28800, 100000].map(compressGapSeconds);
  close(values[1], 1.5, 1e-9);
  close(values[3], 4, 1e-9);
  close(values[5], 9, 1e-9);
  assert.ok(values.every((value, i) => i === 0 || value >= values[i - 1]), "monotonic");
  assert.ok(values[6] <= 12);
  assert.ok(moveSeconds(3600, 250_000) >= 10, "a 250 km leg takes at least 10 s");
  assert.ok(moveSeconds(60, 500) < 2, "a short hop stays short");
  assert.ok(moveSeconds(1e9, 1e9) <= 14, "capped");
});

test("the traveller sets off within a second, even with photos at the first stop", () => {
  const [trip] = new TripBuilder().build([point("m1", 0, 40.75, -74.0), point("m1b", 1, 40.75, -74.0), point("m2", 60, 40.9, -73.8)]);
  const timeline = new TimelineBuilder().build(trip);
  const firstMove = timeline.events.find((event) => event.type === "move");
  assert.ok(firstMove && firstMove.video_time < 1, `first move at ${firstMove?.video_time}`);
  assert.equal(visibleMediaAt(timeline, 1.2)?.mediaId, "m1");
  const times = timeline.events.map((event) => event.video_time);
  assert.deepEqual(times, [...times].sort((a, b) => a - b), "events stay sorted");
  assert.ok(timeline.duration_seconds >= Math.max(...times));
});

test("timeline is deterministic and shows each media once", () => {
  const [trip] = new TripBuilder().build([point("m1", 0, 40.75, -74.0), point("m2", 120, 40.78, -73.97)]);
  const first = new TimelineBuilder().build(structuredClone(trip));
  const second = new TimelineBuilder().build(structuredClone(trip));
  assert.deepEqual(first, second);
  assert.ok(first.duration_seconds > 0);
  assert.equal(first.events.filter((event) => event.type === "media_show").length, 2);
  assert.equal(visibleMediaAt(first, 1.1)?.mediaId, "m1");
  assert.equal(visibleMediaAt(first, first.duration_seconds), null);
});

function osrmResponse(coordinates: number[][], distance: number) {
  return new Response(JSON.stringify({code: "Ok", routes: [{geometry: {coordinates}, distance, duration: distance / 10}]}), {status: 200});
}

test("OSRM router retries, caches by rounded coordinates and marks segments inferred", async () => {
  let calls = 0;
  const router = new OSRMRouter({
    cache: new RouteCache(),
    sleep: async () => undefined,
    fetch: async (url) => {
      calls += 1;
      assert.match(url, /\/route\/v1\/driving\/-74,40\.75;-73\.97,40\.78\?overview=full&geometries=geojson/);
      if (calls === 1) return new Response("busy", {status: 503});
      return osrmResponse([[-74, 40.75], [-73.98, 40.77], [-73.97, 40.78]], 4200);
    },
  });
  const a = {latitude: 40.75, longitude: -74};
  const b = {latitude: 40.78, longitude: -73.97};
  const segment = await router.route(a, b, "o1", "o2");
  assert.equal(segment.inferred, true);
  assert.equal(segment.geometry.length, 3);
  const again = await router.route(a, b, "x1", "x2");
  assert.equal(calls, 2);
  assert.equal(again.start_observation_id, "x1");
});

test("route assembly joins segments and computes observation progress", async () => {
  const [trip] = new TripBuilder().build([point("a", 0, 40.75, -74), point("b", 60, 40.78, -73.97), point("c", 120, 40.8, -73.95)]);
  const distances = [1000, 3000];
  let index = 0;
  const route = await buildRoute(trip, {
    route: async (start, end, s, e) => ({
      start_observation_id: s, end_observation_id: e, geometry: [start, end],
      distance_meters: distances[index++], duration_seconds: 60, routing_profile: "driving", inferred: true,
    }),
  });
  assert.equal(route.geometry.length, 3);
  assert.equal(route.distance_meters, 4000);
  assert.deepEqual(routeProgresses(route, 3), [0, 0.25, 1]);
  assert.deepEqual(routeProgresses(null, 3), [0, 0.5, 1]);
});

test("place names follow the granularity rules", () => {
  const payload = {name: "Maya Devi Temple", address: {neighbourhood: "Sacred Garden", village: "Lumbini", county: "Rupandehi", state: "Lumbini Province"}};
  assert.equal(formatPlaceName(payload, "specific"), "Maya Devi Temple");
  assert.equal(formatPlaceName(payload, "neighborhood"), "Sacred Garden");
  assert.equal(formatPlaceName(payload, "city"), "Lumbini");
  assert.equal(formatPlaceName(payload, "region"), "Rupandehi");
});

test("Nominatim client throttles, caches reverse lookups and parses searches", async () => {
  let clock = 0;
  const waits: number[] = [];
  const urls: string[] = [];
  const geocoder = new NominatimGeocoder({
    now: () => clock,
    sleep: async (ms) => { waits.push(ms); clock += ms; },
    fetch: async (url) => {
      urls.push(url);
      if (url.includes("/search?")) return new Response(JSON.stringify([{lat: "27.67", lon: "85.32", display_name: "Lalitpur, Nepal"}, {lat: "x"}]));
      return new Response(JSON.stringify({address: {city: "Lalitpur"}}));
    },
  });
  assert.equal(await geocoder.reverse(27.67, 85.32, "city"), "Lalitpur");
  assert.equal(await geocoder.reverse(27.67, 85.32, "region"), "Lalitpur");
  assert.deepEqual(await geocoder.search("  Lalitpur   Nepal "), [{latitude: 27.67, longitude: 85.32, display_name: "Lalitpur, Nepal"}]);
  assert.equal(urls.length, 2);
  assert.ok(urls[1].includes("q=Lalitpur+Nepal"));
  assert.equal(waits.length, 1);
});

test("route endpoints: start, end and return-to-start", () => {
  const build = () => new TripBuilder().build([point("a", 0, 40.75, -74.0), point("b", 60, 40.78, -73.97)])[0];
  const withEnds = build();
  applyRouteEndpoints(withEnds, [40.7, -74.01], [40.8, -73.9], false);
  assert.equal(withEnds.observations.length, 4);
  assert.deepEqual(withEnds.observations[0].media_ids, []);
  const loop = build();
  applyRouteEndpoints(loop, null, null, true);
  assert.equal(loop.observations.length, 3);
  assert.equal(loop.observations[2].latitude, loop.observations[0].latitude);
  assert.equal(parseCoordinates("27.6, 85.3")?.[1], 85.3);
  assert.throws(() => parseCoordinates("95, 10"));
  assert.equal(parseCoordinates("Lumbini"), null);
});

test("analyzeMedia builds a trip payload with inferred route and keeps routing errors explicit", async () => {
  const media = [point("a", 0, 40.75, -74.0), point("b", 90, 40.78, -73.97)];
  const services = {
    router: {route: async () => { throw new Error("OSRM down"); }},
    forwardGeocode: async () => null,
  };
  const [analyzed] = await analyzeMedia(media, {keepAsOneTrip: true, startLocation: null, endLocation: null, returnToStart: false}, services);
  assert.equal(analyzed.route, null);
  assert.equal(analyzed.routeError, "OSRM down");
  const payload = tripPayload(analyzed, {}, (item) => ({url: `blob:${item.id}`, preview_url: `blob:${item.id}`}));
  assert.equal(payload.summary.stop_count, 2);
  assert.equal(payload.observations[0].place, "Unknown place");
  assert.deepEqual(payload.observations.map((item) => item.progress), [0, 1]);
  assert.equal(payload.trip.media[0].url, "blob:a");
  await assert.rejects(
    analyzeMedia(media, {keepAsOneTrip: true, startLocation: "Nowhere", endLocation: null, returnToStart: false}, services),
    /Could not find location: Nowhere/,
  );
});

import {playbackStateAt} from "./engine/timeline.ts";

test("playback eases between stops and holds while media shows", () => {
  const [trip] = new TripBuilder().build([point("a", 0, 40.75, -74.0), point("b", 120, 40.78, -73.97), point("c", 240, 40.8, -73.95)]);
  const timeline = new TimelineBuilder().build(trip);
  const observations = trip.observations.map((item, i) => ({id: item.id, progress: [0, 0.4, 1][i]}));
  const moves = timeline.events.filter((event) => event.type === "move");
  assert.equal(playbackStateAt(timeline, observations, 0).phase, "intro");
  assert.equal(playbackStateAt(timeline, observations, 0).progress, 0);
  const first = moves[0];
  const mid = playbackStateAt(timeline, observations, first.video_time + Number(first.payload.duration_seconds) / 2);
  assert.equal(mid.phase, "move");
  close(mid.progress, 0.2, 1e-9);
  assert.equal(mid.toIndex, 1);
  const holding = playbackStateAt(timeline, observations, first.video_time + Number(first.payload.duration_seconds) + 0.5);
  assert.equal(holding.phase, "stop");
  assert.equal(holding.progress, 0.4);
  assert.equal(holding.atIndex, 1);
  const end = playbackStateAt(timeline, observations, timeline.duration_seconds);
  assert.equal(end.phase, "outro");
  assert.equal(end.progress, 1);
  assert.equal(end.atIndex, 2);
});

import {applyStopEdits, customStopId} from "./engine/analyze.ts";

test("stops can be reordered and custom places added, with sane move timings", async () => {
  const media = [point("a", 0, 40.75, -74.0), point("b", 60, 40.78, -73.97), point("c", 120, 40.8, -73.95)];
  const services = {
    router: {route: async (start: {latitude: number; longitude: number}, end: {latitude: number; longitude: number}, s: string, e: string) => ({
      start_observation_id: s, end_observation_id: e, geometry: [start, end], distance_meters: 1000, duration_seconds: 60, routing_profile: "driving", inferred: true as const,
    })},
    forwardGeocode: async () => null,
  };
  const [analyzed] = await analyzeMedia(media, {keepAsOneTrip: true, startLocation: null, endLocation: null, returnToStart: false}, services);
  const [a, b, c] = analyzed.trip.observations.map((item) => item.id);
  const edited = await applyStopEdits(analyzed, [
    {kind: "observation", id: c},
    {kind: "custom", latitude: 40.77, longitude: -73.98, name: "Lunch spot"},
    {kind: "observation", id: a},
    {kind: "observation", id: b},
  ], services);
  assert.deepEqual(edited.trip.observations.map((item) => item.id), [c, customStopId(40.77, -73.98, "Lunch spot"), a, b]);
  assert.equal(edited.route?.segments.length, 3);
  const moves = edited.timeline.events.filter((event) => event.type === "move");
  assert.equal(moves.length, 3);
  assert.ok(moves.every((event) => Number(event.payload.duration_seconds) >= 0.5), "reordered moves still take visible time");
  assert.equal(analyzed.trip.observations[0].id, a, "the original trip is not mutated");
});

import {formatPhotonPlace, PhotonGeocoder} from "./engine/places.ts";

test("Photon fallback formats places by granularity", async () => {
  const properties = {name: "Satdobato Chowk", street: "Kathmandu Ringroad", locality: "Ekantakuna", district: "Lalitpur-13", city: "Lalitpur", state: "Bagmati Province"};
  assert.equal(formatPhotonPlace(properties, "specific"), "Satdobato Chowk");
  assert.equal(formatPhotonPlace(properties, "neighborhood"), "Ekantakuna");
  assert.equal(formatPhotonPlace(properties, "city"), "Lalitpur");
  assert.equal(formatPhotonPlace(properties, "region"), "Bagmati Province");
  const photon = new PhotonGeocoder({fetch: async (url) => {
    assert.match(url, /photon\.komoot\.io\/reverse\?lat=27\.6588&lon=85\.3247&lang=en/);
    return Response.json({features: [{properties}]});
  }});
  assert.equal(await photon.reverse(27.6588, 85.3247, "city"), "Lalitpur");
});

import {cleanPlaceName} from "./engine/places.ts";

test("Nepali administrative names are tidied for map labels", () => {
  assert.equal(cleanPlaceName("Indrasarowar-04"), "Indrasarowar");
  assert.equal(cleanPlaceName("Bharatpur-12"), "Bharatpur");
  assert.equal(cleanPlaceName("Dakshinkali Municipality"), "Dakshinkali");
  assert.equal(cleanPlaceName("Indrasarowar Rural Municipality, Makwanpur"), "Indrasarowar");
  assert.equal(cleanPlaceName("Lalitpur Metropolitan City"), "Lalitpur");
  assert.equal(cleanPlaceName("Thaha-04"), "Thaha");
  assert.equal(cleanPlaceName("Lumbini Bazaar"), "Lumbini Bazaar");
  assert.equal(cleanPlaceName("Route 66"), "Route 66");
  assert.equal(formatPlaceName({address: {neighbourhood: "Dakshinkali-05", city: "Dakshinkali"}}, "neighborhood"), "Dakshinkali");
});

test("an added place can be removed again, even when the same place was added twice", async () => {
  const services = {
    router: {route: async (start: {latitude: number; longitude: number}, end: {latitude: number; longitude: number}, s: string, e: string) => ({
      start_observation_id: s, end_observation_id: e, geometry: [start, end], distance_meters: 1000, duration_seconds: 60, routing_profile: "driving", inferred: true as const,
    })},
    forwardGeocode: async () => null,
  };
  const [analyzed] = await analyzeMedia([point("a", 0, 40.75, -74.0), point("b", 60, 40.78, -73.97)], {keepAsOneTrip: true, startLocation: null, endLocation: null, returnToStart: false}, services);
  const original = analyzed.trip.observations.map((item) => ({kind: "observation" as const, id: item.id}));
  const place = {kind: "custom" as const, latitude: 40.77, longitude: -73.98, name: "Lunch spot"};
  const twice = await applyStopEdits(analyzed, [...original, {...place, id: "first"}, {...place, id: "second"}], services);
  assert.deepEqual(twice.trip.observations.slice(2).map((item) => item.id), ["first", "second"]);
  const once = await applyStopEdits(twice, twice.trip.observations.filter((item) => item.id !== "first").map((item) => ({kind: "observation" as const, id: item.id})), services);
  assert.deepEqual(once.trip.observations.map((item) => item.id), [...original.map((item) => item.id), "second"]);
  const none = await applyStopEdits(once, original, services);
  assert.equal(none.trip.observations.length, 2);
  assert.equal(none.route?.segments.length, 1);
});

import {detectMediaType, sniffMediaType, extractMetadata as extractFromBlob} from "./engine/metadata/extract.ts";

test("media type is recognised from bytes when a phone picker drops the extension", async () => {
  const bytes = (...parts: Array<number[] | string>) => new Uint8Array(parts.flatMap((part) => (typeof part === "string" ? [...part].map((c) => c.charCodeAt(0)) : part)));
  assert.equal(sniffMediaType(bytes([0xff, 0xd8, 0xff, 0xe1])), "photo");
  assert.equal(sniffMediaType(bytes([0x89], "PNG", [13, 10, 26, 10])), "photo");
  assert.equal(sniffMediaType(bytes("RIFF", [0, 0, 0, 0], "WEBP")), "photo");
  assert.equal(sniffMediaType(bytes([0, 0, 0, 24], "ftypheic")), "photo");
  assert.equal(sniffMediaType(bytes([0, 0, 0, 24], "ftypqt  ")), "video");
  assert.equal(sniffMediaType(bytes([0, 0, 0, 24], "ftypmp42")), "video");
  assert.equal(sniffMediaType(bytes("hello world!")), null);
  assert.equal(detectMediaType("1000012345", "video/mp4"), "video");
  assert.throws(() => detectMediaType("notes", "text/plain", bytes("hello world!")), /Unsupported/);

  const jpeg = buildJpeg(buildTiff({dateTimeOriginal: "2026:10:24 07:00:00", latitude: 27.65, longitude: 85.32}));
  const media = await extractFromBlob(new Blob([jpeg as BlobPart]), "1000012345", "x");
  assert.equal(media.media_type, "photo");
  close(media.latitude ?? 0, 27.65, 1e-6);
});
