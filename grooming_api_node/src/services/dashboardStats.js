import { idMatch } from "../middleware/auth.js";
import { runtimeConfig } from "../config/env.js";
import { dateRangeBoundsInTimeZone } from "../utils.js";
import {
  addDaysToKey,
  ESCALATION_THRESHOLD,
  nonCompliantOccurrences,
  weekStartKey,
} from "./evaluationWorker.js";
import {
  describeCollegeIdentification,
  getIdentificationSettings,
  loadCollegeEnrolment,
} from "./identificationSettings.js";
import { localDateKey } from "./instructorReports.js";
import { failedCheckpointRows } from "../stores/evaluationStore.js";
import { coreCollection } from "../stores/coreStore.js";

/**
 * The administrators' Dashboard: today's attendance and grooming results, the
 * recent trend, and where attention is needed.
 *
 * Everything is derived from the records the rest of the application already
 * writes. Nothing here is stored, and no count is kept anywhere that could
 * drift from Daily Records: a status is read the same way the Daily Records
 * badge reads it, and an escalation is counted by the same function that sends
 * reporting partners the URGENT email.
 *
 * The work is split so the arithmetic can be tested without a database:
 * loadDashboard runs the queries, buildDashboard turns their rows into the
 * response.
 */

/** Working days shown on the trend chart. The page offers 7, 14 and 30. */
export const TREND_WORKING_DAYS = 30;
/** Rows in the most-failed checkpoints list. */
export const FAILED_CHECKPOINT_LIMIT = 8;

const COMPLIANT_STATUSES = new Set(["compliant", "done", "needs_review", "review_required"]);
const NON_COMPLIANT_STATUSES = new Set(["non_compliant", "fail"]);

/**
 * One check-in's result, read exactly as the Daily Records badge reads it
 * (normalizeAttendanceStatus in the frontend), so the Dashboard and the table
 * can never count the same record differently.
 */
export function dashboardStatus(status) {
  const value = String(status || "").toLowerCase();
  if (COMPLIANT_STATUSES.has(value)) return "compliant";
  if (NON_COMPLIANT_STATUSES.has(value)) return "non_compliant";
  if (value === "unassessed") return "unassessed";
  if (value === "unidentified") return "unidentified";
  if (value === "error") return "error";
  return "pending";
}

function percent(part, whole) {
  if (!whole) return null;
  return Math.round((part / whole) * 1000) / 10;
}

function isSundayKey(dayKey) {
  const [year, month, day] = String(dayKey).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay() === 0;
}

/**
 * The last `count` working days ending with `todayKey`, oldest first.
 * The working week is Monday to Saturday, as in the weekly report.
 */
export function workingDayKeys(todayKey, count) {
  const keys = [];
  for (let offset = 0; keys.length < count && offset < count * 2 + 7; offset += 1) {
    const key = addDaysToKey(todayKey, -offset);
    if (!isSundayKey(key)) keys.unshift(key);
  }
  return keys;
}

/** The working day before `todayKey`: Saturday for a Monday. */
export function previousWorkingDayKey(todayKey) {
  let key = addDaysToKey(todayKey, -1);
  while (isSundayKey(key)) key = addDaysToKey(key, -1);
  return key;
}

/** Who a checkpoint applies to, from the code the checkpoint tables give it. */
export function checkpointAudience(code) {
  const value = String(code || "");
  if (value.startsWith("M_")) return "Men";
  if (value.startsWith("W_SAREE_")) return "Saree";
  if (value.startsWith("W_KURTI_") || value === "W_DUPATTA" || value === "W_BOTTOM_WEAR") return "Kurti";
  if (value.startsWith("W_FORMAL_")) return "Formal";
  if (value.startsWith("W_")) return "Women";
  return "All";
}

function dayKeyOf(record, timeZone) {
  if (record.attendance_day) return String(record.attendance_day);
  const moment = record.check_in_time || record.date;
  return moment ? localDateKey(new Date(moment), timeZone) : null;
}

function identified(record) {
  return record.instructor_id != null && record.instructor_id !== "";
}

function mostFrequent(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  let best = null;
  for (const [value, count] of counts) {
    if (!best || count > best.count) best = { value, count };
  }
  return best?.value ?? null;
}

