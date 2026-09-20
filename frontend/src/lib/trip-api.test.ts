import assert from "node:assert/strict";
import test from "node:test";
import {apiUrl, fetchTripData, searchLocations} from "./trip-api.ts";

test("API and media URLs resolve against the separately deployed backend", async () => {
  const previousBase = process.env.NEXT_PUBLIC_API_BASE_URL;
  const previousFetch = globalThis.fetch;
  process.env.NEXT_PUBLIC_API_BASE_URL = "https://api.example.com/";
  globalThis.fetch = async input => {
    assert.equal(String(input), "https://api.example.com/api/trips/trip-id/data");
    return Response.json({trip: {media: [{
      url: "/api/trips/trip-id/media/media-id",
      preview_url: "/api/trips/trip-id/media/media-id/preview",
    }]}});
  };
  try {
    assert.equal(apiUrl("/api/renders/job/video"), "https://api.example.com/api/renders/job/video");
    const data = await fetchTripData("trip-id");
    assert.equal(data.trip.media[0].url, "https://api.example.com/api/trips/trip-id/media/media-id");
    assert.equal(data.trip.media[0].preview_url, "https://api.example.com/api/trips/trip-id/media/media-id/preview");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousBase === undefined) delete process.env.NEXT_PUBLIC_API_BASE_URL;
    else process.env.NEXT_PUBLIC_API_BASE_URL = previousBase;
  }
});

test("searchLocations encodes the query and forwards its abort signal", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let requestedUrl = "";
  let requestedSignal: AbortSignal | null | undefined;

  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input);
    requestedSignal = init?.signal;
    return new Response(JSON.stringify({results: []}), {
      status: 200,
      headers: {"Content-Type": "application/json"},
    });
  };

  try {
    const response = await searchLocations("New York / Manhattan", controller.signal);
    assert.deepEqual(response, {results: []});
    assert.equal(
      requestedUrl,
      apiUrl("/api/locations/search?q=New%20York%20%2F%20Manhattan&limit=5"),
    );
    assert.equal(requestedSignal, controller.signal);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
