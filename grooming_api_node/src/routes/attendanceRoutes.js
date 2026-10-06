import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import multer from "multer";
import { runtimeConfig } from "../config/env.js";
import { idMatch, instructorScope, isElevated, requireSuperAdmin } from "../middleware/auth.js";
import { validateImageUpload } from "../imageValidation.js";
import { normalizeGroupImage, normalizeInstructorImage } from "../imageProcessor.js";
import { enqueueEvaluation, evaluateCheckoutNow } from "../services/evaluationWorker.js";
import { parseBodyRegions } from "../services/detailCheck.js";
import {
  deleteEvaluation,
  deleteEvaluationsForAttendance,
  getEvaluation,
} from "../stores/evaluationStore.js";
import { escalationFor, weeklyEscalations } from "../services/escalations.js";
import { getNotificationSettings } from "../services/notificationSettings.js";
import {
  getIdentificationSettings,
  usesFaceIdentification,
} from "../services/identificationSettings.js";
import {
  FACE_REASONS,
  isFaceRecognitionConfigured,
  searchFaceByImage,
} from "../services/faceRecognition.js";
import {
  describeGroupOutcome,
  GROUP_OUTCOMES,
  identifyPeopleInPhoto,
} from "../services/groupRecognition.js";
import { incrementMetric } from "../services/telemetry.js";
import { localDateKey } from "../services/instructorReports.js";
import { enqueueNotification } from "../services/notificationWorker.js";
import {
  buildPhotoKey,
  deletePhoto,
  downloadPhoto,
  getPhotoUrl,
  uploadPhoto,
} from "../services/photoStorage.js";
import {
  canDeleteAttendance,
  canDeleteCheckout,
  getAccessSettings,
} from "../services/accessSettings.js";
import {
  CHECKOUT_TIMING,
  checkoutTiming,
  describeCheckoutTiming,
} from "../services/checkoutTiming.js";
import {
  claimCapture,
  groupTabletCaptureKey,
  rememberCapture,
  tabletCaptureKey,
  CAPTURE_WINDOW_MS,
} from "../services/recentCaptures.js";
import {
  decideKioskAction,
  describeKioskAction,
  KIOSK_ACTIONS,
} from "../services/kioskAction.js";
import { attachAddressToAttendance } from "../services/geocoding.js";
import {
  asyncRoute,
  createDocument,
  dateBoundsInTimeZone,
  parsePagination,
  serializeDocument,
  dateRangeBoundsInTimeZone,
} from "../utils.js";
import { checkoutSchema, parseCoordinates, validate } from "../validation.js";
import { jobCollection } from "../stores/jobStore.js";
import { coreCollection, coreTransaction } from "../stores/coreStore.js";

const upload = multer({
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

const checkInLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => String(req.currentUser?.email || "unauthenticated"),
  message: { detail: "Too many check-in attempts. Please try again later." },
});

const checkOutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => String(req.currentUser?.email || "unauthenticated"),
  message: { detail: "Too many check-out attempts. Please try again later." },
});

const groupCheckInLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => String(req.currentUser?.email || "unauthenticated"),
  message: { detail: "Too many group check-in attempts. Please try again later." },
});

const reanalyseLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => String(req.currentUser?.email || "unauthenticated"),
  message: { detail: "Too many re-analysis requests. Please try again later." },
});

let activeGroupCaptures = 0;
export function groupCaptureGate(_req, res, next) {
  if (activeGroupCaptures >= runtimeConfig().groupConcurrencyLimit) {
    res.set("Retry-After", "5");
    return res.status(503).json({
      detail: "Another group photo is being processed. Please retry in a few seconds.",
    });
  }
  activeGroupCaptures += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    activeGroupCaptures = Math.max(0, activeGroupCaptures - 1);
    res.off("finish", release);
    res.off("close", release);
  };
  res.once("finish", release);
  res.once("close", release);
  return next();
}

let activeCheckIns = 0;
export function checkInConcurrencyGate(_req, res, next) {
  if (activeCheckIns >= runtimeConfig().checkInConcurrencyLimit) {
    res.set("Retry-After", "5");
    return res.status(503).json({
      detail: "Image processing is busy. Please retry in a few seconds.",
    });
  }
  activeCheckIns += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    activeCheckIns = Math.max(0, activeCheckIns - 1);
    res.off("finish", release);
    res.off("close", release);
  };
  res.once("finish", release);
  res.once("close", release);
  return next();
}

const OUTBOX_DEADLINE_MS = 24 * 60 * 60 * 1000;
const INSTRUCTOR_ATTENDANCE_GUARD = "_private_attendance_guard_version";
const INTERNAL_ATTENDANCE_FIELDS = new Set([
  "_private_evaluation_outbox",
  "_private_checkin_outbox",
  "_private_checkout_outbox",
  "deleting_at",
  "checkout_deleting_at",
]);

export const attendanceRouter = Router();

function activeInstructorFilter(currentUser, instructorId) {
  return {
    $and: [
      { _id: idMatch(instructorId) },
      instructorScope(currentUser),
      { $or: [{ deleted_at: null }, { deleted_at: { $exists: false } }] },
    ],
  };
}

function attendanceScope(currentUser) {
  return isElevated(currentUser?.role)
    ? {}
    : { college_id: idMatch(String(currentUser.collegeId)) };
}

async function purgeAttendance(db, attendance) {
  const marked = await coreCollection(db, "attendance").updateOne(
    { _id: attendance._id, deleting_at: { $exists: false } },
    {
      $set: { deleting_at: new Date(), updated_at: new Date() },
      $unset: {
        _private_evaluation_outbox: "",
        _private_checkin_outbox: "",
        _private_checkout_outbox: "",
      },
    }
  );
  if (!marked.matchedCount) {
    const current = await coreCollection(db, "attendance").findOne({ _id: attendance._id });
    if (!current) return;
    return;
  }
  await Promise.all([
    jobCollection(db, "evaluation_jobs").deleteMany({ attendance_id: attendance._id }),
    jobCollection(db, "notification_jobs").deleteMany({ attendance_id: attendance._id }),
    jobCollection(db, "mail_jobs").deleteMany({ attendance_id: attendance._id }),
  ]);
  const keys = [attendance.check_in_photo_key, attendance.check_out_photo_key].filter(Boolean);
  for (const key of keys) {
    const result = await deletePhoto(key);
    if (!result.deleted) {
      const error = new Error(`Photo ${key} could not be removed`);
      error.code = "PHOTO_DELETE_FAILED";
      throw error;
    }
  }
  await deleteEvaluationsForAttendance(db, attendance._id);
  await coreCollection(db, "attendance").deleteOne({ _id: attendance._id, deleting_at: { $exists: true } });
}

async function compensateUploadedPhoto(db, key, reason) {
  if (!key) return;
  const result = await deletePhoto(key);
  if (result.deleted) return;
  await jobCollection(db, "storage_cleanup_jobs").updateOne(
    { _id: key },
    {
      $setOnInsert: {
        _id: key,
        key,
        reason,
        status: "queued",
        attempts: 0,
        available_at: new Date(),
        created_at: new Date(),
      },
      $set: { updated_at: new Date(), last_error: result.reason || "delete_failed" },
    },
    { upsert: true }
  );
}

export function attendanceOnLocalDay(instructorId, now = new Date()) {
  const timeZone = runtimeConfig().appTimeZone;
  const attendanceDay = localDateKey(now, timeZone);
  const { start, end } = dateBoundsInTimeZone(attendanceDay, timeZone);
  return {
    instructor_id: idMatch(String(instructorId)),
    $or: [
      { attendance_day: attendanceDay },
      {
        attendance_day: { $exists: false },
        check_in_time: { $gte: start, $lt: end },
      },
    ],
  };
}

function openCheckInToday(instructorId, now = new Date()) {
  return {
    ...attendanceOnLocalDay(instructorId, now),
    check_out_time: null,
  };
}

export function checkoutAvailability(attendance, now = new Date()) {
  if (!attendance) return "not_checked_in_today";
  if (attendance.check_out_time) return "already_checked_out_today";
  if (checkoutTiming(attendance.check_in_time, { now }).state === CHECKOUT_TIMING.TOO_EARLY) {
    return "too_early";
  }
  return "available";
}

async function attendanceIdForToday(db, instructorId) {
  try {
    const record = await coreCollection(db, "attendance").findOne(
      attendanceOnLocalDay(instructorId),
      { projection: { _id: 1 } },
    );
    return record ? String(record._id) : null;
  } catch {
    return null;
  }
}

