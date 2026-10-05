import { createHash, randomUUID } from "node:crypto";
import { runtimeConfig } from "../config/env.js";
import { PROMPT_VERSION } from "../prompts.js";
import { evaluateImage } from "./visionEngine.js";
import { CHECKPOINT_VERSION, improvementTips } from "../checkpoints.js";
import { enqueueNotification } from "./notificationWorker.js";
import { createWorkerMonitor } from "./workerHealth.js";
import {
  deleteEvaluation,
  evaluationFilter,
  getEvaluation,
  saveEvaluation,
} from "../stores/evaluationStore.js";
import { createIdleBackoff, createSweepSchedule } from "./workerPacing.js";
import { incrementMetric } from "./telemetry.js";
import { downloadPhoto } from "./photoStorage.js";
import { enqueueMailJob } from "./mailWorker.js";
import { idMatch } from "../middleware/auth.js";
import { reportRecipientsFor } from "./reportRecipients.js";
import { ensureReportToken, localDateKey } from "./instructorReports.js";
import { appUrl } from "../config/env.js";
import { jobCollection } from "../stores/jobStore.js";

const WORKER_ID = randomUUID();
const EVALUATION_OUTBOX_FIELD = "_private_evaluation_outbox";

const evaluationWakeups = new Set();

export function onEvaluationQueued(listener) {
  evaluationWakeups.add(listener);
  return () => evaluationWakeups.delete(listener);
}

function notifyEvaluationQueued() {
  for (const listener of evaluationWakeups) {
    try {
      listener();
    } catch {
    }
  }
}
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

function evaluationJobId(attendanceId, kind = "checkin") {
  return kind === "checkout"
    ? `${attendanceId}:evaluation:checkout`
    : `${attendanceId}:evaluation`;
}

function jobKind(job) {
  return job?.kind === "checkout" ? "checkout" : "checkin";
}

const PERMANENT_EVALUATION_ERRORS = new Set([
  "GEMINI_REQUEST_ERROR",
  "GEMINI_AUTH_ERROR",
]);

export function isPermanentEvaluationFailure(error) {
  return PERMANENT_EVALUATION_ERRORS.has(errorCode(error));
}

function errorCode(error, fallback = "EVALUATION_ERROR") {
  const value = String(error?.code || error?.name || fallback).toUpperCase();
  return /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : fallback;
}

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
  const instructor = instructorId
    ? await db.collection("instructors").findOne({ _id: idMatch(String(instructorId)) })
    : null;
  if (!instructor) {
    console.error(`Grooming alert skipped: instructor ${instructorId} was not found`);
    return;
  }

  const token = await ensureReportToken(db, instructor);
  const dayKey = localDateKey(new Date(checkInTime || Date.now()));
  const reportUrl = `${appUrl()}/reports/${token}/day/${dayKey}/${
    kind === "checkout" ? "check-out" : "check-in"
  }`;
  const payload = {
    name: instructorName || instructor.name,
    status,
    summary,
    dateLabel: localDateKey(new Date(eventTime || checkInTime || Date.now())),
    reportUrl,
    kind,
  };

  const deliveries = [];
  const to = instructorEmail || instructor.email;
  if (to) {
    deliveries.push({ to, role: "instructor", payload });
  }

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

function recipientKey(email) {
  return createHash("sha256").update(String(email).trim().toLowerCase()).digest("hex").slice(0, 20);
}

function halfReportUrl(token, dayKey, kind) {
  return `${appUrl()}/reports/${token}/day/${dayKey}/${kind === "checkout" ? "check-out" : "check-in"}`;
}

async function sendComplianceReports(db, {
  attendanceId,
  instructorId,
  instructorName,
  summary,
  checkInTime,
  eventTime = checkInTime,
  kind = "checkin",
}) {
  const recipients = await reportRecipientsFor(db, kind);
  if (!recipients.length) return 0;
  const instructor = instructorId
    ? await db.collection("instructors").findOne({ _id: idMatch(String(instructorId)) })
    : null;
  if (!instructor) return 0;

  const token = await ensureReportToken(db, instructor);
  const payload = {
    name: instructorName || instructor.name,
    status: "compliant",
    summary,
    dateLabel: localDateKey(new Date(eventTime || checkInTime || Date.now())),
    reportUrl: halfReportUrl(token, localDateKey(new Date(checkInTime || Date.now())), kind),
    kind,
    role: "reporting_partner",
    forReviewer: true,
  };
  for (const recipient of recipients) {
    await enqueueMailJob(db, {
      id: `${attendanceId}:compliance-report:${kind}:reporting_partner:${recipientKey(recipient)}`,
      type: "grooming_alert",
      toEmail: recipient,
      attendanceId,
      payload,
    });
  }
  return recipients.length;
}

