import { runtimeConfig } from "../config/env.js";
import { idMatch } from "../middleware/auth.js";
import { dateBoundsInTimeZone } from "../utils.js";
import { localDateKey } from "./instructorReports.js";
import { enqueueMailJob } from "./mailWorker.js";
import { getSetting, saveSetting } from "../stores/settingsStore.js";
import { completeDeliveryRunIfDone, getDeliveryRun, saveDeliveryRun } from "../stores/deliveryRunStore.js";
import { coreCollection } from "../stores/coreStore.js";

export const ATTENDANCE_REMINDER_SETTINGS_ID = "attendance_reminder_settings";
export const REMINDER_KINDS = Object.freeze(["checkin", "checkout"]);
export const LATE_LIMIT_MS = 2 * 60 * 60 * 1000;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const TICK_MS = 30_000;
const FIRST_TICK_MS = 7_000;

export const DEFAULT_ATTENDANCE_REMINDERS = Object.freeze({
  checkin_reminder_enabled: false,
  checkin_reminder_time: "",
  checkout_reminder_enabled: false,
  checkout_reminder_time: "",
});

const KEYS = Object.keys(DEFAULT_ATTENDANCE_REMINDERS);

function toDate(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function normalizeAttendanceReminders(raw = {}) {
  const normalized = {};
  for (const kind of REMINDER_KINDS) {
    const enabled = raw?.[`${kind}_reminder_enabled`];
    const time = raw?.[`${kind}_reminder_time`];
    normalized[`${kind}_reminder_enabled`] = enabled === true;
    normalized[`${kind}_reminder_time`] = typeof time === "string" && TIME_PATTERN.test(time) ? time : "";
  }
  return normalized;
}

export function validateAttendanceReminders(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { valid: false, detail: "Reminder settings must be an object" };
  }
  const unknown = Object.keys(body).filter((key) => !KEYS.includes(key));
  if (unknown.length) return { valid: false, detail: `Unsupported reminder settings: ${unknown.join(", ")}` };
  for (const kind of REMINDER_KINDS) {
    const enabledKey = `${kind}_reminder_enabled`;
    const timeKey = `${kind}_reminder_time`;
    if (enabledKey in body && typeof body[enabledKey] !== "boolean") {
      return { valid: false, detail: `${enabledKey} must be true or false` };
    }
    if (timeKey in body && !(body[timeKey] === "" || (typeof body[timeKey] === "string" && TIME_PATTERN.test(body[timeKey])))) {
      return { valid: false, detail: "Choose a valid send time." };
    }
  }
  return { valid: true };
}

export async function getAttendanceReminderSettings(db) {
  const stored = await getSetting(db, ATTENDANCE_REMINDER_SETTINGS_ID);
  return {
    ...normalizeAttendanceReminders(stored || {}),
    checkin_changed_at: toDate(stored?.checkin_changed_at),
    checkout_changed_at: toDate(stored?.checkout_changed_at),
  };
}

export function attendanceReminderView(settings) {
  return normalizeAttendanceReminders(settings);
}

export async function saveAttendanceReminderSettings(db, body, updatedBy = null, now = new Date()) {
  const current = await getAttendanceReminderSettings(db);
  const next = normalizeAttendanceReminders({ ...attendanceReminderView(current), ...body });
  const changed = {};
  for (const kind of REMINDER_KINDS) {
    const enabledKey = `${kind}_reminder_enabled`;
    const timeKey = `${kind}_reminder_time`;
    if (next[enabledKey] !== current[enabledKey] || next[timeKey] !== current[timeKey]) {
      changed[`${kind}_changed_at`] = now;
    }
  }
  await saveSetting(db, ATTENDANCE_REMINDER_SETTINGS_ID, {
    set: { ...next, ...changed, updated_at: now, updated_by: updatedBy || null },
    setOnInsert: { _id: ATTENDANCE_REMINDER_SETTINGS_ID, created_at: now },
  });
  return attendanceReminderView(await getAttendanceReminderSettings(db));
}

function timeOnDay(dateKey, time, timeZone) {
  const { start } = dateBoundsInTimeZone(dateKey, timeZone);
  const [hour, minute] = time.split(":").map(Number);
  return new Date(start.getTime() + (hour * 60 + minute) * 60_000);
}

function isSunday(dateKey) {
  return new Date(`${dateKey}T12:00:00.000Z`).getUTCDay() === 0;
}

export function reminderRunId(kind, dateKey) {
  return kind === "checkout" ? `attendance-reminders:${dateKey}` : `checkin-reminders:${dateKey}`;
}

export function dueAttendanceReminders(settings, now = new Date(), timeZone = runtimeConfig().appTimeZone) {
  const dateKey = localDateKey(now, timeZone);
  const due = [];
  for (const kind of REMINDER_KINDS) {
    const time = settings?.[`${kind}_reminder_time`];
    if (!settings?.[`${kind}_reminder_enabled`] || !time) continue;
    if (kind === "checkin" && isSunday(dateKey)) continue;
    const at = timeOnDay(dateKey, time, timeZone);
    if (at.getTime() > now.getTime()) continue;
    if (now.getTime() - at.getTime() > LATE_LIMIT_MS) continue;
    const changedAt = toDate(settings[`${kind}_changed_at`]);
    if (changedAt && at.getTime() < changedAt.getTime()) continue;
    due.push({ kind, dateKey, at });
  }
  return due;
}

async function startRun(db, runId, fields) {
  await saveDeliveryRun(db, runId, {
    set: { ...fields, status: "producing", updated_at: new Date() },
    setOnInsert: { sent: 0, failed: 0, terminal: 0, created_at: new Date() },
  });
}

