import { Router } from "express";
import multer from "multer";
import { withMongoTransaction } from "../config/db.js";
import { idMatch, instructorScope, isElevated, requireSuperAdmin, ROLES } from "../middleware/auth.js";
import { asyncRoute, createDocument, dateBoundsInTimeZone, parsePagination, serializeDocument } from "../utils.js";
import { runtimeConfig } from "../config/env.js";
import { instructorGenderSchema, instructorSchema, validate } from "../validation.js";
import { validateImageUpload } from "../imageValidation.js";
import { normalizeInstructorImage } from "../imageProcessor.js";
import {
  buildReferencePhotoKey,
  deletePhoto,
  getPhotoUrl,
  uploadPhoto,
} from "../services/photoStorage.js";
import {
  checkFaceQuality,
  deleteFaces,
  facesToEvict,
  FACE_REASON_MESSAGES,
  indexFace,
  isFaceRecognitionConfigured,
} from "../services/faceRecognition.js";

export const instructorRouter = Router();

// Matches the attendance upload limits: one file, 8 MB, and the same three
// formats the normalizer and the magic-byte check accept.
const referencePhotoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 4 },
  fileFilter: (_req, file, callback) => {
    const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
    if (!allowedTypes.has(file.mimetype)) {
      return callback(new Error("Only JPEG, PNG, and WebP image uploads are allowed"));
    }
    return callback(null, true);
  },
});
const COLLEGE_ASSIGNMENT_GUARD = "_private_assignment_guard_version";

/**
 * Matches an open check-in belonging to today.
 *
 * A check-out that never happens leaves the record open forever, so matching
 * any open record made one forgotten check-out permanent — the instructor
 * could never be edited or removed again.
 */
function openCheckInTodayFilter(instructorId) {
  const { start, end } = dateBoundsInTimeZone(undefined, runtimeConfig().appTimeZone);
  return {
    instructor_id: idMatch(String(instructorId)),
    check_out_time: null,
    check_in_time: { $gte: start, $lt: end },
  };
}
const INSTRUCTOR_PAGE_LIMIT = 1000;
const DAILY_FEEDBACK_LIMIT = 100;

function activeFilter(extra = {}) {
  return {
    $and: [
      extra,
      { $or: [{ deleted_at: null }, { deleted_at: { $exists: false } }] },
    ],
  };
}

function feedbackStatus(status) {
  if (status === "pending") return "PENDING";
  if (status === "error") return "ERROR";
  if (status === "unassessed") return "UNASSESSED";
  // Records evaluated before the review flag was removed still carry this
  // status. They were compliant results that had been flagged, so that is
  // what they report now; the stored value is left untouched.
  if (status === "review_required" || status === "needs_review") return "COMPLIANT";
  if (status === "non_compliant" || status === "fail") return "FLAGGED";
  if (status === "compliant" || status === "done") return "COMPLIANT";
  return "UNKNOWN";
}

function lookupIdVariants(ids) {
  const variants = [];
  const seen = new Set();
  for (const id of ids) {
    for (const variant of idMatch(String(id)).$in) {
      const key = `${variant?._bsontype || typeof variant}:${String(variant)}`;
      if (!seen.has(key)) {
        seen.add(key);
        variants.push(variant);
      }
    }
  }
  return variants;
}

export async function loadRecentInstructorFeedbacks(db, instructorIds) {
  if (!instructorIds.length) return [];
  const normalizedIdField = "_private_paging_instructor_id";
  const normalizedDateField = "_private_paging_feedback_date";
  const rankField = "_private_paging_feedback_rank";
  return db.collection("attendance").aggregate([
    { $match: { instructor_id: { $in: lookupIdVariants(instructorIds) } } },
    {
      $project: {
        _id: 1,
        instructor_id: 1,
        date: 1,
        status: 1,
        remarks: 1,
      },
    },
    {
      $set: {
        [normalizedIdField]: { $toString: "$instructor_id" },
        [normalizedDateField]: {
          $convert: { input: "$date", to: "date", onError: null, onNull: null },
        },
      },
    },
    { $match: { [normalizedDateField]: { $ne: null } } },
    // $documentNumber requires a single-key sortBy, so the _id tiebreaker is
    // applied here instead; $setWindowFields preserves this incoming order
    // for rows that share a date.
    { $sort: { [normalizedIdField]: 1, [normalizedDateField]: -1, _id: -1 } },
    {
      $setWindowFields: {
        partitionBy: `$${normalizedIdField}`,
        sortBy: { [normalizedDateField]: -1 },
        output: { [rankField]: { $documentNumber: {} } },
      },
    },
    { $match: { [rankField]: { $lte: DAILY_FEEDBACK_LIMIT } } },
    { $sort: { [normalizedIdField]: 1, [normalizedDateField]: -1, _id: -1 } },
    { $unset: [normalizedIdField, normalizedDateField, rankField] },
    { $limit: instructorIds.length * DAILY_FEEDBACK_LIMIT },
  ], { allowDiskUse: true }).toArray();
}

