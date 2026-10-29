import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_FILE_BYTES,
  canAnalyze,
  isSupportedMedia,
  partitionFiles,
  resetUploadForRetry,
} from "./upload-queue.ts";

const file = (name: string, size: number) => ({name, size});

test("accepts files at the limit and rejects files above it", () => {
  const result = partitionFiles([
    file("exact.jpg", MAX_FILE_BYTES),
    file("too-large.mov", MAX_FILE_BYTES + 1),
  ]);

  assert.deepEqual(result.accepted.map((item) => item.name), ["exact.jpg"]);
  assert.deepEqual(result.rejected.map((item) => item.name), ["too-large.mov"]);
});

test("skips files the metadata parser cannot read", () => {
  const result = partitionFiles([
    file("IMG_0001.HEIC", 10),
    file("clip.mov", 10),
    file("notes.txt", 10),
    file("scan.pdf", 10),
    file("1000012345", 10),
  ]);

  assert.deepEqual(result.accepted.map((item) => item.name), ["IMG_0001.HEIC", "clip.mov", "1000012345"]);
  assert.deepEqual(result.unsupported.map((item) => item.name), ["notes.txt", "scan.pdf"]);
});

test("keeps extensionless files only when their MIME type could be media", () => {
  assert.equal(isSupportedMedia({name: "1000012345", type: "image/jpeg"}), true);
  assert.equal(isSupportedMedia({name: "1000012345", type: ""}), true);
  assert.equal(isSupportedMedia({name: "1000012345", type: "application/pdf"}), false);
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

test("resets a failed upload to queued state for retry", () => {
  assert.deepEqual(
    resetUploadForRetry({status: "failed", progress: 38, message: "Upload failed"}),
    {status: "queued", progress: 0, message: "Queued"},
  );
});
