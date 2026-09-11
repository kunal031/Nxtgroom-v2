import { createHash, randomUUID } from "node:crypto";
import { runtimeConfig } from "../config/env.js";
import { PROMPT_VERSION } from "../prompts.js";
import { evaluateImage } from "./visionEngine.js";
import { CHECKPOINT_VERSION, improvementTips } from "../checkpoints.js";
import { enqueueNotification } from "./notificationWorker.js";
import { createWorkerMonitor } from "./workerHealth.js";
import { downloadPhoto } from "./photoStorage.js";
import { enqueueMailJob } from "./mailWorker.js";
import { idMatch } from "../middleware/auth.js";
import { reportRecipientsFor } from "./reportRecipients.js";
import { ensureReportToken, localDateKey } from "./instructorReports.js";
import { appUrl } from "../config/env.js";

const WORKER_ID = randomUUID();
const EVALUATION_OUTBOX_FIELD = "_private_evaluation_outbox";
const TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const EVALUATION_DEADLINE_MS = 24 * 60 * 60 * 1000;

function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value?.buffer) return Buffer.from(value.buffer);
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new Error("Evaluation job image is unavailable");
}

function updated(result) {
  return Boolean(result && (result.matchedCount > 0 || result.modifiedCount > 0));
}

/**
 * One job per half of the record.
 *
 * The check-in keeps its original id so jobs queued before check-out analysis
 * existed still run rather than being orphaned by a rename.
 */
function evaluationJobId(attendanceId, kind = "checkin") {
  return kind === "checkout"
    ? `${attendanceId}:evaluation:checkout`
    : `${attendanceId}:evaluation`;
}

/** Evaluations stored before check-out analysis existed are all check-ins. */
function jobKind(job) {
  return job?.kind === "checkout" ? "checkout" : "checkin";
}

function errorCode(error, fallback = "EVALUATION_ERROR") {
  const value = String(error?.code || error?.name || fallback).toUpperCase();
  return /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : fallback;
}

/**
 * Sends a failed or review-required result to the instructor and to every
 * Reporting Partner, each with a link to that day's report.
 *
 * The instructor's link is keyed on their own report token; RPs receive the
 * same link, since they are trusted recipients configured by an administrator.
 */
async function sendGroomingAlerts(db, {
  attendanceId,
  instructorId,
  instructorName,
  instructorEmail,
  status,
  summary,
  checkInTime,
  eventTime = checkInTime,
  kind = "checkin",
}) {
  // idMatch, not the raw value: attendance stores instructor_id as a string,
  // while a synced instructor's _id is an ObjectId. Matching on the string
  // alone found nobody for all 599 imported instructors, and the early return
  // below then silently cancelled the alert — to the instructor and to every
  // reporting partner alike.
  const instructor = instructorId
    ? await db.collection("instructors").findOne({ _id: idMatch(String(instructorId)) })
    : null;
  if (!instructor) {
    console.error(`Grooming alert skipped: instructor ${instructorId} was not found`);
    return;
  }

  const token = await ensureReportToken(db, instructor);
  const dayKey = localDateKey(new Date(checkInTime || Date.now()));
  // The link names the half it belongs to, so an alert about a check-out
  // opens the check-out report rather than the morning's.
  const reportUrl = `${appUrl()}/reports/${token}/day/${dayKey}/${
    kind === "checkout" ? "check-out" : "check-in"
  }`;
  const payload = {
    name: instructorName || instructor.name,
    status,
    summary,
    // The link remains keyed to the attendance session day, while the email
    // names the actual event day (important for a checkout after midnight).
    dateLabel: localDateKey(new Date(eventTime || checkInTime || Date.now())),
    reportUrl,
    kind,
  };

  const deliveries = [];
  const to = instructorEmail || instructor.email;
  if (to) {
    deliveries.push({ to, role: "instructor", payload });
  }

  // Reporting partners are copied per half, each behind its own switch: an
  // administrator may want the morning's failures without a second message
  // every evening.
  const recipients = (await reportRecipientsFor(db, kind));
  for (const recipient of recipients) {
    deliveries.push({
      to: recipient,
      role: "reporting_partner",
      payload: { ...payload, forReviewer: true },
    });
  }

  for (const delivery of deliveries) {
    const recipientKey = createHash("sha256")
      .update(String(delivery.to).trim().toLowerCase())
      .digest("hex")
      .slice(0, 20);
    await enqueueMailJob(db, {
      id: `${attendanceId}:grooming-alert:${kind}:${delivery.role}:${recipientKey}`,
      type: "grooming_alert",
      toEmail: delivery.to,
      attendanceId,
      payload: {
        ...delivery.payload,
        kind,
        role: delivery.role,
      },
    });
  }
  if (!recipients.length) {
    console.warn("No reporting partners are configured; only the instructor was alerted.");
  }
  return deliveries.length;
}

