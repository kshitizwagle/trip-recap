import assert from "node:assert/strict";
import test from "node:test";
import {searchLocations} from "./trip-api.ts";

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
    const response = await searchLocations("Mahalaxmi / Lalitpur", controller.signal);
    assert.deepEqual(response, {results: []});
    assert.equal(
      requestedUrl,
      "/api/locations/search?q=Mahalaxmi%20%2F%20Lalitpur&limit=5",
    );
    assert.equal(requestedSignal, controller.signal);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