export async function createInstructorGuarded(
  db,
  input,
  runTransaction = withMongoTransaction
) {
  return runTransaction(async (session) => {
    const college = await db.collection("colleges").findOne(
      activeFilter({ _id: idMatch(input.college_id) }),
      { session }
    );
    if (!college) return { outcome: "college_not_found" };
    if (await db.collection("instructors").findOne(
      { employee_id: input.employee_id },
      { session }
    )) {
      return { outcome: "duplicate_employee_id" };
    }
    const collegeGuard = await db.collection("colleges").updateOne(
      activeFilter({ _id: college._id }),
      { $inc: { [COLLEGE_ASSIGNMENT_GUARD]: 1 } },
      { session }
    );
    if (!collegeGuard.matchedCount) return { outcome: "college_not_found" };

    const now = new Date();
    const instructor = createDocument({
      ...input,
      college_id: String(college._id),
      created_at: now,
      updated_at: now,
      deleted_at: null,
    });
    await db.collection("instructors").insertOne(instructor, { session });
    return { outcome: "created", instructor };
  });
}

export async function updateInstructorGuarded(
  db,
  instructorId,
  input,
  runTransaction = withMongoTransaction
) {
  return runTransaction(async (session) => {
    const existing = await db.collection("instructors").findOne(
      activeFilter({ _id: idMatch(instructorId) }),
      { session }
    );
    if (!existing) return { outcome: "not_found" };

    // Only a college reassignment conflicts with an open check-in: the
    // attendance record snapshots the college, and moving someone mid-session
    // would leave that record scoped to a college they are no longer at.
    // Everything else — name, email, phone, gender, role — is harmless, and
    // refusing those too meant a forgotten check-out made the whole profile
    // uneditable. The window is today only, for the same reason: a record left
    // open yesterday is a missed check-out, not a session in progress.
    const movingCollege = String(existing.college_id) !== String(input.college_id);
    if (movingCollege) {
      const activeAttendance = await db.collection("attendance").findOne(
        openCheckInTodayFilter(existing._id),
        { session }
      );
      if (activeAttendance) return { outcome: "active_attendance" };
    }

    const college = await db.collection("colleges").findOne(
      activeFilter({ _id: idMatch(input.college_id) }),
      { session }
    );
    if (!college) return { outcome: "college_not_found" };

    const duplicate = await db.collection("instructors").findOne(
      {
        employee_id: input.employee_id,
        _id: { $ne: existing._id },
      },
      { session }
    );
    if (duplicate) return { outcome: "duplicate_employee_id" };

    const collegeGuard = await db.collection("colleges").updateOne(
      activeFilter({ _id: college._id }),
      { $inc: { [COLLEGE_ASSIGNMENT_GUARD]: 1 } },
      { session }
    );
    if (!collegeGuard.matchedCount) return { outcome: "college_not_found" };

    const result = await db.collection("instructors").updateOne(
      activeFilter({ _id: existing._id }),
      { $set: { ...input, college_id: String(college._id), updated_at: new Date() } },
      { session }
    );
    return result.matchedCount
      ? { outcome: "updated" }
      : { outcome: "not_found" };
  });
}

export async function deleteInstructorGuarded(
  db,
  instructorId,
  runTransaction = withMongoTransaction
) {
  return runTransaction(async (session) => {
    const existing = await db.collection("instructors").findOne(
      activeFilter({ _id: idMatch(instructorId) }),
      { session }
    );
    if (!existing) return { outcome: "not_found" };

    // Removing somebody mid-session conflicts whatever the reason, so this
    // refuses on any open check-in — but only one belonging to today, since a
    // record left open yesterday is a missed check-out rather than a session
    // in progress, and would otherwise make the instructor undeletable.
    const activeAttendance = await db.collection("attendance").findOne(
      openCheckInTodayFilter(existing._id),
      { session }
    );
    if (activeAttendance) return { outcome: "active_attendance" };

    const now = new Date();
    const result = await db.collection("instructors").updateOne(
      activeFilter({ _id: existing._id }),
      { $set: { deleted_at: now, updated_at: now } },
      { session }
    );
    return result.matchedCount
      ? { outcome: "deleted" }
      : { outcome: "not_found" };
  });
}

