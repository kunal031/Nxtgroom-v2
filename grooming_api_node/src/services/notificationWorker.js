import { randomUUID } from "node:crypto";
import { appUrl, runtimeConfig } from "../config/env.js";
import { idMatch } from "../middleware/auth.js";
import { sendCheckoutEmail, sendEvaluationEmail } from "./emailService.js";
import { ensureReportToken, localDateKey } from "./instructorReports.js";
import { getNotificationSettings, shouldSendNotification } from "./notificationSettings.js";
import { createWorkerMonitor } from "./workerHealth.js";
import { createIdleBackoff, createSweepSchedule, createWakeSignal } from "./workerPacing.js";
import { jobCollection } from "../stores/jobStore.js";
import { coreCollection } from "../stores/coreStore.js";

const WORKER_ID = randomUUID();
const NOTIFICATION_OUTBOX_FIELDS = {
  checkin: "_private_checkin_outbox",
  checkout: "_private_checkout_outbox",
};
const TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const NOTIFICATION_DEADLINE_MS = 24 * 60 * 60 * 1000;
const TERMINAL_STATUSES = new Set(["sent", "failed", "delivery_unknown"]);
const notificationQueued = createWakeSignal();

function updated(result) {
  return Boolean(result && (result.matchedCount > 0 || result.modifiedCount > 0));
}

function assertNotificationType(type) {
  if (type !== "checkin" && type !== "checkout") {
    throw new Error(`Unsupported notification type: ${type}`);
  }
}

function notificationOutboxField(type) {
  assertNotificationType(type);
  return NOTIFICATION_OUTBOX_FIELDS[type];
}

function errorCode(error, fallback = "NOTIFICATION_ERROR") {
  const value = String(error?.code || error?.name || fallback).toUpperCase();
  return /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : fallback;
}

function terminalExpiry(now) {
  return new Date(now.getTime() + TERMINAL_RETENTION_MS);
}

async function syncNotificationStatus(db, job) {
  assertNotificationType(job.type);
  const outboxField = notificationOutboxField(job.type);
  const statusField = `${job.type}_email_status`;
  const set = { [statusField]: job.status };
  if (job.status === "sent") {
    set[`${job.type}_email_sent_at`] = job.sent_at || new Date();
    set[`${job.type}_email_message_id`] = job.message_id || null;
  }
  await coreCollection(db, "attendance").updateOne(
    { _id: job.attendance_id },
    {
      $set: set,
      $unset: { [outboxField]: "" },
    }
  );

  if (TERMINAL_STATUSES.has(job.status)) {
    const now = new Date();
    const terminalSet = {
      attendance_synced_at: now,
      expires_at: terminalExpiry(now),
      ...(job.status !== "sent" ? {
        last_error: errorCode({ code: job.last_error }, "NOTIFICATION_ERROR"),
      } : {}),
    };
    await jobCollection(db, "notification_jobs").updateOne(
      { _id: job._id, status: job.status, attendance_synced_at: { $exists: false } },
      {
        $set: terminalSet,
      }
    );
  }
}

export async function enqueueNotification(db, {
  attendanceId,
  type,
  toEmail,
  report,
  deadlineAt,
}) {
  assertNotificationType(type);
  const outboxField = notificationOutboxField(type);
  if (!toEmail) {
    await coreCollection(db, "attendance").updateOne(
      { _id: attendanceId },
      {
        $set: { [`${type}_email_status`]: "skipped_no_email" },
        $unset: { [outboxField]: "" },
      }
    );
    return false;
  }

  const settings = await getNotificationSettings(db);
  if (!shouldSendNotification(settings, type, report || {})) {
    await coreCollection(db, "attendance").updateOne(
      { _id: attendanceId },
      {
        $set: { [`${type}_email_status`]: "skipped_by_settings" },
        $unset: { [outboxField]: "" },
      }
    );
    return false;
  }

  const now = new Date();
  const jobId = `${attendanceId}:${type}`;
  await jobCollection(db, "notification_jobs").updateOne(
    { _id: jobId },
    {
      $setOnInsert: {
        _id: jobId,
        attendance_id: attendanceId,
        type,
        to_email: toEmail,
        report,
        status: "queued",
        attempts: 0,
        available_at: now,
        deadline_at: deadlineAt || new Date(now.getTime() + NOTIFICATION_DEADLINE_MS),
        created_at: now,
      },
    },
    { upsert: true }
  );
  const job = await jobCollection(db, "notification_jobs").findOne({ _id: jobId });
  if (!job) throw new Error("Notification job could not be persisted");
  await syncNotificationStatus(db, job);
  if (job.status === "queued") notificationQueued.notify();
  return true;
}