/**
 * Mon–Sat days from `fromKey` to `toKey`, both inclusive. A range that holds
 * no working day at all - a single Sunday someone chose - counts as the one
 * day it is, so its check-ins are still measured against the roster.
 */
export function countWorkingDays(fromKey, toKey) {
  if (!fromKey || !toKey || fromKey > toKey) return 0;
  let count = 0;
  let calendarDays = 0;
  for (let key = fromKey; key <= toKey; key = addDaysToKey(key, 1)) {
    calendarDays += 1;
    if (!isSundayKey(key)) count += 1;
  }
  return count || (calendarDays ? 1 : 0);
}

/**
 * One row per active institute for the Institutes table.
 *
 * `present` counts instructor-days: one per instructor per day they checked
 * in, which the one-record-per-day rule makes the same as their identified
 * check-ins. `expected` is the roster times the working days in the range, so
 * over one day the column reads "present / instructors" as it always has, and
 * over a week it reads instructor-days against the days that were possible.
 */
export function buildInstituteRows({
  colleges = [],
  roster = [],
  identificationSettings = {},
  enrolment = new Map(),
  groups = [],
  workingDays = 1,
}) {
  const totals = new Map(groups.map((row) => [row._id == null ? "" : String(row._id), row]));
  const rosterByCollege = new Map();
  for (const instructor of roster) {
    const key = instructor.college_id == null ? "" : String(instructor.college_id);
    rosterByCollege.set(key, (rosterByCollege.get(key) || 0) + 1);
  }
  const identification = new Map(
    describeCollegeIdentification(identificationSettings, colleges, enrolment)
      .map((row) => [row.college_id, row])
  );
  return colleges.map((row) => {
    const collegeId = String(row._id);
    const group = totals.get(collegeId) || {};
    const present = Number(group.check_ins) || 0;
    const compliant = Number(group.compliant) || 0;
    const nonCompliant = Number(group.non_compliant) || 0;
    const instructors = rosterByCollege.get(collegeId) || 0;
    const expected = instructors * workingDays;
    const described = identification.get(collegeId);
    return {
      college_id: collegeId,
      name: row.name || "Unnamed institute",
      mode: described?.mode || "FACE_ONLY",
      present,
      expected,
      instructors,
      present_percent: percent(present, expected),
      compliant,
      non_compliant: nonCompliant,
      compliance_percent: percent(compliant, compliant + nonCompliant),
      unidentified: Number(group.unidentified) || 0,
      enrolled: described?.enrolled ?? 0,
      enrolled_percent: described?.enrolled_percent ?? 0,
      low_enrolment: Boolean(described?.low_enrolment),
    };
  });
}

/**
 * Turns the loaded rows into the Dashboard response.
 *
 * `weekRecords` covers this Monday-to-today plus the previous working day, so
 * today's figures, the week's escalations and yesterday's missed check-outs
 * all come from one read. `trendRows` are per-day totals already grouped by the
 * database. `failedRows` are the FAIL checkpoint rows of this week's
 * evaluations, one per failed checkpoint.
 */
