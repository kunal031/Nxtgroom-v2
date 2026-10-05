import { runtimeConfig } from "../config/env.js";
import { idMatch } from "../middleware/auth.js";
import { localDateKey } from "./instructorReports.js";
import {
  addDaysToKey,
  ESCALATION_THRESHOLD,
  failedDayStreaks,
  weekStartKey,
} from "./evaluationWorker.js";
import { coreCollection } from "../stores/coreStore.js";

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export const MAX_RANGE_DAYS = 93;

export class EscalationRangeError extends Error {}

export function weekdayOf(dayKey) {
  const [year, month, day] = String(dayKey).split("-").map(Number);
  return WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
}

function isDayKey(value) {
  if (typeof value !== "string" || !DAY_KEY.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) === value;
}

export function requestedWeekStart(week, now = new Date()) {
  if (week === undefined || week === null || week === "") {
    return weekStartKey(localDateKey(now, runtimeConfig().appTimeZone));
  }
  if (!isDayKey(week)) throw new EscalationRangeError("week must be a date as YYYY-MM-DD");
  return weekStartKey(week);
}

export function requestedRange({ week, from, to } = {}, now = new Date()) {
  if (from !== undefined || to !== undefined) {
    if (!isDayKey(from) || !isDayKey(to)) {
      throw new EscalationRangeError("from and to must both be dates as YYYY-MM-DD");
    }
    if (from > to) throw new EscalationRangeError("from must not be after to");
    if (addDaysToKey(from, MAX_RANGE_DAYS - 1) < to) {
      throw new EscalationRangeError(`Choose a range of at most ${MAX_RANGE_DAYS} days`);
    }
    return { from, to };
  }
  const weekStart = requestedWeekStart(week, now);
  return { from: weekStart, to: addDaysToKey(weekStart, 6) };
}

function checkInVerdict(status) {
  const value = String(status || "").toLowerCase();
  if (["compliant", "done", "needs_review", "review_required"].includes(value)) return "compliant";
  if (["non_compliant", "fail"].includes(value)) return "non_compliant";
  return value || "pending";
}

function checkOutVerdict(record) {
  if (!record.check_out_time || record.checkout_deleting_at) return null;
  const value = String(record.checkout_compliance_status || "").toUpperCase();
  if (value === "COMPLIANT") return "compliant";
  if (value === "NON_COMPLIANT") return "non_compliant";
  if (value === "UNASSESSED") return "unassessed";
  if (value === "ERROR") return "error";
  return record.check_out_photo_key ? "pending" : "no_photo";
}

const iso = (value) => (value ? new Date(value).toISOString() : null);

export async function escalationReport(db, { week, from, to, collegeId = null, now = new Date() } = {}) {
  const range = requestedRange({ week, from, to }, now);
  const weekStarts = [];
  for (let start = weekStartKey(range.from); start <= range.to; start = addDaysToKey(start, 7)) {
    weekStarts.push(start);
  }
  const days = weekStarts.flatMap((start) => Array.from({ length: 7 }, (_, offset) => addDaysToKey(start, offset)));

  const records = await coreCollection(db, "attendance").find(
    {
      attendance_day: { $in: days },
      instructor_id: { $type: "string" },
      deleting_at: { $exists: false },
    },
    {
      projection: {
        instructor_id: 1,
        instructor_name: 1,
        instructor_role: 1,
        college_id: 1,
        attendance_day: 1,
        check_in_time: 1,
        check_out_time: 1,
        status: 1,
        remarks: 1,
        checkout_compliance_status: 1,
        checkout_remarks: 1,
        checkout_deleting_at: 1,
        check_in_photo_key: 1,
        check_out_photo_key: 1,
      },
    }
  ).toArray();

  const byInstructor = new Map();
  for (const record of records) {
    const id = String(record.instructor_id);
    if (!byInstructor.has(id)) byInstructor.set(id, []);
    byInstructor.get(id).push(record);
  }

  const runs = [];
  for (const [instructorId, group] of byInstructor) {
    for (const weekStart of weekStarts) {
      for (const streak of failedDayStreaks(group, weekStart)) {
        if (streak.length < ESCALATION_THRESHOLD) continue;
        if (streak.some((record) => record.attendance_day >= range.from && record.attendance_day <= range.to)) {
          runs.push({ instructorId, streak });
        }
      }
    }
  }
  if (!runs.length) {
    return { from: range.from, to: range.to, rows: [], institutes: [] };
  }

  const instructorIds = [...new Set(runs.map((run) => run.instructorId))];
  const instructors = await coreCollection(db, "instructors").find(
    { _id: { $in: instructorIds.flatMap((id) => idMatch(id).$in) } },
    { projection: { name: 1, role: 1, instructor_role: 1, college_id: 1, report_token: 1 } }
  ).toArray();
  const instructorById = new Map(instructors.map((row) => [String(row._id), row]));

  const collegeIds = [...new Set(runs.flatMap(({ instructorId, streak }) => streak.map((record) => (
    record.college_id || instructorById.get(instructorId)?.college_id
  ))).filter(Boolean).map(String))];
  const colleges = collegeIds.length
    ? await coreCollection(db, "colleges").find(
      { _id: { $in: collegeIds.flatMap((id) => idMatch(id).$in) } },
      { projection: { name: 1 } }
    ).toArray()
    : [];
  const collegeName = new Map(colleges.map((row) => [String(row._id), row.name]));

  const rows = [];
  for (const { instructorId, streak } of runs) {
    const instructor = instructorById.get(instructorId);
    streak.forEach((record, index) => {
      if (record.attendance_day < range.from || record.attendance_day > range.to) return;
      const college = record.college_id || instructor?.college_id || null;
      if (collegeId && String(college || "") !== String(collegeId)) return;
      rows.push({
        attendance_id: String(record._id),
        instructor_id: instructorId,
        name: record.instructor_name || instructor?.name || "Unknown",
        role: record.instructor_role || instructor?.instructor_role || instructor?.role || null,
        college_id: college ? String(college) : null,
        institute: college ? (collegeName.get(String(college)) || "Unknown institute") : "No institute",
        date: record.attendance_day,
        weekday: weekdayOf(record.attendance_day),
        run_day: index + 1,
        run_length: streak.length,
        run_start: streak[0].attendance_day,
        check_in_time: iso(record.check_in_time),
        check_in_status: checkInVerdict(record.status),
        check_in_remarks: record.remarks || null,
        check_out_time: record.checkout_deleting_at ? null : iso(record.check_out_time),
        check_out_status: checkOutVerdict(record),
        check_out_remarks: record.checkout_deleting_at ? null : (record.checkout_remarks || null),
        has_checkin_photo: Boolean(record.check_in_photo_key),
        has_checkout_photo: Boolean(record.check_out_photo_key && !record.checkout_deleting_at),
        report_token: instructor?.report_token || null,
      });
    });
  }
  rows.sort((left, right) => left.name.localeCompare(right.name)
    || left.instructor_id.localeCompare(right.instructor_id)
    || left.date.localeCompare(right.date));

  const institutes = [...new Map(rows
    .filter((row) => row.college_id)
    .map((row) => [row.college_id, { id: row.college_id, name: row.institute }])).values()]
    .sort((left, right) => left.name.localeCompare(right.name));
  return { from: range.from, to: range.to, rows, institutes };
}