function isValidEmail(value) {
  return typeof value === "string"
    && value.length <= 254
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
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

export async function commitGuardedCheckIn(
  db,
  {
    currentUser,
    instructorId,
    coordinates,
    normalizedImage,
    photoKey = null,
    locationAccuracyM = null,
    capturedAt = null,
    identification = null,
    bodyRegions = null,
    now = new Date(),
  },
  runTransaction = null
) {
  return (runTransaction || coreTransaction(db))(async (session) => {
    const instructor = await coreCollection(db, "instructors").findOne(
      activeInstructorFilter(currentUser, instructorId),
      { session }
    );
    if (!instructor) return { outcome: "instructor_not_found" };
    if (!isValidEmail(instructor.email)) return { outcome: "invalid_email" };

    const attendanceToday = await coreCollection(db, "attendance").findOne(
      attendanceOnLocalDay(instructor._id, now),
      { session }
    );
    if (attendanceToday) return { outcome: "already_checked_in_today" };

    const guard = await coreCollection(db, "instructors").updateOne(
      activeInstructorFilter(currentUser, instructorId),
      { $inc: { [INSTRUCTOR_ATTENDANCE_GUARD]: 1 } },
      { session }
    );
    if (!guard.matchedCount) return { outcome: "instructor_not_found" };

    const evaluationDeadline = new Date(now.getTime() + OUTBOX_DEADLINE_MS);
    const evaluationPayload = {
      instructor: {
        id: String(instructor._id),
        name: instructor.name,
        email: instructor.email,
        gender: instructor.gender,
        collegeId: instructor.college_id ? String(instructor.college_id) : null,
      },
      photo_key: photoKey,
      mime_type: normalizedImage.mimeType,
      check_in_time: now,
      deadline_at: evaluationDeadline,
      created_at: now,
    };
    const attendance = createDocument({
      instructor_id: String(instructor._id),
      instructor_name: instructor.name,
      instructor_role: instructor.instructor_role || instructor.role || null,
      college_id: instructor.college_id ? String(instructor.college_id) : null,
      boa_id: currentUser.referenceId ? String(currentUser.referenceId) : "super-admin",
      attendance_day: localDateKey(now, runtimeConfig().appTimeZone),
      date: now,
      check_in_time: now,
      check_out_time: null,
      location_coordinates: coordinates,
      location_accuracy_m: locationAccuracyM,
      check_in_photo_key: photoKey,
      check_in_photo_captured_at: capturedAt || now,
      ...(bodyRegions ? { check_in_body_regions: bodyRegions } : {}),
      check_out_photo_key: null,
      status: "pending",
      compliance_status: null,
      remarks: "AI analysis is in progress.",
      evaluation_queue_status: "outbox_pending",
      checkin_email_status: "waiting_for_analysis",
      checkout_email_status: "not_requested",
      ...(identification ? { identification } : {}),
      _private_evaluation_outbox: evaluationPayload,
      created_at: now,
      updated_at: now,
    });
    await coreCollection(db, "attendance").insertOne(attendance, { session });
    return { outcome: "created", attendance, evaluationPayload };
  });
}

export function serializeAttendance(attendance) {
  const publicAttendance = Object.fromEntries(
    Object.entries(attendance).filter(([key]) => (
      !key.startsWith("_private_") && !INTERNAL_ATTENDANCE_FIELDS.has(key)
    ))
  );
  return serializeDocument(publicAttendance);
}

attendanceRouter.post(
  "/auto",
  checkInLimiter,
  checkInConcurrencyGate,
  upload.single("file"),
  asyncRoute(async (req, res) => {
    const validation = validateImageUpload(req.file);
    if (!validation.valid) return res.status(400).json({ detail: validation.detail });

    const db = req.app.locals.db;
    const now = new Date();

    if (!isFaceRecognitionConfigured()) {
      return res.status(503).json({
        detail: "Face recognition is not available right now, so nobody can be identified.",
        action: KIOSK_ACTIONS.NOT_RECOGNISED,
      });
    }

    const coordinates = parseCoordinates(req.body.location_coordinates);
    if (req.body.location_coordinates && !coordinates) {
      return res.status(422).json({ detail: "location_coordinates must be valid latitude,longitude" });
    }
    const bodyRegions = parseBodyRegions(req.body?.body_regions);
    const accuracyMetres = Number.parseInt(req.body.location_accuracy_m, 10) || null;

    let normalizedImage;
    try {
      normalizedImage = await normalizeInstructorImage(req.file.buffer);
    } catch {
      return res.status(400).json({
        detail: "Image could not be decoded; take a clear photo and try again",
      });
    }

    const match = await searchFaceByImage(normalizedImage.buffer);
    const instructor = match.ok
      ? await coreCollection(db, "instructors").findOne(
          activeInstructorFilter(req.currentUser, String(match.instructorId))
        )
      : null;

    const tabletKey = tabletCaptureKey(req.currentUser.email);
    const tabletHold = { now: now.getTime(), windowMs: CAPTURE_WINDOW_MS };
    if (instructor) {
      rememberCapture(tabletKey, tabletHold);
    } else if (!claimCapture(tabletKey, tabletHold)) {
      incrementMetric("kiosk_duplicate_capture_total");
      return res.status(200).json({
        action: KIOSK_ACTIONS.NOT_RECOGNISED,
        recorded: false,
        duplicate: true,
        instructor_name: null,
        attendance_id: null,
        title: "",
        tone: "info",
      });
    }

    const today = instructor
      ? await coreCollection(db, "attendance").findOne(attendanceOnLocalDay(instructor._id, now))
      : null;
    const action = decideKioskAction({
      matched: Boolean(instructor),
      availability: checkoutAvailability(today, now),
    });

    if (action === KIOSK_ACTIONS.TOO_EARLY || action === KIOSK_ACTIONS.ALREADY_DONE) {
      const timing = checkoutTiming(today?.check_in_time, { now });
      const opensAtLabel = timing.opens_at
        ? new Intl.DateTimeFormat("en-IN", {
            timeZone: runtimeConfig().appTimeZone,
            hour: "numeric",
            minute: "2-digit",
            hour12: true,
          }).format(timing.opens_at)
        : null;
      return res.status(200).json({
        action,
        recorded: false,
        instructor_name: instructor?.name || null,
        attendance_id: today ? String(today._id) : null,
        ...describeKioskAction(action, {
          instructorName: instructor?.name,
          opensAtLabel: action === KIOSK_ACTIONS.TOO_EARLY ? opensAtLabel : null,
          minutesRemaining: timing.minutes_remaining,
        }),
      });
    }

    if (action === KIOSK_ACTIONS.NOT_RECOGNISED) {
      return res.status(200).json({
        action,
        recorded: false,
        instructor_name: null,
        attendance_id: null,
        ...describeKioskAction(action),
      });
    }

    const photoKind = action === KIOSK_ACTIONS.CHECK_OUT ? "checkout" : "checkin";
    const photoKey = buildPhotoKey({
      instructorId: String(instructor._id),
      kind: photoKind,
      mimeType: normalizedImage.mimeType,
      now,
    });
    const uploading = uploadPhoto({
      key: photoKey,
      body: normalizedImage.buffer,
      mimeType: normalizedImage.mimeType,
      metadata: {
        instructor_id: String(instructor._id),
        kind: photoKind,
        captured_at: now.toISOString(),
        coordinates: coordinates || "",
        accuracy_m: req.body.location_accuracy_m || "",
      },
    }).then(
      (upload) => Boolean(upload?.stored),
      (error) => {
        console.error(`Kiosk photo upload failed for ${photoKey}: ${error?.name || "Error"}`);
        return false;
      }
    );

    const settleUpload = async (attendanceId, kind) => {
      if (await uploading) return true;
      const field = kind === "checkout" ? "check_out_photo_key" : "check_in_photo_key";
      await coreCollection(db, "attendance").updateOne(
        { _id: attendanceId },
        {
          $set: {
            [field]: null,
            photo_storage_failed_at: new Date(),
            ...(kind === "checkout"
              ? { checkout_evaluation_queue_status: null, checkout_email_status: "not_requested" }
              : {
                evaluation_queue_status: null,
                status: "error",
                remarks: "The photograph could not be stored, so this check-in was not analysed.",
              }),
            updated_at: new Date(),
          },
        }
      );
      incrementMetric("kiosk_photo_upload_failures_total");
      return false;
    };
    const discardPendingUpload = async (reason) => {
      if (await uploading) await compensateUploadedPhoto(db, photoKey, reason);
    };
    const stored = { key: photoKey };

    const identification = {
      method: "FACE",
      outcome: "MATCHED",
      similarity: match.similarity,
      face_id: match.faceId,
      runner_up_instructor_id: match.runnerUp?.instructorId || null,
      runner_up_similarity: match.runnerUp?.similarity ?? null,
      attempted_at: now,
    };

    if (action === KIOSK_ACTIONS.CHECK_IN) {
      let committed;
      try {
        committed = await commitGuardedCheckIn(db, {
          currentUser: req.currentUser,
          instructorId: String(instructor._id),
          coordinates,
          normalizedImage,
          photoKey: stored.key,
          locationAccuracyM: accuracyMetres,
          capturedAt: now,
          identification,
          bodyRegions,
          now,
        });
      } catch (error) {
        await discardPendingUpload("kiosk_checkin_commit_failed");
        if (error.code === 11000) {
          return res.status(409).json({
            detail: "This instructor has already checked in today",
            attendance_id: await attendanceIdForToday(db, instructor._id),
          });
        }
        throw error;
      }
      if (committed.outcome !== "created") {
        await discardPendingUpload(`kiosk_${committed.outcome}`);
        return res.status(committed.outcome === "invalid_email" ? 422 : 409).json({
          detail: committed.outcome === "invalid_email"
            ? "This instructor needs a valid email address before check-in reports can be sent."
            : "This instructor has already checked in today",
        });
      }

      const { attendance, evaluationPayload } = committed;
      void settleUpload(attendance._id, "checkin").then(async (ok) => {
        if (!ok) return;
        try {
          await enqueueEvaluation(db, {
            attendanceId: attendance._id,
            instructor: evaluationPayload.instructor,
            photoKey: evaluationPayload.photo_key,
            mimeType: evaluationPayload.mime_type,
            checkInTime: evaluationPayload.check_in_time,
            deadlineAt: evaluationPayload.deadline_at,
          });
        } catch (error) {
          console.error(`Kiosk evaluation outbox ${attendance._id} remains pending (${error.name || "ERROR"})`);
        }
      });
      if (coordinates) void attachAddressToAttendance(db, attendance._id, coordinates);
      incrementMetric("kiosk_checkin_total");
      return res.status(202).json({
        action,
        recorded: true,
        instructor_name: instructor.name,
        attendance_id: String(attendance._id),
        ...describeKioskAction(action, { instructorName: instructor.name }),
      });
    }

    const recipient = isValidEmail(instructor.email) ? instructor.email : null;
    const result = await coreCollection(db, "attendance").findOneAndUpdate(
      { _id: today._id, check_out_time: null, ...attendanceScope(req.currentUser) },
      {
        $set: {
          check_out_time: now,
          check_out_photo_key: stored.key,
          check_out_photo_captured_at: now,
          ...(bodyRegions ? { check_out_body_regions: bodyRegions } : {}),
          ...(coordinates ? { check_out_coordinates: coordinates } : {}),
          ...(accuracyMetres != null ? { check_out_location_accuracy_m: accuracyMetres } : {}),
          checkout_identification: identification,
          checkout_evaluation_queue_status: "processing",
          checkout_email_status: recipient ? "waiting_for_analysis" : "skipped_no_email",
          updated_at: now,
        },
      },
      { returnDocument: "after" }
    );
    const attendance = result?.value || result;
    if (!attendance) {
      await discardPendingUpload("kiosk_duplicate_checkout");
      return res.status(409).json({
        detail: "This instructor has already checked out today",
        attendance_id: String(today._id),
      });
    }

    void settleUpload(attendance._id, "checkout").then(async (ok) => {
      if (!ok) return;
      try {
        await enqueueEvaluation(db, {
          attendanceId: attendance._id,
          kind: "checkout",
          instructor: {
            id: String(instructor._id),
            name: instructor.name,
            email: recipient || instructor.email || null,
            gender: instructor.gender || null,
            collegeId: instructor.college_id ? String(instructor.college_id) : null,
          },
          photoKey: stored.key,
          mimeType: normalizedImage.mimeType,
          checkInTime: attendance.check_in_time,
          checkOutTime: now,
        });
      } catch (error) {
        console.error(`Kiosk checkout evaluation not queued for ${attendance._id} (${error?.name || "ERROR"})`);
      }
    });
    if (coordinates) void attachAddressToAttendance(db, attendance._id, coordinates, "checkout");
    incrementMetric("kiosk_checkout_total");
    return res.status(202).json({
      action,
      recorded: true,
      instructor_name: instructor.name,
      attendance_id: String(attendance._id),
      ...describeKioskAction(action, { instructorName: instructor.name }),
    });
  })
);

attendanceRouter.post(
  "/auto/group",
  groupCheckInLimiter,
  checkInConcurrencyGate,
  groupCaptureGate,
  upload.single("file"),
  asyncRoute(async (req, res) => {
    const validation = validateImageUpload(req.file);
    if (!validation.valid) return res.status(400).json({ detail: validation.detail });

    const db = req.app.locals.db;
    const now = new Date();
    const config = runtimeConfig();

    if (!isFaceRecognitionConfigured()) {
      return res.status(503).json({
        detail: "Face recognition is not available right now, so nobody can be identified.",
      });
    }

    const coordinates = parseCoordinates(req.body.location_coordinates);
    if (req.body.location_coordinates && !coordinates) {
      return res.status(422).json({ detail: "location_coordinates must be valid latitude,longitude" });
    }
    const accuracyMetres = Number.parseInt(req.body.location_accuracy_m, 10) || null;

    let groupImage;
    try {
      groupImage = await normalizeGroupImage(req.file.buffer);
    } catch {
      return res.status(400).json({
        detail: "Image could not be decoded; take a clear photo and try again",
      });
    }

    const identified = await identifyPeopleInPhoto(groupImage);
    if (!identified.ok) {
      const tooMany = identified.reason === FACE_REASONS.MULTIPLE_FACES;
      return res.status(tooMany ? 422 : 200).json({
        detail: identified.message
          || (identified.reason === FACE_REASONS.NO_FACE
            ? "No faces were found in this photo."
            : "Nobody could be identified from this photo."),
        detected: identified.detected ?? 0,
        recorded: 0,
        people: [],
      });
    }

    const hasUnrecognisedFaces = identified.people.some((person) => (
      person.outcome === GROUP_OUTCOMES.NO_MATCH
      || person.outcome === GROUP_OUTCOMES.AMBIGUOUS
      || person.outcome === GROUP_OUTCOMES.PROVIDER_ERROR
    ));
    const holdKey = groupTabletCaptureKey(req.currentUser.email);
    const hold = { now: now.getTime(), windowMs: CAPTURE_WINDOW_MS };
    const hasRecognisedFaces = identified.people.some((person) => person.outcome === GROUP_OUTCOMES.MATCHED);
    if (hasRecognisedFaces || !hasUnrecognisedFaces) {
      rememberCapture(holdKey, hold);
    } else if (!claimCapture(holdKey, hold)) {
      incrementMetric("group_duplicate_capture_total");
      return res.status(200).json({
        detected: identified.detected,
        recorded: 0,
        duplicate: true,
        people: [],
      });
    }

    const settleUpload = async (uploading, attendanceId, kind) => {
      if (await uploading) return true;
      const field = kind === "checkout" ? "check_out_photo_key" : "check_in_photo_key";
      await coreCollection(db, "attendance").updateOne(
        { _id: attendanceId },
        {
          $set: {
            [field]: null,
            photo_storage_failed_at: new Date(),
            ...(kind === "checkout"
              ? { checkout_evaluation_queue_status: null, checkout_email_status: "not_requested" }
              : {
                evaluation_queue_status: null,
                status: "error",
                remarks: "The photograph could not be stored, so this check-in was not analysed.",
              }),
            updated_at: new Date(),
          },
        }
      );
      incrementMetric("kiosk_photo_upload_failures_total");
      return false;
    };

    const beginUpload = (person, instructorId, kind) => {
      const key = buildPhotoKey({
        instructorId: String(instructorId),
        kind,
        mimeType: person.image.mimeType,
        now,
      });
      const uploading = uploadPhoto({
        key,
        body: person.image.buffer,
        mimeType: person.image.mimeType,
        metadata: {
          instructor_id: String(instructorId),
          kind,
          captured_at: now.toISOString(),
          coordinates: coordinates || "",
          accuracy_m: req.body.location_accuracy_m || "",
          capture_mode: "group",
        },
      }).then(
        (upload) => Boolean(upload?.stored),
        (error) => {
          console.error(`Group photo upload failed for ${key}: ${error?.name || "Error"}`);
          return false;
        }
      );
      return { key, uploading };
    };

    const identificationFor = (person) => ({
      method: "FACE",
      outcome: "MATCHED",
      similarity: person.similarity,
      face_id: person.faceId,
      runner_up_instructor_id: person.runnerUp?.instructorId || null,
      runner_up_similarity: person.runnerUp?.similarity ?? null,
      attempted_at: now,
      capture_mode: "GROUP",
      group_face_box: person.box,
      group_body_coverage: person.bodyCoverage,
    });

    const answer = (person, fields) => ({
      position: person.box,
      similarity: person.similarity,
      recorded_at: null,
      check_in_time: null,
      ...fields,
    });

    const processPerson = async (person) => {
      if (!person.image) {
        return answer(person, {
          action: KIOSK_ACTIONS.NOT_RECOGNISED,
          recorded: false,
          instructor_name: null,
          attendance_id: null,
          title: "Could not be photographed",
          detail: "This person could not be cut out of the group photo.",
          tone: "warning",
        });
      }

      if (person.outcome === GROUP_OUTCOMES.TOO_SMALL) {
        incrementMetric("group_too_small_total");
        return answer(person, {
          action: KIOSK_ACTIONS.NOT_RECOGNISED,
          recorded: false,
          instructor_name: null,
          attendance_id: null,
          title: describeGroupOutcome(person.outcome),
          detail: "Stand closer to the camera and try again.",
          tone: "warning",
        });
      }

      const instructor = person.instructorId
        ? await coreCollection(db, "instructors").findOne(
            activeInstructorFilter(req.currentUser, person.instructorId)
          )
        : null;

      const today = instructor
        ? await coreCollection(db, "attendance").findOne(attendanceOnLocalDay(instructor._id, now))
        : null;
      const action = decideKioskAction({
        matched: Boolean(instructor),
        availability: checkoutAvailability(today, now),
      });

      if (action === KIOSK_ACTIONS.TOO_EARLY || action === KIOSK_ACTIONS.ALREADY_DONE) {
        const timing = checkoutTiming(today?.check_in_time, { now });
        const opensAtLabel = timing.opens_at
          ? new Intl.DateTimeFormat("en-IN", {
              timeZone: config.appTimeZone,
              hour: "numeric",
              minute: "2-digit",
              hour12: true,
            }).format(timing.opens_at)
          : null;
        return answer(person, {
          action,
          recorded: false,
          instructor_name: instructor?.name || null,
          attendance_id: today ? String(today._id) : null,
          check_in_time: today?.check_in_time || null,
          ...describeKioskAction(action, {
            instructorName: instructor?.name,
            opensAtLabel: action === KIOSK_ACTIONS.TOO_EARLY ? opensAtLabel : null,
            minutesRemaining: timing.minutes_remaining,
          }),
        });
      }

      if (action === KIOSK_ACTIONS.NOT_RECOGNISED) {
        return answer(person, {
          action,
          recorded: false,
          instructor_name: null,
          attendance_id: null,
          title: "Not recognised — not recorded",
          detail: "Please try again, or ask an administrator to update your reference photo.",
          tone: "warning",
        });
      }

      if (action === KIOSK_ACTIONS.CHECK_IN) {
        const { key, uploading } = beginUpload(person, instructor._id, "checkin");
        let committed;
        try {
          committed = await commitGuardedCheckIn(db, {
            currentUser: req.currentUser,
            instructorId: String(instructor._id),
            coordinates,
            normalizedImage: person.image,
            photoKey: key,
            locationAccuracyM: accuracyMetres,
            capturedAt: now,
            identification: identificationFor(person),
            now,
          });
        } catch (error) {
          if (await uploading) await compensateUploadedPhoto(db, key, "group_checkin_commit_failed");
          if (error.code !== 11000) throw error;
          committed = { outcome: "already_checked_in_today" };
        }
        if (committed.outcome !== "created") {
          if (await uploading) await compensateUploadedPhoto(db, key, `group_${committed.outcome}`);
          let existing = null;
          if (committed.outcome === "already_checked_in_today") {
            try {
              existing = await coreCollection(db, "attendance").findOne(
                attendanceOnLocalDay(instructor._id, now),
                { projection: { _id: 1, check_in_time: 1 } }
              );
            } catch {
              existing = null;
            }
          }
          return answer(person, {
            action: KIOSK_ACTIONS.ALREADY_DONE,
            recorded: false,
            instructor_name: instructor.name,
            attendance_id: existing ? String(existing._id) : null,
            check_in_time: existing?.check_in_time || null,
            title: committed.outcome === "invalid_email"
              ? `${instructor.name} needs an email address`
              : `${instructor.name} has already checked in today`,
            detail: committed.outcome === "invalid_email"
              ? "Check-in reports cannot be sent until one is set."
              : "Nothing was recorded.",
            tone: "info",
          });
        }

        const { attendance, evaluationPayload } = committed;
        void settleUpload(uploading, attendance._id, "checkin").then(async (ok) => {
          if (!ok) return;
          try {
            await enqueueEvaluation(db, {
              attendanceId: attendance._id,
              instructor: evaluationPayload.instructor,
              photoKey: evaluationPayload.photo_key,
              mimeType: evaluationPayload.mime_type,
              checkInTime: evaluationPayload.check_in_time,
              deadlineAt: evaluationPayload.deadline_at,
            });
          } catch (error) {
            console.error(`Group evaluation outbox ${attendance._id} remains pending (${error.name || "ERROR"})`);
          }
        });
        if (coordinates) void attachAddressToAttendance(db, attendance._id, coordinates);
        incrementMetric("group_checkin_total");
        return answer(person, {
          action,
          recorded: true,
          instructor_name: instructor.name,
          attendance_id: String(attendance._id),
          recorded_at: now,
          check_in_time: now,
          ...describeKioskAction(action, { instructorName: instructor.name }),
        });
      }

      const { key, uploading } = beginUpload(person, instructor._id, "checkout");
      const recipient = isValidEmail(instructor.email) ? instructor.email : null;
      const result = await coreCollection(db, "attendance").findOneAndUpdate(
        { _id: today._id, check_out_time: null, ...attendanceScope(req.currentUser) },
        {
          $set: {
            check_out_time: now,
            check_out_photo_key: key,
            check_out_photo_captured_at: now,
            ...(coordinates ? { check_out_coordinates: coordinates } : {}),
            ...(accuracyMetres != null ? { check_out_location_accuracy_m: accuracyMetres } : {}),
            checkout_identification: identificationFor(person),
            checkout_evaluation_queue_status: "processing",
            checkout_email_status: recipient ? "waiting_for_analysis" : "skipped_no_email",
            updated_at: now,
          },
        },
        { returnDocument: "after" }
      );
      const attendance = result?.value || result;
      if (!attendance) {
        if (await uploading) await compensateUploadedPhoto(db, key, "group_duplicate_checkout");
        return answer(person, {
          action: KIOSK_ACTIONS.ALREADY_DONE,
          recorded: false,
          instructor_name: instructor.name,
          attendance_id: String(today._id),
          check_in_time: today.check_in_time || null,
          title: `${instructor.name} has already checked out today`,
          detail: "Nothing was recorded.",
          tone: "info",
        });
      }

      void settleUpload(uploading, attendance._id, "checkout").then(async (ok) => {
        if (!ok) return;
        try {
          await enqueueEvaluation(db, {
            attendanceId: attendance._id,
            kind: "checkout",
            instructor: {
              id: String(instructor._id),
              name: instructor.name,
              email: recipient || instructor.email || null,
              gender: instructor.gender || null,
              collegeId: instructor.college_id ? String(instructor.college_id) : null,
            },
            photoKey: key,
            mimeType: person.image.mimeType,
            checkInTime: attendance.check_in_time,
            checkOutTime: now,
          });
        } catch (error) {
          console.error(`Group checkout evaluation not queued for ${attendance._id} (${error?.name || "ERROR"})`);
        }
      });
      if (coordinates) void attachAddressToAttendance(db, attendance._id, coordinates, "checkout");
      incrementMetric("group_checkout_total");
      return answer(person, {
        action,
        recorded: true,
        instructor_name: instructor.name,
        attendance_id: String(attendance._id),
        recorded_at: now,
        check_in_time: attendance.check_in_time || null,
        ...describeKioskAction(action, { instructorName: instructor.name }),
      });
    };

    const people = [];
    for (let index = 0; index < identified.people.length; index += config.groupCropConcurrency) {
      const batch = identified.people.slice(index, index + config.groupCropConcurrency);
      const settled = await Promise.allSettled(batch.map(processPerson));
      for (const [offset, outcome] of settled.entries()) {
        if (outcome.status === "fulfilled") {
          people.push(outcome.value);
          continue;
        }
        console.error(`Group attendance failed for one person: ${outcome.reason?.name || "Error"}`);
        incrementMetric("group_person_failed_total");
        people.push({
          position: batch[offset].box,
          action: KIOSK_ACTIONS.NOT_RECOGNISED,
          recorded: false,
          instructor_name: null,
          attendance_id: null,
          title: "Could not be recorded",
          detail: "Something went wrong for this person. Photograph them again.",
          tone: "warning",
        });
      }
    }

    const recorded = people.filter((person) => person.recorded).length;
    incrementMetric("group_capture_total");
    return res.status(recorded > 0 ? 202 : 200).json({
      detected: identified.detected,
      recorded,
      people,
    });
  })
);

attendanceRouter.post(
  "/check-in",
  checkInLimiter,
  checkInConcurrencyGate,
  upload.single("file"),
  asyncRoute(async (req, res) => {
    const validation = validateImageUpload(req.file);
    if (!validation.valid) return res.status(400).json({ detail: validation.detail });

    const db = req.app.locals.db;
    const identificationSettings = await getIdentificationSettings(db);
    const faceMode = usesFaceIdentification(identificationSettings, req.currentUser.collegeId);

    const suppliedInstructorId = String(req.body.instructor_id || "").trim();
    if (suppliedInstructorId.length > 100) {
      return res.status(422).json({ detail: "A valid instructor_id is required" });
    }
    if (!faceMode && !suppliedInstructorId) {
      return res.status(422).json({ detail: "A valid instructor_id is required" });
    }

    const coordinates = parseCoordinates(req.body.location_coordinates);
    if (req.body.location_coordinates && !coordinates) {
      return res.status(422).json({ detail: "location_coordinates must be valid latitude,longitude" });
    }

    let normalizedImage;
    try {
      normalizedImage = await normalizeInstructorImage(req.file.buffer);
    } catch {
      return res.status(400).json({
        detail: "Image could not be decoded; upload a clear JPEG, PNG, or WebP",
      });
    }

    let instructorId = suppliedInstructorId;
    let identification = null;
    let recognitionFailure = null;

    if (faceMode) {
      if (!isFaceRecognitionConfigured()) {
        recognitionFailure = { reason: "NOT_CONFIGURED", bestSimilarity: null, candidateInstructorId: null };
      } else {
        const match = await searchFaceByImage(normalizedImage.buffer);
        if (match.ok) {
          instructorId = String(match.instructorId);
          identification = {
            method: "FACE",
            outcome: "MATCHED",
            similarity: match.similarity,
            face_id: match.faceId,
            runner_up_instructor_id: match.runnerUp?.instructorId || null,
            runner_up_similarity: match.runnerUp?.similarity ?? null,
            attempted_at: new Date(),
          };
        } else {
          recognitionFailure = {
            reason: match.reason,
            bestSimilarity: null,
            candidateInstructorId: null,
          };
        }
      }
    } else {
      identification = { method: "SELECTOR", outcome: "MATCHED", attempted_at: new Date() };
    }

    const now = new Date();

    if (recognitionFailure) {
      return res.status(422).json({
        action: KIOSK_ACTIONS.NOT_RECOGNISED,
        recorded: false,
        identified: false,
        reason: recognitionFailure.reason,
        detail: "Not recognised — nothing was recorded. Please try again, or ask an administrator to update your reference photo.",
      });
    }

    const instructor = await coreCollection(db, "instructors").findOne(
      activeInstructorFilter(req.currentUser, instructorId)
    );
    if (!instructor) {
      if (faceMode) {
        return res.status(422).json({
          action: KIOSK_ACTIONS.NOT_RECOGNISED,
          recorded: false,
          identified: false,
          detail: "Not recognised — nothing was recorded. Please try again, or ask an administrator to update your reference photo.",
        });
      }
      return res.status(404).json({ detail: "Instructor not found" });
    }
    if (!isValidEmail(instructor.email)) {
      return res.status(422).json({
        detail: "This instructor needs a valid email address before check-in reports can be sent.",
      });
    }

    const activeRecord = await coreCollection(db, "attendance").findOne(
      attendanceOnLocalDay(instructor._id)
    );
    if (activeRecord) {
      return res.status(409).json({
        detail: "This instructor has already checked in today",
        attendance_id: String(activeRecord._id),
      });
    }

    const stored = await storeAttendancePhoto({
      instructorId: instructor._id,
      kind: "checkin",
      normalizedImage,
      coordinates,
      accuracyMetres: req.body.location_accuracy_m || "",
      now,
    });
    const photoKey = stored.key;
    if (!stored.stored) {
      return res.status(503).json({
        detail: "Photo storage is unavailable right now. Please try again in a moment.",
      });
    }

    let committed;
    try {
      committed = await commitGuardedCheckIn(db, {
        currentUser: req.currentUser,
        instructorId,
        coordinates,
        normalizedImage,
        photoKey,
        locationAccuracyM: Number.parseInt(req.body.location_accuracy_m, 10) || null,
        capturedAt: now,
        bodyRegions: parseBodyRegions(req.body?.body_regions),
        now,
      });
    } catch (error) {
      await compensateUploadedPhoto(db, photoKey, "checkin_commit_failed");
      if (error.code === 11000) {
        return res.status(409).json({
          detail: "This instructor has already checked in today",
          attendance_id: await attendanceIdForToday(db, instructor._id),
        });
      }
      throw error;
    }
    if (committed.outcome === "instructor_not_found") {
      await compensateUploadedPhoto(db, photoKey, "instructor_not_found");
      return res.status(404).json({ detail: "Instructor not found" });
    }
    if (committed.outcome === "invalid_email") {
      await compensateUploadedPhoto(db, photoKey, "invalid_email");
      return res.status(422).json({
        detail: "This instructor needs a valid email address before check-in reports can be sent.",
      });
    }
    if (committed.outcome === "already_checked_in_today") {
      await compensateUploadedPhoto(db, photoKey, "duplicate_checkin");
      return res.status(409).json({
        detail: "This instructor has already checked in today",
        attendance_id: await attendanceIdForToday(db, instructor._id),
      });
    }
    const { attendance, evaluationPayload } = committed;
    try {
      await enqueueEvaluation(db, {
        attendanceId: attendance._id,
        instructor: evaluationPayload.instructor,
        photoKey: evaluationPayload.photo_key,
        mimeType: evaluationPayload.mime_type,
        checkInTime: evaluationPayload.check_in_time,
        deadlineAt: evaluationPayload.deadline_at,
      });
    } catch (error) {
      console.error(`Evaluation outbox ${attendance._id} remains pending (${error.name || "ERROR"})`);
    }

    if (coordinates) {
      void attachAddressToAttendance(db, attendance._id, coordinates);
    }

    return res.status(202).json({
      message: "Check-in successful. AI analysis is queued.",
      attendance_id: attendance._id,
    });
  })
);

async function storeAttendancePhoto({
  instructorId,
  kind,
  normalizedImage,
  coordinates,
  accuracyMetres,
  now,
}) {
  const key = buildPhotoKey({
    instructorId: String(instructorId),
    kind,
    mimeType: normalizedImage.mimeType,
    now,
  });
  const upload = await uploadPhoto({
    key,
    body: normalizedImage.buffer,
    mimeType: normalizedImage.mimeType,
    metadata: {
      instructor_id: String(instructorId),
      kind,
      captured_at: now.toISOString(),
      coordinates: coordinates || "",
      accuracy_m: accuracyMetres ?? "",
    },
  });
  return upload.stored ? { stored: true, key } : { stored: false, reason: upload.reason };
}

attendanceRouter.post(
  "/check-out",
  checkOutLimiter,
  checkInConcurrencyGate,
  upload.single("file"),
  validate(checkoutSchema),
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    const checkOutTime = new Date();
    const scope = attendanceScope(req.currentUser);

    const identificationSettings = await getIdentificationSettings(db);
    const faceMode = usesFaceIdentification(identificationSettings, req.currentUser.collegeId);

    let instructorId = req.validatedBody.instructor_id || "";
    let identifiedCheckout = null;
    let normalizedCheckoutImage = null;

    if (faceMode) {
      if (!req.file) {
        return res.status(422).json({
          detail: "A photo is required to check out. Take one so the instructor can be identified.",
          outcome: "PHOTO_REQUIRED",
        });
      }
      const validation = validateImageUpload(req.file);
      if (!validation.valid) return res.status(400).json({ detail: validation.detail });
      try {
        normalizedCheckoutImage = await normalizeInstructorImage(req.file.buffer);
      } catch {
        return res.status(400).json({
          detail: "Image could not be decoded; take a clear photo and try again",
        });
      }

      if (!isFaceRecognitionConfigured()) {
        return res.status(503).json({
          detail: "Face recognition is not available right now, so check-out cannot identify anyone.",
          outcome: "NOT_CONFIGURED",
        });
      }
      const match = await searchFaceByImage(normalizedCheckoutImage.buffer);
      if (!match.ok) {
        incrementMetric("checkout_unrecognised_total");
        return res.status(422).json({
          detail: "Not recognised. Try again, or ask an administrator to update your reference photo.",
          outcome: match.reason,
        });
      }
      instructorId = String(match.instructorId);
      identifiedCheckout = {
        method: "FACE",
        outcome: "MATCHED",
        similarity: match.similarity,
        face_id: match.faceId,
        runner_up_instructor_id: match.runnerUp?.instructorId || null,
        runner_up_similarity: match.runnerUp?.similarity ?? null,
        attempted_at: checkOutTime,
      };
    } else if (!instructorId) {
      return res.status(422).json({ detail: "A valid instructor_id is required" });
    }

    const candidate = await coreCollection(db, "attendance").findOne(
      {
        ...attendanceOnLocalDay(instructorId, checkOutTime),
        ...scope,
      }
    );
    const checkoutState = checkoutAvailability(candidate, checkOutTime);
    if (checkoutState === "not_checked_in_today") {
      return res.status(400).json({
        detail: "This instructor has not checked in today",
      });
    }
    if (checkoutState === "already_checked_out_today") {
      return res.status(409).json({
        detail: "This instructor has already checked out today",
        attendance_id: String(candidate._id),
      });
    }
    if (checkoutState === "too_early") {
      const timing = checkoutTiming(candidate.check_in_time, { now: checkOutTime });
      return res.status(409).json({
        detail: describeCheckoutTiming(timing),
        outcome: "TOO_EARLY",
        attendance_id: String(candidate._id),
        checkout_opens_at: timing.opens_at,
        minutes_remaining: timing.minutes_remaining,
      });
    }

    const instructor = await coreCollection(db, "instructors").findOne({
      _id: idMatch(String(candidate.instructor_id)),
    });
    const recipient = isValidEmail(instructor?.email) ? instructor.email : null;
    const notificationDeadline = new Date(checkOutTime.getTime() + OUTBOX_DEADLINE_MS);
    const checkoutPayload = {
      to_email: recipient,
      report: {
        instructorName: candidate.instructor_name || instructor?.name || "Instructor",
        checkInTime: candidate.check_in_time,
        checkOutTime,
        status: candidate.status,
        remarks: candidate.remarks,
      },
      deadline_at: notificationDeadline,
      created_at: checkOutTime,
    };
    let checkOutPhotoKey = null;
    let checkOutPhoto = null;
    if (req.file) {
      const validation = validateImageUpload(req.file);
      if (!validation.valid) return res.status(400).json({ detail: validation.detail });
      try {
        const normalized = normalizedCheckoutImage
          || await normalizeInstructorImage(req.file.buffer);
        const stored = await storeAttendancePhoto({
          instructorId: candidate.instructor_id,
          kind: "checkout",
          normalizedImage: normalized,
          coordinates: parseCoordinates(req.validatedBody.location_coordinates),
          accuracyMetres: req.validatedBody.location_accuracy_m,
          now: checkOutTime,
        });
        if (stored.stored) {
          checkOutPhotoKey = stored.key;
          checkOutPhoto = normalized;
        }
      } catch (error) {
        console.error(`Check-out photo not stored: ${error?.name || "Error"}`);
      }
    }

    const checkoutCoordinates = parseCoordinates(req.validatedBody.location_coordinates);
    const checkoutSet = {
      check_out_time: checkOutTime,
      ...(checkOutPhotoKey ? { check_out_photo_key: checkOutPhotoKey } : {}),
      ...(checkOutPhotoKey && parseBodyRegions(req.body?.body_regions)
        ? { check_out_body_regions: parseBodyRegions(req.body?.body_regions) }
        : {}),
      ...(checkoutCoordinates ? { check_out_coordinates: checkoutCoordinates } : {}),
      ...(req.validatedBody.location_accuracy_m != null
        ? { check_out_location_accuracy_m: req.validatedBody.location_accuracy_m }
        : {}),
      updated_at: checkOutTime,
      ...(identifiedCheckout ? { checkout_identification: identifiedCheckout } : {}),
      checkout_email_status: recipient
        ? (req.file
          ? (checkOutPhotoKey ? "waiting_for_analysis" : "not_sent_analysis_failed")
          : "outbox_pending")
        : "skipped_no_email",
      ...(req.file ? {
        checkout_evaluation_queue_status: checkOutPhotoKey ? "processing" : "failed",
        ...(!checkOutPhotoKey ? { checkout_analysis_error_code: "PHOTO_STORAGE_FAILED" } : {}),
      } : {}),
      ...(recipient && !req.file ? { _private_checkout_outbox: checkoutPayload } : {}),
    };
    const result = await coreCollection(db, "attendance").findOneAndUpdate(
      {
        _id: candidate._id,
        check_out_time: null,
        ...scope,
      },
      {
        $set: checkoutSet,
        ...(!recipient ? { $unset: { _private_checkout_outbox: "" } } : {}),
      },
      { returnDocument: "after" }
    );
    const attendance = result?.value || result;
    if (!attendance) {
      await compensateUploadedPhoto(db, checkOutPhotoKey, "duplicate_checkout");
      return res.status(409).json({
        detail: "This instructor has already checked out today",
        attendance_id: String(candidate._id),
      });
    }

    if (checkoutCoordinates) {
      void attachAddressToAttendance(db, attendance._id, checkoutCoordinates, "checkout");
    }

    const checkoutAnalysisFailed = Boolean(req.file && !checkOutPhotoKey);

    if (checkOutPhotoKey) {
      try {
        await enqueueEvaluation(db, {
          attendanceId: attendance._id,
          kind: "checkout",
          instructor: {
            id: String(candidate.instructor_id),
            name: attendance.instructor_name || instructor?.name || "Instructor",
            email: recipient || instructor?.email || null,
            gender: instructor?.gender || null,
            collegeId: candidate.college_id ? String(candidate.college_id) : null,
          },
          photoKey: checkOutPhotoKey,
          mimeType: checkOutPhoto?.mimeType || "image/jpeg",
          checkInTime: attendance.check_in_time,
          checkOutTime,
        });
      } catch (error) {
        console.error(`Checkout evaluation not queued for ${attendance._id} (${error?.name || "ERROR"})`);
      }
    }

    if (recipient && !req.file) {
      try {
        await enqueueNotification(db, {
          attendanceId: attendance._id,
          type: "checkout",
          toEmail: checkoutPayload.to_email,
          report: checkoutPayload.report,
          deadlineAt: checkoutPayload.deadline_at,
        });
      } catch (error) {
        console.error(`Checkout outbox ${attendance._id} remains pending (${error.name || "ERROR"})`);
      }
    }

    return res.status(202).json({
      message: checkoutAnalysisFailed
        ? "Check-out successful, but its photo could not be stored, so no appearance report will be produced."
        : recipient
          ? "Check-out successful. The appearance report and its email are queued."
          : "Check-out successful, but no email was sent because the instructor email is missing or invalid.",
      attendance_id: String(attendance._id),
      analysis_queued: Boolean(checkOutPhotoKey),
      analysis_completed: false,
      analysis_failed: checkoutAnalysisFailed,
      photo_status: req.file ? (checkOutPhotoKey ? "stored" : "failed") : "not_provided",
      photo_warning: req.file && !checkOutPhotoKey
        ? "The check-out was saved, but its photo could not be stored."
        : null,
    });
  })
);