export function buildDashboard({
  now,
  timeZone,
  college = null,
  colleges = [],
  roster = [],
  weekRecords = [],
  trendRows = [],
  unidentifiedByCollege = [],
  failedRows = [],
}) {
  const todayKey = localDateKey(now, timeZone);
  const weekStart = weekStartKey(todayKey);
  const previousDay = previousWorkingDayKey(todayKey);
  const sameDayLastWeek = addDaysToKey(todayKey, -7);

  const rosterById = new Map(roster.map((instructor) => [String(instructor._id), instructor]));
  const collegeNames = new Map(colleges.map((row) => [String(row._id), row.name || "Unnamed institute"]));

  const records = weekRecords.map((record) => ({ ...record, _day: dayKeyOf(record, timeZone) }));
  const today = records.filter((record) => record._day === todayKey);
  const todayIdentified = today.filter(identified);

  // ---- Today ---------------------------------------------------------------
  const presentIds = new Set(
    todayIdentified
      .map((record) => String(record.instructor_id))
      .filter((id) => rosterById.has(id))
  );
  const byStatus = { compliant: 0, unassessed: 0, non_compliant: 0, pending: 0, error: 0 };
  let checkedOut = 0;
  for (const record of todayIdentified) {
    const status = dashboardStatus(record.status);
    if (status in byStatus) byStatus[status] += 1;
    if (record.check_out_time) checkedOut += 1;
  }
  const analysed = byStatus.compliant + byStatus.non_compliant;
  const missedCheckout = records.filter(
    (record) => record._day === previousDay && identified(record) && !record.check_out_time
  ).length;

  // ---- Trend ---------------------------------------------------------------
  const trendByDay = new Map(trendRows.map((row) => [String(row._id), row]));
  const totalInstructors = roster.length;
  const trend = workingDayKeys(todayKey, TREND_WORKING_DAYS).map((day) => {
    const row = trendByDay.get(day) || {};
    const present = Number(row.present) || 0;
    const compliant = Number(row.compliant) || 0;
    const nonCompliant = Number(row.non_compliant) || 0;
    return {
      day,
      present,
      present_percent: percent(present, totalInstructors),
      compliant,
      non_compliant: nonCompliant,
      compliance_percent: percent(compliant, compliant + nonCompliant),
    };
  });
  const lastWeekRow = trendByDay.get(sameDayLastWeek);
  const lastWeekCompliance = lastWeekRow
    ? percent(Number(lastWeekRow.compliant) || 0, (Number(lastWeekRow.compliant) || 0) + (Number(lastWeekRow.non_compliant) || 0))
    : null;

  // ---- Failed checkpoints, this week ----------------------------------------
  const weekRecordsById = new Map(
    records.filter((record) => record._day >= weekStart).map((record) => [String(record._id), record])
  );
  const countedFailures = failedRows.filter((row) => {
    const record = weekRecordsById.get(String(row.attendance_id));
    if (!record) return false;
    // A check-out result counts only while the check-out it describes exists.
    if (row.kind === "checkout") return Boolean(record.check_out_time) && !record.checkout_deleting_at;
    return true;
  });
  const failureCounts = new Map();
  for (const row of countedFailures) {
    const current = failureCounts.get(row.code) || { code: row.code, name: row.name || row.code, count: 0 };
    current.count += 1;
    failureCounts.set(row.code, current);
  }
  const failedCheckpoints = [...failureCounts.values()]
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
    .slice(0, FAILED_CHECKPOINT_LIMIT)
    .map((row) => ({ ...row, audience: checkpointAudience(row.code) }));

  // ---- Escalations, this week ------------------------------------------------
  const weekByInstructor = new Map();
  for (const record of weekRecordsById.values()) {
    if (!identified(record)) continue;
    const id = String(record.instructor_id);
    if (!weekByInstructor.has(id)) weekByInstructor.set(id, []);
    weekByInstructor.get(id).push(record);
  }
  const failuresByAttendance = new Map();
  for (const row of countedFailures) {
    const key = String(row.attendance_id);
    if (!failuresByAttendance.has(key)) failuresByAttendance.set(key, []);
    failuresByAttendance.get(key).push(row.name || row.code);
  }
  const escalations = [];
  for (const [instructorId, group] of weekByInstructor) {
    const count = nonCompliantOccurrences(group).length;
    if (count < ESCALATION_THRESHOLD) continue;
    const latest = group.reduce((a, b) => (new Date(a.check_in_time || 0) > new Date(b.check_in_time || 0) ? a : b));
    const instructor = rosterById.get(instructorId);
    const collegeId = latest.college_id || instructor?.college_id || null;
    escalations.push({
      instructor_id: instructorId,
      name: instructor?.name || latest.instructor_name || "Unknown instructor",
      college_name: collegeId ? (collegeNames.get(String(collegeId)) || "Unknown institute") : "No institute",
      count,
      top_checkpoint: mostFrequent(group.flatMap((record) => failuresByAttendance.get(String(record._id)) || [])),
      attendance_id: String(latest._id),
    });
  }
  escalations.sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));

  // ---- Unidentified queue --------------------------------------------------------
  // The whole queue, whatever day each arrival was on: this is the figure on
  // the Unidentified tile, not a count of today.
  const unidentifiedTotal = unidentifiedByCollege.reduce((sum, row) => sum + (Number(row.count) || 0), 0);

  return {
    generated_at: now.toISOString(),
    time_zone: timeZone,
    today: todayKey,
    week_start: weekStart,
    previous_working_day: previousDay,
    same_day_last_week: sameDayLastWeek,
    college: college ? { college_id: String(college._id), name: college.name || "Unnamed institute" } : null,
    summary: {
      total_instructors: totalInstructors,
      present: presentIds.size,
      present_percent: percent(presentIds.size, totalInstructors),
      not_checked_in: Math.max(0, totalInstructors - presentIds.size),
      check_ins: todayIdentified.length,
      analysed,
      compliant: byStatus.compliant,
      non_compliant: byStatus.non_compliant,
      compliance_percent: percent(byStatus.compliant, analysed),
      compliance_same_day_last_week: lastWeekCompliance,
      unassessed: byStatus.unassessed,
      pending: byStatus.pending,
      errors: byStatus.error,
      checked_out: checkedOut,
      on_duty: Math.max(0, todayIdentified.length - checkedOut),
      missed_checkout_previous_day: missedCheckout,
      unidentified_waiting: unidentifiedTotal,
      unidentified_today: today.filter((record) => !identified(record) && dashboardStatus(record.status) === "unidentified").length,
    },
    status_breakdown: [
      { key: "compliant", count: byStatus.compliant },
      { key: "unassessed", count: byStatus.unassessed },
      { key: "non_compliant", count: byStatus.non_compliant },
      { key: "pending", count: byStatus.pending },
      { key: "error", count: byStatus.error },
    ],
    trend,
    failed_checkpoints: failedCheckpoints,
    escalations,
  };
}

