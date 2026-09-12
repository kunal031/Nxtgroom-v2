import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import multer from "multer";
import { withMongoTransaction } from "../config/db.js";
import { runtimeConfig } from "../config/env.js";
import { idMatch, instructorScope, isElevated, requireSuperAdmin, ROLES } from "../middleware/auth.js";
import { validateImageUpload } from "../imageValidation.js";
import { normalizeInstructorImage } from "../imageProcessor.js";
import { enqueueEvaluation, evaluateCheckoutNow, evaluationFilter } from "../services/evaluationWorker.js";
import { getNotificationSettings } from "../services/notificationSettings.js";
import {
  getIdentificationSettings,
  usesFaceIdentification,
} from "../services/identificationSettings.js";
import {
  deleteFaces,
  facesToEvict,
  indexFace,
  isFaceRecognitionConfigured,
  searchFaceByImage,
} from "../services/faceRecognition.js";
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
  canIdentifyAttendance,
  getAccessSettings,
} from "../services/accessSettings.js";
import {
  assessIdentification,
  explainFailure,
  findRetryCandidates,
  identifiedRecordUpdate,
  IDENTIFY_OUTCOMES,
} from "../services/identifyQueue.js";
import {
  CHECKOUT_TIMING,
  checkoutTiming,
  describeCheckoutTiming,
} from "../services/checkoutTiming.js";
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

// Check-out runs the vision call inside the request, so it is at least as
// expensive as check-in and needs the same protection.
const checkOutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => String(req.currentUser?.email || "unauthenticated"),
  message: { detail: "Too many check-out attempts. Please try again later." },
});

// Re-analysis spends a vision call on an image that already has a report, so
// it is the cheapest way to run up a bill by accident. Deliberately tighter.
const reanalyseLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => String(req.currentUser?.email || "unauthenticated"),
  message: { detail: "Too many re-analysis requests. Please try again later." },
});

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
  // Both elevated roles see every college. Testing for SUPER_ADMIN alone left
  // an ADMIN scoped to currentUser.collegeId, which administrators do not
  // have, so the filter matched nothing and Daily Records looked empty.
  return isElevated(currentUser?.role)
    ? {}
    : { college_id: idMatch(String(currentUser.collegeId)) };
}

/**
 * Removes a check-in entirely: the record, its evaluation, its queued job and
 * its photographs.
 *
 * Photographs are normally kept indefinitely and never expired on a schedule.
 * This is the one path that removes them, because it is someone deliberately
 * erasing the check-in they belong to — leaving the images behind would retain
 * a person's photograph with no record explaining why it was held.
 *
 * The record goes last. If a photo delete fails the record is still there to
 * try again, whereas the reverse would leave images nothing points at.
 */