function publicEvaluation(report, job, now) {
  const imageQuality = report.image_quality || "RETAKE_RECOMMENDED";
  return {
    attendance_id: job.attendance_id,
    photo_evidence_url: null,
    overall_status: report.overall_status,
    ai_summary: report.ai_summary || "",
    general_idcard_check: report.general_idcard_check || [],
    grooming_check: report.grooming_check || [],
    attire_check: report.attire_check || [],
    accessories_check: report.accessories_check || [],
    footwear_check: report.footwear_check || [],
    image_quality: imageQuality,
    // Classified independently of pass/fail so the weekly saree/kurti split
    // can be counted even on a non-compliant day.
    attire_type: report.attire_type || "UNKNOWN",
    // Which parts of the body the photo actually showed. Stored because it is
    // what explains an N/A row to whoever reads the report later.
    visible_regions: report.visible_regions || null,
    // Set only when no assessment was attempted, so the report can say why
    // rather than showing five empty tables.
    unassessed_reason: report.unassessed_reason || null,
    // Derived from the failing checkpoints here rather than in the browser, so
    // the report page and the emails cannot advise different things.
    improvement_tips: improvementTips(report),
    model: runtimeConfig().geminiModel,
    prompt_version: PROMPT_VERSION,
    // Derived from the checkpoint tables, so a rule reworded without touching
    // PROMPT_VERSION is still distinguishable in a stored report.
    checkpoint_version: CHECKPOINT_VERSION,
    processed_at: now,
    attempts: job.attempts,
  };
}

/**
 * The attendance document is the durable source outbox. The deterministic job id
 * makes a crash between this upsert and clearing the embedded payload harmless.
 */
export async function enqueueEvaluation(db, payload) {
  const now = new Date();
  const deadlineAt = payload.deadlineAt || new Date(now.getTime() + EVALUATION_DEADLINE_MS);
  const kind = payload.kind === "checkout" ? "checkout" : "checkin";
  const jobId = evaluationJobId(payload.attendanceId, kind);
  await db.collection("evaluation_jobs").updateOne(
    { _id: jobId },
    {
      $setOnInsert: {
        _id: jobId,
        attendance_id: payload.attendanceId,
        kind,
        instructor: payload.instructor,
        // The job carries a pointer, not the image. Bytes live only in R2.
        // imageBuffer is still honoured so jobs queued before the move to
        // object storage continue to run instead of failing on retry.
        photo_key: payload.photoKey || null,
        ...(payload.imageBuffer ? { image: payload.imageBuffer } : {}),
        mime_type: payload.mimeType,
        check_in_time: payload.checkInTime,
        // Carried for a checkout job so the report it produces can state when
        // the instructor actually left. Absent on a checkin job, where there is
        // no check-out yet to describe.
        ...(payload.checkOutTime ? { check_out_time: payload.checkOutTime } : {}),
        status: "queued",
        attempts: 0,
        available_at: now,
        deadline_at: deadlineAt,
        created_at: now,
      },
    },
    { upsert: true }
  );
  const storedJob = await db.collection("evaluation_jobs").findOne(
    { _id: jobId },
    { projection: { status: 1 } }
  );
  await db.collection("attendance").updateOne(
    { _id: payload.attendanceId },
    {
      $set: {
        evaluation_queue_status: storedJob?.status || "queued",
        updated_at: now,
      },
      $unset: { [EVALUATION_OUTBOX_FIELD]: "" },
    }
  );
  return jobId;
}

