import assert from "node:assert/strict";
import { test } from "node:test";
import * as faceRecognition from "../src/services/faceRecognition.js";

/**
 * Face identification decides who an attendance record belongs to, so these
 * tests are about the one failure that matters: returning a person the
 * photograph does not show. Every path that cannot answer confidently must
 * report a reason instead of a name.
 *
 * No AWS collection exists yet. The Rekognition client is mocked at the module
 * boundary so the whole decision layer is provable now, and so the suite never
 * depends on a network call or a live credential.
 */

const COLLECTION = "facultytrack-faces-test";

/**
 * Installs a stub provider client and returns the service plus the commands it
 * was given.
 *
 * The real AWS command classes are used, so an input asserted here is the input
 * the SDK would actually send; only the transport is replaced. Each command
 * object carries its own constructor name, which is how the stub routes a
 * canned response.
 */
function loadService({ responses = {}, failures = {} } = {}) {
  const sent = [];
  const nameOf = (command) => command?.constructor?.name
    ?.replace(/Command$/, "")
    ?? "";

  faceRecognition.setRekognitionClientForTests({
    async send(command) {
      sent.push(Object.assign(command, { commandName: nameOf(command) }));
      const key = nameOf(command);
      if (failures[key]) throw failures[key];
      return responses[key] ?? {};
    },
  });

  return { ...faceRecognition, sent };
}

/** A match as Rekognition returns it. */
const faceMatch = (instructorId, similarity, faceId = `face-${instructorId}-${similarity}`) => ({
  Similarity: similarity,
  Face: { FaceId: faceId, ExternalImageId: instructorId },
});

const goodQuality = {
  FaceDetails: [{ Confidence: 99.9, Quality: { Sharpness: 80, Brightness: 70 } }],
};

const imageBytes = Buffer.from("not-a-real-jpeg-only-bytes-for-the-stub");

/**
 * Runs one test with these environment variables in place, then restores them.
 *
 * Deliberately async: the callbacks below await the service, and a synchronous
 * `finally` would restore the environment before the first await resolved. The
 * service would then read whatever the real process had — which is how every
 * configured-state assertion in this file first failed while the service itself
 * was correct.
 */