export const ESCALATION_THRESHOLD = 3;

const NON_COMPLIANT_STATUSES = new Set(["non_compliant", "fail"]);

export function weekStartKey(dayKey) {
  const [year, month, day] = String(dayKey).split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

export function addDaysToKey(dayKey, days) {
  const [year, month, day] = String(dayKey).split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

export function nonCompliantOccurrences(records) {
  const occurrences = [];
  for (const record of records || []) {
    if (record.deleting_at) continue;
    if (NON_COMPLIANT_STATUSES.has(String(record.status || "").toLowerCase())) {
      occurrences.push({
        kind: "checkin",
        day: record.attendance_day,
        time: record.check_in_time || null,
        summary: record.remarks || "",
      });
    }
    if (
      !record.checkout_deleting_at
      && String(record.checkout_compliance_status || "").toUpperCase() === "NON_COMPLIANT"
    ) {
      occurrences.push({
        kind: "checkout",
        day: record.attendance_day,
        time: record.check_out_time || record.check_in_time || null,
        summary: record.checkout_remarks || "",
      });
    }
  }
  return occurrences.sort((a, b) => new Date(a.time || 0) - new Date(b.time || 0));
}

const RUN_BREAKING_STATUSES = new Set(["compliant", "done", "needs_review", "review_required"]);

export function failedDayStreaks(records, weekStart) {
  const byDay = new Map();
  for (const record of records || []) {
    if (record?.deleting_at || !record?.attendance_day) continue;
    const existing = byDay.get(record.attendance_day);
    if (!existing || new Date(record.check_in_time || 0) < new Date(existing.check_in_time || 0)) {
      byDay.set(record.attendance_day, record);
    }
  }
  const streaks = [];
  let current = [];
  for (let offset = 0; offset < 7; offset += 1) {
    const record = byDay.get(addDaysToKey(weekStart, offset));
    const status = String(record?.status || "").toLowerCase();
    if (record && NON_COMPLIANT_STATUSES.has(status)) {
      current.push(record);
    } else if (record && RUN_BREAKING_STATUSES.has(status) && current.length) {
      streaks.push(current);
      current = [];
    }
  }
  if (current.length) streaks.push(current);
  return streaks;
}

export function longestFailedStreak(records, weekStart) {
  return failedDayStreaks(records, weekStart)
    .reduce((longest, streak) => (streak.length >= longest.length ? streak : longest), []);
}

async function escalateRepeatedNonCompliance(db, { attendanceId, instructorId, kind = "checkin" }) {
  if (!instructorId) return 0;
  if (kind !== "checkin") return 0;
  const attendance = await db.collection("attendance").findOne(
    { _id: attendanceId },
    { projection: { attendance_day: 1, check_in_time: 1 } }
  );
  const dayKey = attendance?.attendance_day
    || localDateKey(new Date(attendance?.check_in_time || Date.now()));
  const weekStart = weekStartKey(dayKey);
  const weekEnd = addDaysToKey(weekStart, 6);

  const records = await db.collection("attendance").find(
    {
      instructor_id: idMatch(String(instructorId)),
      attendance_day: { $gte: weekStart, $lte: weekEnd },
      deleting_at: { $exists: false },
    },
    {
      projection: {
        attendance_day: 1,
        check_in_time: 1,
        check_out_time: 1,
        status: 1,
        remarks: 1,
        checkout_compliance_status: 1,
        checkout_remarks: 1,
        checkout_deleting_at: 1,
      },
    }
  ).toArray();
  const streak = failedDayStreaks(records, weekStart)
    .find((days) => days.some((record) => record.attendance_day === dayKey)) || [];
  if (streak.length < ESCALATION_THRESHOLD) return 0;
  const occurrences = streak.map((record) => ({
    kind: "checkin",
    day: record.attendance_day,
    time: record.check_in_time || null,
    summary: record.remarks || "",
  }));

  const recipients = await reportRecipientsFor(db, kind);
  if (!recipients.length) return 0;
  const instructor = await db.collection("instructors").findOne({ _id: idMatch(String(instructorId)) });
  if (!instructor) return 0;

  const token = await ensureReportToken(db, instructor);
  const payload = {
    name: instructor.name,
    count: occurrences.length,
    streak: true,
    weekStart,
    weekEnd,
    occurrences: occurrences.map((occurrence) => ({
      kind: occurrence.kind,
      day: occurrence.day,
      time: occurrence.time ? new Date(occurrence.time).toISOString() : null,
      summary: occurrence.summary,
      reportUrl: halfReportUrl(token, occurrence.day, occurrence.kind),
    })),
  };
  for (const recipient of recipients) {
    await enqueueMailJob(db, {
      id: `escalation:${instructorId}:streak:${streak[0].attendance_day}:${streak.length}:${recipientKey(recipient)}`,
      type: "grooming_escalation",
      toEmail: recipient,
      attendanceId,
      payload,
    });
  }
  incrementMetric("grooming_escalations_total");
  return recipients.length;
}

async function notifyReportingPartners(db, { attendanceStatus, ...details }) {
  if (attendanceStatus === "compliant") {
    try {
      await sendComplianceReports(db, details);
    } catch (error) {
      console.error(`Compliance report not queued for ${details.attendanceId}: ${error?.name || "Error"}`);
    }
  }
  if (attendanceStatus === "non_compliant") {
    try {
      await escalateRepeatedNonCompliance(db, details);
    } catch (error) {
      console.error(`Escalation not checked for ${details.attendanceId}: ${error?.name || "Error"}`);
    }
  }
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
    attire_type: report.attire_type || "UNKNOWN",
    visible_regions: report.visible_regions || null,
    detail_check: report.detail_check || null,
    unassessed_reason: report.unassessed_reason || null,
    improvement_tips: improvementTips(report),
    model: runtimeConfig().geminiModel,
    prompt_version: PROMPT_VERSION,
    checkpoint_version: CHECKPOINT_VERSION,
    processed_at: now,
    attempts: job.attempts,
  };
}

export async function enqueueEvaluation(db, payload) {
  const now = new Date();
  const deadlineAt = payload.deadlineAt || new Date(now.getTime() + EVALUATION_DEADLINE_MS);
  const kind = payload.kind === "checkout" ? "checkout" : "checkin";
  const jobId = evaluationJobId(payload.attendanceId, kind);
  await jobCollection(db, "evaluation_jobs").updateOne(
    { _id: jobId },
    {
      $setOnInsert: {
        _id: jobId,
        attendance_id: payload.attendanceId,
        kind,
        instructor: payload.instructor,
        photo_key: payload.photoKey || null,
        ...(payload.imageBuffer ? { image: payload.imageBuffer } : {}),
        mime_type: payload.mimeType,
        check_in_time: payload.checkInTime,
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
  const storedJob = await jobCollection(db, "evaluation_jobs").findOne(
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
  notifyEvaluationQueued();
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
  const result = await jobCollection(db, "evaluation_jobs").findOneAndUpdate(
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

async function bodyRegionsFor(db, attendanceId, kind) {
  const field = kind === "checkout" ? "check_out_body_regions" : "check_in_body_regions";
  try {
    const record = await db.collection("attendance").findOne({ _id: attendanceId }, { projection: { [field]: 1 } });
    return record?.[field] || null;
  } catch {
    return null;
  }
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
  const result = await jobCollection(db, "evaluation_jobs").updateOne(
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
  const evaluationKind = evaluation?.kind === "checkout" ? "checkout" : "checkin";
  if (evaluationKind !== jobKind(job)) {
    throw new Error(
      `Refusing to record a ${evaluationKind} evaluation against the ${jobKind(job)} half of ${job.attendance_id}`
    );
  }

  const now = new Date();
  const overallStatus = evaluation.overall_status;
  const imageQuality = evaluation.image_quality || "RETAKE_RECOMMENDED";
  const attendanceStatus = overallStatus === "UNASSESSED"
    ? "unassessed"
    : overallStatus === "COMPLIANT" ? "compliant" : "non_compliant";

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
    await notifyReportingPartners(db, {
      attendanceStatus,
      attendanceId: job.attendance_id,
      instructorId: job.instructor?.id,
      instructorName: job.instructor?.name,
      summary: evaluation.ai_summary || "",
      checkInTime: job.check_in_time,
      eventTime: job.check_out_time || job.check_in_time,
      kind: "checkout",
    });

    if (job._id) {
      await jobCollection(db, "evaluation_jobs").deleteOne({
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
  await notifyReportingPartners(db, {
    attendanceStatus,
    attendanceId: job.attendance_id,
    instructorId: job.instructor?.id,
    instructorName: job.instructor?.name,
    summary: evaluation.ai_summary || "",
    checkInTime: job.check_in_time,
    kind: jobKind(job),
  });
  await jobCollection(db, "evaluation_jobs").deleteOne({
    _id: job._id,
    worker_id: WORKER_ID,
    status: ownedStatus,
  });
  return true;
}

export { evaluationFilter };

async function completeEvaluation(db, job, report) {
  if (!(await renewEvaluationLease(db, job))) return false;
  if (!(await evaluationTargetExists(db, job))) {
    await jobCollection(db, "evaluation_jobs").deleteOne({
      _id: job._id,
      status: "processing",
      worker_id: WORKER_ID,
    });
    return false;
  }

  const now = new Date();
  const evaluation = { ...publicEvaluation(report, job, now), kind: jobKind(job) };
  await saveEvaluation(db, job.attendance_id, jobKind(job), evaluation, now);
  const synced = await syncStoredEvaluation(db, job, evaluation, "processing");
  if (!synced) {
    await deleteEvaluation(db, job.attendance_id, jobKind(job));
    return false;
  }
  return true;
}

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
  const report = await evaluateImage(
    source.buffer,
    source.mimeType || mimeType,
    instructor?.gender,
    {
      timeoutMs: config.geminiInteractiveTimeoutMs,
      maxRetries: config.geminiInteractiveMaxRetries,
    },
    { bodyRegions: await bodyRegionsFor(db, attendanceId, "checkout") }
  );
  const now = new Date();
  const job = {
    attendance_id: attendanceId,
    kind: "checkout",
    instructor,
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
  await saveEvaluation(db, attendanceId, "checkout", evaluation, now);
  const synced = await syncStoredEvaluation(db, job, evaluation, null);
  if (!synced || !(await evaluationTargetExists(db, { ...job, photo_key: photoKey }))) {
    await deleteEvaluation(db, attendanceId, "checkout");
    const error = new Error("Checkout was removed before the report was committed");
    error.code = "ATTENDANCE_NOT_FOUND";
    throw error;
  }
  return evaluation;
}

export async function recoverClaimedEvaluation(db, job) {
  const storedEvaluation = await getEvaluation(db, job.attendance_id, jobKind(job));
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
  await jobCollection(db, "evaluation_jobs").updateOne(
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
  const storedJob = await jobCollection(db, "evaluation_jobs").findOne({ _id: jobId });
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

  await jobCollection(db, "evaluation_jobs").updateOne(
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
    });
  }
  const failureNotification = buildFailureNotification(job, now);
  const result = await jobCollection(db, "evaluation_jobs").findOneAndUpdate(
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
  const job = await jobCollection(db, "evaluation_jobs").findOne(
    { status: "failed", failure_synced_at: { $exists: false } },
    { sort: { failed_at: 1 } }
  );
  if (!job) return false;
  await syncFailedEvaluationOutcome(db, job);
  return true;
}

export async function retryEvaluation(db, job, error) {
  const storedEvaluation = await getEvaluation(db, job.attendance_id, jobKind(job));
  if (storedEvaluation) {
    if (await renewEvaluationLease(db, job)) {
      await syncStoredEvaluation(db, job, storedEvaluation, "processing");
    }
    return;
  }

  if (error?.retryable === false) {
    await markEvaluationFailed(db, job, error);
    return;
  }

  const config = runtimeConfig();
  if (isPermanentEvaluationFailure(error) || job.attempts >= config.evaluationMaxAttempts) {
    await markEvaluationFailed(db, job, error);
    return;
  }
  await jobCollection(db, "evaluation_jobs").updateOne(
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

export async function reconcileExpiredEvaluationJobs(db, now = new Date()) {
  const config = runtimeConfig();
  const result = await jobCollection(db, "evaluation_jobs").findOneAndUpdate(
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
    const storedEvaluation = await getEvaluation(db, job.attendance_id, jobKind(job));
    if (storedEvaluation) {
      await syncStoredEvaluation(db, job, storedEvaluation, "recovering");
    } else {
      const error = new Error("Evaluation worker lease expired on the final attempt");
      error.name = "EVALUATION_LEASE_EXPIRED";
      await markEvaluationFailed(db, job, error, "recovering");
    }
    return true;
  } catch (error) {
    await jobCollection(db, "evaluation_jobs").updateOne(
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

export async function reconcileOverdueEvaluationJobs(db, now = new Date()) {
  const config = runtimeConfig();
  const legacyCutoff = new Date(now.getTime() - EVALUATION_DEADLINE_MS);
  const result = await jobCollection(db, "evaluation_jobs").findOneAndUpdate(
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
    const storedEvaluation = await getEvaluation(db, job.attendance_id, jobKind(job));
    if (storedEvaluation) {
      await syncStoredEvaluation(db, job, storedEvaluation, "recovering");
    } else {
      const error = new Error("Evaluation deadline exceeded");
      error.name = "EVALUATION_DEADLINE_EXCEEDED";
      await markEvaluationFailed(db, job, error, "recovering");
    }
    return true;
  } catch (error) {
    await jobCollection(db, "evaluation_jobs").updateOne(
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
  const backoff = createIdleBackoff({ minMs: interval, maxMs: config.workerIdleMaxPollMs });
  const sweeps = createSweepSchedule(config.workerSweepIntervalMs);
  let sweepBacklog = false;
  const monitor = createWorkerMonitor("evaluation", {
    busyStaleAfterMs: config.evaluationLeaseMs + 60000,
  });

  let idle = false;
  let wokenMidCycle = false;

  const schedule = (delay = interval) => {
    if (stopped) return;
    idle = delay > 0;
    timer = setTimeout(() => {
      idle = false;
      tick();
    }, delay);
  };

  const wake = () => {
    if (stopped) return;
    if (!idle) {
      wokenMidCycle = true;
      return;
    }
    idle = false;
    backoff.reset();
    if (timer) clearTimeout(timer);
    timer = setTimeout(tick, 0);
  };
  const stopListening = onEvaluationQueued(wake);
  const processJob = async (job) => {
    try {
      if (!(await evaluationTargetExists(db, job))) {
        await jobCollection(db, "evaluation_jobs").deleteOne({
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
          job.instructor.gender,
          undefined,
          { bodyRegions: await bodyRegionsFor(db, job.attendance_id, jobKind(job)) }
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
    wokenMidCycle = false;
    let loopErrorCode = null;
    let processedCount = 0;
    inFlight = (async () => {
      try {
        if (sweepBacklog || sweeps.due()) {
          sweepBacklog = false;
          let repaired = await reconcileEvaluationOutbox(db);
          monitor.progress("evaluation_outbox_reconciled");
          repaired = await reconcileOverdueEvaluationJobs(db) || repaired;
          monitor.progress("overdue_jobs_reconciled");
          repaired = await reconcileExpiredEvaluationJobs(db) || repaired;
          monitor.progress("expired_leases_reconciled");
          repaired = await reconcileFailedEvaluationOutcomes(db) || repaired;
          monitor.progress("failed_outcomes_reconciled");
          sweepBacklog = repaired;
        }
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
        schedule(backoff.afterCycle(processedCount > 0 || sweepBacklog || wokenMidCycle));
      }
    })();
  };
  schedule(0);
  return {
    async stop() {
      stopped = true;
      stopListening();
      if (timer) clearTimeout(timer);
      await inFlight;
      monitor.stop();
    },
  };
}