attendanceRouter.get(
  "/today",
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    let dateFilter;
    let updatedSince = null;
    let pagination;
    try {
      const zone = runtimeConfig().appTimeZone;
      const ranged = req.query.from !== undefined || req.query.to !== undefined;
      if (ranged) {
        const blankToUndefined = (value) => (value === "" ? undefined : value);
        const { start, end } = dateRangeBoundsInTimeZone(
          blankToUndefined(req.query.from),
          blankToUndefined(req.query.to),
          zone
        );
        dateFilter = {};
        if (start) dateFilter.$gte = start;
        if (end) dateFilter.$lt = end;
      } else {
        const { start, end } = dateBoundsInTimeZone(req.query.date, zone);
        dateFilter = { $gte: start, $lt: end };
      }
      pagination = parsePagination(req.query, {
        defaultLimit: 200,
        maxLimit: 1000,
      });
      if (req.query.instructor_id !== undefined
        && (typeof req.query.instructor_id !== "string" || !req.query.instructor_id.trim() || req.query.instructor_id.length > 100)) {
        throw new RangeError("instructor_id must be a single instructor id");
      }
      if (req.query.updated_since !== undefined) {
        if (typeof req.query.updated_since !== "string" || req.query.updated_since.length > 40) {
          throw new RangeError("updated_since must be an ISO timestamp");
        }
        updatedSince = new Date(req.query.updated_since);
        if (Number.isNaN(updatedSince.getTime()) || updatedSince > new Date(Date.now() + 60_000)) {
          throw new RangeError("updated_since must be a valid past ISO timestamp");
        }
      }
    } catch (error) {
      if (error instanceof RangeError) {
        return res.status(422).json({ detail: error.message });
      }
      throw error;
    }
    const attendances = await coreCollection(db, "attendance")
      .find({
        ...(Object.keys(dateFilter).length ? { date: dateFilter } : {}),
        ...(updatedSince ? { updated_at: { $gt: updatedSince } } : {}),
        ...(req.query.instructor_id ? { instructor_id: idMatch(req.query.instructor_id.trim()) } : {}),
        ...attendanceScope(req.currentUser),
        status: { $ne: "unidentified" },
      })
      .project({
        _private_evaluation_outbox: 0,
        _private_checkin_outbox: 0,
        _private_checkout_outbox: 0,
      })
      .sort({ check_in_time: -1, _id: -1 })
      .skip(pagination.offset)
      .limit(pagination.limit)
      .toArray();

    const instructorIds = [...new Set(attendances.map((row) => String(row.instructor_id)))];
    const legacyInstructors = instructorIds.length
      ? await coreCollection(db, "instructors").find(
          { _id: { $in: lookupIdVariants(instructorIds) } },
          { projection: { name: 1, role: 1, instructor_role: 1, college_id: 1, report_token: 1 } }
        ).toArray()
      : [];
    const instructorMap = new Map(legacyInstructors.map((row) => [String(row._id), row]));
    const collegeIds = [...new Set(attendances
      .map((attendance) => (
        attendance.college_id
        || instructorMap.get(String(attendance.instructor_id))?.college_id
      ))
      .filter(Boolean)
      .map(String))];
    const colleges = collegeIds.length
      ? await coreCollection(db, "colleges").find({
          _id: { $in: lookupIdVariants(collegeIds) },
        }).toArray()
      : [];
    const collegeMap = new Map(colleges.map((row) => [String(row._id), row.name]));
    const escalations = await weeklyEscalations(db, attendances, attendanceScope(req.currentUser));
    return res.json(attendances.map((attendance) => {
      const instructor = instructorMap.get(String(attendance.instructor_id));
      const collegeId = attendance.college_id || instructor?.college_id || null;
      return {
        ...serializeAttendance(attendance),
        escalation: escalationFor(escalations, attendance),
        instructor_name: attendance.instructor_name || instructor?.name || "Unknown",
        instructor_role: attendance.instructor_role
          || instructor?.instructor_role
          || instructor?.role
          || "Unknown",
        college_name: collegeId
          ? (collegeMap.get(String(collegeId)) || "Unknown College")
          : "No College",
        report_token: instructor?.report_token || null,
      };
    }));
  })
);