export async function reconcileEvaluationOutbox(db) {
  const attendance = await db.collection("attendance").findOne(
    { [EVALUATION_OUTBOX_FIELD]: { $exists: true } },
    { sort: { [`${EVALUATION_OUTBOX_FIELD}.created_at`]: 1 } }
  );
  if (!attendance) return false;

  const payload = attendance[EVALUATION_OUTBOX_FIELD];
  const now = new Date();
  const inferredDeadline = payload?.deadline_at
    ? new Date(payload.deadline_at)
    : new Date(new Date(attendance.created_at || attendance.check_in_time).getTime()
      + EVALUATION_DEADLINE_MS);
  if (Number.isNaN(inferredDeadline.getTime())) {
    await terminalizeEvaluationOutbox(db, attendance, payload, "INVALID_EVALUATION_OUTBOX");
    return true;
  }
  if (inferredDeadline <= now) {
    await terminalizeEvaluationOutbox(db, attendance, payload, "EVALUATION_DEADLINE_EXCEEDED");
    return true;
  }
  // A recovered outbox must name its image: either an R2 key (current) or
  // inline bytes (queued before photos moved to object storage).
  const hasPhotoSource = Boolean(payload?.photo_key || payload?.image);
  if (!hasPhotoSource || !payload?.mime_type || !payload?.instructor) {
    await terminalizeEvaluationOutbox(db, attendance, payload, "INVALID_EVALUATION_OUTBOX");
    return true;
  }

  await enqueueEvaluation(db, {
    attendanceId: attendance._id,
    instructor: payload.instructor,
    photoKey: payload.photo_key || null,
    imageBuffer: payload.image,
    mimeType: payload.mime_type,
    checkInTime: payload.check_in_time || attendance.check_in_time,
    deadlineAt: payload.deadline_at,
  });
  return true;
}

async function claimEvaluation(db) {
  const now = new Date();
  const config = runtimeConfig();
  const legacyCutoff = new Date(now.getTime() - EVALUATION_DEADLINE_MS);
  const result = await db.collection("evaluation_jobs").findOneAndUpdate(
    {
      attempts: { $lt: config.evaluationMaxAttempts },
      $and: [
        {
          $or: [
            { deadline_at: { $gt: now } },
            { deadline_at: { $exists: false }, created_at: { $gt: legacyCutoff } },
          ],
        },
        { $or: [
          { status: "queued", available_at: { $lte: now } },
          { status: "processing", lease_until: { $lte: now } },
        ] },
      ],
    },
    {
      $set: {
        status: "processing",
        worker_id: WORKER_ID,
        lease_until: new Date(now.getTime() + config.evaluationLeaseMs),
        updated_at: now,
      },
      $inc: { attempts: 1 },
    },
    { sort: { created_at: 1 }, returnDocument: "after" }
  );
  return result?.value || result;
}

async function evaluationTargetExists(db, job) {
  const checkout = jobKind(job) === "checkout";
  const filter = {
    _id: job.attendance_id,
    deleting_at: { $exists: false },
    ...(checkout ? {
      checkout_deleting_at: { $exists: false },
      check_out_time: { $ne: null },
    } : {}),
  };
  if (job.photo_key) {
    filter[checkout ? "check_out_photo_key" : "check_in_photo_key"] = job.photo_key;
  }
  return Boolean(await db.collection("attendance").findOne(filter, { projection: { _id: 1 } }));
}

async function renewEvaluationLease(db, job) {
  const now = new Date();
  const result = await db.collection("evaluation_jobs").updateOne(
    {
      _id: job._id,
      status: "processing",
      worker_id: WORKER_ID,
      lease_until: { $gt: now },
    },
    {
      $set: {
        commit_started_at: now,
        lease_until: new Date(now.getTime() + runtimeConfig().evaluationLeaseMs),
        updated_at: now,
      },
    }
  );
  return updated(result);
}

