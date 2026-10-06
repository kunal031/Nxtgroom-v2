import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { asyncRoute, dateBoundsInTimeZone } from "../utils.js";
import { idMatch, requireCronSecret } from "../middleware/auth.js";
import { appUrl, runtimeConfig } from "../config/env.js";
import {
  findInstructorByReportToken,
  isValidDateKey,
  localDateKey,
  summariseWeek,
  weekStartKey,
  workingWeekDates,
  ensureReportToken,
} from "../services/instructorReports.js";
import { getReportRecipients } from "../services/reportRecipients.js";
import {
  deliverAttendanceReminders,
  getAttendanceReminderSettings,
} from "../services/attendanceReminders.js";
import {
  buildFullDayReport,
  dailyReportPhotoKey,
  findCampusReportDay,
  findDailyReportDay,
} from "../services/dailyReport.js";
import {
  closeOpenCheckIns,
  dayToClose,
  openCheckInFilter,
} from "../services/openCheckIns.js";

import { getEvaluation } from "../stores/evaluationStore.js";
import {
  completeDeliveryRunIfDone,
  saveDeliveryRun,
} from "../stores/deliveryRunStore.js";
import { getPhotoUrl } from "../services/photoStorage.js";
import { enqueueMailJob } from "../services/mailWorker.js";
import {
  getNotificationSettings,
  shouldSendWeeklyReport,
} from "../services/notificationSettings.js";
import { coreCollection } from "../stores/coreStore.js";

export const reportRouter = Router();

const runningProducers = new Set();

function startProducer(runId, work) {
  if (runningProducers.has(runId)) return false;
  runningProducers.add(runId);
  void (async () => {
    try {
      await work();
    } catch (error) {
      console.error(`Producer ${runId} failed: ${error?.name || "Error"}`);
    } finally {
      runningProducers.delete(runId);
    }
  })();
  return true;
}

const publicReportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { detail: "Too many requests. Please try again later." },
});

reportRouter.get(
  "/daily/:date/:token",
  publicReportLimiter,
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    const day = await findDailyReportDay(db, req.params.date, req.params.token);
    if (!day) {
      return res.status(404).json({ detail: "This report link is invalid or has expired." });
    }
    const report = await buildFullDayReport(db, day.date, { ensureTokens: true });
    return res.json(dayReportResponse(report, day));
  })
);

function dayReportResponse(report, link) {
  return {
    title: report.subject,
    date_label: report.dateLabel,
    window_label: report.windowLabel,
    ...(report.institute !== undefined ? { institute: report.institute } : {}),
    rows: report.rows.map((row) => ({
      attendance_id: row.attendanceId,
      date: row.date,
      name: row.name,
      institute: row.institute,
      status: row.status,
      check_in: row.checkIn,
      check_out: row.checkOut,
      feedback: row.feedback,
      has_checkin_photo: row.hasCheckinPhoto,
      has_checkout_photo: row.hasCheckoutPhoto,
      checkin_report_url: row.checkinReportUrl,
      checkout_report_url: row.checkoutReportUrl,
    })),
  };
}

reportRouter.get(
  "/daily/:date/:campus/:token",
  publicReportLimiter,
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    const link = await findCampusReportDay(db, req.params.date, req.params.token);
    if (!link) {
      return res.status(404).json({ detail: "This report link is invalid or has expired." });
    }
    const report = await buildFullDayReport(db, link.date, { ensureTokens: true, collegeId: link.college_id });
    return res.json(dayReportResponse(report, link));
  })
);

reportRouter.get(
  "/daily/:date/:campus/:token/photo/:attendanceId/:kind",
  publicReportLimiter,
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    const link = await findCampusReportDay(db, req.params.date, req.params.token);
    if (!link) {
      return res.status(404).json({ detail: "This report link is invalid or has expired." });
    }
    if (!["checkin", "checkout"].includes(req.params.kind)) {
      return res.status(400).json({ detail: "Invalid photo" });
    }
    const key = await dailyReportPhotoKey(db, link.date, req.params.attendanceId, req.params.kind, {
      collegeId: link.college_id,
    });
    if (!key) return res.status(404).json({ detail: "No photo was stored for this record." });
    const url = await getPhotoUrl(key, { expiresIn: 900 });
    if (!url) return res.status(503).json({ detail: "Photo storage is unavailable right now" });
    return res.json({ url, expires_in: 900 });
  })
);