attendanceRouter.get(
  "/:attendanceId",
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    const attendance = await coreCollection(db, "attendance").findOne({
      _id: idMatch(req.params.attendanceId),
      ...attendanceScope(req.currentUser),
      status: { $ne: "unidentified" },
    });
    if (!attendance) return res.status(404).json({ detail: "Attendance record not found" });

    const instructor = await coreCollection(db, "instructors").findOne(
      { _id: idMatch(String(attendance.instructor_id)) },
      { projection: { name: 1, role: 1, instructor_role: 1, report_token: 1 } }
    );
    return res.json({
      ...serializeAttendance(attendance),
      instructor_name: attendance.instructor_name || instructor?.name || "Unknown",
      instructor_role: attendance.instructor_role
        || instructor?.instructor_role
        || instructor?.role
        || "Unknown",
      report_token: instructor?.report_token || null,
    });
  })
);

attendanceRouter.post(
  "/:attendanceId/checkout-photo",
  upload.single("file"),
  asyncRoute(async (req, res) => {
    const validation = validateImageUpload(req.file);
    if (!validation.valid) return res.status(400).json({ detail: validation.detail });

    const db = req.app.locals.db;
    const scope = attendanceScope(req.currentUser);
    const attendance = await coreCollection(db, "attendance").findOne({
      _id: idMatch(req.params.attendanceId),
      check_out_time: { $ne: null },
      deleting_at: { $exists: false },
      checkout_deleting_at: { $exists: false },
      ...scope,
    });
    if (!attendance) return res.status(404).json({ detail: "Checkout record not found" });
    if (attendance.check_out_photo_key) {
      return res.status(409).json({ detail: "This checkout already has a stored photo" });
    }

    let normalized;
    try {
      normalized = await normalizeInstructorImage(req.file.buffer);
    } catch {
      return res.status(400).json({
        detail: "Image could not be decoded; upload a clear JPEG, PNG, or WebP",
      });
    }

    const now = new Date();
    const photoKey = buildPhotoKey({
      instructorId: String(attendance.instructor_id),
      kind: "checkout",
      mimeType: normalized.mimeType,
      now,
    });
    const stored = await uploadPhoto({
      key: photoKey,
      body: normalized.buffer,
      mimeType: normalized.mimeType,
      metadata: {
        instructor_id: String(attendance.instructor_id),
        kind: "checkout",
        captured_at: now.toISOString(),
        coordinates: attendance.check_out_coordinates || "",
        accuracy_m: attendance.check_out_location_accuracy_m ?? "",
      },
    });
    if (!stored.stored) {
      return res.status(503).json({
        detail: "Photo storage is unavailable right now. Please retry without recording checkout again.",
      });
    }

    const claimed = await coreCollection(db, "attendance").updateOne(
      {
        _id: attendance._id,
        deleting_at: { $exists: false },
        checkout_deleting_at: { $exists: false },
        $or: [
          { check_out_photo_key: null },
          { check_out_photo_key: { $exists: false } },
        ],
      },
      {
        $set: {
          check_out_photo_key: photoKey,
          check_out_photo_captured_at: now,
          checkout_evaluation_queue_status: "processing",
          checkout_email_status: "waiting_for_analysis",
          updated_at: now,
        },
        $unset: { checkout_analysis_error_code: "", _private_checkout_outbox: "" },
      }
    );
    if (!claimed.matchedCount) {
      await compensateUploadedPhoto(db, photoKey, "concurrent_checkout_photo_retry");
      return res.status(409).json({ detail: "A checkout photo was already attached" });
    }

    const instructor = await coreCollection(db, "instructors").findOne({
      _id: idMatch(String(attendance.instructor_id)),
    });
    const recipient = isValidEmail(instructor?.email) ? instructor.email : null;
    try {
      const evaluation = await evaluateCheckoutNow(db, {
        attendanceId: attendance._id,
        instructor: {
          id: String(attendance.instructor_id),
          name: attendance.instructor_name || instructor?.name || "Instructor",
          email: recipient || instructor?.email || null,
          gender: instructor?.gender || null,
          collegeId: String(attendance.college_id || instructor?.college_id || ""),
        },
        photoKey,
        imageBuffer: normalized.buffer,
        mimeType: normalized.mimeType,
        checkOutTime: attendance.check_out_time,
        checkInTime: attendance.check_in_time,
      });

      if (recipient) {
        const report = {
          instructorName: attendance.instructor_name || instructor?.name || "Instructor",
          checkInTime: attendance.check_in_time,
          checkOutTime: attendance.check_out_time,
          status: evaluation.overall_status,
          remarks: evaluation.ai_summary || "",
          imageQuality: evaluation.image_quality || null,
        };
        await coreCollection(db, "attendance").updateOne(
          { _id: attendance._id, deleting_at: { $exists: false } },
          { $set: { checkout_email_status: "outbox_pending", updated_at: new Date() } }
        );
        await enqueueNotification(db, {
          attendanceId: attendance._id,
          type: "checkout",
          toEmail: recipient,
          report,
          deadlineAt: new Date(Date.now() + OUTBOX_DEADLINE_MS),
        });
      }

      return res.json({
        message: "Checkout photo stored and analysis completed.",
        attendance_id: String(attendance._id),
        analysis_queued: false,
        analysis_completed: true,
        photo_status: "stored",
      });
    } catch (error) {
      const code = String(error?.code || error?.name || "EVALUATION_ERROR").toUpperCase();
      await coreCollection(db, "attendance").updateOne(
        { _id: attendance._id },
        {
          $set: {
            checkout_evaluation_queue_status: "failed",
            checkout_analysis_error_code: code,
            checkout_email_status: recipient ? "not_sent_analysis_failed" : "skipped_no_email",
            updated_at: new Date(),
          },
        }
      );
      throw error;
    }
  })
);

