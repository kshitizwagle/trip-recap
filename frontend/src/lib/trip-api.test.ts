import assert from "node:assert/strict";
import test from "node:test";
import {buildJpeg, buildTiff} from "./engine/test-fixtures.ts";
import {analyzeSession, discardUploadedMedia, fetchTripData, searchLocations, uploadMedia} from "./trip-api.ts";

function jpeg(name: string, time: string, latitude: number, longitude: number): File {
  return new File([buildJpeg(buildTiff({dateTimeOriginal: time, latitude, longitude})) as BlobPart], name, {type: "image/jpeg"});
}

test("media is processed in the browser and analyzed without any server", async () => {
  const originalFetch = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    requested.push(url);
    assert.match(url, /^https:\/\/router\.project-osrm\.org\/route\/v1\/driving\//);
    return Response.json({code: "Ok", routes: [{geometry: {coordinates: [[85.32, 27.67], [85.26, 27.61]]}, distance: 14700, duration: 1980}]});
  };
  try {
    const sessionId = "session-a";
    const progress: number[] = [];
    const first = await uploadMedia(sessionId, jpeg("a.jpg", "2026:10:24 08:00:00", 27.6587, 85.3247), (value) => progress.push(value)).promise;
    const second = await uploadMedia(sessionId, jpeg("b.jpg", "2026:10:24 09:00:00", 27.6128, 85.2645), () => undefined).promise;
    assert.equal(progress.at(-1), 100);
    assert.equal(first.state, "uploaded");
    assert.equal(first.stored_bytes, 0);

    const response = await analyzeSession({
      session_id: sessionId,
      upload_ids: [first.id, second.id],
      keep_as_one_trip: true,
      start_location: null,
      end_location: null,
      return_to_start: false,
    });
    const trip = response.trips[0];
    assert.equal(trip.summary.stop_count, 2);
    assert.equal(trip.summary.distance_meters, 14700);
    assert.equal(trip.route?.properties.inferred, true);
    assert.match(trip.trip.media[0].url, /^blob:/);
    assert.equal(requested.length, 1);
    assert.equal((await fetchTripData(trip.id)).id, trip.id);

    await discardUploadedMedia(sessionId, first.id);
    await assert.rejects(
      analyzeSession({session_id: sessionId, upload_ids: [first.id], keep_as_one_trip: true, start_location: null, end_location: null, return_to_start: false}),
      /No available media/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("unsupported files are rejected before reading", async () => {
  await assert.rejects(uploadMedia("session-b", new File(["x"], "notes.txt"), () => undefined).promise, /Unsupported media type/);
});

test("searchLocations goes straight to Nominatim and forwards the abort signal", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  let sawSignal = false;
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input);
    sawSignal = init?.signal instanceof AbortSignal;
    return Response.json([{lat: "40.78", lon: "-73.97", display_name: "Manhattan, New York"}]);
  };
  try {
    const response = await searchLocations("New York / Manhattan", new AbortController().signal);
    assert.deepEqual(response.results, [{latitude: 40.78, longitude: -73.97, display_name: "Manhattan, New York"}]);
    assert.ok(requestedUrl.startsWith("https://nominatim.openstreetmap.org/search?q=New+York+%2F+Manhattan"));
    assert.ok(sawSignal);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
