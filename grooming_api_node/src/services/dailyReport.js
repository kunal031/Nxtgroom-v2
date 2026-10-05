import crypto from "node:crypto";
import { appUrl, runtimeConfig } from "../config/env.js";
import { idMatch } from "../middleware/auth.js";
import { improvementTips } from "../checkpoints.js";
import { dateBoundsInTimeZone } from "../utils.js";
import { ensureReportToken, isValidDateKey, localDateKey } from "./instructorReports.js";
import { isValidRecipient, normaliseEmail } from "./reportRecipients.js";
import {
  addSettingListValue,
  getSetting,
  removeSettingListValue,
  saveSetting,
} from "../stores/settingsStore.js";
import { evaluationsForSessions } from "../stores/evaluationStore.js";
import { getDeliveryRun, saveDeliveryRun } from "../stores/deliveryRunStore.js";
import { coreCollection } from "../stores/coreStore.js";

export const DAILY_REPORT_SETTINGS_ID = "daily_report";
export const MAX_DAILY_REPORT_TIMES = 8;
export const MAX_DAILY_REPORT_RECIPIENTS = 50;
const MAX_REPORT_ROWS = 5000;
const REPORT_CACHE_MS = 60_000;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const LINK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

function toDate(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export async function getDailyReportSettings(db) {
  const document = await getSetting(db, DAILY_REPORT_SETTINGS_ID);
  const times = Array.isArray(document?.times)
    ? document.times.filter((time) => typeof time === "string" && TIME_PATTERN.test(time))
    : [];
  return {
    enabled: document?.enabled === true,
    campus_reports: document?.campus_reports === true,
    times: [...new Set(times)].sort(),
    emails: (Array.isArray(document?.emails) ? document.emails : []).filter(isValidRecipient),
    schedule_changed_at: toDate(document?.schedule_changed_at),
  };
}

export function dailyReportSettingsView(settings) {
  return {
    enabled: settings.enabled,
    campus_reports: settings.campus_reports,
    times: settings.times,
    emails: settings.emails,
  };
}

export function normaliseTimes(values) {
  if (!Array.isArray(values)) return { ok: false, detail: "times must be a list of HH:MM times." };
  if (values.length > MAX_DAILY_REPORT_TIMES) {
    return { ok: false, detail: `At most ${MAX_DAILY_REPORT_TIMES} send times can be set.` };
  }
  const times = [];
  for (const value of values) {
    if (typeof value !== "string" || !TIME_PATTERN.test(value)) {
      return { ok: false, detail: "Each send time must be a valid time." };
    }
    if (times.includes(value)) return { ok: false, detail: `${slotLabel(value)} is listed twice.` };
    times.push(value);
  }
  return { ok: true, times: times.sort() };
}

export async function saveDailyReportSchedule(db, body, updatedBy) {
  const current = await getDailyReportSettings(db);
  let { enabled, times, campus_reports: campusReports } = current;
  if (body && "enabled" in body) {
    if (typeof body.enabled !== "boolean") return { ok: false, detail: "enabled must be true or false." };
    enabled = body.enabled;
  }
  if (body && "campus_reports" in body) {
    if (typeof body.campus_reports !== "boolean") return { ok: false, detail: "campus_reports must be true or false." };
    campusReports = body.campus_reports;
  }
  if (body && "times" in body) {
    const result = normaliseTimes(body.times);
    if (!result.ok) return result;
    times = result.times;
  }
  const changed = enabled !== current.enabled || times.join(",") !== current.times.join(",");
  const now = new Date();
  await saveSetting(db, DAILY_REPORT_SETTINGS_ID, {
    set: {
      enabled,
      campus_reports: campusReports,
      times,
      updated_at: now,
      updated_by: updatedBy || null,
      ...(changed ? { schedule_changed_at: now } : {}),
    },
    setOnInsert: { _id: DAILY_REPORT_SETTINGS_ID, created_at: now },
  });
  return { ok: true, settings: dailyReportSettingsView(await getDailyReportSettings(db)) };
}

export async function addDailyReportRecipient(db, value, addedBy) {
  const email = normaliseEmail(value);
  if (!isValidRecipient(email)) return { ok: false, reason: "invalid" };
  const { emails } = await getDailyReportSettings(db);
  if (emails.includes(email)) return { ok: false, reason: "duplicate" };
  if (emails.length >= MAX_DAILY_REPORT_RECIPIENTS) return { ok: false, reason: "limit" };
  const now = new Date();
  await addSettingListValue(db, DAILY_REPORT_SETTINGS_ID, "emails", email, {
    set: { updated_at: now, updated_by: addedBy || null },
    setOnInsert: { _id: DAILY_REPORT_SETTINGS_ID, created_at: now },
  });
  return { ok: true, emails: (await getDailyReportSettings(db)).emails };
}

export async function removeDailyReportRecipient(db, value, removedBy) {
  const email = normaliseEmail(value);
  if (!email) return { ok: false, reason: "invalid" };
  await removeSettingListValue(db, DAILY_REPORT_SETTINGS_ID, "emails", email, {
    set: { updated_at: new Date(), updated_by: removedBy || null },
  });
  return { ok: true, emails: (await getDailyReportSettings(db)).emails };
}

export function slotLabel(slot) {
  const [hour, minute] = String(slot).split(":").map(Number);
  const period = hour >= 12 ? "PM" : "AM";
  return `${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${period}`;
}

export function dateSegment(dateKey) {
  const [year, month, day] = String(dateKey).split("-");
  return `${day}-${month}-${year}`;
}

export function parseDateSegment(segment) {
  const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(String(segment || ""));
  if (!match) return null;
  const key = `${match[3]}-${match[2]}-${match[1]}`;
  return isValidDateKey(key) ? key : null;
}

export function displayDate(dateKey) {
  return dateSegment(dateKey).replaceAll("-", "/");
}

export function dailyReportSubject(dateKey, institute = "") {
  return institute
    ? `Daily report_Attendance & Grooming_Check_${institute}_${displayDate(dateKey)}`
    : `Daily report_Attendance & Grooming_Check_${displayDate(dateKey)}`;
}

export function campusSlug(name) {
  const slug = String(name || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug || "campus";
}

export function slotInstant(dateKey, slot, timeZone = runtimeConfig().appTimeZone) {
  const { start } = dateBoundsInTimeZone(dateKey, timeZone);
  const [hour, minute] = slot.split(":").map(Number);
  return new Date(start.getTime() + (hour * 60 + minute) * 60_000);
}

export function dailyReportRunId(dateKey, slot) {
  return `daily-report:${dateKey}:${slot}`;
}

export function dueDailyReports(settings, now = new Date(), timeZone = runtimeConfig().appTimeZone) {
  if (!settings?.enabled || !settings.times?.length) return [];
  const dateKey = localDateKey(now, timeZone);
  const dayStart = dateBoundsInTimeZone(dateKey, timeZone).start;
  const changedAt = toDate(settings.schedule_changed_at)?.getTime() ?? Number.NEGATIVE_INFINITY;
  const due = [];
  let previous = dayStart;
  for (const slot of [...settings.times].sort()) {
    const at = slotInstant(dateKey, slot, timeZone);
    if (at.getTime() < changedAt) continue;
    if (at.getTime() > now.getTime()) break;
    due.push({ dateKey, slot, from: previous, to: at });
    previous = at;
  }
  return due;
}

export function newLinkToken() {
  return crypto.randomUUID();
}

export function dailyReportDayId(dateKey) {
  return `daily-report-day:${dateKey}`;
}

export function dailyReportDayPath(dateKey, token) {
  return `/daily-report/${dateSegment(dateKey)}/${token}`;
}

export function dailyReportDayUrl(day) {
  return `${appUrl()}${dailyReportDayPath(day.date, day.link_token)}`;
}

function isDuplicateKey(error) {
  return error?.code === 11000;
}

export function campusReportDayId(dateKey, collegeId) {
  return `daily-report-campus:${dateKey}:${collegeId}`;
}

function campusReportLinkId(dateKey, token) {
  return `daily-report-campus-link:${dateKey}:${token}`;
}

export function campusReportPath(dateKey, slug, token) {
  return `/daily-report/${dateSegment(dateKey)}/${slug}/${token}`;
}

export function campusReportUrl(link) {
  return `${appUrl()}${campusReportPath(link.date, link.slug || "campus", link.link_token)}`;
}

export async function ensureCampusReportDay(db, dateKey, college, now = new Date()) {
  const collegeId = String(college._id);
  const id = campusReportDayId(dateKey, collegeId);
  const slug = campusSlug(college.name);
  const existing = await getDeliveryRun(db, id);
  if (existing?.link_token) {
    if (existing.slug === slug) return existing;
    await saveDeliveryRun(db, id, { set: { slug, updated_at: now } });
    return { ...existing, slug };
  }
  const token = newLinkToken();
  await saveDeliveryRun(db, campusReportLinkId(dateKey, token), {
    set: { updated_at: now },
    setOnInsert: {
      _id: campusReportLinkId(dateKey, token),
      type: "daily_report_campus_link",
      date: dateKey,
      college_id: collegeId,
      created_at: now,
    },
  });
  try {
    await saveDeliveryRun(db, id, {
      set: { slug, updated_at: now },
      setOnInsert: {
        _id: id,
        type: "daily_report_campus",
        date: dateKey,
        college_id: collegeId,
        link_token: token,
        created_at: now,
      },
    });
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
  }
  const link = await getDeliveryRun(db, id);
  if (!link?.link_token) throw new Error(`Campus report page for ${dateKey} could not be read back`);
  return link;
}

export async function ensureDailyReportDay(db, dateKey, now = new Date()) {
  const id = dailyReportDayId(dateKey);
  const existing = await getDeliveryRun(db, id);
  if (existing?.link_token) return existing;
  try {
    await saveDeliveryRun(db, id, {
      set: { updated_at: now },
      setOnInsert: {
        _id: id,
        type: "daily_report_day",
        date: dateKey,
        link_token: newLinkToken(),
        created_at: now,
      },
    });
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
  }
  const day = await getDeliveryRun(db, id);
  if (!day?.link_token) throw new Error(`Daily report page for ${dateKey} could not be read back`);
  return day;
}

function sameSecret(expected, given) {
  const left = Buffer.from(String(expected));
  const right = Buffer.from(String(given));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export async function findDailyReportDay(db, dateValue, token) {
  const dateKey = parseDateSegment(dateValue);
  if (!dateKey || typeof token !== "string" || !LINK_TOKEN_PATTERN.test(token)) return null;
  const day = await getDeliveryRun(db, dailyReportDayId(dateKey));
  if (!day || day.type !== "daily_report_day" || typeof day.link_token !== "string") return null;
  if (!sameSecret(day.link_token, token)) return null;
  return day;
}

export async function findCampusReportDay(db, dateValue, token) {
  const dateKey = parseDateSegment(dateValue);
  if (!dateKey || typeof token !== "string" || !LINK_TOKEN_PATTERN.test(token)) return null;
  const pointer = await getDeliveryRun(db, campusReportLinkId(dateKey, token));
  if (!pointer || pointer.type !== "daily_report_campus_link" || !pointer.college_id) return null;
  const link = await getDeliveryRun(db, campusReportDayId(dateKey, pointer.college_id));
  if (!link || link.type !== "daily_report_campus" || typeof link.link_token !== "string") return null;
  if (!sameSecret(link.link_token, token)) return null;
  return link;
}

function clockTime(value, timeZone) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone,
  }).format(value);
}