async function withEnv(values, run) {
  const original = {};
  for (const [key, value] of Object.entries(values)) {
    original[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** The configured state: a collection plus the credentials the SDK needs. */
const configured = {
  REKOGNITION_COLLECTION_ID: COLLECTION,
  AWS_REKOGNITION_REGION: "ap-south-1",
  AWS_ACCESS_KEY_ID: "test-access-key-id",
  AWS_SECRET_ACCESS_KEY: "test-secret-access-key",
};

test.afterEach(() => {
  // Leaving a stub installed would hand the next test file a fake provider.
  faceRecognition.setRekognitionClientForTests(null);
});

test("an unconfigured collection reports itself instead of throwing", async () => {
  // Check-in must keep working before the AWS collection exists, so every
  // entry point answers NOT_CONFIGURED rather than raising a credentials error.
  await withEnv({ ...configured, REKOGNITION_COLLECTION_ID: "" }, async () => {
    const service = await loadService();
    assert.equal(service.isFaceRecognitionConfigured(), false);
    for (const result of [
      await service.searchFaceByImage(imageBytes),
      await service.checkFaceQuality(imageBytes),
      await service.indexFace(imageBytes, "instructor-1"),
      await service.deleteFaces(["face-1"]),
    ]) {
      assert.equal(result.ok, false);
      assert.equal(result.reason, "NOT_CONFIGURED");
    }
  });
});

test("identity comes from the instructor id, not from the face id", async () => {
  // One instructor owns several embeddings, so a FaceId names a photograph
  // while ExternalImageId names the person.
  await withEnv(configured, async () => {
    const service = await loadService({
      responses: { SearchFacesByImage: { FaceMatches: [faceMatch("instructor-7", 98.2)] } },
    });
    const result = await service.searchFaceByImage(imageBytes);
    assert.equal(result.ok, true);
    assert.equal(result.instructorId, "instructor-7");
    assert.equal(result.similarity, 98.2);
  });
});

test("two embeddings of one person are one match, not an ambiguous pair", async () => {
  // The accumulating-faces design means the nearest neighbours are usually the
  // same person. Grouping by instructor is what stops that reading as a tie.
  await withEnv(configured, async () => {
    const service = await loadService({
      responses: {
        SearchFacesByImage: {
          FaceMatches: [
            faceMatch("instructor-7", 97.1, "face-a"),
            faceMatch("instructor-7", 96.4, "face-b"),
            faceMatch("instructor-7", 95.8, "face-c"),
          ],
        },
      },
    });
    const result = await service.searchFaceByImage(imageBytes);
    assert.equal(result.ok, true);
    assert.equal(result.instructorId, "instructor-7");
    // The best of that person's own scores, and no rival person to report.
    assert.equal(result.similarity, 97.1);
    assert.equal(result.runnerUp, null);
  });
});

test("the closest rival person is reported so look-alikes can be found later", async () => {
  await withEnv(configured, async () => {
    const service = await loadService({
      responses: {
        SearchFacesByImage: {
          FaceMatches: [faceMatch("instructor-7", 97.0), faceMatch("instructor-9", 96.2)],
        },
      },
    });
    const result = await service.searchFaceByImage(imageBytes);
    assert.equal(result.instructorId, "instructor-7");
    assert.deepEqual(result.runnerUp, { instructorId: "instructor-9", similarity: 96.2 });
  });
});

test("a score below the threshold is refused rather than offered as a guess", async () => {
  await withEnv({ ...configured, REKOGNITION_MATCH_THRESHOLD: "95" }, async () => {
    const service = await loadService({
      responses: { SearchFacesByImage: { FaceMatches: [faceMatch("instructor-7", 91.4)] } },
    });
    const result = await service.searchFaceByImage(imageBytes);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "BELOW_THRESHOLD");
    assert.equal(result.instructorId, undefined);
  });
});

test("the provider is asked to apply the threshold too", async () => {
  // Belt and braces: a candidate under the floor should not even be returned,
  // so a future caller cannot mistake one for a suggestion.
  await withEnv({ ...configured, REKOGNITION_MATCH_THRESHOLD: "97" }, async () => {
    const service = await loadService({
      responses: { SearchFacesByImage: { FaceMatches: [faceMatch("instructor-7", 99)] } },
    });
    await service.searchFaceByImage(imageBytes);
    const search = service.sent.find((command) => command.commandName === "SearchFacesByImage");
    assert.equal(search.input.FaceMatchThreshold, 97);
    assert.equal(search.input.CollectionId, COLLECTION);
  });
});

test("no match and no face are distinguished", async () => {
  await withEnv(configured, async () => {
    const empty = await loadService({ responses: { SearchFacesByImage: { FaceMatches: [] } } });
    assert.equal((await empty.searchFaceByImage(imageBytes)).reason, "NO_MATCH");

    // Rekognition reports an unusable image as InvalidParameterException, not
    // as an empty result, and the two mean different things to the caller.
    const noFace = await loadService({
      failures: {
        SearchFacesByImage: Object.assign(new Error("no face"), { name: "InvalidParameterException" }),
      },
    });
    assert.equal((await noFace.searchFaceByImage(imageBytes)).reason, "NO_FACE");
  });
});

test("a matched face with no instructor id is not a match", async () => {
  // An externally indexed face cannot be traced to a person, so it must never
  // resolve to one.
  await withEnv(configured, async () => {
    const service = await loadService({
      responses: {
        SearchFacesByImage: {
          FaceMatches: [{ Similarity: 99, Face: { FaceId: "orphan-face" } }],
        },
      },
    });
    assert.equal((await service.searchFaceByImage(imageBytes)).reason, "NO_MATCH");
  });
});

test("a provider outage is reported, never thrown, so the check-in survives", async () => {
  // The caller saves the record unidentified on PROVIDER_ERROR. Throwing here
  // would lose an attendance submission to an AWS incident.
  await withEnv(configured, async () => {
    const service = await loadService({
      failures: {
        SearchFacesByImage: Object.assign(new Error("service down"), { name: "ThrottlingException" }),
      },
    });
    const result = await service.searchFaceByImage(imageBytes);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "PROVIDER_ERROR");
  });
});

test("a reference photograph needs exactly one good face", async () => {
  await withEnv(configured, async () => {
    const none = await loadService({ responses: { DetectFaces: { FaceDetails: [] } } });
    assert.equal((await none.checkFaceQuality(imageBytes)).reason, "NO_FACE");

    const many = await loadService({
      responses: { DetectFaces: { FaceDetails: [goodQuality.FaceDetails[0], goodQuality.FaceDetails[0]] } },
    });
    assert.equal((await many.checkFaceQuality(imageBytes)).reason, "MULTIPLE_FACES");

    const good = await loadService({ responses: { DetectFaces: goodQuality } });
    const accepted = await good.checkFaceQuality(imageBytes);
    assert.equal(accepted.ok, true);
    assert.equal(accepted.quality.sharpness, 80);
  });
});

test("a blurry or dark reference photograph is refused before it is indexed", async () => {
  // This is the expensive one to get wrong: a poor reference does not fail
  // loudly, it produces confident wrong matches until someone removes it.
  await withEnv(configured, async () => {
    const blurry = await loadService({
      responses: { DetectFaces: { FaceDetails: [{ Confidence: 99, Quality: { Sharpness: 3, Brightness: 70 } }] } },
    });
    assert.equal((await blurry.checkFaceQuality(imageBytes)).reason, "POOR_QUALITY");

    const dark = await loadService({
      responses: { DetectFaces: { FaceDetails: [{ Confidence: 99, Quality: { Sharpness: 80, Brightness: 4 } }] } },
    });
    assert.equal((await dark.checkFaceQuality(imageBytes)).reason, "POOR_QUALITY");
  });
});

test("indexing tags the face with the instructor id", async () => {
  await withEnv(configured, async () => {
    const service = await loadService({
      responses: { IndexFaces: { FaceRecords: [{ Face: { FaceId: "new-face-id" } }] } },
    });
    const result = await service.indexFace(imageBytes, "instructor-42");
    assert.equal(result.ok, true);
    assert.equal(result.faceId, "new-face-id");

    const command = service.sent.find((entry) => entry.commandName === "IndexFaces");
    assert.equal(command.input.ExternalImageId, "instructor-42");
    assert.equal(command.input.CollectionId, COLLECTION);
    // Never let the provider pick a face when a photo shows several.
    assert.equal(command.input.MaxFaces, 1);
  });
});

test("an instructor id Rekognition cannot store is refused locally", async () => {
  // ExternalImageId permits only [a-zA-Z0-9_.\-:]. Refusing here names the
  // instructor; refusing at the provider does not.
  await withEnv(configured, async () => {
    const service = await loadService();
    const result = await service.indexFace(imageBytes, "instructor 42/../etc");
    assert.equal(result.ok, false);
    assert.equal(service.sent.length, 0);
  });
});

test("an accepted request that indexed nothing is reported as a quality refusal", async () => {
  // QualityFilter rejection looks like success with an empty FaceRecords list.
  // Silently returning ok would leave an instructor enrolled with no face.
  await withEnv(configured, async () => {
    const service = await loadService({ responses: { IndexFaces: { FaceRecords: [] } } });
    const result = await service.indexFace(imageBytes, "instructor-42");
    assert.equal(result.ok, false);
    assert.equal(result.reason, "POOR_QUALITY");
  });
});

test("deleting no faces is a no-op that never calls the provider", async () => {
  await withEnv(configured, async () => {
    const service = await loadService();
    const result = await service.deleteFaces([]);
    assert.equal(result.ok, true);
    assert.equal(service.sent.length, 0);
  });
});

test("the oldest faces are evicted once the cap is reached", async () => {
  // Newer photographs come from the tablet in use, in the lighting that
  // collection actually has, so they are the ones worth keeping.
  await withEnv({ ...configured, REKOGNITION_MAX_FACES_PER_INSTRUCTOR: "3" }, async () => {
    const service = await loadService();
    assert.deepEqual(service.facesToEvict(["a", "b"], { adding: 1 }), []);
    assert.deepEqual(service.facesToEvict(["a", "b", "c"], { adding: 1 }), ["a"]);
    assert.deepEqual(service.facesToEvict(["a", "b", "c", "d"], { adding: 1 }), ["a", "b"]);
    assert.deepEqual(service.facesToEvict([], { adding: 1 }), []);
  });
});