async function reconcileNotificationOutbox(db, type) {
  const outboxField = notificationOutboxField(type);
  const attendance = await coreCollection(db, "attendance").findOne(
    { [outboxField]: { $exists: true } },
    { sort: { [`${outboxField}.created_at`]: 1 } }
  );
  if (!attendance) return false;

  const payload = attendance[outboxField] || {};
  const inferredDeadline = payload.deadline_at
    ? new Date(payload.deadline_at)
    : new Date(new Date(
      type === "checkout"
        ? attendance.check_out_time || attendance.updated_at
        : attendance.check_in_time || attendance.created_at
    ).getTime()
      + NOTIFICATION_DEADLINE_MS);
  if (Number.isNaN(inferredDeadline.getTime()) || inferredDeadline <= new Date()) {
    await coreCollection(db, "attendance").updateOne(
      { _id: attendance._id, [outboxField]: { $exists: true } },
      {
        $set: { [`${type}_email_status`]: "failed" },
        $unset: { [outboxField]: "" },
      }
    );
    return true;
  }
  await enqueueNotification(db, {
    attendanceId: attendance._id,
    type,
    toEmail: payload.to_email,
    report: payload.report || (type === "checkout"
      ? {
          instructorName: attendance.instructor_name || "Instructor",
          checkInTime: attendance.check_in_time,
          checkOutTime: attendance.check_out_time,
          status: attendance.status,
          remarks: attendance.remarks,
        }
      : {
          instructorName: attendance.instructor_name || "Instructor",
          overallStatus: "error",
          aiSummary: "AI analysis could not be completed. Check out this attendance, then check in again with a new photo.",
          checkInTime: attendance.check_in_time,
        }),
    deadlineAt: payload.deadline_at,
  });
  return true;
}

export function reconcileCheckinOutbox(db) {
  return reconcileNotificationOutbox(db, "checkin");
}

export function reconcileCheckoutOutbox(db) {
  return reconcileNotificationOutbox(db, "checkout");
}

async function claimNotification(db) {
  const now = new Date();
  const config = runtimeConfig();
  const legacyCutoff = new Date(now.getTime() - NOTIFICATION_DEADLINE_MS);
  const result = await jobCollection(db, "notification_jobs").findOneAndUpdate(
    {
      attempts: { $lt: config.notificationMaxAttempts },
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
        lease_until: new Date(now.getTime() + config.notificationLeaseMs),
        updated_at: now,
      },
      $inc: { attempts: 1 },
    },
    { sort: { created_at: 1 }, returnDocument: "after" }
  );
  return result?.value || result;
}

async function renewNotificationLease(db, job) {
  const now = new Date();
  const config = runtimeConfig();
  const result = await jobCollection(db, "notification_jobs").updateOne(
    {
      _id: job._id,
      status: "processing",
      worker_id: WORKER_ID,
      lease_until: { $gt: now },
    },
    {
      $set: {
        lease_until: new Date(now.getTime() + config.notificationLeaseMs),
        delivery_started_at: now,
        updated_at: now,
      },
    }
  );
  return updated(result);
}

async function deferCheckoutNotification(db, job) {
  const result = await jobCollection(db, "notification_jobs").updateOne(
    { _id: job._id, status: "processing", worker_id: WORKER_ID },
    {
      $set: {
        status: "queued",
        available_at: new Date(Date.now() + 15000),
        updated_at: new Date(),
      },
      $inc: { attempts: -1 },
      $unset: { lease_until: "", worker_id: "", delivery_started_at: "" },
    }
  );
  return updated(result);
}