function eventTime(value, reportDate, timeZone) {
  const time = clockTime(value, timeZone);
  const day = localDateKey(value, timeZone);
  return day === reportDate ? time : `${dateSegment(day).slice(0, 5).replace("-", "/")} ${time}`;
}

const STATE_TEXT = {
  compliant: "No improvements needed",
  unassessed: "Not assessed: the photo did not show enough",
  error: "Analysis failed: open the report",
  pending: "Analysis in progress",
};

function halfOutcome(record, kind, evaluation) {
  if (evaluation) {
    const overall = String(evaluation.overall_status || "").toUpperCase();
    if (overall === "NON_COMPLIANT") {
      const tips = Array.isArray(evaluation.improvement_tips)
        ? evaluation.improvement_tips
        : improvementTips(evaluation);
      return { state: "non_compliant", tips: tips.filter((tip) => typeof tip === "string" && tip.trim()) };
    }
    if (overall === "COMPLIANT") return { state: "compliant", tips: [] };
    if (overall === "UNASSESSED") return { state: "unassessed", tips: [] };
  }
  const status = String(
    (kind === "checkout" ? record.checkout_compliance_status : record.status) || ""
  ).toLowerCase();
  if (["non_compliant", "non-compliant", "fail"].includes(status)) return { state: "non_compliant", tips: [] };
  if (["compliant", "done", "review_required", "needs_review"].includes(status)) return { state: "compliant", tips: [] };
  if (status === "unassessed") return { state: "unassessed", tips: [] };
  if (["error", "analysis_error"].includes(status)) return { state: "error", tips: [] };
  return { state: "pending", tips: [] };
}

