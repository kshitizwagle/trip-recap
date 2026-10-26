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

import {fetchPlaces, renameStop, updateStops} from "./trip-api.ts";

test("places fill in one by one, fall back to Photon, and can be renamed; stops can be reordered and added", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("router.project-osrm.org")) {
      return Response.json({code: "Ok", routes: [{geometry: {coordinates: [[85.32, 27.67], [85.26, 27.61]]}, distance: 5000, duration: 600}]});
    }
    if (url.includes("nominatim.openstreetmap.org/reverse")) {
      if (url.includes("lat=27.6128")) return new Response("busy", {status: 429});
      return Response.json({address: {suburb: "Satdobato"}});
    }
    if (url.includes("photon.komoot.io/reverse")) return Response.json({features: [{properties: {locality: "Dakshinkali"}}]});
    if (url.includes("nominatim.openstreetmap.org/search")) return Response.json([{lat: "27.5844", lon: "83.3768", display_name: "Lumbini Palace Resort, Siyari, Nepal"}]);
    throw new Error(`unexpected ${url}`);
  };
  try {
    const sessionId = "session-places";
    const a = await uploadMedia(sessionId, jpeg("a.jpg", "2026:10:24 08:00:00", 27.6588, 85.3247), () => undefined).promise;
    const b = await uploadMedia(sessionId, jpeg("b.jpg", "2026:10:24 09:00:00", 27.6128, 85.2645), () => undefined).promise;
    const {trips: [trip]} = await analyzeSession({session_id: sessionId, upload_ids: [a.id, b.id], keep_as_one_trip: true, start_location: null, end_location: null, return_to_start: false});
    assert.ok(trip.observations.every((item) => item.place === "Looking up…"));
    const updates: Array<Record<string, string>> = [];
    const {places} = await fetchPlaces(trip.id, "neighborhood", (value) => updates.push(value));
    assert.equal(updates.length, 2);
    assert.equal(Object.values(updates[0]).filter((value) => value === "Looking up…").length, 1);
    assert.deepEqual(trip.observations.map((item) => places[item.id]), ["Satdobato", "Dakshinkali"]);

    const renamed = await renameStop(trip.id, trip.observations[0].id, "Home");
    assert.equal(renamed.observations[0].place, "Home");

    const [first, second] = trip.observations.map((item) => item.id);
    const edited = await updateStops(trip.id, [{id: second}, {query: "Lumbini Palace Resort, Siyari, Nepal"}, {id: first}]);
    assert.equal(edited.observations.length, 3);
    assert.deepEqual(edited.observations.map((item) => item.place), ["Looking up…", "Lumbini Palace Resort", "Home"].map((value, i) => i === 0 ? edited.observations[0].place : value));
    assert.equal(edited.observations[1].media_files.length, 0);
    assert.equal(edited.route?.properties.inferred, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