async function reportUrlForAttendance(db, attendance, type) {
  const instructor = await coreCollection(db, "instructors").findOne({
    _id: idMatch(String(attendance.instructor_id)),
  });
  if (!instructor) {
    const error = new Error("Instructor unavailable for report link");
    error.name = "INSTRUCTOR_NOT_FOUND";
    throw error;
  }
  const token = await ensureReportToken(db, instructor);
  const sessionTime = new Date(attendance.check_in_time || attendance.date);
  if (Number.isNaN(sessionTime.getTime())) {
    const error = new Error("Attendance session date unavailable for report link");
    error.name = "ATTENDANCE_DATE_INVALID";
    throw error;
  }
  return `${appUrl()}/reports/${encodeURIComponent(token)}/day/${localDateKey(sessionTime)}/${
    type === "checkout" ? "check-out" : "check-in"
  }`;
}

export async function prepareCheckinReport(db, job) {
  if (job.type !== "checkin") return job;
  const attendance = await coreCollection(db, "attendance").findOne({ _id: job.attendance_id });
  if (!attendance) {
    const error = new Error("Attendance record unavailable");
    error.name = "ATTENDANCE_NOT_FOUND";
    throw error;
  }
  const reportUrl = await reportUrlForAttendance(db, attendance, "checkin");
  return { ...job, report: { ...job.report, reportUrl } };
}

export async function prepareCheckoutReport(db, job) {
  if (job.type !== "checkout") return job;
  const attendance = await coreCollection(db, "attendance").findOne({ _id: job.attendance_id });
  if (!attendance) {
    const error = new Error("Attendance record unavailable");
    error.name = "ATTENDANCE_NOT_FOUND";
    throw error;
  }

  const hasCheckoutPhoto = Boolean(attendance.check_out_photo_key);
  const checkoutAnalysisTerminal = new Set([
    "COMPLIANT",
    "NON_COMPLIANT",
    "UNASSESSED",
    "REVIEW_REQUIRED",
  ]).has(String(attendance.checkout_compliance_status || "").toUpperCase());
  if (hasCheckoutPhoto && !checkoutAnalysisTerminal) {
    await deferCheckoutNotification(db, job);
    return null;
  }
  const reportUrl = await reportUrlForAttendance(db, attendance, "checkout");

  return {
    ...job,
    report: {
      ...job.report,
      instructorName: attendance.instructor_name || job.report?.instructorName || "Instructor",
      checkInTime: attendance.check_in_time || job.report?.checkInTime,
      checkOutTime: attendance.check_out_time || job.report?.checkOutTime,
      status: hasCheckoutPhoto
        ? attendance.checkout_compliance_status
        : attendance.status,
      remarks: hasCheckoutPhoto
        ? attendance.checkout_remarks
        : attendance.remarks,
      imageQuality: hasCheckoutPhoto
        ? attendance.checkout_image_quality || null
        : attendance.image_quality || null,
      reportUrl,
    },
  };
}