function outcomeText(outcome) {
  if (outcome.state !== "non_compliant") return STATE_TEXT[outcome.state];
  return outcome.tips.length ? outcome.tips.join(" ") : "Did not meet the standards: open the report";
}

export const DAILY_STATUS_LABELS = Object.freeze({
  compliant: "Compliant",
  non_compliant: "Non-compliant",
});

function reportLink(token, dayKey, kind) {
  if (!token) return null;
  return `${appUrl()}/reports/${token}/day/${dayKey}/${kind === "checkout" ? "check-out" : "check-in"}`;
}

export async function buildDailyReport(db, run, { ensureTokens = false } = {}) {
  const timeZone = runtimeConfig().appTimeZone;
  const from = toDate(run.window_from);
  const to = toDate(run.window_to);
  if (!from || !to) throw new Error("Daily report run has no period");
  const dayStart = dateBoundsInTimeZone(run.date, timeZone).start;

  const records = await coreCollection(db, "attendance")
    .find(
      {
        date: { $gte: new Date(dayStart.getTime() - 24 * 60 * 60 * 1000), $lt: to },
        deleting_at: { $exists: false },
        instructor_id: { $nin: [null, ""] },
        status: { $ne: "unidentified" },
        $or: [
          { check_in_time: { $gte: from, $lt: to } },
          { check_out_time: { $gte: from, $lt: to } },
        ],
      },
      {
        projection: {
          instructor_id: 1,
          instructor_name: 1,
          college_id: 1,
          attendance_day: 1,
          check_in_time: 1,
          check_out_time: 1,
          checkout_deleting_at: 1,
          status: 1,
          checkout_compliance_status: 1,
        },
      }
    )
    .sort({ check_in_time: 1 })
    .limit(MAX_REPORT_ROWS)
    .toArray();

  const instructorIds = [...new Set(records.map((record) => String(record.instructor_id)))];
  const instructors = instructorIds.length
    ? await coreCollection(db, "instructors")
      .find(
        { _id: { $in: instructorIds.flatMap((id) => idMatch(id).$in) } },
        { projection: { name: 1, report_token: 1, college_id: 1 } }
      )
      .toArray()
    : [];
  const instructorById = new Map(instructors.map((instructor) => [String(instructor._id), instructor]));
  const collegeOf = (record) => record.college_id || instructorById.get(String(record.instructor_id))?.college_id || null;
  const collegeIds = [...new Set(records.map(collegeOf).filter(Boolean).map(String))];
  const colleges = collegeIds.length
    ? await coreCollection(db, "colleges")
      .find({ _id: { $in: collegeIds.flatMap((id) => idMatch(id).$in) } }, { projection: { name: 1 } })
      .toArray()
    : [];
  const collegeName = new Map(colleges.map((college) => [String(college._id), college.name]));
  if (ensureTokens) {
    for (const instructor of instructors) {
      if (!instructor.report_token) instructor.report_token = await ensureReportToken(db, instructor);
    }
  }

  const evaluations = await evaluationsForSessions(db, records.map((record) => String(record._id)));
  const evaluationFor = new Map(evaluations.map((evaluation) => [
    `${String(evaluation.attendance_id)}|${evaluation.kind === "checkout" ? "checkout" : "checkin"}`,
    evaluation,
  ]));

  const rows = [];
  for (const record of records) {
    const checkIn = toDate(record.check_in_time);
    if (!checkIn) continue;
    const rawCheckOut = record.checkout_deleting_at ? null : toDate(record.check_out_time);
    const checkOut = rawCheckOut && rawCheckOut.getTime() < to.getTime() ? rawCheckOut : null;
    const halves = [];
    if (checkIn.getTime() >= from.getTime() && checkIn.getTime() < to.getTime()) halves.push("checkin");
    if (checkOut && checkOut.getTime() >= from.getTime()) halves.push("checkout");
    if (!halves.length) continue;

    const arrival = halfOutcome(record, "checkin", evaluationFor.get(`${String(record._id)}|checkin`));
    if (!DAILY_STATUS_LABELS[arrival.state]) continue;
    const instructor = instructorById.get(String(record.instructor_id));
    const sessionDay = record.attendance_day || localDateKey(checkIn, timeZone);
    const college = collegeOf(record);
    rows.push({
      name: record.instructor_name || instructor?.name || "Instructor",
      institute: (college && collegeName.get(String(college))) || "",
      collegeId: college ? String(college) : null,
      checkIn: eventTime(checkIn, run.date, timeZone),
      checkOut: checkOut ? eventTime(checkOut, run.date, timeZone) : "-",
      status: arrival.state,
      points: [outcomeText(arrival)],
      reportUrl: reportLink(instructor?.report_token, sessionDay, "checkin"),
      severity: arrival.state === "non_compliant" ? 0 : 1,
      sortTime: checkIn.getTime(),
    });
  }
  rows.sort((left, right) => left.severity - right.severity || left.sortTime - right.sortTime);

  return {
    date: run.date,
    slot: run.slot,
    dateLabel: displayDate(run.date),
    windowLabel: `${clockTime(from, timeZone)} to ${clockTime(to, timeZone)}`,
    subject: dailyReportSubject(run.date),
    rows: rows.map(({ sortTime, ...row }) => row),
  };
}

