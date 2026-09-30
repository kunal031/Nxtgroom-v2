import {
  addDaysToKey,
  ESCALATION_THRESHOLD,
  nonCompliantOccurrences,
  weekStartKey,
} from "./evaluationWorker.js";
import { coreCollection } from "../stores/coreStore.js";

/**
 * Which instructors are in escalation, for the rows of a Daily Records page.
 *
 * An instructor is escalated for a Monday-to-Sunday week once they have three
 * or more non-compliant results in it - the same count, from the same function,
 * that sends reporting partners the URGENT email, so the table and the inbox
 * can never disagree about who is escalated.
 *
 * The count covers the whole week whatever range the page is showing. A page
 * filtered to today still knows about Monday's and Tuesday's failures, which
 * is the only way "escalated" can mean anything on a single-day view.
 *
 * One query for the page: every instructor on it, across every week its rows
 * touch. Returns a map keyed `${instructorId}|${weekStart}`, holding only the
 * escalated pairs.
 */
export async function weeklyEscalations(db, rows, scope = {}) {
  const weeksByInstructor = new Map();
  for (const row of rows || []) {
    if (!row?.instructor_id || !row.attendance_day) continue;
    const instructorId = String(row.instructor_id);
    if (!weeksByInstructor.has(instructorId)) weeksByInstructor.set(instructorId, new Set());
    weeksByInstructor.get(instructorId).add(weekStartKey(row.attendance_day));
  }
  if (!weeksByInstructor.size) return new Map();

  const weeks = [...new Set([...weeksByInstructor.values()].flatMap((set) => [...set]))];
  const days = weeks.flatMap((week) => Array.from({ length: 7 }, (_, offset) => addDaysToKey(week, offset)));

  const records = await coreCollection(db, "attendance").find(
    {
      instructor_id: { $in: [...weeksByInstructor.keys()] },
      attendance_day: { $in: days },
      deleting_at: { $exists: false },
      ...scope,
    },
    {
      projection: {
        instructor_id: 1,
        attendance_day: 1,
        check_in_time: 1,
        check_out_time: 1,
        status: 1,
        checkout_compliance_status: 1,
        checkout_deleting_at: 1,
      },
    }
  ).toArray();

  const groups = new Map();
  for (const record of records) {
    const key = `${record.instructor_id}|${weekStartKey(record.attendance_day)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }

  const escalated = new Map();
  for (const [key, group] of groups) {
    const count = nonCompliantOccurrences(group).length;
    if (count < ESCALATION_THRESHOLD) continue;
    const weekStart = key.slice(key.lastIndexOf("|") + 1);
    escalated.set(key, { week_start: weekStart, week_end: addDaysToKey(weekStart, 6), count });
  }
  return escalated;
}

/** The escalation for one row, or null. */
export function escalationFor(escalations, row) {
  if (!row?.instructor_id || !row.attendance_day) return null;
  return escalations.get(`${row.instructor_id}|${weekStartKey(row.attendance_day)}`) || null;
}
