import { randomUUID } from "node:crypto";
import { appUrl, runtimeConfig } from "../config/env.js";
import {
  sendAttendanceReminderEmail,
  sendDailyReportEmail,
  sendEscalationEmail,
  sendGroomingAlertEmail,
  sendPasswordResetEmail,
  sendWeeklyReportEmail,
} from "./emailService.js";
import {
  buildDailyReportForEmail,
  campusReportUrl,
  dailyReportDayUrl,
  dailyReportSubject,
  ensureCampusReportDay,
  ensureDailyReportDay,
} from "./dailyReport.js";
import { idMatch } from "../middleware/auth.js";
import { dateBoundsInTimeZone } from "../utils.js";
import { createWorkerMonitor } from "./workerHealth.js";
import { createIdleBackoff, createWakeSignal } from "./workerPacing.js";
import { openSecret } from "./secretBox.js";
import { completeDeliveryRunIfDone, getDeliveryRun, recordDeliveryOutcome } from "../stores/deliveryRunStore.js";
import { jobCollection } from "../stores/jobStore.js";

const WORKER_ID = randomUUID();
const mailQueued = createWakeSignal();
const SUPPORTED_TYPES = new Set([
  "password_reset",
  "weekly_report",
  "attendance_reminder",
  "grooming_alert",
  "grooming_escalation",
  "daily_report",
  "daily_report_campus",
  "checkin_reminder",
]);