export async function buildFullDayReport(db, dateKey, { ensureTokens = false, collegeId = null } = {}) {
  const timeZone = runtimeConfig().appTimeZone;
  const { start, end } = dateBoundsInTimeZone(dateKey, timeZone);
  const records = await coreCollection(db, "attendance")
    .find(
      {
        date: { $gte: start, $lt: end },
        check_in_time: { $gte: start, $lt: end },
        deleting_at: { $exists: false },
        instructor_id: { $nin: [null, ""] },
        status: { $ne: "unidentified" },
      },
      {
        projection: {
          instructor_id: 1,
          instructor_name: 1,
          college_id: 1,
          attendance_day: 1,
          check_in_time: 1,
          check_out_time: 1,
          checkout_deleting_at: 1,
          status: 1,
          checkout_compliance_status: 1,
          check_in_photo_key: 1,
          check_out_photo_key: 1,
        },
      }
    )
    .sort({ check_in_time: 1 })
    .limit(MAX_REPORT_ROWS)
    .toArray();

  const instructorIds = [...new Set(records.map((record) => String(record.instructor_id)))];
  const instructors = instructorIds.length
    ? await coreCollection(db, "instructors")
      .find(
        { _id: { $in: instructorIds.flatMap((id) => idMatch(id).$in) } },
        { projection: { name: 1, report_token: 1, college_id: 1 } }
      )
      .toArray()
    : [];
  const instructorById = new Map(instructors.map((instructor) => [String(instructor._id), instructor]));
  const collegeOf = (record) => record.college_id || instructorById.get(String(record.instructor_id))?.college_id || null;
  const collegeIds = [...new Set(records.map(collegeOf).filter(Boolean).map(String))];
  const colleges = collegeIds.length
    ? await coreCollection(db, "colleges")
      .find({ _id: { $in: collegeIds.flatMap((id) => idMatch(id).$in) } }, { projection: { name: 1 } })
      .toArray()
    : [];
  const collegeName = new Map(colleges.map((college) => [String(college._id), college.name]));
  const scoped = collegeId
    ? records.filter((record) => String(collegeOf(record) || "") === String(collegeId))
    : records;
  if (ensureTokens) {
    const listed = new Set(scoped.map((record) => String(record.instructor_id)));
    for (const instructor of instructors) {
      if (!listed.has(String(instructor._id))) continue;
      if (!instructor.report_token) instructor.report_token = await ensureReportToken(db, instructor);
    }
  }

  const evaluations = await evaluationsForSessions(db, scoped.map((record) => String(record._id)));
  const evaluationFor = new Map(evaluations.map((evaluation) => [
    `${String(evaluation.attendance_id)}|${evaluation.kind === "checkout" ? "checkout" : "checkin"}`,
    evaluation,
  ]));

  let institute = null;
  if (collegeId) {
    institute = collegeName.get(String(collegeId)) || (await db.collection("colleges").findOne(
      { _id: idMatch(String(collegeId)) },
      { projection: { name: 1 } }
    ))?.name || "";
  }

  const rows = [];
  for (const record of scoped) {
    const checkIn = toDate(record.check_in_time);
    if (!checkIn) continue;
    const checkOut = record.checkout_deleting_at ? null : toDate(record.check_out_time);
    const id = String(record._id);
    const token = instructorById.get(String(record.instructor_id))?.report_token;
    const sessionDay = record.attendance_day || dateKey;
    const checkinOutcome = halfOutcome(record, "checkin", evaluationFor.get(`${id}|checkin`));
    const feedback = outcomeText(checkinOutcome);
    const college = collegeOf(record);
    rows.push({
      attendanceId: id,
      date: displayDate(dateKey),
      name: record.instructor_name || instructorById.get(String(record.instructor_id))?.name || "Instructor",
      institute: (college && collegeName.get(String(college))) || "",
      status: checkinOutcome.state,
      checkIn: clockTime(checkIn, timeZone),
      checkOut: checkOut ? eventTime(checkOut, dateKey, timeZone) : "-",
      feedback,
      hasCheckinPhoto: Boolean(record.check_in_photo_key),
      hasCheckoutPhoto: Boolean(checkOut && record.check_out_photo_key),
      checkinReportUrl: reportLink(token, sessionDay, "checkin"),
      checkoutReportUrl: checkOut ? reportLink(token, sessionDay, "checkout") : null,
    });
  }

  return {
    date: dateKey,
    dateLabel: displayDate(dateKey),
    windowLabel: "12:00 AM to 11:59 PM",
    subject: dailyReportSubject(dateKey, institute || ""),
    ...(collegeId ? { institute } : {}),
    rows,
  };
}