const ACTIVE = { $or: [{ deleted_at: null }, { deleted_at: { $exists: false } }] };

export class DashboardCollegeNotFound extends Error {}

/**
 * Runs the Dashboard's queries and builds the response.
 *
 * Every attendance read filters on `date`, which is indexed on its own and
 * behind college_id, rather than on attendance_day, which is indexed only
 * behind instructor_id. Tombstoned records (deleting_at) are excluded
 * everywhere, since they are already on their way out of Daily Records.
 */
export async function loadDashboard(db, { collegeId = null, now = new Date() } = {}) {
  const timeZone = runtimeConfig().appTimeZone;
  const todayKey = localDateKey(now, timeZone);
  const collegeScope = collegeId ? { college_id: idMatch(String(collegeId)) } : {};

  const colleges = await coreCollection(db, "colleges")
    .find(collegeId ? { $and: [{ _id: idMatch(String(collegeId)) }, ACTIVE] } : ACTIVE, { projection: { name: 1 } })
    .sort({ name: 1 })
    .toArray();
  const college = collegeId ? colleges[0] || null : null;
  if (collegeId && !college) throw new DashboardCollegeNotFound("Institute not found");

  const weekStart = weekStartKey(todayKey);
  const previousDay = previousWorkingDayKey(todayKey);
  const recordsFrom = previousDay < weekStart ? previousDay : weekStart;
  const recordBounds = dateRangeBoundsInTimeZone(recordsFrom, todayKey, timeZone);
  const trendDays = workingDayKeys(todayKey, TREND_WORKING_DAYS);
  // The oldest trend day, or a week before today when the comparison day is
  // further back than that (it never is with 30 working days, but the bound
  // should not depend on it).
  const trendFrom = [trendDays[0], addDaysToKey(todayKey, -7)].sort()[0];
  const trendBounds = dateRangeBoundsInTimeZone(trendFrom, todayKey, timeZone);

  const [roster, weekRecords, trendRows, unidentifiedByCollege] = await Promise.all([
    coreCollection(db, "instructors")
      .find({ $and: [ACTIVE, collegeScope] }, { projection: { name: 1, college_id: 1 } })
      .toArray(),
    coreCollection(db, "attendance")
      .find(
        {
          date: { $gte: recordBounds.start, $lt: recordBounds.end },
          deleting_at: { $exists: false },
          ...collegeScope,
        },
        {
          projection: {
            instructor_id: 1,
            instructor_name: 1,
            college_id: 1,
            attendance_day: 1,
            date: 1,
            check_in_time: 1,
            check_out_time: 1,
            status: 1,
            checkout_compliance_status: 1,
            checkout_deleting_at: 1,
          },
        }
      )
      .toArray(),
    coreCollection(db, "attendance").aggregate([
      {
        $match: {
          date: { $gte: trendBounds.start, $lt: trendBounds.end },
          deleting_at: { $exists: false },
          ...collegeScope,
        },
      },
      {
        $project: {
          day: {
            $ifNull: [
              "$attendance_day",
              {
                $dateToString: {
                  date: { $ifNull: ["$check_in_time", "$date"] },
                  format: "%Y-%m-%d",
                  timezone: timeZone,
                },
              },
            ],
          },
          instructor: {
            $cond: [
              { $eq: [{ $ifNull: ["$instructor_id", null] }, null] },
              null,
              { $toString: "$instructor_id" },
            ],
          },
          status: { $toLower: { $ifNull: ["$status", ""] } },
        },
      },
      {
        $group: {
          _id: "$day",
          instructors: { $addToSet: "$instructor" },
          compliant: { $sum: { $cond: [{ $in: ["$status", [...COMPLIANT_STATUSES]] }, 1, 0] } },
          non_compliant: { $sum: { $cond: [{ $in: ["$status", [...NON_COMPLIANT_STATUSES]] }, 1, 0] } },
        },
      },
      {
        $project: {
          present: { $size: { $setDifference: ["$instructors", [null]] } },
          compliant: 1,
          non_compliant: 1,
        },
      },
    ]).toArray(),
    coreCollection(db, "attendance").aggregate([
      {
        $match: {
          status: "unidentified",
          instructor_id: null,
          deleting_at: { $exists: false },
          ...collegeScope,
        },
      },
      { $group: { _id: "$college_id", count: { $sum: 1 } } },
    ]).toArray(),
  ]);

  const weekIds = weekRecords
    .filter((record) => (record.attendance_day || localDateKey(new Date(record.check_in_time || record.date), timeZone)) >= weekStart)
    .map((record) => record._id);
  const failedRows = await failedCheckpointRows(db, weekIds);

  return buildDashboard({
    now,
    timeZone,
    college,
    colleges,
    roster,
    weekRecords,
    trendRows,
    unidentifiedByCollege,
    failedRows,
  });
}