attendanceRouter.get(
  "/:attendanceId/evaluation",
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    const attendance = await coreCollection(db, "attendance").findOne({
      _id: idMatch(req.params.attendanceId),
      ...attendanceScope(req.currentUser),
    });
    if (!attendance) return res.status(404).json({ detail: "Attendance record not found" });

    const kind = req.query.kind === "checkout" ? "checkout" : "checkin";
    const evaluation = await getEvaluation(db, String(attendance._id), kind);
    if (!evaluation) {
      return res.status(204).end();
    }
    return res.json(serializeDocument(evaluation));
  })
);

attendanceRouter.get(
  "/:attendanceId/status",
  asyncRoute(async (req, res) => {
    const attendance = await coreCollection(req.app.locals.db, "attendance").findOne(
      { _id: idMatch(req.params.attendanceId), ...attendanceScope(req.currentUser) },
      {
        projection: {
          status: 1,
          compliance_status: 1,
          remarks: 1,
          evaluation_queue_status: 1,
          check_out_photo_key: 1,
          checkout_compliance_status: 1,
          checkout_remarks: 1,
          checkout_evaluation_queue_status: 1,
          updated_at: 1,
        },
      }
    );
    if (!attendance) return res.status(404).json({ detail: "Attendance record not found" });

    if (req.query.kind === "checkout") {
      const queueStatus = attendance.checkout_evaluation_queue_status || null;
      return res.json({
        attendance_id: String(attendance._id),
        status: attendance.checkout_compliance_status
          ? String(attendance.checkout_compliance_status).toLowerCase()
          : "pending",
        compliance_status: attendance.checkout_compliance_status || null,
        remarks: attendance.checkout_remarks || null,
        queue_status: queueStatus,
        settled: queueStatus === "completed"
          || queueStatus === "failed"
          || !attendance.check_out_photo_key,
        updated_at: attendance.updated_at || null,
      });
    }

    return res.json({
      attendance_id: String(attendance._id),
      status: attendance.status || "pending",
      compliance_status: attendance.compliance_status || null,
      remarks: attendance.remarks || null,
      queue_status: attendance.evaluation_queue_status || null,
      settled: attendance.status !== "pending",
      updated_at: attendance.updated_at || null,
    });
  })
);