export async function dailyReportPhotoKey(db, dateKey, attendanceId, kind, { collegeId = null } = {}) {
  if (typeof attendanceId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(attendanceId)) return null;
  const { start, end } = dateBoundsInTimeZone(dateKey, runtimeConfig().appTimeZone);
  const record = await coreCollection(db, "attendance").findOne(
    {
      _id: idMatch(attendanceId),
      check_in_time: { $gte: start, $lt: end },
      deleting_at: { $exists: false },
      instructor_id: { $nin: [null, ""] },
      status: { $ne: "unidentified" },
    },
    { projection: { check_in_photo_key: 1, check_out_photo_key: 1, checkout_deleting_at: 1, college_id: 1, instructor_id: 1 } }
  );
  if (!record) return null;
  if (collegeId) {
    let recordCollege = record.college_id;
    if (!recordCollege) {
      recordCollege = (await db.collection("instructors").findOne(
        { _id: idMatch(String(record.instructor_id)) },
        { projection: { college_id: 1 } }
      ))?.college_id;
    }
    if (String(recordCollege || "") !== String(collegeId)) return null;
  }
  if (kind === "checkout") return record.checkout_deleting_at ? null : record.check_out_photo_key || null;
  return record.check_in_photo_key || null;
}

function dayMatch(start, end) {
  return {
    date: { $gte: start, $lt: end },
    check_in_time: { $gte: start, $lt: end },
    deleting_at: { $exists: false },
    instructor_id: { $nin: [null, ""] },
    status: { $ne: "unidentified" },
  };
}