export class DashboardRangeError extends Error {}

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

function validDayKey(value) {
  if (!DAY_KEY.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * Normalises the Institutes table's date range. Either end may be empty, which
 * leaves that side open ("All time" sends both empty). The end is capped at
 * today: a day that has not happened has no attendance to count, and counting
 * it as a working day would drag every institute's figure down.
 */
export function normalizeInstituteRange({ from = "", to = "" } = {}, todayKey) {
  for (const [name, value] of [["from", from], ["to", to]]) {
    if (typeof value !== "string" || (value !== "" && !validDayKey(value))) {
      throw new DashboardRangeError(`${name} must be a date in YYYY-MM-DD format`);
    }
  }
  if (from && to && from > to) throw new DashboardRangeError("from must be on or before to");
  if (from && from > todayKey) throw new DashboardRangeError("The range starts after today");
  const end = !to || to > todayKey ? todayKey : to;
  return { from, to: end };
}

/**
 * The Institutes table for any date range, counted by the database.
 *
 * Grouped in one aggregation rather than read record by record, because "All
 * time" covers every attendance record ever written. An identified record is a
 * check-in, counted as compliant or non-compliant by the same statuses
 * dashboardStatus reads; an unnamed one counts only as an unidentified arrival.
 */
export async function loadInstituteStats(db, { from = "", to = "", now = new Date() } = {}) {
  const timeZone = runtimeConfig().appTimeZone;
  const todayKey = localDateKey(now, timeZone);
  const range = normalizeInstituteRange({ from, to }, todayKey);
  const bounds = dateRangeBoundsInTimeZone(range.from || undefined, range.to, timeZone);
  const date = { $lt: bounds.end, ...(bounds.start ? { $gte: bounds.start } : {}) };

  const [colleges, roster, enrolment, identificationSettings, groups] = await Promise.all([
    coreCollection(db, "colleges").find(ACTIVE, { projection: { name: 1 } }).sort({ name: 1 }).toArray(),
    coreCollection(db, "instructors").find(ACTIVE, { projection: { college_id: 1 } }).toArray(),
    loadCollegeEnrolment(db),
    getIdentificationSettings(db),
    coreCollection(db, "attendance").aggregate([
      { $match: { date, deleting_at: { $exists: false } } },
      {
        $project: {
          college: {
            $cond: [{ $eq: [{ $ifNull: ["$college_id", null] }, null] }, null, { $toString: "$college_id" }],
          },
          identified: { $ne: [{ $ifNull: ["$instructor_id", null] }, null] },
          status: { $toLower: { $ifNull: ["$status", ""] } },
          day: {
            $ifNull: [
              "$attendance_day",
              {
                $dateToString: {
                  date: { $ifNull: ["$check_in_time", "$date"] },
                  format: "%Y-%m-%d",
                  timezone: timeZone,
                },
              },
            ],
          },
        },
      },
      {
        $group: {
          _id: "$college",
          check_ins: { $sum: { $cond: ["$identified", 1, 0] } },
          compliant: {
            $sum: { $cond: [{ $and: ["$identified", { $in: ["$status", [...COMPLIANT_STATUSES]] }] }, 1, 0] },
          },
          non_compliant: {
            $sum: { $cond: [{ $and: ["$identified", { $in: ["$status", [...NON_COMPLIANT_STATUSES]] }] }, 1, 0] },
          },
          unidentified: {
            $sum: { $cond: [{ $and: [{ $not: ["$identified"] }, { $eq: ["$status", "unidentified"] }] }, 1, 0] },
          },
          first_day: { $min: "$day" },
        },
      },
    ]).toArray(),
  ]);

  // "All time" starts at the first recorded day rather than an invented date.
  const firstRecorded = groups.map((row) => row.first_day).filter(Boolean).sort()[0] || range.to;
  const start = range.from || (firstRecorded < range.to ? firstRecorded : range.to);
  const workingDays = countWorkingDays(start, range.to);

  return {
    from: start,
    to: range.to,
    working_days: workingDays,
    institutes: buildInstituteRows({
      colleges,
      roster,
      identificationSettings,
      enrolment,
      groups,
      workingDays,
    }),
  };
}

/**
 * The page refreshes itself every 30 seconds for every administrator who has
 * it open, so a response is shared for a few seconds rather than recomputed
 * per request. Short enough that a new check-in still shows within one
 * refresh.
 */
const CACHE_MS = 10_000;
const cache = new Map();

export function clearDashboardCache() {
  cache.clear();
  rangeCache.clear();
}

const rangeCache = new Map();

/** Same short sharing as the Dashboard, keyed by the requested range. */
export async function cachedInstituteStats(db, { from = "", to = "", now = new Date() } = {}) {
  const key = `${from}|${to}`;
  const hit = rangeCache.get(key);
  if (hit && now.getTime() - hit.at < CACHE_MS) return hit.promise;
  // Validated before anything is cached, so a bad range is never stored.
  normalizeInstituteRange({ from, to }, localDateKey(now, runtimeConfig().appTimeZone));
  if (rangeCache.size > 50) rangeCache.clear();
  const promise = loadInstituteStats(db, { from, to, now });
  rangeCache.set(key, { at: now.getTime(), promise });
  promise.catch(() => {
    if (rangeCache.get(key)?.promise === promise) rangeCache.delete(key);
  });
  return promise;
}

export async function cachedDashboard(db, { collegeId = null, now = new Date() } = {}) {
  const key = collegeId ? String(collegeId) : "*";
  const hit = cache.get(key);
  if (hit && now.getTime() - hit.at < CACHE_MS) return hit.promise;
  const promise = loadDashboard(db, { collegeId, now });
  cache.set(key, { at: now.getTime(), promise });
  // A failed load is not kept, so the next refresh tries again.
  promise.catch(() => {
    if (cache.get(key)?.promise === promise) cache.delete(key);
  });
  return promise;
}