async function syncStoredEvaluation(db, job, evaluation, ownedStatus) {
  // The evaluation must belong to the half being written. A lookup that
  // matched on attendance_id alone once handed a check-out job the check-in's
  // report, and this wrote the morning's verdict into the check-out fields
  // while no check-out report existed at all — a record showing a result with
  // no checkpoints behind it. Refusing here means the job is retried rather
  // than a wrong answer being recorded.
  const evaluationKind = evaluation?.kind === "checkout" ? "checkout" : "checkin";
  if (evaluationKind !== jobKind(job)) {
    throw new Error(
      `Refusing to record a ${evaluationKind} evaluation against the ${jobKind(job)} half of ${job.attendance_id}`
    );
  }

  const now = new Date();
  const overallStatus = evaluation.overall_status;
  const imageQuality = evaluation.image_quality || "RETAKE_RECOMMENDED";
  // UNASSESSED is neither. A photograph that does not show the instructor is
  // not a violation, and it is not a clean check-in either — recording it as
  // compliant is how a picture of a ceiling used to pass. It is left out of
  // the compliant and non-compliant counts entirely.
  const attendanceStatus = overallStatus === "UNASSESSED"
    ? "unassessed"
    : overallStatus === "COMPLIANT" ? "compliant" : "non_compliant";

  // The day's status belongs to the check-in. A check-out assessment is
  // recorded alongside it under its own fields: overwriting status and remarks
  // would rewrite the morning's verdict with the evening's photograph, and the
  // weekly counts read those fields.
  if (jobKind(job) === "checkout") {
    const attendanceUpdate = await db.collection("attendance").updateOne(
      {
        _id: job.attendance_id,
        deleting_at: { $exists: false },
        checkout_deleting_at: { $exists: false },
      },
      {
        $set: {
          checkout_compliance_status: overallStatus,
          checkout_remarks: evaluation.ai_summary || "",
          checkout_image_quality: imageQuality,
          checkout_analysis_completed_at: evaluation.processed_at || now,
          checkout_evaluation_queue_status: "completed",
          updated_at: now,
        },
      }
    );
    if (!attendanceUpdate.matchedCount) return false;

    /**
     * The routine check-out report, queued exactly as the check-in one is.
     *
     * This branch previously sent only the non-compliant alert below, because
     * check-out ran its analysis inside the HTTP request and the route built the
     * email outbox itself. Once check-out is queued like check-in the route no
     * longer runs, so without this a compliant check-out would store its report
     * and send nothing — while a failing one still emailed. A partial silence
     * that no test covered and nobody would report as a bug.
     */
    await enqueueNotification(db, {
      attendanceId: job.attendance_id,
      type: "checkout",
      toEmail: job.instructor?.email,
      report: {
        instructorName: job.instructor?.name || "Instructor",
        overallStatus,
        aiSummary: evaluation.ai_summary || "",
        checkInTime: job.check_in_time,
        checkOutTime: job.check_out_time || null,
        imageQuality,
      },
    });

    // The check-out gets its own report email, built from its own evaluation
    // and linking to its own half. Previously nothing was sent for it, so the
    // only report anybody ever received described the morning.
    if (attendanceStatus === "non_compliant") {
      try {
        await sendGroomingAlerts(db, {
          attendanceId: job.attendance_id,
          instructorId: job.instructor?.id,
          instructorName: job.instructor?.name,
          instructorEmail: job.instructor?.email,
          status: attendanceStatus,
          summary: evaluation.ai_summary || "",
          checkInTime: job.check_in_time,
          eventTime: job.check_out_time || job.check_in_time,
          kind: "checkout",
        });
      } catch (error) {
        console.error(`Check-out alert not sent for ${job.attendance_id}: ${error?.name || "Error"}`);
      }
    }

    if (job._id) {
      await db.collection("evaluation_jobs").deleteOne({
        _id: job._id,
        worker_id: WORKER_ID,
        status: ownedStatus,
      });
    }
    return true;
  }
  const attendanceUpdate = await db.collection("attendance").updateOne(
    { _id: job.attendance_id, deleting_at: { $exists: false } },
    {
      $set: {
        status: attendanceStatus,
        compliance_status: overallStatus,
        remarks: evaluation.ai_summary || "",
        analysis_completed_at: evaluation.processed_at || now,
        evaluation_queue_status: "completed",
        // Denormalised onto attendance so Daily Records and the weekly report
        // need no join to the evaluations collection.
        attire_type: evaluation.attire_type || "UNKNOWN",
        image_quality: imageQuality,
        updated_at: now,
      },
      $unset: {
        analysis_error_code: "",
        [EVALUATION_OUTBOX_FIELD]: "",
      },
    }
  );
  if (!attendanceUpdate.matchedCount) return false;
  await enqueueNotification(db, {
    attendanceId: job.attendance_id,
    type: "checkin",
    toEmail: job.instructor?.email,
    report: {
      instructorName: job.instructor?.name || "Instructor",
      overallStatus,
      aiSummary: evaluation.ai_summary || "",
      checkInTime: job.check_in_time,
      imageQuality,
    },
  });

  // A failed result is durably queued for the instructor and reporting
  // partners rather than waiting for the weekly summary. Enqueue failures are
  // logged and swallowed: the evaluation itself is already committed and must
  // not be retried (and paid for again) because an alert could not be queued.
  if (attendanceStatus === "non_compliant") {
    try {
      await sendGroomingAlerts(db, {
        attendanceId: job.attendance_id,
        instructorId: job.instructor?.id,
        instructorName: job.instructor?.name,
        instructorEmail: job.instructor?.email,
        status: attendanceStatus,
        summary: evaluation.ai_summary || "",
        checkInTime: job.check_in_time,
        kind: jobKind(job),
      });
    } catch (error) {
      console.error(`Grooming alert not sent for ${job.attendance_id}: ${error?.name || "Error"}`);
    }
  }
  await db.collection("evaluation_jobs").deleteOne({
    _id: job._id,
    worker_id: WORKER_ID,
    status: ownedStatus,
  });
  return true;
}

/**
 * Matches one half's evaluation.
 *
 * A check-in is matched on the absence of a kind as well as on "checkin",
 * because every evaluation stored before check-out analysis existed has no
 * kind field and all of them are check-ins.
 */