export function dayCountsPipeline(start, end, timeZone = runtimeConfig().appTimeZone) {
  return [
    { $match: dayMatch(start, end) },
    {
      $group: {
        _id: { $dateToString: { format: "%Y-%m-%d", date: "$check_in_time", timezone: timeZone } },
        checkins: { $sum: 1 },
        checkouts: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $gt: ["$check_out_time", null] },
                  { $not: [{ $gt: ["$checkout_deleting_at", null] }] },
                ],
              },
              1,
              0,
            ],
          },
        },
      },
    },
  ];
}

export const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

const dayLinkCache = new Map();
const DAY_LINK_CACHE_MS = 10 * 60 * 1000;

async function dayLinkFor(db, dateKey, now) {
  const cached = dayLinkCache.get(dateKey);
  if (cached && now.getTime() - cached.at < DAY_LINK_CACHE_MS) {
    return cached.day;
  }
  const day = await ensureDailyReportDay(db, dateKey, now);
  dayLinkCache.set(dateKey, { at: now.getTime(), day });
  return day;
}

export async function dailyReportDays(db, month, now = new Date()) {
  const timeZone = runtimeConfig().appTimeZone;
  if (!MONTH_PATTERN.test(String(month))) throw new RangeError("month must be YYYY-MM");
  const today = localDateKey(now, timeZone);
  const [year, monthNumber] = month.split("-").map(Number);
  const lastOfMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const firstKey = `${month}-01`;
  if (firstKey > today) return [];
  const monthEndKey = `${month}-${String(lastOfMonth).padStart(2, "0")}`;
  const lastKey = monthEndKey < today ? monthEndKey : today;
  const start = dateBoundsInTimeZone(firstKey, timeZone).start;
  const end = dateBoundsInTimeZone(lastKey, timeZone).end;

  const counts = await coreCollection(db, "attendance").aggregate(dayCountsPipeline(start, end, timeZone)).toArray();
  const byDay = new Map(counts.map((row) => [row._id, row]));

  const days = [];
  for (let day = Number(lastKey.slice(8)); day >= 1; day -= 1) {
    const dateKey = `${month}-${String(day).padStart(2, "0")}`;
    const checkins = Number(byDay.get(dateKey)?.checkins || 0);
    const checkouts = Math.min(checkins, Number(byDay.get(dateKey)?.checkouts || 0));
    days.push({
      date: dateKey,
      date_label: displayDate(dateKey),
      checkins,
      checkouts,
      not_checked_out: checkins - checkouts,
      report_url: checkins ? dailyReportDayUrl(await dayLinkFor(db, dateKey, now)) : null,
    });
  }
  return days;
}