attendanceRouter.post(
  "/:attendanceId/reanalyse",
  requireSuperAdmin,
  reanalyseLimiter,
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    const { reanalyse_enabled: reanalyseEnabled } = await getNotificationSettings(db);
    if (!reanalyseEnabled) {
      return res.status(403).json({
        detail: "Re-analysis is turned off for this workspace. An administrator can enable it in Settings.",
      });
    }
    const attendance = await coreCollection(db, "attendance").findOne({
      _id: idMatch(req.params.attendanceId),
      ...attendanceScope(req.currentUser),
    });
    if (!attendance) return res.status(404).json({ detail: "Attendance record not found" });

    const kind = req.query.kind === "checkout" ? "checkout" : "checkin";
    const photoKey = kind === "checkout"
      ? attendance.check_out_photo_key
      : attendance.check_in_photo_key;
    if (!photoKey) {
      return res.status(422).json({
        detail: `This ${kind === "checkout" ? "check-out" : "check-in"} has no stored photo, so it cannot be analysed again.`,
      });
    }

    const instructor = await coreCollection(db, "instructors").findOne({
      _id: idMatch(String(attendance.instructor_id)),
    });

    const now = new Date();
    await jobCollection(db, "evaluation_jobs").deleteOne({
      _id: kind === "checkout"
        ? `${attendance._id}:evaluation:checkout`
        : `${attendance._id}:evaluation`,
    });
    await deleteEvaluation(db, String(attendance._id), kind);
    await coreCollection(db, "attendance").updateOne(
      { _id: attendance._id },
      {
        $set: kind === "checkout"
          ? {
            checkout_compliance_status: null,
            checkout_remarks: "AI analysis is in progress.",
            checkout_evaluation_queue_status: "processing",
            updated_at: now,
          }
          : {
            status: "pending",
            compliance_status: null,
            remarks: "AI analysis is in progress.",
            evaluation_queue_status: "queued",
            updated_at: now,
          },
      }
    );

    if (kind === "checkout") {
      try {
        await evaluateCheckoutNow(db, {
          attendanceId: attendance._id,
          instructor: {
            id: String(attendance.instructor_id),
            name: attendance.instructor_name || instructor?.name || "Instructor",
            email: instructor?.email || null,
            gender: instructor?.gender || null,
            collegeId: String(attendance.college_id || instructor?.college_id || ""),
          },
          photoKey,
          mimeType: "image/jpeg",
          checkOutTime: attendance.check_out_time,
          checkInTime: attendance.check_in_time,
        });
        return res.json({
          message: "Re-analysis completed.",
          attendance_id: String(attendance._id),
        });
      } catch (error) {
        const code = String(error?.code || error?.name || "EVALUATION_ERROR").toUpperCase();
        await coreCollection(db, "attendance").updateOne(
          { _id: attendance._id },
          {
            $set: {
              checkout_evaluation_queue_status: "failed",
              checkout_analysis_error_code: code,
              updated_at: new Date(),
            },
          }
        );
        throw error;
      }
    }

    await enqueueEvaluation(db, {
      attendanceId: attendance._id,
      kind: "checkin",
      instructor: {
        id: String(attendance.instructor_id),
        name: attendance.instructor_name || instructor?.name || "Instructor",
        email: instructor?.email || null,
        gender: instructor?.gender || null,
        collegeId: String(attendance.college_id || instructor?.college_id || ""),
      },
      photoKey,
      mimeType: "image/jpeg",
      checkInTime: attendance.check_in_time,
      deadlineAt: new Date(now.getTime() + OUTBOX_DEADLINE_MS),
    });

    return res.status(202).json({
      message: "Re-analysis queued.",
      attendance_id: String(attendance._id),
    });
  })
);