reportRouter.get(
  "/daily/:date/:token/photo/:attendanceId/:kind",
  publicReportLimiter,
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    const day = await findDailyReportDay(db, req.params.date, req.params.token);
    if (!day) {
      return res.status(404).json({ detail: "This report link is invalid or has expired." });
    }
    if (!["checkin", "checkout"].includes(req.params.kind)) {
      return res.status(400).json({ detail: "Invalid photo" });
    }
    const key = await dailyReportPhotoKey(db, day.date, req.params.attendanceId, req.params.kind);
    if (!key) return res.status(404).json({ detail: "No photo was stored for this record." });
    const url = await getPhotoUrl(key, { expiresIn: 900 });
    if (!url) return res.status(503).json({ detail: "Photo storage is unavailable right now" });
    return res.json({ url, expires_in: 900 });
  })
);

function reportInstructor(instructor) {
  return {
    name: instructor.name,
    role: instructor.instructor_role || instructor.role || null,
    institute: instructor.institute_name || null,
    employee_id: instructor.employee_id || null,
    email: instructor.email || null,
  };
}

function monthKeyOf(dateKey) {
  return dateKey.slice(0, 7);
}

async function loadInstructorWeek(db, instructor, startKey) {
  const dates = workingWeekDates(startKey);
  const from = new Date(`${dates[0]}T00:00:00.000Z`);
  from.setUTCDate(from.getUTCDate() - 1);
  const to = new Date(`${dates[dates.length - 1]}T23:59:59.999Z`);
  to.setUTCDate(to.getUTCDate() + 1);

  const records = await coreCollection(db, "attendance")
    .find({
      instructor_id: String(instructor._id),
      check_in_time: { $gte: from, $lte: to },
    })
    .sort({ check_in_time: 1 })
    .toArray();

  const inWeek = records.filter((record) => (
    dates.includes(localDateKey(new Date(record.check_in_time || record.date)))
  ));
  return summariseWeek(inWeek, startKey, { gender: instructor.gender });
}

async function loadInstructorMonth(db, instructor, monthKey) {
  const [year, month] = monthKey.split("-").map(Number);
  const next = new Date(Date.UTC(year, month, 1));
  const nextKey = next.toISOString().slice(0, 7);
  const zone = runtimeConfig().appTimeZone;
  const from = dateBoundsInTimeZone(`${monthKey}-01`, zone).start;
  const to = dateBoundsInTimeZone(`${nextKey}-01`, zone).start;
  const records = await coreCollection(db, "attendance")
    .find({ instructor_id: String(instructor._id), check_in_time: { $gte: from, $lt: to } })
    .sort({ check_in_time: 1 })
    .toArray();

  const uniqueDays = new Map();
  for (const record of records) {
    const key = localDateKey(new Date(record.check_in_time || record.date), zone);
    if (key.startsWith(`${monthKey}-`) && !uniqueDays.has(key)) uniqueDays.set(key, record);
  }
  const counted = [...uniqueDays.values()];
  return {
    month: monthKey,
    present_days: counted.length,
    compliant_days: counted.filter((r) => r.status === "compliant").length,
    non_compliant_days: counted.filter((r) => r.status === "non_compliant").length,
    saree_days: counted.filter((r) => r.attire_type === "SAREE").length,
    kurti_days: counted.filter((r) => r.attire_type === "KURTI_WITH_DUPATTA").length,
    formal_days: counted.filter((r) => r.attire_type === "FORMAL").length,
    abaya_days: counted.filter((r) => r.attire_type === "ABAYA").length,
    kurta_days: counted.filter((r) => r.attire_type === "KURTA_PAJAMA").length,
    missed_checkouts: counted.filter((r) => !r.check_out_time).length,
  };
}