const campusLinkCache = new Map();

async function campusLinkFor(db, dateKey, college, now) {
  const key = `${dateKey}:${String(college._id)}`;
  const cached = campusLinkCache.get(key);
  if (cached && now.getTime() - cached.at < DAY_LINK_CACHE_MS && cached.link.slug === campusSlug(college.name)) {
    return cached.link;
  }
  const link = await ensureCampusReportDay(db, dateKey, college, now);
  campusLinkCache.set(key, { at: now.getTime(), link });
  return link;
}

export async function dailyReportCampuses(db, dateKey, now = new Date()) {
  const timeZone = runtimeConfig().appTimeZone;
  if (!isValidDateKey(dateKey)) throw new RangeError("date must be YYYY-MM-DD");
  const { start, end } = dateBoundsInTimeZone(dateKey, timeZone);
  const records = await db.collection("attendance")
    .find(dayMatch(start, end), {
      projection: { college_id: 1, instructor_id: 1, check_out_time: 1, checkout_deleting_at: 1 },
    })
    .limit(MAX_REPORT_ROWS)
    .toArray();

  const missing = [...new Set(records.filter((record) => !record.college_id).map((record) => String(record.instructor_id)))];
  const instructors = missing.length
    ? await db.collection("instructors")
      .find({ _id: { $in: missing.flatMap((id) => idMatch(id).$in) } }, { projection: { college_id: 1 } })
      .toArray()
    : [];
  const instructorCollege = new Map(instructors.map((instructor) => [String(instructor._id), instructor.college_id]));

  const counts = new Map();
  for (const record of records) {
    const college = record.college_id || instructorCollege.get(String(record.instructor_id));
    if (!college) continue;
    const entry = counts.get(String(college)) || { checkins: 0, checkouts: 0 };
    entry.checkins += 1;
    if (record.check_out_time && !record.checkout_deleting_at) entry.checkouts += 1;
    counts.set(String(college), entry);
  }
  const ids = [...counts.keys()];
  const colleges = ids.length
    ? await db.collection("colleges")
      .find({ _id: { $in: ids.flatMap((id) => idMatch(id).$in) } }, { projection: { name: 1 } })
      .toArray()
    : [];

  const campuses = [];
  for (const college of colleges) {
    const entry = counts.get(String(college._id));
    if (!entry) continue;
    const checkouts = Math.min(entry.checkins, entry.checkouts);
    const link = await campusLinkFor(db, dateKey, college, now);
    campuses.push({
      college_id: String(college._id),
      institute: college.name || "",
      checkins: entry.checkins,
      checkouts,
      not_checked_out: entry.checkins - checkouts,
      report_url: campusReportUrl(link),
    });
  }
  return campuses.sort((left, right) => left.institute.localeCompare(right.institute));
}

export function campusIdsInReport(report) {
  return [...new Set(report.rows.map((row) => row.collegeId).filter(Boolean))].sort();
}

const reportCache = new Map();

export async function buildDailyReportForEmail(db, run, now = Date.now()) {
  for (const [key, entry] of reportCache) {
    if (now - entry.at > REPORT_CACHE_MS) reportCache.delete(key);
  }
  const cached = reportCache.get(run._id);
  if (cached) return cached.report;
  const report = await buildDailyReport(db, run, { ensureTokens: true });
  reportCache.set(run._id, { at: now, report });
  return report;
}