export function evaluationFilter(attendanceId, kind = "checkin") {
  return kind === "checkout"
    ? { attendance_id: attendanceId, kind: "checkout" }
    : { attendance_id: attendanceId, kind: { $ne: "checkout" } };
}

async function completeEvaluation(db, job, report) {
  if (!(await renewEvaluationLease(db, job))) return false;
  if (!(await evaluationTargetExists(db, job))) {
    await db.collection("evaluation_jobs").deleteOne({
      _id: job._id,
      status: "processing",
      worker_id: WORKER_ID,
    });
    return false;
  }

  const now = new Date();
  // Tagged before it is written or synced, so the half it belongs to travels
  // with it rather than being inferred at each use.
  const evaluation = { ...publicEvaluation(report, job, now), kind: jobKind(job) };
  await db.collection("evaluations").updateOne(
    evaluationFilter(job.attendance_id, jobKind(job)),
    {
      $set: evaluation,
      $setOnInsert: { _id: randomUUID(), created_at: now },
    },
    { upsert: true }
  );
  const synced = await syncStoredEvaluation(db, job, evaluation, "processing");
  if (!synced) {
    await db.collection("evaluations").deleteOne(
      evaluationFilter(job.attendance_id, jobKind(job))
    );
    return false;
  }
  return true;
}

/**
 * Analyses a check-out photo in the request that saved it.
 *
 * Check-ins deliberately retain the durable evaluation worker. Check-outs use
 * this direct path so their detailed report is persisted before the route
 * creates the checkout-email outbox. No evaluation_jobs document is created.
 */
export async function evaluateCheckoutNow(db, {
  attendanceId,
  instructor,
  photoKey,
  imageBuffer,
  mimeType = "image/jpeg",
  checkOutTime,
  checkInTime,
}) {
  const target = { attendance_id: attendanceId, kind: "checkout", photo_key: photoKey };
  if (!(await evaluationTargetExists(db, target))) {
    const error = new Error("Checkout was removed before analysis started");
    error.code = "ATTENDANCE_NOT_FOUND";
    throw error;
  }
  const source = imageBuffer
    ? { buffer: asBuffer(imageBuffer), mimeType }
    : await downloadPhoto(photoKey);
  const config = runtimeConfig();
  // This runs inside the check-out request, so it uses the shortened
  // interactive budget: the caller is holding a connection that the server
  // will destroy at requestTimeout, and a reply the client never receives is
  // worse than one retry fewer.
  const report = await evaluateImage(
    source.buffer,
    source.mimeType || mimeType,
    instructor?.gender,
    {
      timeoutMs: config.geminiInteractiveTimeoutMs,
      maxRetries: config.geminiInteractiveMaxRetries,
    }
  );
  const now = new Date();
  const job = {
    attendance_id: attendanceId,
    kind: "checkout",
    instructor,
    // Reports are addressed by the attendance session's check-in day. Keep
    // the actual checkout timestamp separate so a session crossing midnight
    // does not create a link to a day where no check-in record exists.
    check_in_time: checkInTime || checkOutTime,
    check_out_time: checkOutTime,
    attempts: 1,
  };
  if (!(await evaluationTargetExists(db, { ...job, photo_key: photoKey }))) {
    const error = new Error("Checkout was removed while analysis was running");
    error.code = "ATTENDANCE_NOT_FOUND";
    throw error;
  }
  const evaluation = { ...publicEvaluation(report, job, now), kind: "checkout" };
  await db.collection("evaluations").updateOne(
    evaluationFilter(attendanceId, "checkout"),
    {
      $set: evaluation,
      $setOnInsert: { _id: randomUUID(), created_at: now },
    },
    { upsert: true }
  );
  const synced = await syncStoredEvaluation(db, job, evaluation, null);
  if (!synced || !(await evaluationTargetExists(db, { ...job, photo_key: photoKey }))) {
    await db.collection("evaluations").deleteOne(evaluationFilter(attendanceId, "checkout"));
    const error = new Error("Checkout was removed before the report was committed");
    error.code = "ATTENDANCE_NOT_FOUND";
    throw error;
  }
  return evaluation;
}

export async function recoverClaimedEvaluation(db, job) {
  const storedEvaluation = await db.collection("evaluations").findOne(
    evaluationFilter(job.attendance_id, jobKind(job))
  );
  if (!storedEvaluation) return null;
  if (!(await renewEvaluationLease(db, job))) return false;
  await syncStoredEvaluation(db, job, storedEvaluation, "processing");
  return true;
}

