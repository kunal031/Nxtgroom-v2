import {
  DeleteFacesCommand,
  DetectFacesCommand,
  IndexFacesCommand,
  RekognitionClient,
  SearchFacesByImageCommand,
} from "@aws-sdk/client-rekognition";
import { runtimeConfig } from "../config/env.js";
import { incrementMetric, observeDuration } from "./telemetry.js";

/**
 * Face identification for photo-first attendance.
 *
 * The instructor is no longer chosen from a dropdown, so the match is what
 * supplies gender, college and the open session to close. Everything here is
 * therefore written to fail towards "I do not know" rather than towards a
 * guess: a wrong identity files one person's grooming record against another's
 * name, which is worse than recording no name at all.
 *
 * Identity resolves from ExternalImageId, which holds the instructor's own id,
 * never from a FaceId. One instructor accumulates several faces as admins
 * correct mistakes, so a FaceId names one photograph of a person while
 * ExternalImageId names the person.
 */

let client = null;
let clientFingerprint = "";

/**
 * Test seam for the provider client.
 *
 * The decision layer here — grouping candidates by person, applying the
 * threshold, refusing a poor reference — is the part worth proving, and it must
 * be provable without a live collection or a credential. Node's module mocking
 * is still behind a flag, and `npm test` runs a plain `node --test`, so the
 * client is injected rather than intercepted.
 */
let clientOverride = null;

export function setRekognitionClientForTests(stub) {
  clientOverride = stub;
  client = null;
  clientFingerprint = "";
}

/**
 * Rekognition is optional until the collection exists.
 *
 * The flow is being built before the AWS collection has been created, and the
 * existing select-an-instructor check-in must keep working in the meantime.
 * Every entry point therefore reports NOT_CONFIGURED instead of throwing, so a
 * half-configured deployment degrades to the old behaviour rather than failing
 * every attendance submission with an AWS credentials error.
 */
export function isFaceRecognitionConfigured() {
  const config = runtimeConfig();
  return Boolean(
    config.rekognitionCollectionId
    && process.env.AWS_ACCESS_KEY_ID?.trim()
    && process.env.AWS_SECRET_ACCESS_KEY?.trim()
  );
}

/**
 * Rebuilt when the region or credentials change, matching photoStorage: caching
 * on nothing would keep using a rotated key until the process restarted.
 */
function getClient() {
  if (clientOverride) return clientOverride;
  const config = runtimeConfig();
  const fingerprint = `${config.rekognitionRegion}|${process.env.AWS_ACCESS_KEY_ID || ""}`;
  if (!client || clientFingerprint !== fingerprint) {
    client = new RekognitionClient({
      region: config.rekognitionRegion,
      maxAttempts: config.rekognitionMaxAttempts,
      requestHandler: { requestTimeout: config.rekognitionTimeoutMs },
    });
    clientFingerprint = fingerprint;
  }
  return client;
}

/** Reasons a caller may act on. Returned as data; nothing here throws for them. */
export const FACE_REASONS = {
  NOT_CONFIGURED: "NOT_CONFIGURED",
  NO_FACE: "NO_FACE",
  MULTIPLE_FACES: "MULTIPLE_FACES",
  POOR_QUALITY: "POOR_QUALITY",
  NO_MATCH: "NO_MATCH",
  BELOW_THRESHOLD: "BELOW_THRESHOLD",
  PROVIDER_ERROR: "PROVIDER_ERROR",
};

/** Wording shown to an admin, so a refusal says what to do about it. */
export const FACE_REASON_MESSAGES = {
  NOT_CONFIGURED: "Face recognition is not configured on the server.",
  NO_FACE: "No face was found in this photograph. Use a clear, front-facing photo.",
  MULTIPLE_FACES: "More than one face was found. Use a photograph of only this instructor.",
  POOR_QUALITY: "The face is too blurry or too dark to use as a reference. Retake it in better light.",
  NO_MATCH: "No enrolled instructor matches this face.",
  BELOW_THRESHOLD: "The closest match was not confident enough to be used.",
  PROVIDER_ERROR: "The face recognition service could not be reached.",
};

function failure(reason) {
  return { ok: false, reason, message: FACE_REASON_MESSAGES[reason] };
}

/**
 * Provider faults are recorded and reported, never thrown.
 *
 * A Rekognition outage during check-in must not lose the attendance record. The
 * caller treats PROVIDER_ERROR exactly like an unrecognised face: the record is
 * saved unidentified and an admin attaches the name afterwards.
 */