async function purgeAttendance(db, attendance) {
  const marked = await db.collection("attendance").updateOne(
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
    const current = await db.collection("attendance").findOne({ _id: attendance._id });
    if (!current) return;
  }
  // Cancel both halves before touching storage. Workers also re-check the
  // tombstone immediately before external work, covering already-claimed jobs.
  await Promise.all([
    db.collection("evaluation_jobs").deleteMany({ attendance_id: attendance._id }),
    db.collection("notification_jobs").deleteMany({ attendance_id: attendance._id }),
    db.collection("mail_jobs").deleteMany({ attendance_id: attendance._id }),
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
  await db.collection("evaluations").deleteMany({ attendance_id: String(attendance._id) });
  await db.collection("attendance").deleteOne({ _id: attendance._id, deleting_at: { $exists: true } });
}

async function compensateUploadedPhoto(db, key, reason) {
  if (!key) return;
  const result = await deletePhoto(key);
  if (result.deleted) return;
  // A transient R2 outage must not turn the original conflict into a 500.
  // Persist a durable cleanup request so storage reconciliation can retry it.
  await db.collection("storage_cleanup_jobs").updateOne(
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

/**
 * Matches an instructor's attendance record for the current local day.
 *
 * The guard used to match any open check-in ever. A check-out that was never
 * done left the record open forever, so one missed check-out on Monday blocked
 * that instructor from checking in for the rest of time. A day here is a local
 * calendar day — midnight to midnight where the instructor is — so yesterday's
 * unclosed record is a missed check-out to chase, not a reason to refuse today.
 * Completed records still match because the product allows one check-in and
 * one checkout per instructor per day, rather than multiple daily sessions.
 */
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

/**
 * Pure decision used before any check-out photo is processed or stored.
 *
 * `too_early` is checked last, after the states that describe the record rather
 * than the clock: somebody who never checked in, or already checked out, should
 * be told that regardless of the time of day.
 *
 * `now` is defaulted so existing callers that ask only about the record keep
 * working, and so the timing boundaries stay testable.
 */
export function checkoutAvailability(attendance, now = new Date()) {
  if (!attendance) return "not_checked_in_today";
  if (attendance.check_out_time) return "already_checked_out_today";
  if (checkoutTiming(attendance.check_in_time, { now }).state === CHECKOUT_TIMING.TOO_EARLY) {
    return "too_early";
  }
  return "available";
}

/**
 * The id of the instructor's attendance record for today, or null.
 *
 * Used only on the refusal path, where a duplicate check-in has already been
 * rejected and the caller needs somewhere to look. A failed lookup must not
 * turn a clear 409 into a 500, so it degrades to null.
 */
async function attendanceIdForToday(db, instructorId) {
  try {
    const record = await db.collection("attendance").findOne(
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

/**
 * Revalidates and commits check-in after image processing. Updating the same
 * instructor document that profile mutations update gives MongoDB transactions
 * a shared write-conflict boundary: either the profile change wins and this
 * transaction retries with the new profile, or check-in wins and the profile
 * mutation retries and observes the open attendance.
 */
/**
 * Records a check-in whose face was not recognised.
 *
 * There is no instructor to look up, so none of the usual guards apply: no
 * gender to choose a dress code with, no email to send a report to, and no
 * identity to test today's duplicate rule against. The record is still created,
 * because the photograph and the time and place it was taken are the evidence
 * somebody showed up, and discarding that to keep the data tidy would lose the
 * attendance itself.
 *
 * The college comes from the account the tablet is signed in as. An unidentified
 * record has no instructor to inherit one from, and without it a BOA cannot see
 * the queue containing the photograph they just took — attendanceScope filters
 * them to their own college.
 *
 * Deliberately not transactional: there is no instructor document to guard
 * against a concurrent edit, and no duplicate-day rule to enforce, so the single
 * insert is the whole operation.
 */
export async function commitUnidentifiedCheckIn(
  db,
  {
    currentUser,
    coordinates,
    normalizedImage,
    photoKey = null,
    locationAccuracyM = null,
    capturedAt = null,
    recognition = null,
    now = new Date(),
  }
) {
  const attendance = createDocument({
    // Null rather than absent: the partial index that enforces one record per
    // instructor per day requires a string instructor_id, so these records sit
    // outside it and several can exist for one day.
    instructor_id: null,
    instructor_name: null,
    instructor_role: null,
    college_id: currentUser.collegeId ? String(currentUser.collegeId) : null,
    boa_id: currentUser.referenceId ? String(currentUser.referenceId) : "super-admin",
    attendance_day: localDateKey(now, runtimeConfig().appTimeZone),
    date: now,
    check_in_time: now,
    check_out_time: null,
    location_coordinates: coordinates,
    location_accuracy_m: locationAccuracyM,
    check_in_photo_key: photoKey,
    check_in_photo_captured_at: capturedAt || now,
    check_out_photo_key: null,
    // Its own status, so it is never counted as compliant, non-compliant or
    // merely pending analysis. Nothing was assessed and nothing is queued.
    status: "unidentified",
    compliance_status: null,
    remarks: "The instructor could not be identified from this photo. An administrator needs to attach the right instructor.",
    // No job is queued, so no queue status is claimed. Analysis runs once an
    // administrator attaches an instructor and chooses to analyse.
    evaluation_queue_status: null,
    checkin_email_status: "not_requested",
    checkout_email_status: "not_requested",
    identification: {
      method: "FACE",
      outcome: recognition?.reason || "NO_MATCH",
      // The best score seen, even when it was below the accept threshold: it is
      // the difference between "nobody resembled this face" and "somebody nearly
      // did", which is what an administrator resolving the queue wants to know.
      best_similarity: recognition?.bestSimilarity ?? null,
      candidate_instructor_id: recognition?.candidateInstructorId || null,
      attempted_at: now,
    },
    mime_type: normalizedImage.mimeType,
    created_at: now,
    updated_at: now,
  });
  await db.collection("attendance").insertOne(attendance);
  return { outcome: "created_unidentified", attendance };
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
    now = new Date(),
  },
  runTransaction = withMongoTransaction
) {
  return runTransaction(async (session) => {
    const instructor = await db.collection("instructors").findOne(
      activeInstructorFilter(currentUser, instructorId),
      { session }
    );
    if (!instructor) return { outcome: "instructor_not_found" };
    if (!isValidEmail(instructor.email)) return { outcome: "invalid_email" };

    const attendanceToday = await db.collection("attendance").findOne(
      attendanceOnLocalDay(instructor._id, now),
      { session }
    );
    if (attendanceToday) return { outcome: "already_checked_in_today" };

    const guard = await db.collection("instructors").updateOne(
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
      // Only the R2 key travels through the queue. The worker downloads the
      // image when it runs, so no image bytes are ever written to MongoDB.
      photo_key: photoKey,
      mime_type: normalizedImage.mimeType,
      check_in_time: now,
      deadline_at: evaluationDeadline,
      created_at: now,
    };
    const attendance = createDocument({
      instructor_id: String(instructor._id),
      instructor_name: instructor.name,
      // instructor_role first: an instructor imported from BigQuery carries
      // their real role there and has no `role` at all, so snapshotting
      // `role` alone recorded null for 599 of 600 people and lost the
      // distinction between an INSTRUCTOR and a CENTRAL_INSTRUCTOR.
      instructor_role: instructor.instructor_role || instructor.role || null,
      // Null stays null. String() turned an unlinked instructor's absent
      // college into the literal text "null", which then sat in the record as
      // if it were a real college id and matched nothing anywhere.
      college_id: instructor.college_id ? String(instructor.college_id) : null,
      boa_id: currentUser.referenceId ? String(currentUser.referenceId) : "super-admin",
      attendance_day: localDateKey(now, runtimeConfig().appTimeZone),
      date: now,
      check_in_time: now,
      check_out_time: null,
      location_coordinates: coordinates,
      // Accuracy is kept next to the coordinates so a reading from a coarse
      // IP lookup is distinguishable from a real GPS fix.
      location_accuracy_m: locationAccuracyM,
      check_in_photo_key: photoKey,
      check_in_photo_captured_at: capturedAt || now,
      check_out_photo_key: null,
      status: "pending",
      compliance_status: null,
      remarks: "AI analysis is in progress.",
      evaluation_queue_status: "outbox_pending",
      checkin_email_status: "waiting_for_analysis",
      checkout_email_status: "not_requested",
      // How this record came to name the instructor it names. A face match and
      // a BOA's dropdown choice are different kinds of evidence, and once the
      // selector is retired this is the only way to tell a recognised record
      // from one identified by hand, or to find the matches that were close.
      ...(identification ? { identification } : {}),
      _private_evaluation_outbox: evaluationPayload,
      created_at: now,
      updated_at: now,
    });
    await db.collection("attendance").insertOne(attendance, { session });
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

/**
 * One photograph, and the system decides what it means.
 *
 * The attendance screen has no buttons: somebody stands in front of the tablet,
 * the camera photographs them, and this works out whether it is their arrival or
 * their departure. Registered before every "/:attendanceId/..." route, because
 * a literal path declared after one of those is read as an attendance id.
 *
 * Nothing here invents a rule. The identity comes from the same face search
 * check-in uses, the arrival is committed by the same guarded transaction, and
 * the departure applies the same timing rules — this route only chooses between
 * them, which is the part a person used to do by pressing a button.
 */
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
        action: KIOSK_ACTIONS.UNIDENTIFIED,
      });
    }

    const coordinates = parseCoordinates(req.body.location_coordinates);
    if (req.body.location_coordinates && !coordinates) {
      return res.status(422).json({ detail: "location_coordinates must be valid latitude,longitude" });
    }
    const accuracyMetres = Number.parseInt(req.body.location_accuracy_m, 10) || null;

    // Normalized once. The same buffer is recognised, stored and analysed, so a
    // refused or mistaken match can be reproduced from the photograph the record
    // keeps rather than from a second encoding of it.
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
      ? await db.collection("instructors").findOne(
          activeInstructorFilter(req.currentUser, String(match.instructorId))
        )
      : null;

    // A face that matched somebody this tablet cannot see is treated as no
    // match: the college scope is what stops one campus recording another's
    // attendance, and it must not be bypassed by a recognition result.
    const today = instructor
      ? await db.collection("attendance").findOne(attendanceOnLocalDay(instructor._id, now))
      : null;
    const action = decideKioskAction({
      matched: Boolean(instructor),
      availability: checkoutAvailability(today, now),
    });

    /** Nothing is recorded, so nothing is stored: the photo is simply dropped. */
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

    const stored = await storeAttendancePhoto({
      instructorId: instructor?._id || "unidentified",
      kind: action === KIOSK_ACTIONS.CHECK_OUT ? "checkout" : "checkin",
      normalizedImage,
      coordinates,
      accuracyMetres: req.body.location_accuracy_m || "",
      now,
    });
    if (!stored.stored) {
      return res.status(503).json({
        detail: "Photo storage is unavailable right now. Please try again in a moment.",
      });
    }

    /**
     * Nobody matched, so this is recorded as an arrival for an administrator to
     * name. A departure cannot be: it closes one specific open session, and
     * there is no way to tell which.
     */
    if (action === KIOSK_ACTIONS.UNIDENTIFIED) {
      const unidentified = await commitUnidentifiedCheckIn(db, {
        currentUser: req.currentUser,
        coordinates,
        normalizedImage,
        photoKey: stored.key,
        locationAccuracyM: accuracyMetres,
        capturedAt: now,
        recognition: { reason: match.reason, bestSimilarity: null, candidateInstructorId: null },
        now,
      });
      if (coordinates) void attachAddressToAttendance(db, unidentified.attendance._id, coordinates);
      incrementMetric("kiosk_unidentified_total");
      return res.status(202).json({
        action,
        recorded: true,
        instructor_name: null,
        attendance_id: String(unidentified.attendance._id),
        ...describeKioskAction(action, {}),
      });
    }

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
          now,
        });
      } catch (error) {
        await compensateUploadedPhoto(db, stored.key, "kiosk_checkin_commit_failed");
        if (error.code === 11000) {
          return res.status(409).json({
            detail: "This instructor has already checked in today",
            attendance_id: await attendanceIdForToday(db, instructor._id),
          });
        }
        throw error;
      }
      if (committed.outcome !== "created") {
        // invalid_email and the duplicate guard both land here. The photo has an
        // owner only when a record was written, so it is discarded otherwise.
        await compensateUploadedPhoto(db, stored.key, `kiosk_${committed.outcome}`);
        return res.status(committed.outcome === "invalid_email" ? 422 : 409).json({
          detail: committed.outcome === "invalid_email"
            ? "This instructor needs a valid email address before check-in reports can be sent."
            : "This instructor has already checked in today",
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
        console.error(`Kiosk evaluation outbox ${attendance._id} remains pending (${error.name || "ERROR"})`);
      }
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

    // CHECK_OUT. Guarded on check_out_time so two photographs taken moments
    // apart cannot both close the same session.
    const recipient = isValidEmail(instructor.email) ? instructor.email : null;
    const result = await db.collection("attendance").findOneAndUpdate(
      { _id: today._id, check_out_time: null, ...attendanceScope(req.currentUser) },
      {
        $set: {
          check_out_time: now,
          check_out_photo_key: stored.key,
          check_out_photo_captured_at: now,
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
      await compensateUploadedPhoto(db, stored.key, "kiosk_duplicate_checkout");
      return res.status(409).json({
        detail: "This instructor has already checked out today",
        attendance_id: String(today._id),
      });
    }

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
  "/check-in",
  checkInLimiter,
  checkInConcurrencyGate,
  upload.single("file"),
  asyncRoute(async (req, res) => {
    const validation = validateImageUpload(req.file);
    if (!validation.valid) return res.status(400).json({ detail: validation.detail });

    const db = req.app.locals.db;
    // The tablet is signed in as its own college, and that college decides
    // whether this check-in identifies by face or by the submitted id. It has to
    // be known before anybody has been identified, so it cannot come from the
    // instructor.
    const identificationSettings = await getIdentificationSettings(db);
    const faceMode = usesFaceIdentification(identificationSettings, req.currentUser.collegeId);

    const suppliedInstructorId = String(req.body.instructor_id || "").trim();
    if (suppliedInstructorId.length > 100) {
      return res.status(422).json({ detail: "A valid instructor_id is required" });
    }
    // Only the selector requires one. In face mode the photograph is the
    // identity, and an id arriving anyway is ignored rather than trusted: the
    // whole point is that nobody chooses who the record belongs to.
    if (!faceMode && !suppliedInstructorId) {
      return res.status(422).json({ detail: "A valid instructor_id is required" });
    }

    const coordinates = parseCoordinates(req.body.location_coordinates);
    if (req.body.location_coordinates && !coordinates) {
      return res.status(422).json({ detail: "location_coordinates must be valid latitude,longitude" });
    }

    // Normalized before recognition so the bytes that identify the person are
    // the same bytes that get stored and analysed. Recognising the raw upload
    // and storing a re-encoded copy would make a failed match impossible to
    // reproduce from the record.
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
        // Nothing can be recognised, and guessing from a submitted id would
        // silently reintroduce the selector this mode exists to remove.
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
            // Kept so a near-tie between two people is findable later, even
            // though look-alike handling is deliberately still open.
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

    /**
     * A photograph nobody could be identified from is still recorded.
     *
     * The alternative is refusing the check-in, which loses the evidence that
     * somebody turned up because the lighting was poor or their reference photo
     * is weak. No analysis is queued and no email is sent: gender decides which
     * dress code applies and there is no instructor to take one from, so a
     * report now would be an empty one. Both happen once an administrator
     * attaches the right instructor.
     */
    if (recognitionFailure) {
      const unidentifiedKey = buildPhotoKey({
        instructorId: "unidentified",
        kind: "checkin",
        mimeType: normalizedImage.mimeType,
        now,
      });
      const unidentifiedUpload = await uploadPhoto({
        key: unidentifiedKey,
        body: normalizedImage.buffer,
        mimeType: normalizedImage.mimeType,
        metadata: {
          kind: "checkin",
          identification: "unidentified",
          outcome: recognitionFailure.reason,
          captured_at: now.toISOString(),
          coordinates: coordinates || "",
        },
      });
      if (!unidentifiedUpload.stored) {
        return res.status(503).json({
          detail: "Photo storage is unavailable right now. Please try again in a moment.",
        });
      }

      const unidentified = await commitUnidentifiedCheckIn(db, {
        currentUser: req.currentUser,
        coordinates,
        normalizedImage,
        photoKey: unidentifiedKey,
        locationAccuracyM: Number.parseInt(req.body.location_accuracy_m, 10) || null,
        capturedAt: now,
        recognition: recognitionFailure,
        now,
      });
      if (coordinates) {
        void attachAddressToAttendance(db, unidentified.attendance._id, coordinates);
      }
      incrementMetric("checkin_unidentified_total");
      return res.status(202).json({
        message: "Check-in recorded, but the instructor could not be identified. An administrator will attach the right instructor.",
        attendance_id: unidentified.attendance._id,
        identified: false,
        reason: recognitionFailure.reason,
      });
    }

    const instructor = await db.collection("instructors").findOne(
      activeInstructorFilter(req.currentUser, instructorId)
    );
    if (!instructor) return res.status(404).json({ detail: "Instructor not found" });
    if (!isValidEmail(instructor.email)) {
      return res.status(422).json({
        detail: "This instructor needs a valid email address before check-in reports can be sent.",
      });
    }

    // Return the open record's id, not just the refusal: the caller's next
    // step is almost always to look at that check-in, and without the id the
    // user has to go and find it by hand.
    const activeRecord = await db.collection("attendance").findOne(
      attendanceOnLocalDay(instructor._id)
    );
    if (activeRecord) {
      return res.status(409).json({
        detail: "This instructor has already checked in today",
        attendance_id: String(activeRecord._id),
      });
    }

    // The photo goes to R2 and only its key is stored, so MongoDB never holds
    // image bytes. Upload before the transaction: a failure here should stop
    // the check-in rather than leave a record pointing at a missing object.
    // `now` is the one declared before recognition ran, so the stored time is
    // when the photograph arrived rather than when the match finished.
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

    // Fire-and-forget: the response has already been decided, so a slow or
    // failing address lookup cannot delay or fail the check-in. The record
    // keeps its coordinates either way.
    if (coordinates) {
      void attachAddressToAttendance(db, attendance._id, coordinates);
    }

    return res.status(202).json({
      message: "Check-in successful. AI analysis is queued.",
      attendance_id: attendance._id,
    });
  })
);

/**
 * Stores one attendance photograph and returns its key.
 *
 * The only part of check-in and check-out that is genuinely the same: build a
 * date-partitioned key, put the normalized bytes in R2, and record who and when
 * in the object metadata. Everything around it differs deliberately — check-in
 * refuses when the photo cannot be stored, because the photograph is the
 * check-in, while check-out proceeds without one because the attendance matters
 * more than its picture — so only this much is shared.
 *
 * Returns { stored: false } rather than throwing, leaving each caller to decide
 * what a storage failure means for it.
 */
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

/** Guard for queue work: naming a record, and discarding one. */
async function requireIdentifyPermission(req, res, next) {
  const settings = await getAccessSettings(req.app.locals.db);
  if (!canIdentifyAttendance(req.currentUser, settings)) {
    return res.status(403).json({ detail: "Not authorized to resolve unidentified check-ins" });
  }
  return next();
}

/**
 * Check-ins whose face was not recognised, oldest first.
 *
 * Scoped like every other attendance read, which is why an unidentified record
 * is stamped with the tablet's college: a BOA can only see their own, and
 * without it the queue would be empty for the person who took the photograph.
 *
 * Each row carries the likely retry suggestions for its own day. They are
 * offered, never applied — the photograph failed to match, so nothing actually
 * links it to the recognised record beyond the college, the day and a few
 * minutes, and discarding somebody's attendance on that basis would be a guess.
 */
attendanceRouter.get(
  "/unidentified",
  requireIdentifyPermission,
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    let pagination;
    try {
      pagination = parsePagination(req.query, { defaultLimit: 50, maxLimit: 200 });
    } catch (error) {
      if (error instanceof RangeError) return res.status(422).json({ detail: error.message });
      throw error;
    }

    const filter = {
      status: "unidentified",
      instructor_id: null,
      deleting_at: { $exists: false },
      ...attendanceScope(req.currentUser),
    };
    const [records, total] = await Promise.all([
      db.collection("attendance")
        .find(filter)
        .sort({ check_in_time: 1 })
        .skip(pagination.offset)
        .limit(pagination.limit)
        .toArray(),
      db.collection("attendance").countDocuments(filter),
    ]);

    // One query for every day present in this page, rather than one per row.
    const days = [...new Set(records.map((row) => row.attendance_day).filter(Boolean))];
    const sameDayRecords = days.length
      ? await db.collection("attendance")
          .find(
            {
              attendance_day: { $in: days },
              instructor_id: { $type: "string" },
              deleting_at: { $exists: false },
              ...attendanceScope(req.currentUser),
            },
            {
              projection: {
                instructor_id: 1,
                instructor_name: 1,
                college_id: 1,
                attendance_day: 1,
                check_in_time: 1,
                identification: 1,
              },
            }
          )
          .toArray()
      : [];
    const byDay = new Map();
    for (const row of sameDayRecords) {
      const key = String(row.attendance_day);
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(row);
    }

    return res.json({
      total,
      limit: pagination.limit,
      offset: pagination.offset,
      records: records.map((record) => ({
        ...serializeAttendance(record),
        failure_reason: record.identification?.outcome || null,
        failure_explanation: explainFailure(record.identification?.outcome),
        retry_candidates: findRetryCandidates(record, byDay.get(String(record.attendance_day)) || []),
      })),
    });
  })
);

/**
 * Names an unidentified check-in.
 *
 * The arrival itself is left alone — time, photograph, coordinates and address
 * are what happened, and the only thing missing was who it happened to. The
 * photograph is then enrolled as a face for that instructor, because a
 * correction is the best possible reference: it is a real photo from the tablet
 * in use, in that room's lighting, of the person recognition just failed on.
 *
 * `force` carries an administrator past the already-checked-in warning rather
 * than the server deciding for them: that instructor having a record already is
 * usually a retry the queue has not caught up with, and occasionally is not.
 */
attendanceRouter.post(
  "/:attendanceId/identify",
  requireIdentifyPermission,
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    const instructorId = String(req.body?.instructor_id || "").trim();
    if (!instructorId || instructorId.length > 100) {
      return res.status(422).json({ detail: "A valid instructor_id is required" });
    }
    const faceMode = String(req.body?.face_mode || "add").toLowerCase();
    if (!["add", "replace", "none"].includes(faceMode)) {
      return res.status(422).json({ detail: "face_mode must be add, replace, or none" });
    }
    const analyse = req.body?.analyse === true;
    const force = req.body?.force === true;

    const record = await db.collection("attendance").findOne({
      _id: idMatch(req.params.attendanceId),
      deleting_at: { $exists: false },
      ...attendanceScope(req.currentUser),
    });
    const instructor = await db.collection("instructors").findOne(
      activeInstructorFilter(req.currentUser, instructorId)
    );
    const existingRecordToday = instructor
      ? await db.collection("attendance").findOne(attendanceOnLocalDay(instructor._id))
      : null;

    const assessment = assessIdentification({ record, instructor, existingRecordToday });
    if (assessment.outcome === IDENTIFY_OUTCOMES.NOT_FOUND) {
      return res.status(404).json({ detail: "Unidentified check-in not found" });
    }
    if (assessment.outcome === IDENTIFY_OUTCOMES.ALREADY_IDENTIFIED) {
      return res.status(409).json({
        detail: assessment.instructor_name
          ? `This check-in was already identified as ${assessment.instructor_name}.`
          : "This check-in has already been identified.",
        outcome: assessment.outcome,
      });
    }
    if (assessment.outcome === IDENTIFY_OUTCOMES.INSTRUCTOR_NOT_FOUND) {
      return res.status(404).json({ detail: "Instructor not found" });
    }
    if (assessment.outcome === IDENTIFY_OUTCOMES.INSTRUCTOR_ALREADY_CHECKED_IN && !force) {
      // Reported rather than refused: the administrator can see both records and
      // is better placed than the server to say whether this was a retry.
      return res.status(409).json({
        detail: assessment.existing_was_recognised
          ? "This instructor was already recognised and checked in today, so this photo is probably the failed attempt just before it. Discard it instead, or confirm to record it anyway."
          : "This instructor already has a check-in today. Confirm to record this one as well.",
        outcome: assessment.outcome,
        existing_attendance_id: assessment.existing_attendance_id,
        existing_check_in_time: assessment.existing_check_in_time,
        existing_was_recognised: assessment.existing_was_recognised,
      });
    }

    const now = new Date();
    const update = identifiedRecordUpdate({
      instructor,
      record,
      identifiedBy: req.currentUser?.email || null,
      now,
    });
    // Claimed on status so two administrators resolving the same row cannot both
    // succeed; the second finds it already identified.
    const claimed = await db.collection("attendance").updateOne(
      { _id: record._id, status: "unidentified", instructor_id: null },
      { $set: update }
    );
    if (!claimed.matchedCount) {
      return res.status(409).json({ detail: "This check-in was identified by someone else." });
    }

    // Enrollment is best effort. The attendance is now correct, and failing the
    // request over a face that could not be indexed would undo work that
    // succeeded; the administrator can add a photo from the instructor form.
    let enrolled = null;
    if (faceMode !== "none" && record.check_in_photo_key) {
      try {
        const photo = await downloadPhoto(record.check_in_photo_key);
        const indexed = await indexFace(photo.buffer, String(instructor._id));
        if (indexed.ok) {
          const existingFaceIds = Array.isArray(instructor.face_ids)
            ? instructor.face_ids.filter(Boolean).map(String)
            : [];
          const retired = faceMode === "replace"
            ? existingFaceIds
            : facesToEvict(existingFaceIds, { adding: 1 });
          const kept = existingFaceIds.filter((id) => !retired.includes(id));
          await db.collection("instructors").updateOne(
            { _id: instructor._id },
            {
              $set: {
                face_ids: [...kept, indexed.faceId],
                face_indexed_at: now,
                updated_at: now,
              },
            }
          );
          if (retired.length) await deleteFaces(retired);
          enrolled = { face_id: indexed.faceId, retired: retired.length };
        } else {
          enrolled = { error: indexed.reason };
        }
      } catch (error) {
        enrolled = { error: error?.name || "ENROLL_FAILED" };
      }
    }

    // Analysis is offered rather than assumed: it spends a vision call, and an
    // administrator resolving a backlog may not want one per row.
    let queued = false;
    if (analyse) {
      try {
        await enqueueEvaluation(db, {
          attendanceId: record._id,
          instructor: {
            id: String(instructor._id),
            name: instructor.name,
            email: instructor.email,
            gender: instructor.gender,
            collegeId: instructor.college_id ? String(instructor.college_id) : null,
          },
          photoKey: record.check_in_photo_key,
          mimeType: record.mime_type || "image/jpeg",
          checkInTime: record.check_in_time,
        });
        await db.collection("attendance").updateOne(
          { _id: record._id },
          { $set: { evaluation_queue_status: "queued", updated_at: new Date() } }
        );
        queued = true;
      } catch (error) {
        console.error(`Identify queue: analysis not queued for ${record._id} (${error?.name || "ERROR"})`);
      }
    }

    incrementMetric("checkin_identified_by_admin_total");
    return res.json({
      message: `Check-in assigned to ${instructor.name}.`,
      attendance_id: String(record._id),
      instructor_id: String(instructor._id),
      analysis_queued: queued,
      face_enrolled: enrolled,
      gender_missing: assessment.outcome === IDENTIFY_OUTCOMES.NO_GENDER,
    });
  })
);

/**
 * Discards an unidentified check-in.
 *
 * Its own action rather than the attendance delete permission: most of what
 * reaches this queue is a wall, a passer-by or a test shot, and clearing those
 * is queue work rather than destroying somebody's record. Only a record that
 * still names nobody can be discarded this way, so an identified check-in cannot
 * be removed through it.
 */
attendanceRouter.delete(
  "/:attendanceId/unidentified",
  requireIdentifyPermission,
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    const record = await db.collection("attendance").findOne({
      _id: idMatch(req.params.attendanceId),
      status: "unidentified",
      instructor_id: null,
      ...attendanceScope(req.currentUser),
    });
    if (!record) {
      return res.status(404).json({ detail: "Unidentified check-in not found" });
    }

    // Photo first, then the record: a deleted record with a surviving object
    // would leave a photograph of somebody with nothing explaining why it is
    // held, which is the opposite of what discarding is for.
    if (record.check_in_photo_key) {
      const removed = await deletePhoto(record.check_in_photo_key);
      if (!removed.deleted) {
        await compensateUploadedPhoto(db, record.check_in_photo_key, "unidentified_discarded");
      }
    }
    await db.collection("attendance").deleteOne({ _id: record._id, instructor_id: null });
    incrementMetric("checkin_unidentified_discarded_total");
    return res.json({ message: "Unidentified check-in discarded" });
  })
);