function buildFailureNotification(job, now) {
  const recipient = typeof job.instructor?.email === "string"
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(job.instructor.email)
    ? job.instructor.email
    : null;
  if (!recipient) return null;
  return {
    to_email: recipient,
    report: {
      instructorName: job.instructor?.name || "Instructor",
      overallStatus: "error",
      aiSummary: "AI analysis could not be completed. Check out this attendance, then check in again with a new photo.",
      checkInTime: job.check_in_time,
    },
    deadline_at: new Date(now.getTime() + EVALUATION_DEADLINE_MS),
    created_at: now,
  };
}

async function terminalizeEvaluationOutbox(db, attendance, payload, code) {
  const now = new Date();
  const jobId = evaluationJobId(attendance._id);
  const sourceJob = {
    attendance_id: attendance._id,
    instructor: payload?.instructor,
    check_in_time: payload?.check_in_time || attendance.check_in_time,
  };
  const failureNotification = buildFailureNotification(sourceJob, now);
  await db.collection("evaluation_jobs").updateOne(
    { _id: jobId },
    {
      $setOnInsert: {
        _id: jobId,
        attendance_id: attendance._id,
        check_in_time: sourceJob.check_in_time,
        status: "failed",
        attempts: 0,
        last_error: code,
        error_code: code,
        failed_at: now,
        created_at: attendance.created_at || now,
        ...(failureNotification ? { failure_notification: failureNotification } : {}),
      },
    },
    { upsert: true }
  );
  const storedJob = await db.collection("evaluation_jobs").findOne({ _id: jobId });
  if (storedJob?.status === "failed" && !storedJob.failure_synced_at) {
    await syncFailedEvaluationOutcome(db, storedJob);
    return;
  }
  await db.collection("attendance").updateOne(
    { _id: attendance._id },
    {
      $set: { evaluation_queue_status: storedJob?.status || "queued", updated_at: now },
      $unset: { [EVALUATION_OUTBOX_FIELD]: "" },
    }
  );
}

export async function syncFailedEvaluationOutcome(db, job) {
  const now = new Date();
  const notification = job.failure_notification || null;
  const terminalErrorCode = errorCode(
    { code: job.error_code || job.last_error },
    "ANALYSIS_ERROR"
  );

  await db.collection("attendance").updateOne(
    { _id: job.attendance_id, analysis_completed_at: { $exists: false } },
    {
      $set: {
        status: "error",
        compliance_status: null,
        evaluation_queue_status: "failed",
        remarks: "AI analysis could not be completed. Check out this attendance, then check in again with a new photo.",
        analysis_error_code: terminalErrorCode,
        image_quality: null,
        checkin_email_status: notification ? "outbox_pending" : "skipped_no_email",
        ...(notification ? { _private_checkin_outbox: notification } : {}),
        updated_at: now,
      },
      $unset: {
        [EVALUATION_OUTBOX_FIELD]: "",
        ...(!notification ? { _private_checkin_outbox: "" } : {}),
      },
    }
  );

  await db.collection("evaluation_jobs").updateOne(
    { _id: job._id, status: "failed", failure_synced_at: { $exists: false } },
    {
      $set: {
        failure_synced_at: now,
        expires_at: new Date(now.getTime() + TERMINAL_RETENTION_MS),
        last_error: terminalErrorCode,
        error_code: terminalErrorCode,
      },
      $unset: { failure_notification: "", instructor: "" },
    }
  );

  if (notification) {
    try {
      await enqueueNotification(db, {
        attendanceId: job.attendance_id,
        type: "checkin",
        toEmail: notification.to_email,
        report: notification.report,
        deadlineAt: notification.deadline_at,
      });
    } catch (notificationError) {
      console.error(
        `Failure notification outbox ${job.attendance_id} remains pending `
        + `(${errorCode(notificationError, "NOTIFICATION_ERROR")})`
      );
    }
  }
  return true;
}