function providerFailure(operation, error) {
  incrementMetric("rekognition_request_failures_total");
  console.error(`Rekognition ${operation} failed: ${error?.name || "Error"}`);
  return failure(FACE_REASONS.PROVIDER_ERROR);
}

async function send(operation, command) {
  const startedAt = Date.now();
  incrementMetric("rekognition_requests_total");
  try {
    const response = await getClient().send(command);
    observeDuration("rekognition_request_latency", Date.now() - startedAt);
    return { response };
  } catch (error) {
    observeDuration("rekognition_request_latency", Date.now() - startedAt);
    return { error };
  }
}

/**
 * Whether one photograph is usable as a reference.
 *
 * Run before indexing, never after. A blurry or half-turned reference does not
 * fail loudly; it produces confident wrong matches for as long as it stays in
 * the collection, which is the most expensive failure this module can have.
 * Refusing the upload costs an admin one retake.
 */
export async function checkFaceQuality(imageBuffer) {
  if (!isFaceRecognitionConfigured()) return failure(FACE_REASONS.NOT_CONFIGURED);
  if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
    return failure(FACE_REASONS.NO_FACE);
  }

  const { response, error } = await send(
    "DetectFaces",
    new DetectFacesCommand({
      Image: { Bytes: imageBuffer },
      Attributes: ["DEFAULT"],
    })
  );
  if (error) return providerFailure("DetectFaces", error);

  const faces = response?.FaceDetails || [];
  if (faces.length === 0) return failure(FACE_REASONS.NO_FACE);
  if (faces.length > 1) return failure(FACE_REASONS.MULTIPLE_FACES);

  const [face] = faces;
  const config = runtimeConfig();
  const sharpness = Number(face?.Quality?.Sharpness ?? 0);
  const brightness = Number(face?.Quality?.Brightness ?? 0);
  const confidence = Number(face?.Confidence ?? 0);
  if (
    confidence < config.rekognitionMinFaceConfidence
    || sharpness < config.rekognitionMinSharpness
    || brightness < config.rekognitionMinBrightness
  ) {
    return failure(FACE_REASONS.POOR_QUALITY);
  }

  return {
    ok: true,
    quality: { sharpness, brightness, confidence },
  };
}

/**
 * Adds one face for an instructor and returns its FaceId.
 *
 * ExternalImageId carries the instructor id so a later search resolves to the
 * person without a second database lookup. Rekognition restricts that field to
 * `[a-zA-Z0-9_.\-:]`, which the app's UUID ids already satisfy; anything else
 * is refused here rather than at the provider, where the error does not say
 * which instructor it was about.
 *
 * MaxFaces is 1 and QualityFilter is AUTO: a reference photo showing two people
 * must be refused by checkFaceQuality, not quietly resolved by indexing
 * whichever face Rekognition considers largest.
 */
export async function indexFace(imageBuffer, instructorId) {
  if (!isFaceRecognitionConfigured()) return failure(FACE_REASONS.NOT_CONFIGURED);
  const externalImageId = String(instructorId || "");
  if (!/^[A-Za-z0-9_.\-:]{1,255}$/.test(externalImageId)) {
    return failure(FACE_REASONS.NO_FACE);
  }

  const config = runtimeConfig();
  const { response, error } = await send(
    "IndexFaces",
    new IndexFacesCommand({
      CollectionId: config.rekognitionCollectionId,
      Image: { Bytes: imageBuffer },
      ExternalImageId: externalImageId,
      MaxFaces: 1,
      QualityFilter: "AUTO",
      DetectionAttributes: [],
    })
  );
  if (error) return providerFailure("IndexFaces", error);

  const faceId = response?.FaceRecords?.[0]?.Face?.FaceId;
  if (!faceId) {
    // Rekognition accepted the request and indexed nothing, which is what
    // QualityFilter rejection looks like. Report it as a quality refusal so the
    // admin is told to retake rather than left with a silent no-op.
    incrementMetric("rekognition_index_rejected_total");
    return failure(FACE_REASONS.POOR_QUALITY);
  }
  incrementMetric("rekognition_index_success_total");
  return { ok: true, faceId, instructorId: externalImageId };
}

/**
 * Identifies who is in one photograph.
 *
 * Rekognition is asked for several candidates rather than one, because the
 * nearest face may be another of the same instructor's own embeddings. Results
 * are grouped by ExternalImageId and the best score per person is compared, so
 * two embeddings of one person scoring alike is the system working rather than
 * an ambiguous match.
 *
 * FaceMatchThreshold is set to the configured accept threshold, so a candidate
 * below it is never returned at all: a 70% match is not evidence of identity
 * and must not reach the caller as a suggestion.
 */