instructorRouter.post(
  "/",
  requireSuperAdmin,
  validate(instructorSchema),
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    let result;
    try {
      result = await createInstructorGuarded(db, req.validatedBody);
    } catch (error) {
      if (error.code === 11000) {
        return res.status(400).json({ detail: "Instructor Employee ID exists" });
      }
      throw error;
    }
    if (result.outcome === "college_not_found") {
      return res.status(400).json({ detail: "Selected college does not exist" });
    }
    if (result.outcome === "duplicate_employee_id") {
      return res.status(400).json({ detail: "Instructor Employee ID exists" });
    }
    return res.status(201).json({
      message: "Instructor created successfully",
      id: result.instructor._id,
    });
  })
);

instructorRouter.get(
  "/",
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    let pagination;
    let includeFeedback = true;
    try {
      pagination = parsePagination(req.query, {
        defaultLimit: INSTRUCTOR_PAGE_LIMIT,
        maxLimit: INSTRUCTOR_PAGE_LIMIT,
      });
      if (req.query.include_feedback !== undefined) {
        if (req.query.include_feedback === "true") includeFeedback = true;
        else if (req.query.include_feedback === "false") includeFeedback = false;
        else throw new RangeError("include_feedback must be true or false");
      }
    } catch (error) {
      if (error instanceof RangeError) {
        return res.status(422).json({ detail: error.message });
      }
      throw error;
    }
    const instructors = await db.collection("instructors")
      .find(activeFilter(instructorScope(req.currentUser)))
      .sort({ name: 1, _id: 1 })
      .skip(pagination.offset)
      .limit(pagination.limit)
      .toArray();
    const instructorIds = instructors.map((row) => String(row._id));
    // The attendance and management screens use only roster/profile fields.
    // Avoid a windowed scan over attendance for every page unless a legacy
    // caller explicitly needs the embedded history.
    const attendances = includeFeedback
      ? await loadRecentInstructorFeedbacks(db, instructorIds)
      : [];
    const grouped = new Map();
    for (const attendance of attendances) {
      const rows = grouped.get(String(attendance.instructor_id)) || [];
      if (rows.length < 100) rows.push(attendance);
      grouped.set(String(attendance.instructor_id), rows);
    }

    return res.json(instructors.map((instructor) => {
      const serialized = serializeDocument(instructor);
      for (const key of Object.keys(serialized)) {
        if (key.startsWith("_private_")) delete serialized[key];
      }
      // Whether an address exists is not the address itself, and the two were
      // being conflated: a BOA cannot see the email, so the attendance screen
      // reported "No email on record" for instructors who have one. Sent for
      // everybody so the interface can tell absence apart from permission.
      serialized.has_email = Boolean(instructor.email);
      // How many reference faces are enrolled, not which ones. The list needs
      // the count to mark an instructor recognition cannot identify; the FaceIds
      // themselves are biometric identifiers with no use in the browser, so they
      // are replaced by the count rather than sent alongside it.
      serialized.face_count = Array.isArray(instructor.face_ids)
        ? instructor.face_ids.filter(Boolean).length
        : 0;
      delete serialized.face_ids;
      delete serialized.reference_photo_key;
      // Contact details are visible to both elevated roles; a BOA still only
      // sees the instructors at their own college, without contact details.
      if (!isElevated(req.currentUser.role)) {
        delete serialized.email;
        delete serialized.phone_no;
      }
      serialized.daily_feedbacks = (grouped.get(String(instructor._id)) || [])
        .filter((attendance) => attendance.date && !Number.isNaN(new Date(attendance.date).getTime()))
        .map((attendance) => {
          const overallStatus = feedbackStatus(attendance.status);
          return {
            date: new Date(attendance.date).toISOString(),
            overall_status: overallStatus,
            detailed_report: {
              overall_status: overallStatus,
              ai_summary: attendance.remarks || "",
            },
          };
        });
      return serialized;
    }));
  })
);

instructorRouter.put(
  "/:instructorId",
  requireSuperAdmin,
  validate(instructorSchema),
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    let result;
    try {
      result = await updateInstructorGuarded(
        db,
        req.params.instructorId,
        req.validatedBody
      );
    } catch (error) {
      if (error.code === 11000) {
        return res.status(400).json({ detail: "Instructor Employee ID exists" });
      }
      throw error;
    }
    if (result.outcome === "not_found") {
      return res.status(404).json({ detail: "Instructor not found" });
    }
    if (result.outcome === "active_attendance") {
      return res.status(409).json({
        detail: "Check this instructor out before moving them to another institute",
      });
    }
    if (result.outcome === "college_not_found") {
      return res.status(400).json({ detail: "Selected college does not exist" });
    }
    if (result.outcome === "duplicate_employee_id") {
      return res.status(400).json({ detail: "Instructor Employee ID exists" });
    }
    return res.json({ message: "Instructor updated successfully" });
  })
);

