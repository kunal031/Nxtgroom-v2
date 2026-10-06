import { Router } from "express";
import multer from "multer";
import { idMatch, instructorScope, isElevated, requireSuperAdmin, ROLES } from "../middleware/auth.js";
import { asyncRoute, createDocument, dateBoundsInTimeZone, parsePagination, serializeDocument } from "../utils.js";
import { runtimeConfig } from "../config/env.js";
import {
  instructorGenderSchema,
  instructorImportRowsSchema,
  instructorImportSheetSchema,
  instructorSchema,
  validate,
} from "../validation.js";
import { validateImageUpload } from "../imageValidation.js";
import { normalizeInstructorImage } from "../imageProcessor.js";
import { getPhotoUrl } from "../services/photoStorage.js";
import {
  deleteFaces,
  FACE_REASON_MESSAGES,
  isFaceRecognitionConfigured,
} from "../services/faceRecognition.js";
import { discardReferencePhoto, enrollReferencePhoto } from "../services/referencePhotos.js";
import {
  commitImportRows,
  fetchSheetCsv,
  MAX_COMMIT_ROWS,
  MAX_PREVIEW_ROWS,
  previewImportRows,
} from "../services/instructorImport.js";
import { RemoteFetchError } from "../services/remoteFetch.js";
import { getConfigSettings } from "../services/configSettings.js";
import { randomUUID } from "node:crypto";
import { coreCollection, coreTransaction } from "../stores/coreStore.js";

export const instructorRouter = Router();

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
  if (status === "unidentified") return "UNIDENTIFIED";
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
  return coreCollection(db, "attendance").aggregate([
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

function duplicateKeyDetail(error) {
  const fields = Object.keys(error?.keyPattern || error?.keyValue || {});
  return fields.includes("instructor_user_id") || /instructor_user_id/.test(String(error?.message || ""))
    ? "Instructor User ID exists"
    : "Instructor Employee ID exists";
}

export function generateInstructorUserId() {
  return randomUUID().replace(/-/g, "");
}

async function newInstructorUserId(db, session) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = generateInstructorUserId();
    if (!await coreCollection(db, "instructors").findOne({ instructor_user_id: candidate }, { session })) return candidate;
  }
  throw new Error("Could not generate a unique instructor user ID");
}

export async function createInstructorGuarded(
  db,
  input,
  runTransaction = null
) {
  return (runTransaction || coreTransaction(db))(async (session) => {
    const college = await coreCollection(db, "colleges").findOne(
      activeFilter({ _id: idMatch(input.college_id) }),
      { session }
    );
    if (!college) return { outcome: "college_not_found" };
    if (input.employee_id && await coreCollection(db, "instructors").findOne(
      { employee_id: input.employee_id },
      { session }
    )) {
      return { outcome: "duplicate_employee_id" };
    }
    let userId = input.instructor_user_id;
    if (userId) {
      if (await coreCollection(db, "instructors").findOne({ instructor_user_id: userId }, { session })) {
        return { outcome: "duplicate_user_id" };
      }
    } else {
      userId = await newInstructorUserId(db, session);
    }
    const collegeGuard = await coreCollection(db, "colleges").updateOne(
      activeFilter({ _id: college._id }),
      { $inc: { [COLLEGE_ASSIGNMENT_GUARD]: 1 } },
      { session }
    );
    if (!collegeGuard.matchedCount) return { outcome: "college_not_found" };

    const now = new Date();
    const instructor = createDocument({
      ...input,
      instructor_user_id: userId,
      college_id: String(college._id),
      created_at: now,
      updated_at: now,
      deleted_at: null,
    });
    await coreCollection(db, "instructors").insertOne(instructor, { session });
    return { outcome: "created", instructor };
  });
}