reportRouter.get(
  "/:token/week/:weekStart",
  publicReportLimiter,
  asyncRoute(async (req, res) => {
    const { token, weekStart } = req.params;
    if (!isValidDateKey(weekStart)) {
      return res.status(400).json({ detail: "Invalid week" });
    }
    const db = req.app.locals.db;
    const instructor = await findInstructorByReportToken(db, token);
    if (!instructor) return res.status(404).json({ detail: "Report not found" });

    const normalizedStart = weekStartKey(new Date(`${weekStart}T12:00:00Z`));
    const [week, month] = await Promise.all([
      loadInstructorWeek(db, instructor, normalizedStart),
      loadInstructorMonth(db, instructor, monthKeyOf(normalizedStart)),
    ]);

    return res.json({
      instructor: reportInstructor(instructor),
      week,
      month,
    });
  })
);

reportRouter.get(
  ["/:token/day/:date", "/:token/day/:date/:half"],
  publicReportLimiter,
  asyncRoute(async (req, res, next) => {
    const { token, date } = req.params;
    if (req.params.half !== undefined
      && req.params.half !== "check-in"
      && req.params.half !== "check-out") {
      return next();
    }
    if (!isValidDateKey(date)) return res.status(400).json({ detail: "Invalid date" });
    const half = req.params.half === "check-out" ? "checkout" : "checkin";

    const db = req.app.locals.db;
    const instructor = await findInstructorByReportToken(db, token);
    if (!instructor) return res.status(404).json({ detail: "Report not found" });

    const from = new Date(`${date}T00:00:00.000Z`);
    from.setUTCDate(from.getUTCDate() - 1);
    const to = new Date(`${date}T23:59:59.999Z`);
    to.setUTCDate(to.getUTCDate() + 1);
    const candidates = await coreCollection(db, "attendance")
      .find({ instructor_id: String(instructor._id), check_in_time: { $gte: from, $lte: to } })
      .sort({ check_in_time: 1 })
      .toArray();
    const record = candidates.find((item) => (
      localDateKey(new Date(item.check_in_time || item.date)) === date
    ));
    if (!record) return res.status(404).json({ detail: "No check-in was recorded that day" });

    const evaluation = await getEvaluation(db, String(record._id), half);
    const { weekly_rotation: weeklyRotation } = await loadInstructorWeek(
      db,
      instructor,
      weekStartKey(new Date(`${date}T12:00:00.000Z`))
    );

    return res.json({
      instructor: reportInstructor(instructor),
      date,
      attendance: {
        check_in_time: record.check_in_time,
        check_out_time: record.check_out_time,
        status: half === "checkout"
          ? (record.checkout_compliance_status
            ? String(record.checkout_compliance_status).toLowerCase()
            : null)
          : record.status,
        attire_type: half === "checkout" ? null : (record.attire_type || null),
        remarks: half === "checkout"
          ? (record.checkout_remarks || null)
          : (record.remarks || null),
        location_address: half === "checkout"
          ? (record.check_out_location_address || null)
          : (record.location_address || null),
        has_checkin_photo: Boolean(record.check_in_photo_key),
        has_checkout_photo: Boolean(record.check_out_photo_key),
      },
      half,
      weekly_rotation: weeklyRotation,
      evaluation: evaluation
        ? {
          overall_status: evaluation.overall_status,
          ai_summary: evaluation.ai_summary,
          image_quality: evaluation.image_quality,
          attire_type: evaluation.attire_type || record.attire_type || "UNKNOWN",
          visible_regions: evaluation.visible_regions || null,
          unassessed_reason: evaluation.unassessed_reason || null,
          improvement_tips: evaluation.improvement_tips || [],
          general_idcard_check: evaluation.general_idcard_check || [],
          grooming_check: evaluation.grooming_check || [],
          attire_check: evaluation.attire_check || [],
          accessories_check: evaluation.accessories_check || [],
          footwear_check: evaluation.footwear_check || [],
        }
        : null,
    });
  })
);