async function deliverNotification(db, job) {
  const target = await coreCollection(db, "attendance").findOne(
    {
      _id: job.attendance_id,
      deleting_at: { $exists: false },
      ...(job.type === "checkout" ? {
        checkout_deleting_at: { $exists: false },
        check_out_time: { $ne: null },
      } : {}),
    },
    { projection: { _id: 1 } }
  );
  if (!target) {
    await jobCollection(db, "notification_jobs").deleteOne({
      _id: job._id,
      status: "processing",
      worker_id: WORKER_ID,
    });
    return false;
  }
  const preparedJob = job.type === "checkout"
    ? await prepareCheckoutReport(db, job)
    : await prepareCheckinReport(db, job);
  if (!preparedJob) return false;
  if (!(await renewNotificationLease(db, preparedJob))) return false;
  const stillPresent = await coreCollection(db, "attendance").findOne(
    {
      _id: job.attendance_id,
      deleting_at: { $exists: false },
      ...(job.type === "checkout" ? {
        checkout_deleting_at: { $exists: false },
        check_out_time: { $ne: null },
      } : {}),
    },
    { projection: { _id: 1 } }
  );
  if (!stillPresent) {
    await jobCollection(db, "notification_jobs").deleteOne({
      _id: job._id,
      status: "processing",
      worker_id: WORKER_ID,
    });
    return false;
  }

  const result = preparedJob.type === "checkout"
    ? await sendCheckoutEmail(preparedJob.to_email, preparedJob.report)
    : await sendEvaluationEmail(preparedJob.to_email, preparedJob.report);
  if (!result.sent) {
    const failure = new Error(result.reason || "ses_delivery_failed");
    failure.code = result.reason || "ses_delivery_failed";
    throw failure;
  }

  const now = new Date();
  const transition = await jobCollection(db, "notification_jobs").findOneAndUpdate(
    { _id: preparedJob._id, status: "processing", worker_id: WORKER_ID },
    {
      $set: {
        status: "sent",
        message_id: result.messageId || null,
        sent_at: now,
      },
      $unset: {
        to_email: "",
        report: "",
        lease_until: "",
        worker_id: "",
        delivery_started_at: "",
        last_error: "",
      },
    },
    { returnDocument: "after" }
  );
  const terminalJob = transition?.value || transition;
  if (terminalJob) {
    await syncNotificationStatus(db, terminalJob);
    return true;
  }

  const settled = {
    ...preparedJob,
    status: "sent",
    message_id: result.messageId || null,
    sent_at: now,
  };
  await jobCollection(db, "notification_jobs").updateOne(
    { _id: preparedJob._id },
    {
      $set: {
        status: "sent",
        message_id: settled.message_id,
        sent_at: now,
        lease_lost_after_send: true,
      },
      $unset: {
        to_email: "",
        report: "",
        lease_until: "",
        worker_id: "",
        delivery_started_at: "",
        last_error: "",
      },
    }
  );
  await syncNotificationStatus(db, settled);
  return true;
}

const NON_RETRYABLE_DELIVERY_REASONS = new Set([
  "SES_NOT_CONFIGURED",
  "MISSING_RECIPIENT",
  "MESSAGEREJECTED",
  "MAILFROMDOMAINNOTVERIFIEDEXCEPTION",
  "CONFIGURATIONSETDOESNOTEXISTEXCEPTION",
  "ACCOUNTSENDINGPAUSEDEXCEPTION",
]);

async function retryNotification(db, job, error) {
  const now = new Date();
  const exhausted = job.attempts >= runtimeConfig().notificationMaxAttempts
    || NON_RETRYABLE_DELIVERY_REASONS.has(errorCode(error));
  if (!exhausted) {
    await jobCollection(db, "notification_jobs").updateOne(
      { _id: job._id, worker_id: WORKER_ID, status: "processing" },
      {
        $set: {
          status: "queued",
          last_error: errorCode(error),
          available_at: new Date(now.getTime() + Math.min(600000, 5000 * 2 ** job.attempts)),
        },
        $unset: { lease_until: "", worker_id: "", delivery_started_at: "" },
      }
    );
    return;
  }

  const transition = await jobCollection(db, "notification_jobs").findOneAndUpdate(
    { _id: job._id, worker_id: WORKER_ID, status: "processing" },
    {
      $set: {
        status: "failed",
        last_error: errorCode(error),
        failed_at: now,
      },
      $unset: {
        to_email: "",
        report: "",
        lease_until: "",
        worker_id: "",
        delivery_started_at: "",
      },
    },
    { returnDocument: "after" }
  );
  const terminalJob = transition?.value || transition;
  if (terminalJob) await syncNotificationStatus(db, terminalJob);
}