attendanceRouter.get(
  "/:attendanceId/photo/:kind",
  asyncRoute(async (req, res) => {
    const kind = req.params.kind === "checkout" ? "checkout" : "checkin";
    const attendance = await coreCollection(req.app.locals.db, "attendance").findOne(
      { _id: idMatch(req.params.attendanceId), ...attendanceScope(req.currentUser) },
      { projection: { check_in_photo_key: 1, check_out_photo_key: 1 } }
    );
    if (!attendance) return res.status(404).json({ detail: "Attendance record not found" });

    const key = kind === "checkout"
      ? attendance.check_out_photo_key
      : attendance.check_in_photo_key;
    if (!key) return res.status(404).json({ detail: "No photo was stored for this record" });

    const url = await getPhotoUrl(key, { expiresIn: 900 });
    if (!url) return res.status(503).json({ detail: "Photo storage is unavailable right now" });

    return res.json({ url, expires_in: 900 });
  })
);

attendanceRouter.post(
  "/bulk-delete",
  requireSuperAdmin,
  asyncRoute(async (req, res) => {
    if (!Array.isArray(req.body?.attendance_ids)) {
      return res.status(422).json({ detail: "attendance_ids must be an array" });
    }
    const attendanceIds = [...new Set(req.body.attendance_ids.map((value) => String(value).trim()))];
    if (!attendanceIds.length || attendanceIds.length > 100) {
      return res.status(422).json({
        detail: "Select between 1 and 100 attendance records to delete",
      });
    }
    if (attendanceIds.some((value) => !value || value.length > 100)) {
      return res.status(422).json({ detail: "Every attendance id must be valid" });
    }

    const db = req.app.locals.db;
    const records = await coreCollection(db, "attendance").find({
      $or: attendanceIds.map((attendanceId) => ({ _id: idMatch(attendanceId) })),
    }).toArray();
    const recordsById = new Map(records.map((record) => [String(record._id), record]));
    const deletedIds = [];
    const failed = [];

    for (const attendanceId of attendanceIds) {
      const attendance = recordsById.get(attendanceId);
      if (!attendance) {
        failed.push({ attendance_id: attendanceId, detail: "Attendance record not found" });
        continue;
      }
      try {
        await purgeAttendance(db, attendance);
        deletedIds.push(attendanceId);
      } catch (error) {
        failed.push({
          attendance_id: attendanceId,
          detail: error.code === "PHOTO_DELETE_FAILED"
            ? "The photo could not be removed. Retry deletion."
            : "The record could not be deleted. Retry deletion.",
        });
      }
    }

    return res.status(failed.length ? 207 : 200).json({
      message: failed.length
        ? `${deletedIds.length} record(s) deleted; ${failed.length} could not be deleted`
        : `${deletedIds.length} attendance record(s) deleted`,
      deleted_ids: deletedIds,
      failed,
    });
  })
);

