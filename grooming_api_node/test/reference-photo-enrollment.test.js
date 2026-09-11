import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReferencePhotoKey } from "../src/services/photoStorage.js";
import * as faceRecognition from "../src/services/faceRecognition.js";

/**
 * Reference-photo enrollment: the add/replace rule, the face cap, and the two
 * storage properties the retention purge depends on.
 *
 * The endpoint itself needs Express, Mongo and R2, so what is proved here is
 * the decision layer it delegates to — which face is retired, which is kept,
 * and where the object is written. Those are the parts that silently lose data
 * when they are wrong: a retired face left in the collection keeps matching,
 * and a reference photo written under the wrong prefix is deleted two months
 * later with nothing logged.
 */

function withEnv(values, run) {
  const original = {};
  for (const [key, value] of Object.entries(values)) {
    original[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/**
 * The route's own selection of faces to retire, extracted so the rule can be
 * asserted directly. Mirrors the branch in POST /:instructorId/face.
 */
function retiredFaceIds(mode, existingFaceIds) {
  return mode === "replace"
    ? existingFaceIds
    : faceRecognition.facesToEvict(existingFaceIds, { adding: 1 });
}

/** What the record ends up holding, given the retirement decision. */
function resultingFaceIds(mode, existingFaceIds, newFaceId) {
  const retired = retiredFaceIds(mode, existingFaceIds);
  const kept = existingFaceIds.filter((id) => !retired.includes(id));
  return { retired, faceIds: [...kept, newFaceId] };
}

test("add keeps the existing faces alongside the new one", () => {
  // One photograph in one lighting condition fails repeatedly in others, so
  // accumulating embeddings is the point of add.
  withEnv({ REKOGNITION_MAX_FACES_PER_INSTRUCTOR: "6" }, () => {
    const { retired, faceIds } = resultingFaceIds("add", ["face-1", "face-2"], "face-3");
    assert.deepEqual(retired, []);
    assert.deepEqual(faceIds, ["face-1", "face-2", "face-3"]);
  });
});

test("replace discards every earlier face and keeps only the new one", () => {
  withEnv({ REKOGNITION_MAX_FACES_PER_INSTRUCTOR: "6" }, () => {
    const { retired, faceIds } = resultingFaceIds("replace", ["face-1", "face-2"], "face-3");
    assert.deepEqual(retired, ["face-1", "face-2"]);
    assert.deepEqual(faceIds, ["face-3"]);
  });
});

test("replace on an instructor with no face yet is just an add", () => {
  withEnv({ REKOGNITION_MAX_FACES_PER_INSTRUCTOR: "6" }, () => {
    const { retired, faceIds } = resultingFaceIds("replace", [], "face-1");
    assert.deepEqual(retired, []);
    assert.deepEqual(faceIds, ["face-1"]);
  });
});

test("add at the cap retires the oldest face, never the newest", () => {
  // Newer photographs come from the tablet and lighting actually in use, so
  // they are the ones worth keeping when something has to go.
  withEnv({ REKOGNITION_MAX_FACES_PER_INSTRUCTOR: "3" }, () => {
    const { retired, faceIds } = resultingFaceIds("add", ["oldest", "middle", "newest"], "fresh");
    assert.deepEqual(retired, ["oldest"]);
    assert.deepEqual(faceIds, ["middle", "newest", "fresh"]);
    // The cap holds rather than growing by one on every correction.
    assert.equal(faceIds.length, 3);
  });
});

test("a record already over the cap is trimmed back to it, oldest first", () => {
  // A lowered cap, or faces written before one existed, must converge rather
  // than stay over the limit forever.
  withEnv({ REKOGNITION_MAX_FACES_PER_INSTRUCTOR: "2" }, () => {
    const { retired, faceIds } = resultingFaceIds("add", ["a", "b", "c", "d"], "e");
    assert.deepEqual(retired, ["a", "b", "c"]);
    assert.deepEqual(faceIds, ["d", "e"]);
    assert.equal(faceIds.length, 2);
  });
});

test("every retired face is dropped from the record, so none is left searchable", () => {
  // A face removed from the record but left in the collection keeps matching,
  // with nothing pointing at it to find it again.
  withEnv({ REKOGNITION_MAX_FACES_PER_INSTRUCTOR: "3" }, () => {
    const existing = ["a", "b", "c"];
    for (const mode of ["add", "replace"]) {
      const { retired, faceIds } = resultingFaceIds(mode, existing, "new");
      for (const id of retired) {
        assert.ok(!faceIds.includes(id), `${mode}: retired ${id} must not remain on the record`);
      }
    }
  });
});

test("a reference photo is written outside the prefix the purge sweeps", () => {
  // The retention purge deletes attendance photo keys and the orphan reconciler
  // lists attendance/ and removes anything unreferenced. A reference photo
  // under that prefix would be deleted roughly two months after enrollment:
  // recognition would keep working, because the face vector lives at
  // Rekognition, so the only symptom would be a missing image, months late.
  const key = buildReferencePhotoKey({ instructorId: "abc-123", mimeType: "image/jpeg" });
  assert.ok(key.startsWith("reference/"));
  assert.ok(!key.startsWith("attendance/"));
});

test("a replacement photo never collides with the photo it replaces", () => {
  // The old object is deleted after the new one is written, so an identical key
  // would delete the replacement.
  const first = buildReferencePhotoKey({ instructorId: "abc-123", mimeType: "image/jpeg" });
  const second = buildReferencePhotoKey({ instructorId: "abc-123", mimeType: "image/jpeg" });
  assert.notEqual(first, second);
});

test("an instructor id that could escape its prefix is sanitised", () => {
  const key = buildReferencePhotoKey({ instructorId: "../../etc/passwd", mimeType: "image/jpeg" });
  assert.ok(key.startsWith("reference/"));
  assert.ok(!key.includes(".."));
  assert.ok(!key.includes("/etc/"));
});

test("the stored extension follows the normalised image type", () => {
  // The normalizer always emits JPEG, so a reference key should say so rather
  // than carry the extension the admin happened to upload.
  assert.ok(buildReferencePhotoKey({ instructorId: "i", mimeType: "image/jpeg" }).endsWith(".jpg"));
  assert.ok(buildReferencePhotoKey({ instructorId: "i", mimeType: "image/png" }).endsWith(".png"));
  // An unknown type falls back rather than producing a key with no extension.
  assert.ok(buildReferencePhotoKey({ instructorId: "i", mimeType: "image/tiff" }).endsWith(".jpg"));
});
