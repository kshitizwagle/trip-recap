import assert from "node:assert/strict";
import test from "node:test";
import {MAX_FILE_BYTES, canAnalyze, partitionFiles} from "./upload-queue.ts";

const file = (name: string, size: number) => ({name, size});

test("accepts files at the limit and rejects files above it", () => {
  const result = partitionFiles([
    file("exact.jpg", MAX_FILE_BYTES),
    file("too-large.mov", MAX_FILE_BYTES + 1),
  ]);

  assert.deepEqual(result.accepted.map((item) => item.name), ["exact.jpg"]);
  assert.deepEqual(result.rejected.map((item) => item.name), ["too-large.mov"]);
});

test("does not allow analysis while a retained upload is pending", () => {
  assert.equal(
    canAnalyze([
      {status: "uploading", discarded: false},
      {status: "uploaded", discarded: false},
    ]),
    false,
  );
  assert.equal(
    canAnalyze([{status: "uploaded", discarded: false}]),
    true,
  );
});

test("allows analysis when a retained upload failed but another is ready", () => {
  assert.equal(
    canAnalyze([
      {status: "uploaded", discarded: false},
      {status: "failed", discarded: false},
    ]),
    true,
  );
  assert.equal(
    canAnalyze([{status: "failed", discarded: false}]),
    false,
  );
});