reportRouter.get(
  "/:token/day/:date/photo/:kind",
  publicReportLimiter,
  asyncRoute(async (req, res) => {
    const { token, date } = req.params;
    const kind = req.params.kind === "checkout" ? "checkout" : "checkin";
    if (!isValidDateKey(date)) return res.status(400).json({ detail: "Invalid date" });

    const db = req.app.locals.db;
    const instructor = await findInstructorByReportToken(db, token);
    if (!instructor) return res.status(404).json({ detail: "Report not found" });

    const from = new Date(`${date}T00:00:00.000Z`);
    from.setUTCDate(from.getUTCDate() - 1);
    const to = new Date(`${date}T23:59:59.999Z`);
    to.setUTCDate(to.getUTCDate() + 1);
    const candidates = await coreCollection(db, "attendance")
      .find({ instructor_id: String(instructor._id), check_in_time: { $gte: from, $lte: to } })
      .sort({ check_in_time: 1 })
      .toArray();
    const record = candidates.find((item) => (
      localDateKey(new Date(item.check_in_time || item.date)) === date
    ));
    if (!record) return res.status(404).json({ detail: "No check-in was recorded that day" });

    const key = kind === "checkout" ? record.check_out_photo_key : record.check_in_photo_key;
    if (!key) return res.status(404).json({ detail: "No photo was stored for this check-in" });

    const url = await getPhotoUrl(key, { expiresIn: 900 });
    if (!url) return res.status(503).json({ detail: "Photo storage is unavailable right now" });
    return res.json({ url, expires_in: 900 });
  })
);

async function startDeliveryRun(db, runId, fields) {
  await saveDeliveryRun(db, runId, {
    set: { ...fields, status: "producing", updated_at: new Date() },
    setOnInsert: { sent: 0, failed: 0, terminal: 0, created_at: new Date() },
  });
}

export async function deliverWeeklyReports(db, startKey) {
  const notificationSettings = await getNotificationSettings(db);
  if (!shouldSendWeeklyReport(notificationSettings)) {
    console.log(`Weekly reports for ${startKey}: disabled by notification settings`);
    return { queued: 0, skipped: 0, failures: [], disabled: true };
  }

  const dates = workingWeekDates(startKey);
  const from = new Date(`${dates[0]}T00:00:00.000Z`);
  from.setUTCDate(from.getUTCDate() - 1);
  const to = new Date(`${dates[dates.length - 1]}T23:59:59.999Z`);
  to.setUTCDate(to.getUTCDate() + 1);

  const instructorIds = await coreCollection(db, "attendance").distinct("instructor_id", {
    check_in_time: { $gte: from, $lte: to },
  });

  const runId = `weekly:${startKey}`;
  await startDeliveryRun(db, runId, { type: "weekly_report", week_start: startKey });
  let queued = 0;
  let skipped = 0;
  const failures = [];
  for (const instructorId of instructorIds) {
    try {
      const instructor = await coreCollection(db, "instructors").findOne({ _id: idMatch(String(instructorId)) });
      if (!instructor?.email) {
        skipped += 1;
        continue;
      }
      const summary = await loadInstructorWeek(db, instructor, startKey);
      if (summary.present_days === 0) {
        skipped += 1;
        continue;
      }
      const reportToken = await ensureReportToken(db, instructor);
      await enqueueMailJob(db, {
        id: `${runId}:${String(instructor._id)}`,
        type: "weekly_report",
        toEmail: instructor.email,
        runId,
        payload: {
          name: instructor.name,
          summary,
          reportUrl: `${appUrl()}/reports/${reportToken}/week/${startKey}`,
        },
      });
      queued += 1;
    } catch (error) {
      failures.push({ instructor: String(instructorId), reason: error?.name || "error" });
    }
  }

  await saveDeliveryRun(db, runId, {
    set: {
      type: "weekly_report",
      week_start: startKey,
      production_finished_at: new Date(),
      considered: instructorIds.length,
      queued,
      skipped,
      producer_failures: failures.slice(0, 20),
      status: queued ? "queued" : "completed",
      updated_at: new Date(),
    },
    setOnInsert: { sent: 0, failed: 0, terminal: 0, created_at: new Date() },
  });
  await completeDeliveryRunIfDone(db, runId, {
    status: "completed",
    finished_at: new Date(),
    updated_at: new Date(),
  });
  console.log(`Weekly reports for ${startKey}: ${queued} queued, ${skipped} skipped, ${failures.length} producer failures`);
  return { queued, skipped, failures };
}