attendanceRouter.delete(
  "/:attendanceId",
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    const settings = await getAccessSettings(db);
    if (!canDeleteAttendance(req.currentUser, settings)) {
      return res.status(403).json({
        detail: "You do not have permission to delete attendance records",
      });
    }

    const attendance = await coreCollection(db, "attendance").findOne({
      _id: idMatch(req.params.attendanceId),
      ...attendanceScope(req.currentUser),
    });
    if (!attendance) return res.status(404).json({ detail: "Attendance record not found" });

    try {
      await purgeAttendance(db, attendance);
    } catch (error) {
      if (error.code === "PHOTO_DELETE_FAILED") {
        return res.status(503).json({ detail: "The photo could not be removed. Please retry deletion." });
      }
      throw error;
    }
    return res.json({ message: "Attendance record deleted" });
  })
);

attendanceRouter.delete(
  "/:attendanceId/check-out",
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    const settings = await getAccessSettings(db);
    if (!canDeleteCheckout(req.currentUser, settings)) {
      return res.status(403).json({
        detail: "You do not have permission to delete check-outs",
      });
    }

    const attendance = await coreCollection(db, "attendance").findOne({
      _id: idMatch(req.params.attendanceId),
      ...attendanceScope(req.currentUser),
    });
    if (!attendance) return res.status(404).json({ detail: "Attendance record not found" });
    if (!attendance.check_out_time) {
      return res.status(409).json({ detail: "This record has no check-out to delete" });
    }

    await coreCollection(db, "attendance").updateOne(
      { _id: attendance._id, checkout_deleting_at: { $exists: false } },
      {
        $set: { checkout_deleting_at: new Date(), updated_at: new Date() },
        $unset: { _private_checkout_outbox: "" },
      }
    );
    await Promise.all([
      jobCollection(db, "evaluation_jobs").deleteMany({
        attendance_id: attendance._id,
        $or: [
          { kind: "checkout" },
          { _id: `${attendance._id}:evaluation:checkout` },
        ],
      }),
      jobCollection(db, "notification_jobs").deleteMany({
        attendance_id: attendance._id,
        type: "checkout",
      }),
      jobCollection(db, "mail_jobs").deleteMany({
        attendance_id: attendance._id,
        type: "attendance_reminder",
      }),
    ]);
    if (attendance.check_out_photo_key) {
      const removed = await deletePhoto(attendance.check_out_photo_key);
      if (!removed.deleted) {
        return res.status(503).json({ detail: "The check-out photo could not be removed. Please retry deletion." });
      }
    }
    await jobCollection(db, "evaluation_jobs").deleteOne({
      _id: `${attendance._id}:evaluation:checkout`,
    });
    await deleteEvaluation(db, String(attendance._id), "checkout");
    await coreCollection(db, "attendance").updateOne(
      { _id: attendance._id },
      {
        $set: { check_out_time: null, updated_at: new Date() },
        $unset: {
          check_out_photo_key: "",
          check_out_coordinates: "",
          check_out_location_accuracy_m: "",
          checkout_deleting_at: "",
          checkout_compliance_status: "",
          checkout_remarks: "",
          checkout_image_quality: "",
          checkout_analysis_completed_at: "",
          checkout_evaluation_queue_status: "",
          checkout_email_status: "",
          checkout_reminder_sent_at: "",
        },
      }
    );
    return res.json({ message: "Check-out deleted" });
  })
);