attendanceRouter.post(
  "/check-out",
  checkOutLimiter,
  // Shares the check-in gate deliberately: both decode an image and call the
  // vision model in-process, so one shared ceiling bounds the real work rather
  // than letting each half reach the limit independently.
  checkInConcurrencyGate,
  // Accepts multipart so a check-out photo can be attached. Optional in a
  // selector college, where check-out must still work when a camera is
  // unavailable; required where the face is what says whose session to close.
  upload.single("file"),
  validate(checkoutSchema),
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    const checkOutTime = new Date();
    const scope = attendanceScope(req.currentUser);

    const identificationSettings = await getIdentificationSettings(db);
    const faceMode = usesFaceIdentification(identificationSettings, req.currentUser.collegeId);

    /**
     * Who is checking out.
     *
     * In a selector college this is the submitted id, as it always was. In a
     * face-only college the photograph decides, so it is normalized once here
     * and the same buffer is reused for the appearance analysis further down:
     * recognising one encoding and analysing another would make a failed match
     * impossible to reproduce from the stored photo.
     *
     * An unrecognised face is refused rather than recorded. Unlike check-in
     * there is nothing to create — a check-out closes one specific open
     * session, and guessing which would attach one person's departure to
     * another's day.
     */
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
          // Says what to do about it: a bare refusal leaves somebody standing at
          // a tablet with no idea whether to retry or find an administrator.
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

    const candidate = await db.collection("attendance").findOne(
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
    /**
     * Too soon to close this day, so nothing is recorded.
     *
     * Refused before the photograph is decoded or stored: an early appearance
     * should cost nothing and leave nothing behind. The response names the time
     * check-out opens, because somebody standing at the tablet who is told only
     * "no" cannot tell a rule from a fault.
     */
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

    const instructor = await db.collection("instructors").findOne({
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
    // Store the check-out photo when one was supplied. A failure here is
    // logged and skipped rather than blocking the check-out itself, which is
    // the record that actually matters for attendance.
    let checkOutPhotoKey = null;
    let checkOutPhoto = null;
    if (req.file) {
      const validation = validateImageUpload(req.file);
      if (!validation.valid) return res.status(400).json({ detail: validation.detail });
      try {
        // Reused when face identification already normalized it. Decoding the
        // same upload twice would store a second encoding of the bytes the
        // match was made against, so a refused or mistaken match could not be
        // reproduced from the photograph the record keeps.
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
        // Unlike check-in, a failure here is logged and skipped: the check-out
        // is what attendance depends on, and refusing it over a photograph
        // would lose the departure to a storage outage.
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
      ...(checkoutCoordinates ? { check_out_coordinates: checkoutCoordinates } : {}),
      ...(req.validatedBody.location_accuracy_m != null
        ? { check_out_location_accuracy_m: req.validatedBody.location_accuracy_m }
        : {}),
      updated_at: checkOutTime,
      // How this check-out established whose session it was closing. Kept
      // beside the check-in's own identification so a record carries the
      // evidence for both halves of the day.
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
    const result = await db.collection("attendance").findOneAndUpdate(
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

    // The check-out has its own coordinates, and nothing was turning them into
    // a place name — the report showed "Address unavailable" beside a perfectly
    // good fix. Detached, as at check-in: a slow geocoder must not hold up the
    // response.
    if (checkoutCoordinates) {
      void attachAddressToAttendance(db, attendance._id, checkoutCoordinates, "checkout");
    }

    const checkoutAnalysisFailed = Boolean(req.file && !checkOutPhotoKey);

    // A photographed check-out is analysed in this request. Its email outbox
    // is created only after the detailed report is stored, so the email can
    // never race ahead carrying the morning/check-in assessment.
    /**
     * The photographed check-out is analysed by the worker, exactly as the
     * check-in is.
     *
     * It used to run inside this request so its email could not race ahead of
     * its report. The worker now owns both — it stores the report and only then
     * queues the email — so the ordering is preserved without holding the
     * connection open for a vision call. That matters because the tablet is a
     * kiosk: a person stands in front of it, and twenty seconds of waiting for
     * an analysis nobody is reading blocks the next person in the queue.
     *
     * A failure to enqueue is logged rather than surfaced. The check-out itself
     * is committed and is what attendance depends on; the outbox reconciler
     * picks the job up on its next pass.
     */
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

    // A photoless check-out has no report to wait for, so its plain
    // confirmation is queued here. A photographed one is emailed by the worker
    // once the report exists, which is what keeps the email behind its report.
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

    // 202 rather than 200: with a photo the appearance report is still being
    // produced when this returns, so the check-out is accepted rather than
    // complete.
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
      // A range wins when either end is given; otherwise this stays the
      // single-day endpoint it has always been, so existing callers and saved
      // links keep working.
      const ranged = req.query.from !== undefined || req.query.to !== undefined;
      if (ranged) {
        // An empty bound means that side is open, which is how "all time"
        // arrives: both present and both blank.
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
    const attendances = await db.collection("attendance")
      // An unbounded range still filters on the field so the same index is
      // used; $exists alone would fall back to a collection scan.
      .find({
        ...(Object.keys(dateFilter).length ? { date: dateFilter } : {}),
        ...(updatedSince ? { updated_at: { $gt: updatedSince } } : {}),
        ...attendanceScope(req.currentUser),
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

    // Every row is looked up now, not only the ones missing a name snapshot:
    // the report token lives on the instructor and the table needs it to build
    // the public report links.
    const instructorIds = [...new Set(attendances.map((row) => String(row.instructor_id)))];
    const legacyInstructors = instructorIds.length
      ? await db.collection("instructors").find(
          { _id: { $in: lookupIdVariants(instructorIds) } },
          // instructor_role as well as role: an instructor imported from
          // BigQuery carries only the former, so projecting role alone left
          // every synced person showing as "Unknown".
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
      ? await db.collection("colleges").find({
          _id: { $in: lookupIdVariants(collegeIds) },
        }).toArray()
      : [];
    const collegeMap = new Map(colleges.map((row) => [String(row._id), row.name]));
    return res.json(attendances.map((attendance) => {
      const instructor = instructorMap.get(String(attendance.instructor_id));
      const collegeId = attendance.college_id || instructor?.college_id || null;
      return {
        ...serializeAttendance(attendance),
        instructor_name: attendance.instructor_name || instructor?.name || "Unknown",
        instructor_role: attendance.instructor_role
          || instructor?.instructor_role
          || instructor?.role
          || "Unknown",
        college_name: collegeId
          ? (collegeMap.get(String(collegeId)) || "Unknown College")
          : "No College",
        // Lets the table link straight to the public report an instructor
        // receives by email, rather than a second internal-only view of it.
        report_token: instructor?.report_token || null,
      };
    }));
  })
);

/**
 * One attendance record by id, so the detail page can be opened directly from
 * a URL. Without this the page could only render a record handed to it by the
 * list, and a refresh or a shared link showed an empty screen.
 */
attendanceRouter.get(
  "/:attendanceId",
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    const attendance = await db.collection("attendance").findOne({
      _id: idMatch(req.params.attendanceId),
      ...attendanceScope(req.currentUser),
    });
    if (!attendance) return res.status(404).json({ detail: "Attendance record not found" });

    // Records written before the snapshot was fixed carry no role, and this
    // route is what serves a detail page opened directly from its URL. Without
    // the lookup the role reads blank there while the list shows it correctly.
    const instructor = await db.collection("instructors").findOne(
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

/**
 * Recovers a checkout whose optional photo could not be stored. The attendance
 * already exists, so calling /check-out again can never work; this narrowly
 * attaches the missing photo, runs checkout analysis directly, and only then
 * creates the report email job.
 */
attendanceRouter.post(
  "/:attendanceId/checkout-photo",
  upload.single("file"),
  asyncRoute(async (req, res) => {
    const validation = validateImageUpload(req.file);
    if (!validation.valid) return res.status(400).json({ detail: validation.detail });

    const db = req.app.locals.db;
    const scope = attendanceScope(req.currentUser);
    const attendance = await db.collection("attendance").findOne({
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

    const claimed = await db.collection("attendance").updateOne(
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

    const instructor = await db.collection("instructors").findOne({
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
        await db.collection("attendance").updateOne(
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
      await db.collection("attendance").updateOne(
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
    const attendance = await db.collection("attendance").findOne({
      _id: idMatch(req.params.attendanceId),
      ...attendanceScope(req.currentUser),
    });
    if (!attendance) return res.status(404).json({ detail: "Attendance record not found" });

    // ?kind=checkout selects the check-out assessment. The default stays the
    // check-in one, so every existing caller keeps the report it asked for.
    const kind = req.query.kind === "checkout" ? "checkout" : "checkin";
    const evaluation = await db.collection("evaluations").findOne(
      evaluationFilter(String(attendance._id), kind)
    );
    if (!evaluation) {
      // 204, not 404. A half with no evaluation is an ordinary state — no
      // photo was taken, or the analysis has not finished — and returning an
      // error made the page paint it red as though something had broken.
      return res.status(204).end();
    }
    return res.json(serializeDocument(evaluation));
  })
);

/**
 * Lightweight status for the check-in screen to poll while analysis runs.
 * Deliberately small: it is requested every few seconds and must not carry
 * the full evaluation payload.
 */
attendanceRouter.get(
  "/:attendanceId/status",
  asyncRoute(async (req, res) => {
    const attendance = await req.app.locals.db.collection("attendance").findOne(
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

    // Each half is assessed separately, so the caller says which one it is
    // waiting on. The default stays the check-in, which is what every existing
    // caller means.
    if (req.query.kind === "checkout") {
      const queueStatus = attendance.checkout_evaluation_queue_status || null;
      return res.json({
        attendance_id: String(attendance._id),
        // No photo means nothing was ever queued, so the caller must not be
        // left polling for an analysis that will never arrive.
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
      // Lets the client stop polling instead of guessing from the status text.
      settled: attendance.status !== "pending",
      updated_at: attendance.updated_at || null,
    });
  })
);

/**
 * Runs the grooming analysis again on the photo already in R2.
 *
 * Used when a result looks wrong or the first attempt failed. The photo is
 * never re-uploaded, so this cannot change what was captured at check-in — it
 * only re-runs the model over the same image.
 */
attendanceRouter.post(
  "/:attendanceId/reanalyse",
  requireSuperAdmin,
  reanalyseLimiter,
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    // Enforced here, not only by hiding the button: re-analysis spends a
    // vision call and replaces a report the instructor may already have been
    // emailed, so a workspace that has not enabled it must be refused.
    const { reanalyse_enabled: reanalyseEnabled } = await getNotificationSettings(db);
    if (!reanalyseEnabled) {
      return res.status(403).json({
        detail: "Re-analysis is turned off for this workspace. An administrator can enable it in Settings.",
      });
    }
    const attendance = await db.collection("attendance").findOne({
      _id: idMatch(req.params.attendanceId),
      ...attendanceScope(req.currentUser),
    });
    if (!attendance) return res.status(404).json({ detail: "Attendance record not found" });

    // Each half has its own photograph, its own job and its own report, so a
    // re-analysis has to say which one it means.
    const kind = req.query.kind === "checkout" ? "checkout" : "checkin";
    const photoKey = kind === "checkout"
      ? attendance.check_out_photo_key
      : attendance.check_in_photo_key;
    if (!photoKey) {
      return res.status(422).json({
        detail: `This ${kind === "checkout" ? "check-out" : "check-in"} has no stored photo, so it cannot be analysed again.`,
      });
    }

    const instructor = await db.collection("instructors").findOne({
      _id: idMatch(String(attendance.instructor_id)),
    });

    const now = new Date();
    // Clear any older job for this half before starting fresh work. Checkout
    // is direct; check-in continues through the durable evaluation worker.
    await db.collection("evaluation_jobs").deleteOne({
      _id: kind === "checkout"
        ? `${attendance._id}:evaluation:checkout`
        : `${attendance._id}:evaluation`,
    });
    // Scoped to the half being re-run. An unscoped delete threw away the other
    // half's report as well, so re-analysing a check-in silently destroyed the
    // check-out one.
    await db.collection("evaluations").deleteMany(
      evaluationFilter(String(attendance._id), kind)
    );
    await db.collection("attendance").updateOne(
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
        await db.collection("attendance").updateOne(
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

/**
 * Time-limited link to a stored photo. The bucket is private, so this is the
 * only way to view one; the URL is generated per request and expires, rather
 * than being stored anywhere it could leak.
 */
attendanceRouter.get(
  "/:attendanceId/photo/:kind",
  asyncRoute(async (req, res) => {
    const kind = req.params.kind === "checkout" ? "checkout" : "checkin";
    const attendance = await req.app.locals.db.collection("attendance").findOne(
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

/**
 * Deletes a bounded set of complete attendance records for administrators.
 *
 * This endpoint deliberately does not inherit the BOA deletion toggle. Bulk
 * deletion has a wider blast radius than deleting one reviewed detail record,
 * so only ADMIN and SUPER_ADMIN may use it. Each record still goes through the
 * same storage/job/evaluation cleanup as the single-record endpoint.
 */
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
    const records = await db.collection("attendance").find({
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

/**
 * Permanently removes a check-in.
 *
 * Scoped like every other read: a BOA can only reach records at their own
 * college, so the capability toggle governs whether they may delete, never
 * whose records they can see.
 */
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

    const attendance = await db.collection("attendance").findOne({
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

/**
 * Removes only the check-out half, leaving the check-in and its report intact.
 *
 * A record cannot exist without a check-in, so deleting that is deleting the
 * record — which is what DELETE /:attendanceId does. This is the other half:
 * the time, the photograph, the location and the check-out assessment go, and
 * the instructor is back to being checked in.
 */
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

    const attendance = await db.collection("attendance").findOne({
      _id: idMatch(req.params.attendanceId),
      ...attendanceScope(req.currentUser),
    });
    if (!attendance) return res.status(404).json({ detail: "Attendance record not found" });
    if (!attendance.check_out_time) {
      return res.status(409).json({ detail: "This record has no check-out to delete" });
    }

    // The photograph goes first. If it fails the record is untouched and the
    // delete can be retried, where the reverse would leave an image in storage
    // that nothing points at.
    await db.collection("attendance").updateOne(
      { _id: attendance._id, checkout_deleting_at: { $exists: false } },
      {
        $set: { checkout_deleting_at: new Date(), updated_at: new Date() },
        $unset: { _private_checkout_outbox: "" },
      }
    );
    await Promise.all([
      db.collection("evaluation_jobs").deleteMany({
        attendance_id: attendance._id,
        $or: [
          { kind: "checkout" },
          { _id: `${attendance._id}:evaluation:checkout` },
        ],
      }),
      db.collection("notification_jobs").deleteMany({
        attendance_id: attendance._id,
        type: "checkout",
      }),
      db.collection("mail_jobs").deleteMany({
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
    await db.collection("evaluation_jobs").deleteOne({
      _id: `${attendance._id}:evaluation:checkout`,
    });
    await db.collection("evaluations").deleteMany(
      evaluationFilter(String(attendance._id), "checkout")
    );
    await db.collection("attendance").updateOne(
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