async function markEvaluationFailed(db, job, error, ownedStatus = "processing") {
  const now = new Date();
  if (jobKind(job) === "checkout") {
    // Only the check-out fields: the check-in half keeps its own report and
    // its own status, which this failure says nothing about.
    await db.collection("attendance").updateOne(
      { _id: job.attendance_id },
      {
        $set: {
          checkout_evaluation_queue_status: "failed",
          checkout_analysis_error_code: errorCode(error, "ANALYSIS_ERROR"),
          updated_at: now,
        },
      }
    ).catch(() => {
      // The job is already being marked failed; losing this note must not
      // stop that.
    });
  }
  const failureNotification = buildFailureNotification(job, now);
  const result = await db.collection("evaluation_jobs").findOneAndUpdate(
    { _id: job._id, worker_id: WORKER_ID, status: ownedStatus },
    {
      $set: {
        status: "failed",
        last_error: errorCode(error),
        error_code: errorCode(error, "ANALYSIS_ERROR"),
        failed_at: now,
        ...(failureNotification ? { failure_notification: failureNotification } : {}),
      },
      $unset: {
        image: "",
        instructor: "",
        lease_until: "",
        worker_id: "",
        commit_started_at: "",
        ...(!failureNotification ? { failure_notification: "" } : {}),
      },
    },
    { returnDocument: "after" }
  );
  const terminalJob = result?.value || result;
  if (!terminalJob) return false;
  await syncFailedEvaluationOutcome(db, terminalJob);
  return true;
}

export async function reconcileFailedEvaluationOutcomes(db) {
  const job = await db.collection("evaluation_jobs").findOne(
    { status: "failed", failure_synced_at: { $exists: false } },
    { sort: { failed_at: 1 } }
  );
  if (!job) return false;
  await syncFailedEvaluationOutcome(db, job);
  return true;
}

async function retryEvaluation(db, job, error) {
  const storedEvaluation = await db.collection("evaluations").findOne(
    // Scoped to this half. Matching on attendance_id alone found the check-in
    // report and reused it for the check-out job, so the check-out was never
    // analysed at all — it inherited the morning's verdict, remarks and
    // timestamp, and the two reports were identical by construction.
    evaluationFilter(job.attendance_id, jobKind(job))
  );
  if (storedEvaluation) {
    if (await renewEvaluationLease(db, job)) {
      await syncStoredEvaluation(db, job, storedEvaluation, "processing");
    }
    return;
  }

  const config = runtimeConfig();
  if (job.attempts >= config.evaluationMaxAttempts) {
    await markEvaluationFailed(db, job, error);
    return;
  }
  await db.collection("evaluation_jobs").updateOne(
    { _id: job._id, worker_id: WORKER_ID, status: "processing" },
    {
      $set: {
        status: "queued",
        last_error: errorCode(error),
        available_at: new Date(Date.now() + Math.min(60000, 2000 * 2 ** job.attempts)),
      },
      $unset: { lease_until: "", worker_id: "", commit_started_at: "" },
    }
  );
}

/**
 * Claims expired last-attempt work so it can no longer remain unclaimable. If
 * the evaluation was persisted before the crash, the remaining idempotent side
 * effects are completed; otherwise the job is terminally failed.
 */
export async function reconcileExpiredEvaluationJobs(db, now = new Date()) {
  const config = runtimeConfig();
  const result = await db.collection("evaluation_jobs").findOneAndUpdate(
    {
      status: { $in: ["processing", "recovering"] },
      attempts: { $gte: config.evaluationMaxAttempts },
      lease_until: { $lte: now },
    },
    {
      $set: {
        status: "recovering",
        worker_id: WORKER_ID,
        lease_until: new Date(now.getTime() + config.evaluationLeaseMs),
        recovery_started_at: now,
        updated_at: now,
      },
    },
    { sort: { created_at: 1 }, returnDocument: "after" }
  );
  const job = result?.value || result;
  if (!job) return false;

  try {
    const storedEvaluation = await db.collection("evaluations").findOne(
      evaluationFilter(job.attendance_id, jobKind(job))
    );
    if (storedEvaluation) {
      await syncStoredEvaluation(db, job, storedEvaluation, "recovering");
    } else {
      const error = new Error("Evaluation worker lease expired on the final attempt");
      error.name = "EVALUATION_LEASE_EXPIRED";
      await markEvaluationFailed(db, job, error, "recovering");
    }
    return true;
  } catch (error) {
    await db.collection("evaluation_jobs").updateOne(
      { _id: job._id, worker_id: WORKER_ID, status: "recovering" },
      {
        $set: {
          status: "processing",
          lease_until: new Date(Date.now() + Math.max(1000, config.evaluationPollMs)),
          last_error: errorCode(error),
        },
        $unset: { worker_id: "" },
      }
    );
    throw error;
  }
}