export async function searchFaceByImage(imageBuffer) {
  if (!isFaceRecognitionConfigured()) return failure(FACE_REASONS.NOT_CONFIGURED);
  if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
    return failure(FACE_REASONS.NO_FACE);
  }

  const config = runtimeConfig();
  const { response, error } = await send(
    "SearchFacesByImage",
    new SearchFacesByImageCommand({
      CollectionId: config.rekognitionCollectionId,
      Image: { Bytes: imageBuffer },
      FaceMatchThreshold: config.rekognitionMatchThreshold,
      MaxFaces: config.rekognitionSearchCandidates,
      QualityFilter: "AUTO",
    })
  );
  if (error) {
    // A photograph with no detectable face is reported by this API as an
    // InvalidParameterException rather than an empty match list.
    if (error?.name === "InvalidParameterException") {
      incrementMetric("rekognition_search_no_face_total");
      return failure(FACE_REASONS.NO_FACE);
    }
    return providerFailure("SearchFacesByImage", error);
  }

  const matches = response?.FaceMatches || [];
  if (matches.length === 0) {
    incrementMetric("rekognition_search_no_match_total");
    return failure(FACE_REASONS.NO_MATCH);
  }

  const bestByPerson = new Map();
  for (const match of matches) {
    const personId = match?.Face?.ExternalImageId;
    const similarity = Number(match?.Similarity ?? 0);
    if (!personId || !Number.isFinite(similarity)) continue;
    const existing = bestByPerson.get(personId);
    if (!existing || similarity > existing.similarity) {
      bestByPerson.set(personId, { similarity, faceId: match?.Face?.FaceId || null });
    }
  }
  if (bestByPerson.size === 0) {
    // Indexed faces with no ExternalImageId cannot be traced to an instructor.
    incrementMetric("rekognition_search_unattributed_total");
    return failure(FACE_REASONS.NO_MATCH);
  }

  const ranked = [...bestByPerson.entries()]
    .map(([instructorId, value]) => ({ instructorId, ...value }))
    .sort((a, b) => b.similarity - a.similarity);
  const [best, runnerUp] = ranked;

  if (best.similarity < config.rekognitionMatchThreshold) {
    incrementMetric("rekognition_search_below_threshold_total");
    return failure(FACE_REASONS.BELOW_THRESHOLD);
  }

  incrementMetric("rekognition_search_match_total");
  return {
    ok: true,
    instructorId: best.instructorId,
    faceId: best.faceId,
    similarity: best.similarity,
    // The closest different person, so a caller can record how clear-cut the
    // identification was. Look-alike handling is deliberately deferred, but the
    // margin is captured now so those records can be found later.
    runnerUp: runnerUp
      ? { instructorId: runnerUp.instructorId, similarity: runnerUp.similarity }
      : null,
  };
}

/**
 * Removes faces from the collection.
 *
 * Called when a reference photo is replaced, and when an instructor is deleted:
 * a soft-deleted instructor keeps their attendance history, but there is no
 * reason to keep their biometric data in a collection that is searched on every
 * check-in.
 */
export async function deleteFaces(faceIds) {
  if (!isFaceRecognitionConfigured()) return failure(FACE_REASONS.NOT_CONFIGURED);
  const ids = (Array.isArray(faceIds) ? faceIds : [faceIds])
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  if (ids.length === 0) return { ok: true, deleted: [] };

  const config = runtimeConfig();
  const { response, error } = await send(
    "DeleteFaces",
    new DeleteFacesCommand({
      CollectionId: config.rekognitionCollectionId,
      FaceIds: ids,
    })
  );
  if (error) return providerFailure("DeleteFaces", error);

  incrementMetric("rekognition_delete_success_total");
  return { ok: true, deleted: response?.DeletedFaces || [] };
}

/**
 * Which face to discard when an instructor has reached the cap.
 *
 * Faces accumulate as admins correct mistakes, so the list is allowed to grow
 * to REKOGNITION_MAX_FACES_PER_INSTRUCTOR and then drops its oldest entry. The
 * newest photographs are the ones taken on the tablet actually in use, in the
 * lighting that collection actually has, so they are the ones worth keeping.
 */
export function facesToEvict(existingFaceIds, { adding = 1 } = {}) {
  const config = runtimeConfig();
  const current = (Array.isArray(existingFaceIds) ? existingFaceIds : []).filter(Boolean);
  const overflow = current.length + adding - config.rekognitionMaxFacesPerInstructor;
  if (overflow <= 0) return [];
  return current.slice(0, overflow);
}