export function canonicalReportUrl(reportUrl) {
  if (!reportUrl) return reportUrl;
  const canonicalOrigin = appUrl();
  if (!canonicalOrigin) return reportUrl;
  try {
    const parsed = new URL(reportUrl, `${canonicalOrigin}/`);
    if (!parsed.pathname.startsWith("/reports/")) return reportUrl;
    return `${canonicalOrigin}${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return reportUrl;
  }
}

function deliveryPayload(job) {
  if (!job.payload?.reportUrl) return job.payload;
  return {
    ...job.payload,
    reportUrl: canonicalReportUrl(job.payload.reportUrl),
  };
}

function escalationPayload(job) {
  const payload = job.payload || {};
  return {
    ...payload,
    occurrences: (payload.occurrences || []).map((occurrence) => ({
      ...occurrence,
      reportUrl: canonicalReportUrl(occurrence.reportUrl),
    })),
  };
}

export async function enqueueMailJob(db, { id, type, toEmail, payload, attendanceId = null, runId = null }) {
  if (!SUPPORTED_TYPES.has(type)) throw new Error(`Unsupported mail job type: ${type}`);
  if (!id || !toEmail) return false;
  const now = new Date();
  await jobCollection(db, "mail_jobs").updateOne(
    { _id: id },
    {
      $setOnInsert: {
        _id: id,
        type,
        to_email: toEmail,
        payload,
        attendance_id: attendanceId,
        run_id: runId,
        status: "queued",
        attempts: 0,
        available_at: now,
        created_at: now,
      },
    },
    { upsert: true }
  );
  mailQueued.notify();
  return true;
}

async function claimMail(db) {
  const now = new Date();
  const leaseMs = runtimeConfig().notificationLeaseMs;
  const result = await jobCollection(db, "mail_jobs").findOneAndUpdate(
    {
      attempts: { $lt: runtimeConfig().notificationMaxAttempts },
      $or: [
        { status: "queued", available_at: { $lte: now } },
        { status: "processing", lease_until: { $lte: now } },
      ],
    },
    {
      $set: {
        status: "processing",
        worker_id: WORKER_ID,
        lease_until: new Date(now.getTime() + leaseMs),
        updated_at: now,
      },
      $inc: { attempts: 1 },
    },
    { sort: { created_at: 1 }, returnDocument: "after" }
  );
  return result?.value || result;
}

function passwordResetPayload(payload) {
  if (!payload?.token_sealed) return payload;
  const { token_sealed: sealed, ...rest } = payload;
  return { ...rest, token: openSecret(sealed) };
}

async function deliverDailyReport(db, job) {
  const runId = job.run_id || job.payload?.run_id;
  const run = runId ? await getDeliveryRun(db, runId) : null;
  if (!run) {
    throw Object.assign(new Error("Daily report run not found"), { code: "DAILY_REPORT_RUN_MISSING" });
  }
  const report = await buildDailyReportForEmail(db, run);
  const day = await ensureDailyReportDay(db, run.date);
  return sendDailyReportEmail(job.to_email, { ...report, pageUrl: dailyReportDayUrl(day) });
}

async function deliverCampusDailyReport(db, job) {
  const runId = job.run_id || job.payload?.run_id;
  const run = runId ? await getDeliveryRun(db, runId) : null;
  if (!run) {
    throw Object.assign(new Error("Daily report run not found"), { code: "DAILY_REPORT_RUN_MISSING" });
  }
  const collegeId = String(job.payload?.college_id || "");
  const college = collegeId
    ? await db.collection("colleges").findOne({ _id: idMatch(collegeId) }, { projection: { name: 1 } })
    : null;
  if (!college) {
    throw Object.assign(new Error("Institute not found"), { code: "DAILY_REPORT_CAMPUS_MISSING" });
  }
  const report = await buildDailyReportForEmail(db, run);
  const link = await ensureCampusReportDay(db, run.date, college);
  return sendDailyReportEmail(job.to_email, {
    ...report,
    subject: dailyReportSubject(run.date, college.name),
    institute: college.name,
    rows: report.rows.filter((row) => row.collegeId === String(college._id)),
    pageUrl: campusReportUrl(link),
  });
}

async function deliver(db, job) {
  if (job.type === "daily_report") return deliverDailyReport(db, job);
  if (job.type === "daily_report_campus") return deliverCampusDailyReport(db, job);
  if (job.type === "checkin_reminder") return sendAttendanceReminderEmail(job.to_email, job.payload);
  if (job.type === "password_reset") return sendPasswordResetEmail(job.to_email, passwordResetPayload(job.payload));
  if (job.type === "weekly_report") return sendWeeklyReportEmail(job.to_email, deliveryPayload(job));
  if (job.type === "grooming_alert") return sendGroomingAlertEmail(job.to_email, deliveryPayload(job));
  if (job.type === "grooming_escalation") return sendEscalationEmail(job.to_email, escalationPayload(job));
  return sendAttendanceReminderEmail(job.to_email, job.payload);
}

export async function recordRunTerminal(db, runId, outcome, now) {
  const run = await recordDeliveryOutcome(db, runId, outcome, now);
  if (run && run.terminal >= run.queued) {
    await completeDeliveryRunIfDone(db, runId, { status: "completed", finished_at: now, updated_at: now });
  }
}

async function checkedInSinceQueued(db, payload) {
  if (!payload?.instructor_id || !payload?.date) return false;
  const { start, end } = dateBoundsInTimeZone(payload.date, runtimeConfig().appTimeZone);
  const record = await db.collection("attendance").findOne(
    {
      instructor_id: String(payload.instructor_id),
      check_in_time: { $gte: start, $lt: end },
      deleting_at: { $exists: false },
    },
    { projection: { _id: 1 } }
  );
  return Boolean(record);
}

async function processMail(db, job) {
  try {
    if (job.type === "checkin_reminder" && await checkedInSinceQueued(db, job.payload)) {
      await db.collection("mail_jobs").deleteOne({ _id: job._id, worker_id: WORKER_ID });
      return;
    }
    if (job.attendance_id) {
      const checkoutAlert = job.type === "grooming_alert" && job.payload?.kind === "checkout";
      const attendance = await db.collection("attendance").findOne(
        {
          _id: job.attendance_id,
          deleting_at: { $exists: false },
          ...(job.type === "attendance_reminder" ? { check_out_time: null } : {}),
          ...(checkoutAlert ? {
            checkout_deleting_at: { $exists: false },
            check_out_time: { $ne: null },
          } : {}),
        },
        { projection: { _id: 1 } }
      );
      if (!attendance) {
        await jobCollection(db, "mail_jobs").deleteOne({ _id: job._id, worker_id: WORKER_ID });
        return;
      }
    }
    const result = await deliver(db, job);
    if (!result.sent) throw Object.assign(new Error(result.reason || "Email was not accepted"), { code: result.reason });
    const now = new Date();
    await jobCollection(db, "mail_jobs").updateOne(
      { _id: job._id, status: "processing", worker_id: WORKER_ID },
      {
        $set: {
          status: "sent",
          sent_at: now,
          message_id: result.messageId || null,
          expires_at: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
        },
        $unset: { to_email: "", payload: "", worker_id: "", lease_until: "", last_error: "" },
      }
    );
    if (job.type === "attendance_reminder" && job.attendance_id) {
      await db.collection("attendance").updateOne(
        { _id: job.attendance_id, deleting_at: { $exists: false } },
        { $set: { checkout_reminder_sent_at: now } }
      );
    }
    if (job.type === "grooming_alert" && job.attendance_id) {
      await db.collection("attendance").updateOne(
        { _id: job.attendance_id, deleting_at: { $exists: false } },
        {
          $push: {
            alert_deliveries: {
              role: job.payload?.role || "recipient",
              sent: true,
              message_id: result.messageId || null,
              sent_at: now,
            },
          },
          $set: { alert_sent_at: now },
        }
      );
    }
    if (job.run_id) {
      await recordRunTerminal(db, job.run_id, "sent", now);
    }
  } catch (error) {
    const terminal = job.attempts >= runtimeConfig().notificationMaxAttempts;
    const now = new Date();
    await jobCollection(db, "mail_jobs").updateOne(
      { _id: job._id, status: "processing", worker_id: WORKER_ID },
      {
        $set: {
          status: terminal ? "failed" : "queued",
          available_at: new Date(now.getTime() + Math.min(300_000, 5_000 * (2 ** Math.max(0, job.attempts - 1)))),
          last_error: String(error?.code || error?.name || "MAIL_ERROR").slice(0, 80),
          updated_at: now,
          ...(terminal ? { expires_at: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000) } : {}),
        },
        $unset: { worker_id: "", lease_until: "" },
      }
    );
    if (terminal && job.run_id) {
      await recordRunTerminal(db, job.run_id, "failed", now);
    }
  }
}

export function startMailWorker(db) {
  let stopped = false;
  let timer = null;
  let inFlight = Promise.resolve();
  const config = runtimeConfig();
  const monitor = createWorkerMonitor("mail", { busyStaleAfterMs: config.notificationLeaseMs + 60_000 });
  const backoff = createIdleBackoff({
    minMs: Math.max(1000, config.evaluationPollMs),
    maxMs: config.workerIdleMaxPollMs,
  });
  let idle = false;
  let wokenMidCycle = false;
  const schedule = (delay) => {
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
  const stopListening = mailQueued.listen(wake);
  const tick = () => {
    monitor.cycleStarted();
    wokenMidCycle = false;
    let loopError = null;
    let count = 0;
    inFlight = (async () => {
      try {
        const jobs = (await Promise.all(
          Array.from({ length: config.notificationConcurrency }, () => claimMail(db))
        )).filter(Boolean);
        count = jobs.length;
        monitor.progress(count ? "jobs_claimed" : "queue_idle");
        await Promise.all(jobs.map((job) => processMail(db, job)));
      } catch (error) {
        loopError = String(error?.code || error?.name || "MAIL_WORKER_ERROR");
        console.error(`Mail worker error (${loopError})`);
      } finally {
        monitor.cycleCompleted(loopError);
        schedule(backoff.afterCycle(count > 0 || wokenMidCycle));
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