/**
 * Sets gender alone for an elevated user, or for a BOA's own college.
 *
 * The AI is given the instructor's gender so it compares against the right
 * reference photos; synced instructors have none, so they are currently
 * judged against both men's and women's examples. The full update route
 * cannot fix that — it requires a college and email the roster never
 * supplied — so this narrow route exists to make the field settable from the
 * table without touching anything else on the record.
 */
instructorRouter.patch(
  "/:instructorId/gender",
  validate(instructorGenderSchema),
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    const result = await db.collection("instructors").updateOne(
      activeFilter({
        _id: idMatch(req.params.instructorId),
        ...instructorScope(req.currentUser),
      }),
      { $set: { gender: req.validatedBody.gender, updated_at: new Date() } }
    );
    if (!result.matchedCount) {
      return res.status(404).json({ detail: "Instructor not found" });
    }
    return res.json({ message: "Gender updated", gender: req.validatedBody.gender });
  })
);

/**
 * Queues an R2 object for deletion after an inline delete failed.
 *
 * The cleanup collection keys a job by the object key itself, so requesting the
 * same deletion twice is a no-op rather than a duplicate job. Mirrors
 * compensateUploadedPhoto in the attendance routes: the photo is removed
 * immediately in the normal case, and a transient storage outage leaves a
 * durable retry instead of an orphaned file nothing points at.
 */
async function queuePhotoCleanup(db, key, reason, lastError) {
  if (!key) return;
  const now = new Date();
  await db.collection("storage_cleanup_jobs").updateOne(
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

/** Removes a reference photo from R2 now, or queues it if storage refuses. */
async function discardReferencePhoto(db, key, reason) {
  if (!key) return;
  const result = await deletePhoto(key);
  if (!result.deleted) await queuePhotoCleanup(db, key, reason, result.reason);
}

/**
 * Replaces or adds one instructor's reference face.
 *
 * mode=add keeps the faces already enrolled, so recognition improves as admins
 * correct it: one photograph in one lighting condition fails repeatedly in
 * others, and several embeddings of the same person are the fix. mode=replace
 * discards the previous face and photo, for a reference that turned out to be
 * the wrong person or too poor to keep.
 *
 * Ordering is deliberate. The new face is indexed BEFORE the old one is
 * removed: if indexing fails the instructor keeps a working reference rather
 * than being left with none, and a brief moment holding two faces is harmless
 * where a moment holding zero breaks recognition for that person.
 */
instructorRouter.post(
  "/:instructorId/face",
  requireSuperAdmin,
  referencePhotoUpload.single("photo"),
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    if (!isFaceRecognitionConfigured()) {
      return res.status(503).json({ detail: FACE_REASON_MESSAGES.NOT_CONFIGURED });
    }

    const mode = String(req.body?.mode || "add").toLowerCase();
    if (!["add", "replace"].includes(mode)) {
      return res.status(422).json({ detail: "mode must be add or replace" });
    }

    const validation = validateImageUpload(req.file);
    if (!validation.valid) return res.status(400).json({ detail: validation.detail });

    const instructor = await db.collection("instructors").findOne(
      activeFilter({ _id: idMatch(req.params.instructorId) })
    );
    if (!instructor) return res.status(404).json({ detail: "Instructor not found" });

    let normalized;
    try {
      normalized = await normalizeInstructorImage(req.file.buffer);
    } catch (error) {
      return res.status(400).json({ detail: error.message });
    }

    // Quality is judged before anything is stored or indexed. A blurry or
    // half-turned reference never fails loudly; it produces confident wrong
    // matches for as long as it stays in the collection, so refusing it here
    // costs the admin one retake and prevents misfiled attendance later.
    const quality = await checkFaceQuality(normalized.buffer);
    if (!quality.ok) {
      return res.status(quality.reason === "PROVIDER_ERROR" ? 503 : 422).json({
        detail: quality.message,
        reason: quality.reason,
      });
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
      return res.status(503).json({ detail: "The reference photo could not be stored. Try again." });
    }

    const indexed = await indexFace(normalized.buffer, String(instructor._id));
    if (!indexed.ok) {
      // Nothing was enrolled, so the object just written has no owner.
      await discardReferencePhoto(db, photoKey, "reference_index_failed");
      return res.status(indexed.reason === "PROVIDER_ERROR" ? 503 : 422).json({
        detail: indexed.message,
        reason: indexed.reason,
      });
    }

    const existingFaceIds = Array.isArray(instructor.face_ids)
      ? instructor.face_ids.filter(Boolean).map(String)
      : [];
    const existingPhotoKey = instructor.reference_photo_key || null;

    // replace discards every earlier face; add keeps them and drops only what
    // overflows the cap, oldest first, since the newest photographs come from
    // the tablet and lighting actually in use.
    const retiredFaceIds = mode === "replace"
      ? existingFaceIds
      : facesToEvict(existingFaceIds, { adding: 1 });
    const keptFaceIds = existingFaceIds.filter((id) => !retiredFaceIds.includes(id));
    const faceIds = [...keptFaceIds, indexed.faceId];

    const now = new Date();
    const update = await db.collection("instructors").updateOne(
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
      // The instructor was removed while the photo was being processed.
      await discardReferencePhoto(db, photoKey, "reference_owner_missing");
      await deleteFaces([indexed.faceId]);
      return res.status(404).json({ detail: "Instructor not found" });
    }

    // Only now that the record points at the new face is the old one removed.
    if (retiredFaceIds.length) await deleteFaces(retiredFaceIds);
    if (mode === "replace" && existingPhotoKey && existingPhotoKey !== photoKey) {
      await discardReferencePhoto(db, existingPhotoKey, "reference_replaced");
    }

    return res.status(201).json({
      message: mode === "replace"
        ? "Reference photo replaced"
        : "Reference photo added",
      mode,
      face_count: faceIds.length,
      retired_faces: retiredFaceIds.length,
      quality: quality.quality,
    });
  })
);