/** Terminally clears photos which could not be processed within the retention deadline. */
export async function reconcileOverdueEvaluationJobs(db, now = new Date()) {
  const config = runtimeConfig();
  const legacyCutoff = new Date(now.getTime() - EVALUATION_DEADLINE_MS);
  const result = await db.collection("evaluation_jobs").findOneAndUpdate(
    {
      $and: [
        {
          $or: [
            { deadline_at: { $lte: now } },
            { deadline_at: { $exists: false }, created_at: { $lte: legacyCutoff } },
          ],
        },
        { $or: [
          { status: "queued" },
          { status: "processing", lease_until: { $lte: now } },
          { status: "recovering", lease_until: { $lte: now } },
        ] },
      ],
    },
    {
      $set: {
        status: "recovering",
        worker_id: WORKER_ID,
        lease_until: new Date(now.getTime() + config.evaluationLeaseMs),
        recovery_started_at: now,
        updated_at: now,
      },
    },
    { sort: { deadline_at: 1 }, returnDocument: "after" }
  );
  const job = result?.value || result;
  if (!job) return false;

  try {
    const storedEvaluation = await db.collection("evaluations").findOne(
      evaluationFilter(job.attendance_id, jobKind(job))
    );
    if (storedEvaluation) {
      await syncStoredEvaluation(db, job, storedEvaluation, "recovering");
    } else {
      const error = new Error("Evaluation deadline exceeded");
      error.name = "EVALUATION_DEADLINE_EXCEEDED";
      await markEvaluationFailed(db, job, error, "recovering");
    }
    return true;
  } catch (error) {
    await db.collection("evaluation_jobs").updateOne(
      { _id: job._id, worker_id: WORKER_ID, status: "recovering" },
      {
        $set: {
          status: "processing",
          lease_until: new Date(Date.now() + Math.max(1000, config.evaluationPollMs)),
          last_error: errorCode(error),
        },
        $unset: { worker_id: "" },
      }
    );
    throw error;
  }
}

export function startEvaluationWorker(db) {
  let stopped = false;
  let timer = null;
  let inFlight = Promise.resolve();
  const config = runtimeConfig();
  const interval = config.evaluationPollMs;
  const monitor = createWorkerMonitor("evaluation", {
    busyStaleAfterMs: config.evaluationLeaseMs + 60000,
  });

  const schedule = (delay = interval) => {
    if (!stopped) timer = setTimeout(tick, delay);
  };
  const processJob = async (job) => {
    try {
      if (!(await evaluationTargetExists(db, job))) {
        await db.collection("evaluation_jobs").deleteOne({
          _id: job._id,
          status: "processing",
          worker_id: WORKER_ID,
        });
        monitor.progress("deleted_target_cancelled");
        return;
      }
      const recovered = await recoverClaimedEvaluation(db, job);
      if (recovered === null) {
        monitor.progress("vision_request_started");
        const source = job.photo_key
          ? await downloadPhoto(job.photo_key)
          : { buffer: asBuffer(job.image), mimeType: job.mime_type };
        const report = await evaluateImage(
          source.buffer,
          source.mimeType || job.mime_type,
          job.instructor.gender
        );
        monitor.progress("vision_request_completed");
        await completeEvaluation(db, job, report);
        monitor.progress("evaluation_completed");
      } else {
        monitor.progress("stored_evaluation_recovered");
      }
    } catch (error) {
      monitor.recordJobError(errorCode(error));
      console.error(
        `Evaluation job ${job._id} attempt ${job.attempts} failed (${errorCode(error)}): `
        + `${error?.name || "Error"} ${String(error?.message || "").slice(0, 300)}`
      );
      await retryEvaluation(db, job, error);
    }
  };
  const tick = () => {
    monitor.cycleStarted();
    let loopErrorCode = null;
    let processedCount = 0;
    inFlight = (async () => {
      try {
        await reconcileEvaluationOutbox(db);
        monitor.progress("evaluation_outbox_reconciled");
        await reconcileOverdueEvaluationJobs(db);
        monitor.progress("overdue_jobs_reconciled");
        await reconcileExpiredEvaluationJobs(db);
        monitor.progress("expired_leases_reconciled");
        await reconcileFailedEvaluationOutcomes(db);
        monitor.progress("failed_outcomes_reconciled");
        const jobs = (await Promise.all(
          Array.from({ length: config.evaluationConcurrency }, () => claimEvaluation(db))
        )).filter(Boolean);
        processedCount = jobs.length;
        monitor.progress(jobs.length ? "jobs_claimed" : "queue_idle");
        await Promise.all(jobs.map(processJob));
      } catch (error) {
        loopErrorCode = errorCode(error);
        console.error(`Evaluation worker error (${loopErrorCode})`);
      } finally {
        monitor.cycleCompleted(loopErrorCode);
        // Drain immediately while work exists; use the configured delay only
        // when idle so consecutive jobs never wait for an arbitrary poll gap.
        schedule(processedCount ? 0 : interval);
      }
    })();
  };
  schedule(0);
  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inFlight;
      monitor.stop();
    },
  };
}