async function finishRun(db, runId, fields) {
  await saveDeliveryRun(db, runId, {
    set: { ...fields, production_finished_at: new Date(), status: "queued", updated_at: new Date() },
    setOnInsert: { sent: 0, failed: 0, terminal: 0, created_at: new Date() },
  });
  await completeDeliveryRunIfDone(db, runId, {
    status: "completed",
    finished_at: new Date(),
    updated_at: new Date(),
  });
}

export async function deliverAttendanceReminders(db, now = new Date()) {
  const timeZone = runtimeConfig().appTimeZone;
  const today = localDateKey(now, timeZone);
  const from = new Date(`${today}T00:00:00.000Z`);
  from.setUTCDate(from.getUTCDate() - 1);
  const to = new Date(`${today}T23:59:59.999Z`);
  to.setUTCDate(to.getUTCDate() + 1);

  const records = await coreCollection(db, "attendance")
    .find({ check_in_time: { $gte: from, $lte: to }, check_out_time: null })
    .toArray();
  const todays = records.filter((record) => (
    localDateKey(new Date(record.check_in_time || record.date), timeZone) === today
  ));

  const runId = reminderRunId("checkout", today);
  await startRun(db, runId, { type: "attendance_reminder", date: today });
  let queued = 0;
  const failures = [];
  for (const record of todays) {
    try {
      if (record.checkout_reminder_sent_at) continue;
      const instructor = await coreCollection(db, "instructors").findOne({ _id: idMatch(String(record.instructor_id)) });
      const email = instructor?.email;
      if (!email) continue;

      await enqueueMailJob(db, {
        id: `${runId}:${String(record._id)}`,
        type: "attendance_reminder",
        toEmail: email,
        attendanceId: record._id,
        runId,
        payload: {
          name: record.instructor_name || instructor?.name,
          kind: "checkout",
          dateLabel: today,
        },
      });
      queued += 1;
    } catch (error) {
      failures.push({ attendance: String(record._id), reason: error?.name || "error" });
    }
  }

  await finishRun(db, runId, {
    type: "attendance_reminder",
    date: today,
    checked: todays.length,
    queued,
    producer_failures: failures.slice(0, 20),
  });
  console.log(`Attendance reminders for ${today}: ${queued} queued of ${todays.length} open check-ins`);
  return { queued, failures };
}

export async function deliverCheckinReminders(db, now = new Date()) {
  const timeZone = runtimeConfig().appTimeZone;
  const today = localDateKey(now, timeZone);
  const { start, end } = dateBoundsInTimeZone(today, timeZone);
  const checkedIn = new Set((await coreCollection(db, "attendance").distinct("instructor_id", {
    check_in_time: { $gte: start, $lt: end },
    deleting_at: { $exists: false },
    instructor_id: { $nin: [null, ""] },
  })).map(String));
  const instructors = await coreCollection(db, "instructors")
    .find(
      { $or: [{ deleted_at: null }, { deleted_at: { $exists: false } }] },
      { projection: { name: 1, email: 1 } }
    )
    .toArray();

  const runId = reminderRunId("checkin", today);
  await startRun(db, runId, { type: "checkin_reminder", date: today });
  let queued = 0;
  const failures = [];
  for (const instructor of instructors) {
    const id = String(instructor._id);
    const email = typeof instructor.email === "string" ? instructor.email.trim() : "";
    if (checkedIn.has(id) || !email.includes("@")) continue;
    try {
      await enqueueMailJob(db, {
        id: `${runId}:${id}`,
        type: "checkin_reminder",
        toEmail: email,
        runId,
        payload: { name: instructor.name, kind: "checkin", dateLabel: today, date: today, instructor_id: id },
      });
      queued += 1;
    } catch (error) {
      failures.push({ instructor: id, reason: error?.name || "error" });
    }
  }

  await finishRun(db, runId, {
    type: "checkin_reminder",
    date: today,
    checked: instructors.length,
    queued,
    producer_failures: failures.slice(0, 20),
  });
  console.log(`Check-in reminders for ${today}: ${queued} queued of ${instructors.length} instructors`);
  return { queued, failures };
}

export async function runDueAttendanceReminders(db, now = new Date(), { done = new Set() } = {}) {
  const settings = await getAttendanceReminderSettings(db);
  const ran = [];
  for (const due of dueAttendanceReminders(settings, now)) {
    const runId = reminderRunId(due.kind, due.dateKey);
    if (done.has(runId)) continue;
    const existing = await getDeliveryRun(db, runId);
    if (existing?.production_finished_at) {
      done.add(runId);
      continue;
    }
    if (due.kind === "checkout") await deliverAttendanceReminders(db, now);
    else await deliverCheckinReminders(db, now);
    done.add(runId);
    ran.push(runId);
  }
  return ran;
}

export function startAttendanceReminderScheduler(db, { intervalMs = TICK_MS, firstTickMs = FIRST_TICK_MS } = {}) {
  let stopped = false;
  let timer = null;
  let inFlight = Promise.resolve();
  let done = new Set();
  let doneDay = null;

  const tick = () => {
    inFlight = (async () => {
      try {
        const now = new Date();
        const day = localDateKey(now);
        if (day !== doneDay) {
          done = new Set();
          doneDay = day;
        }
        await runDueAttendanceReminders(db, now, { done });
      } catch (error) {
        console.error(`Attendance reminder scheduler error (${String(error?.code || error?.name || "Error")})`);
      } finally {
        if (!stopped) timer = setTimeout(tick, intervalMs);
      }
    })();
  };

  timer = setTimeout(tick, firstTickMs);
  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inFlight;
    },
  };
}