/** A short-lived link to the current reference photo, for the admin screen. */
instructorRouter.get(
  "/:instructorId/face",
  requireSuperAdmin,
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    const instructor = await db.collection("instructors").findOne(
      activeFilter({ _id: idMatch(req.params.instructorId) }),
      { projection: { face_ids: 1, reference_photo_key: 1, face_indexed_at: 1 } }
    );
    if (!instructor) return res.status(404).json({ detail: "Instructor not found" });

    const faceIds = Array.isArray(instructor.face_ids) ? instructor.face_ids.filter(Boolean) : [];
    return res.json({
      has_reference: faceIds.length > 0,
      face_count: faceIds.length,
      face_indexed_at: instructor.face_indexed_at || null,
      // Null rather than absent when storage is unavailable, so the screen can
      // say "photo unavailable" instead of "no photo enrolled".
      photo_url: instructor.reference_photo_key
        ? await getPhotoUrl(instructor.reference_photo_key)
        : null,
    });
  })
);

/**
 * Removes an instructor's enrolled faces.
 *
 * Used when a reference turns out to be the wrong person, and when an
 * instructor leaves: the soft delete keeps their attendance history, but there
 * is no reason to keep biometric data in a collection searched on every
 * check-in. Recognition then falls back to the unidentified queue for them.
 */
instructorRouter.delete(
  "/:instructorId/face",
  requireSuperAdmin,
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    const instructor = await db.collection("instructors").findOne(
      activeFilter({ _id: idMatch(req.params.instructorId) })
    );
    if (!instructor) return res.status(404).json({ detail: "Instructor not found" });

    const faceIds = Array.isArray(instructor.face_ids)
      ? instructor.face_ids.filter(Boolean).map(String)
      : [];
    if (faceIds.length && isFaceRecognitionConfigured()) {
      const removed = await deleteFaces(faceIds);
      if (!removed.ok) {
        // Clearing the record while the collection still held the faces would
        // leave them searchable with no way to find them again.
        return res.status(503).json({ detail: removed.message, reason: removed.reason });
      }
    }

    const now = new Date();
    await db.collection("instructors").updateOne(
      activeFilter({ _id: instructor._id }),
      {
        $set: { face_ids: [], updated_at: now },
        $unset: { reference_photo_key: "", face_indexed_at: "" },
      }
    );
    await discardReferencePhoto(db, instructor.reference_photo_key, "reference_removed");

    return res.json({ message: "Reference photo removed", removed_faces: faceIds.length });
  })
);

instructorRouter.delete(
  "/:instructorId",
  requireSuperAdmin,
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    const result = await deleteInstructorGuarded(db, req.params.instructorId);
    if (result.outcome === "not_found") {
      return res.status(404).json({ detail: "Instructor not found" });
    }
    if (result.outcome === "active_attendance") {
      return res.status(409).json({
        detail: "Check out this instructor before deleting their profile",
      });
    }
    return res.json({ message: "Instructor deleted successfully" });
  })
);