reportRouter.post(
  "/cron/weekly-reports",
  requireCronSecret,
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    const startKey = weekStartKey(new Date());

    if (!shouldSendWeeklyReport(await getNotificationSettings(db))) {
      return res.status(202).json({
        week_start: startKey,
        queued: 0,
        skipped: 0,
        failures: [],
        status: "disabled",
        note: "Weekly instructor emails are turned off in admin notification settings.",
      });
    }

    const runId = `weekly:${startKey}`;
    const started = startProducer(runId, () => deliverWeeklyReports(db, startKey));
    return res.status(202).json({
      week_start: startKey,
      status: started ? "started" : "already_running",
      run_id: runId,
      note: started
        ? "Queueing runs in the background; each recipient is an idempotent delivery job with retries."
        : "A run for this week is already in progress.",
    });
  })
);

export { deliverAttendanceReminders };

reportRouter.post(
  "/cron/attendance-reminders",
  requireCronSecret,
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    const today = localDateKey(new Date());
    const runId = `attendance-reminders:${today}`;
    const { checkout_reminder_enabled: enabled } = await getAttendanceReminderSettings(db);
    if (!enabled) {
      return res.status(200).json({
        date: today,
        status: "disabled",
        run_id: runId,
        note: "Check-out missed emails are switched off in Settings > Notifications.",
      });
    }
    const started = startProducer(runId, () => deliverAttendanceReminders(db));
    return res.status(202).json({
      date: today,
      status: started ? "started" : "already_running",
      run_id: runId,
      note: started
        ? "Queueing runs in the background; each reminder is an idempotent delivery job with retries."
        : "A reminder run for today is already in progress.",
    });
  })
);

reportRouter.post(
  "/cron/close-open-checkins",
  requireCronSecret,
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    const requested = req.query.date;
    if (requested !== undefined && (typeof requested !== "string" || !isValidDateKey(requested))) {
      return res.status(422).json({ detail: "date must be a valid YYYY-MM-DD local date" });
    }
    const day = requested || dayToClose(new Date());
    const dryRun = req.query.dry === "1" || req.query.dry === "true";

    if (dryRun) {
      const would = await coreCollection(db, "attendance").countDocuments(openCheckInFilter(day));
      return res.json({ dry_run: true, day, would_mark: would });
    }

    const result = await closeOpenCheckIns(db, { dayKey: day });
    console.log(JSON.stringify({
      event: "open_checkins_closed",
      day: result.day,
      marked: result.marked,
    }));
    return res.json({ day: result.day, marked: result.marked });
  })
);

reportRouter.get(
  "/cron/health",
  requireCronSecret,
  asyncRoute(async (req, res) => {
    const recipients = await getReportRecipients(req.app.locals.db);
    return res.json({
      ok: true,
      time_zone: runtimeConfig().appTimeZone,
      current_week_start: weekStartKey(new Date()),
      today: localDateKey(new Date()),
      rp_recipients: recipients.length,
    });
  })
);

reportRouter.post(
  "/cron/purge-photos",
  requireCronSecret,
  asyncRoute(async (req, res) => {
    return res.json({
      status: "disabled",
      photos_deleted: 0,
      note: "Photos are kept permanently. Nothing is deleted.",
    });
  })
);
