import {
  buildReferencePhotoKey,
  deletePhoto,
  uploadPhoto,
} from "./photoStorage.js";
import {
  checkFaceQuality,
  deleteFaces,
  facesToEvict,
  indexFace,
} from "./faceRecognition.js";
import { jobCollection } from "../stores/jobStore.js";
import { coreCollection } from "../stores/coreStore.js";

function activeFilter(extra = {}) {
  return {
    $and: [
      extra,
      { $or: [{ deleted_at: null }, { deleted_at: { $exists: false } }] },
    ],
  };
}

export async function queuePhotoCleanup(db, key, reason, lastError) {
  if (!key) return;
  const now = new Date();
  await jobCollection(db, "storage_cleanup_jobs").updateOne(
    { _id: key },
    {
      $setOnInsert: {
        _id: key,
        key,
        reason,
        status: "queued",
        attempts: 0,
        available_at: now,
        created_at: now,
      },
      $set: { updated_at: now, last_error: lastError || "delete_failed" },
    },
    { upsert: true }
  );
}

export async function discardReferencePhoto(db, key, reason) {
  if (!key) return;
  const result = await deletePhoto(key);
  if (!result.deleted) await queuePhotoCleanup(db, key, reason, result.reason);
}

function refusal(status, detail, reason) {
  return { ok: false, status, detail, ...(reason ? { reason } : {}) };
}

export async function enrollReferencePhoto(db, instructor, normalized, {
  mode = "add",
  checkedQuality = null,
} = {}) {
  const quality = checkedQuality
    ? { ok: true, quality: checkedQuality }
    : await checkFaceQuality(normalized.buffer);
  if (!quality.ok) {
    return refusal(quality.reason === "PROVIDER_ERROR" ? 503 : 422, quality.message, quality.reason);
  }

  const photoKey = buildReferencePhotoKey({
    instructorId: String(instructor._id),
    mimeType: normalized.mimeType,
  });
  const stored = await uploadPhoto({
    key: photoKey,
    body: normalized.buffer,
    mimeType: normalized.mimeType,
    metadata: { instructor_id: String(instructor._id), kind: "reference" },
  });
  if (!stored.stored) {
    return refusal(503, "The reference photo could not be stored. Try again.");
  }

  const indexed = await indexFace(normalized.buffer, String(instructor._id));
  if (!indexed.ok) {
    await discardReferencePhoto(db, photoKey, "reference_index_failed");
    return refusal(indexed.reason === "PROVIDER_ERROR" ? 503 : 422, indexed.message, indexed.reason);
  }

  const existingFaceIds = Array.isArray(instructor.face_ids)
    ? instructor.face_ids.filter(Boolean).map(String)
    : [];
  const existingPhotoKey = instructor.reference_photo_key || null;

  const retiredFaceIds = mode === "replace"
    ? existingFaceIds
    : facesToEvict(existingFaceIds, { adding: 1 });
  const keptFaceIds = existingFaceIds.filter((id) => !retiredFaceIds.includes(id));
  const faceIds = [...keptFaceIds, indexed.faceId];

  const now = new Date();
  const update = await coreCollection(db, "instructors").updateOne(
    activeFilter({ _id: instructor._id }),
    {
      $set: {
        face_ids: faceIds,
        reference_photo_key: photoKey,
        face_indexed_at: now,
        updated_at: now,
      },
    }
  );
  if (!update.matchedCount) {
    await discardReferencePhoto(db, photoKey, "reference_owner_missing");
    await deleteFaces([indexed.faceId]);
    return refusal(404, "Instructor not found");
  }

  if (retiredFaceIds.length) await deleteFaces(retiredFaceIds);
  if (mode === "replace" && existingPhotoKey && existingPhotoKey !== photoKey) {
    await discardReferencePhoto(db, existingPhotoKey, "reference_replaced");
  }

  return {
    ok: true,
    faceIds,
    retiredFaceIds,
    photoKey,
    quality: quality.quality,
  };
}