export async function updateInstructorGuarded(
  db,
  instructorId,
  input,
  runTransaction = null,
  { allowMoveWhileCheckedIn = false } = {}
) {
  return (runTransaction || coreTransaction(db))(async (session) => {
    const existing = await coreCollection(db, "instructors").findOne(
      activeFilter({ _id: idMatch(instructorId) }),
      { session }
    );
    if (!existing) return { outcome: "not_found" };

    const movingCollege = String(existing.college_id) !== String(input.college_id);
    if (movingCollege && !allowMoveWhileCheckedIn) {
      const activeAttendance = await coreCollection(db, "attendance").findOne(
        openCheckInTodayFilter(existing._id),
        { session }
      );
      if (activeAttendance) return { outcome: "active_attendance" };
    }

    const college = await coreCollection(db, "colleges").findOne(
      activeFilter({ _id: idMatch(input.college_id) }),
      { session }
    );
    if (!college) return { outcome: "college_not_found" };

    const duplicate = input.employee_id && await coreCollection(db, "instructors").findOne(
      {
        employee_id: input.employee_id,
        _id: { $ne: existing._id },
      },
      { session }
    );
    if (duplicate) return { outcome: "duplicate_employee_id" };

    const { instructor_user_id: requestedUserId, ...fields } = input;
    const userIdUpdate = {};
    if (requestedUserId && requestedUserId !== existing.instructor_user_id) {
      if (existing.instructor_user_id) return { outcome: "user_id_locked" };
      const taken = await coreCollection(db, "instructors").findOne(
        { instructor_user_id: requestedUserId, _id: { $ne: existing._id } },
        { session }
      );
      if (taken) return { outcome: "duplicate_user_id" };
      userIdUpdate.instructor_user_id = requestedUserId;
    }

    const collegeGuard = await coreCollection(db, "colleges").updateOne(
      activeFilter({ _id: college._id }),
      { $inc: { [COLLEGE_ASSIGNMENT_GUARD]: 1 } },
      { session }
    );
    if (!collegeGuard.matchedCount) return { outcome: "college_not_found" };

    const result = await coreCollection(db, "instructors").updateOne(
      activeFilter({ _id: existing._id }),
      { $set: { ...fields, ...userIdUpdate, college_id: String(college._id), updated_at: new Date() } },
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
  runTransaction = null
) {
  return (runTransaction || coreTransaction(db))(async (session) => {
    const existing = await coreCollection(db, "instructors").findOne(
      activeFilter({ _id: idMatch(instructorId) }),
      { session }
    );
    if (!existing) return { outcome: "not_found" };

    const activeAttendance = await coreCollection(db, "attendance").findOne(
      openCheckInTodayFilter(existing._id),
      { session }
    );
    if (activeAttendance) return { outcome: "active_attendance" };

    const now = new Date();
    const result = await coreCollection(db, "instructors").updateOne(
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
        return res.status(400).json({ detail: duplicateKeyDetail(error) });
      }
      throw error;
    }
    if (result.outcome === "college_not_found") {
      return res.status(400).json({ detail: "Selected college does not exist" });
    }
    if (result.outcome === "duplicate_employee_id") {
      return res.status(400).json({ detail: "Instructor Employee ID exists" });
    }
    if (result.outcome === "duplicate_user_id") {
      return res.status(400).json({ detail: "Instructor User ID exists" });
    }
    return res.status(201).json({
      message: "Instructor created successfully",
      id: result.instructor._id,
      instructor_user_id: result.instructor.instructor_user_id,
    });
  })
);

instructorRouter.post(
  "/import/sheet",
  requireSuperAdmin,
  validate(instructorImportSheetSchema),
  asyncRoute(async (req, res) => {
    try {
      const csv = await fetchSheetCsv(req.validatedBody.url);
      return res.json({ csv });
    } catch (error) {
      if (error instanceof RemoteFetchError) return res.status(400).json({ detail: error.message });
      throw error;
    }
  })
);

instructorRouter.post(
  "/import/preview",
  requireSuperAdmin,
  validate(instructorImportRowsSchema(MAX_PREVIEW_ROWS)),
  asyncRoute(async (req, res) => {
    if (!isFaceRecognitionConfigured()) {
      return res.status(503).json({ detail: FACE_REASON_MESSAGES.NOT_CONFIGURED });
    }
    const results = await previewImportRows(req.app.locals.db, req.validatedBody.rows);
    return res.json({ results });
  })
);

instructorRouter.post(
  "/import",
  requireSuperAdmin,
  validate(instructorImportRowsSchema(MAX_COMMIT_ROWS)),
  asyncRoute(async (req, res) => {
    if (!isFaceRecognitionConfigured()) {
      return res.status(503).json({ detail: FACE_REASON_MESSAGES.NOT_CONFIGURED });
    }
    const db = req.app.locals.db;
    const { allow_move_while_checked_in: allowMoveWhileCheckedIn } = await getConfigSettings(db);
    const results = await commitImportRows(db, req.validatedBody.rows, {
      createInstructor: createInstructorGuarded,
      updateInstructor: (database, instructorId, fields) => updateInstructorGuarded(
        database,
        instructorId,
        fields,
        null,
        { allowMoveWhileCheckedIn },
      ),
    });
    return res.json({ results });
  })
);

instructorRouter.get(
  "/",
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    let pagination;
    let includeFeedback = true;
    let includePhotoUrl = false;
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
      if (req.query.include_photo_url !== undefined) {
        if (req.query.include_photo_url === "true") includePhotoUrl = true;
        else if (req.query.include_photo_url === "false") includePhotoUrl = false;
        else throw new RangeError("include_photo_url must be true or false");
      }
    } catch (error) {
      if (error instanceof RangeError) {
        return res.status(422).json({ detail: error.message });
      }
      throw error;
    }
    const instructors = await coreCollection(db, "instructors")
      .find(activeFilter(instructorScope(req.currentUser)))
      .sort({ name: 1, _id: 1 })
      .skip(pagination.offset)
      .limit(pagination.limit)
      .toArray();
    const instructorIds = instructors.map((row) => String(row._id));
    const attendances = includeFeedback
      ? await loadRecentInstructorFeedbacks(db, instructorIds)
      : [];
    const grouped = new Map();
    for (const attendance of attendances) {
      const rows = grouped.get(String(attendance.instructor_id)) || [];
      if (rows.length < 100) rows.push(attendance);
      grouped.set(String(attendance.instructor_id), rows);
    }

    const photoUrls = new Map();
    if (includePhotoUrl && isElevated(req.currentUser.role)) {
      const withPhotos = instructors.filter((row) => row.reference_photo_key);
      const signed = await Promise.all(withPhotos.map(async (row) => [
        String(row._id),
        await getPhotoUrl(row.reference_photo_key),
      ]));
      for (const [id, url] of signed) if (url) photoUrls.set(id, url);
    }

    return res.json(instructors.map((instructor) => {
      const serialized = serializeDocument(instructor);
      for (const key of Object.keys(serialized)) {
        if (key.startsWith("_private_")) delete serialized[key];
      }
      serialized.has_email = Boolean(instructor.email);
      serialized.face_count = Array.isArray(instructor.face_ids)
        ? instructor.face_ids.filter(Boolean).length
        : 0;
      delete serialized.face_ids;
      delete serialized.reference_photo_key;
      if (includePhotoUrl) {
        serialized.reference_photo_url = photoUrls.get(String(instructor._id)) || null;
      }
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
    const { allow_move_while_checked_in: allowMoveWhileCheckedIn } = await getConfigSettings(db);
    let result;
    try {
      result = await updateInstructorGuarded(
        db,
        req.params.instructorId,
        req.validatedBody,
        null,
        { allowMoveWhileCheckedIn }
      );
    } catch (error) {
      if (error.code === 11000) {
        return res.status(400).json({ detail: duplicateKeyDetail(error) });
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
    if (result.outcome === "duplicate_user_id") {
      return res.status(400).json({ detail: "Instructor User ID exists" });
    }
    if (result.outcome === "user_id_locked") {
      return res.status(400).json({ detail: "An instructor's User ID cannot be changed once it is set" });
    }
    return res.json({ message: "Instructor updated successfully" });
  })
);

instructorRouter.patch(
  "/:instructorId/gender",
  validate(instructorGenderSchema),
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    const result = await coreCollection(db, "instructors").updateOne(
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

    const instructor = await coreCollection(db, "instructors").findOne(
      activeFilter({ _id: idMatch(req.params.instructorId) })
    );
    if (!instructor) return res.status(404).json({ detail: "Instructor not found" });

    let normalized;
    try {
      normalized = await normalizeInstructorImage(req.file.buffer);
    } catch (error) {
      return res.status(400).json({ detail: error.message });
    }

    const enrolled = await enrollReferencePhoto(db, instructor, normalized, { mode });
    if (!enrolled.ok) {
      return res.status(enrolled.status).json({
        detail: enrolled.detail,
        ...(enrolled.reason ? { reason: enrolled.reason } : {}),
      });
    }
    const { faceIds, retiredFaceIds, photoKey, quality } = enrolled;

    return res.status(201).json({
      message: mode === "replace"
        ? "Reference photo replaced"
        : "Reference photo added",
      mode,
      face_count: faceIds.length,
      retired_faces: retiredFaceIds.length,
      quality,
      photo_url: await getPhotoUrl(photoKey),
    });
  })
);

instructorRouter.get(
  "/:instructorId/face",
  requireSuperAdmin,
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    const instructor = await coreCollection(db, "instructors").findOne(
      activeFilter({ _id: idMatch(req.params.instructorId) }),
      { projection: { face_ids: 1, reference_photo_key: 1, face_indexed_at: 1 } }
    );
    if (!instructor) return res.status(404).json({ detail: "Instructor not found" });

    const faceIds = Array.isArray(instructor.face_ids) ? instructor.face_ids.filter(Boolean) : [];
    return res.json({
      has_reference: faceIds.length > 0,
      face_count: faceIds.length,
      face_indexed_at: instructor.face_indexed_at || null,
      photo_url: instructor.reference_photo_key
        ? await getPhotoUrl(instructor.reference_photo_key)
        : null,
    });
  })
);

instructorRouter.delete(
  "/:instructorId/face",
  requireSuperAdmin,
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    const instructor = await coreCollection(db, "instructors").findOne(
      activeFilter({ _id: idMatch(req.params.instructorId) })
    );
    if (!instructor) return res.status(404).json({ detail: "Instructor not found" });

    const faceIds = Array.isArray(instructor.face_ids)
      ? instructor.face_ids.filter(Boolean).map(String)
      : [];
    if (faceIds.length && isFaceRecognitionConfigured()) {
      const removed = await deleteFaces(faceIds);
      if (!removed.ok) {
        return res.status(503).json({ detail: removed.message, reason: removed.reason });
      }
    }

    const now = new Date();
    await coreCollection(db, "instructors").updateOne(
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