export async function reconcileOverdueNotificationJobs(db, now = new Date()) {
  const legacyCutoff = new Date(now.getTime() - NOTIFICATION_DEADLINE_MS);
  let result = await jobCollection(db, "notification_jobs").findOneAndUpdate(
    {
      status: "queued",
      $or: [
        { deadline_at: { $lte: now } },
        { deadline_at: { $exists: false }, created_at: { $lte: legacyCutoff } },
      ],
    },
    {
      $set: {
        status: "failed",
        last_error: "NOTIFICATION_DEADLINE_EXCEEDED",
        failed_at: now,
      },
      $unset: {
        to_email: "",
        report: "",
        lease_until: "",
        worker_id: "",
        delivery_started_at: "",
      },
    },
    { sort: { deadline_at: 1 }, returnDocument: "after" }
  );
  let terminalJob = result?.value || result;
  if (!terminalJob) {
    result = await jobCollection(db, "notification_jobs").findOneAndUpdate(
      {
        status: "processing",
        lease_until: { $lte: now },
        $or: [
          { deadline_at: { $lte: now } },
          { deadline_at: { $exists: false }, created_at: { $lte: legacyCutoff } },
        ],
      },
      {
        $set: {
          status: "delivery_unknown",
          last_error: "NOTIFICATION_DEADLINE_EXCEEDED",
          failed_at: now,
        },
        $unset: {
          to_email: "",
          report: "",
          lease_until: "",
          worker_id: "",
          delivery_started_at: "",
        },
      },
      { sort: { deadline_at: 1 }, returnDocument: "after" }
    );
    terminalJob = result?.value || result;
  }
  if (!terminalJob) return false;
  await syncNotificationStatus(db, terminalJob);
  return true;
}

export async function reconcileExpiredNotificationJobs(db, now = new Date()) {
  const config = runtimeConfig();
  const result = await jobCollection(db, "notification_jobs").findOneAndUpdate(
    {
      status: "processing",
      attempts: { $gte: config.notificationMaxAttempts },
      lease_until: { $lte: now },
    },
    {
      $set: {
        status: "delivery_unknown",
        last_error: "NOTIFICATION_LEASE_EXPIRED",
        failed_at: now,
      },
      $unset: {
        to_email: "",
        report: "",
        lease_until: "",
        worker_id: "",
        delivery_started_at: "",
      },
    },
    { sort: { created_at: 1 }, returnDocument: "after" }
  );
  const terminalJob = result?.value || result;
  if (!terminalJob) return false;
  await syncNotificationStatus(db, terminalJob);
  return true;
}

export async function reconcileNotificationOutcome(db) {
  const job = await jobCollection(db, "notification_jobs").findOne(
    {
      status: { $in: [...TERMINAL_STATUSES] },
      attendance_synced_at: { $exists: false },
    },
    { sort: { created_at: 1 } }
  );
  if (!job) return false;
  await syncNotificationStatus(db, job);
  return true;
}

export function startNotificationWorker(db) {
  let stopped = false;
  let timer = null;
  let inFlight = Promise.resolve();
  const config = runtimeConfig();
  const interval = Math.max(1000, config.evaluationPollMs);
  const backoff = createIdleBackoff({ minMs: interval, maxMs: config.workerIdleMaxPollMs });
  const sweeps = createSweepSchedule(config.workerSweepIntervalMs);
  let sweepBacklog = false;
  const monitor = createWorkerMonitor("notification", {
    busyStaleAfterMs: config.notificationLeaseMs + 60000,
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
  const stopListening = notificationQueued.listen(wake);
  const processJob = async (job) => {
    try {
      monitor.progress("ses_delivery_started");
      await deliverNotification(db, job);
      monitor.progress("ses_delivery_completed");
    } catch (error) {
      monitor.recordJobError(errorCode(error));
      console.error(`Notification job ${job._id} failed (${errorCode(error)})`);
      await retryNotification(db, job, error);
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
          let repaired = await reconcileCheckinOutbox(db);
          monitor.progress("checkin_outbox_reconciled");
          repaired = await reconcileCheckoutOutbox(db) || repaired;
          monitor.progress("checkout_outbox_reconciled");
          repaired = await reconcileOverdueNotificationJobs(db) || repaired;
          monitor.progress("overdue_jobs_reconciled");
          repaired = await reconcileExpiredNotificationJobs(db) || repaired;
          monitor.progress("expired_leases_reconciled");
          repaired = await reconcileNotificationOutcome(db) || repaired;
          monitor.progress("terminal_outcomes_reconciled");
          sweepBacklog = repaired;
        }
        const jobs = (await Promise.all(
          Array.from({ length: config.notificationConcurrency }, () => claimNotification(db))
        )).filter(Boolean);
        processedCount = jobs.length;
        monitor.progress(jobs.length ? "jobs_claimed" : "queue_idle");
        await Promise.all(jobs.map(processJob));
      } catch (error) {
        loopErrorCode = errorCode(error);
        console.error(`Notification worker error (${loopErrorCode})`);
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
