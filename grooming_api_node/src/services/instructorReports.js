import crypto from "node:crypto";
import { runtimeConfig } from "../config/env.js";
import { coreCollection } from "../stores/coreStore.js";

const TOKEN_BYTES = 24;

export async function ensureReportToken(db, instructor) {
  if (instructor?.report_token) return instructor.report_token;
  const token = crypto.randomBytes(TOKEN_BYTES).toString("base64url");
  const result = await coreCollection(db, "instructors").findOneAndUpdate(
    {
      _id: instructor._id,
      $or: [
        { report_token: { $exists: false } },
        { report_token: null },
        { report_token: "" },
      ],
    },
    { $set: { report_token: token, updated_at: new Date() } }
    , { returnDocument: "after", projection: { report_token: 1 } }
  );
  const claimed = result?.value || result;
  if (claimed?.report_token) return claimed.report_token;
  const authoritative = await coreCollection(db, "instructors").findOne(
    { _id: instructor._id },
    { projection: { report_token: 1 } }
  );
  if (!authoritative?.report_token) throw new Error("Report token could not be persisted");
  return authoritative.report_token;
}

export async function findInstructorByReportToken(db, token) {
  if (!token || typeof token !== "string" || token.length > 128) return null;
  return coreCollection(db, "instructors").findOne({ report_token: token });
}

export function localDateKey(date, timeZone = runtimeConfig().appTimeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function weekStartKey(date, timeZone = runtimeConfig().appTimeZone) {
  const key = localDateKey(date, timeZone);
  const [year, month, day] = key.split("-").map(Number);
  const local = new Date(Date.UTC(year, month - 1, day));
  const weekday = local.getUTCDay();
  const daysSinceMonday = weekday === 0 ? 6 : weekday - 1;
  local.setUTCDate(local.getUTCDate() - daysSinceMonday);
  return local.toISOString().slice(0, 10);
}

export function workingWeekDates(startKey) {
  const [year, month, day] = startKey.split("-").map(Number);
  const dates = [];
  for (let offset = 0; offset < 6; offset += 1) {
    const date = new Date(Date.UTC(year, month - 1, day + offset));
    dates.push(date.toISOString().slice(0, 10));
  }
  return dates;
}

export function isValidDateKey(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

export const REQUIRED_SAREE_DAYS = 3;
export const REQUIRED_KURTI_DAYS = 3;

export function weeklyRotation({ gender, sareeDays, kurtiDays, unknownDays, weekComplete, abayaDays = 0 }) {
  if (String(gender || "").toUpperCase() !== "FEMALE") return null;
  const base = {
    saree_days: sareeDays,
    kurti_days: kurtiDays,
    unknown_days: unknownDays,
    required_saree_days: REQUIRED_SAREE_DAYS,
    required_kurti_days: REQUIRED_KURTI_DAYS,
    ...(abayaDays ? { abaya_days: abayaDays } : {}),
  };
  if (abayaDays > 0) return { ...base, status: "NOT_APPLICABLE" };
  if (!weekComplete) return { ...base, status: "IN_PROGRESS" };
  if (unknownDays > 0) return { ...base, status: "INSUFFICIENT_DATA" };
  const satisfied = sareeDays >= REQUIRED_SAREE_DAYS && kurtiDays >= REQUIRED_KURTI_DAYS;
  return { ...base, status: satisfied ? "PASS" : "FAIL" };
}

export function summariseWeek(records, startKey, options = {}) {
  const dates = workingWeekDates(startKey);
  const byDate = new Map();
  for (const record of records) {
    const key = localDateKey(new Date(record.check_in_time || record.date));
    const existing = byDate.get(key);
    if (!existing || new Date(record.check_in_time) < new Date(existing.check_in_time)) {
      byDate.set(key, record);
    }
  }

  const days = dates.map((date) => {
    const record = byDate.get(date) || null;
    return {
      date,
      present: Boolean(record),
      attendance_id: record ? String(record._id) : null,
      check_in_time: record?.check_in_time || null,
      check_out_time: record?.check_out_time || null,
      status: record?.status || null,
      attire_type: record?.attire_type || null,
      remarks: record?.remarks || null,
      missed_checkout: Boolean(record && !record.check_out_time),
    };
  });

  const counted = days.filter((day) => day.present);
  return {
    week_start: startKey,
    week_end: dates[dates.length - 1],
    days,
    present_days: counted.length,
    compliant_days: counted.filter(
      (day) => day.status === "compliant" || day.status === "review_required"
    ).length,
    non_compliant_days: counted.filter((day) => day.status === "non_compliant").length,
    saree_days: counted.filter((day) => day.attire_type === "SAREE").length,
    kurti_days: counted.filter((day) => day.attire_type === "KURTI_WITH_DUPATTA").length,
    formal_days: counted.filter((day) => day.attire_type === "FORMAL").length,
    abaya_days: counted.filter((day) => day.attire_type === "ABAYA").length,
    kurta_days: counted.filter((day) => day.attire_type === "KURTA_PAJAMA").length,
    missed_checkouts: counted.filter((day) => day.missed_checkout).length,
    weekly_rotation: weeklyRotation({
      gender: options.gender,
      sareeDays: counted.filter((day) => day.attire_type === "SAREE").length,
      kurtiDays: counted.filter((day) => day.attire_type === "KURTI_WITH_DUPATTA").length,
      abayaDays: counted.filter((day) => day.attire_type === "ABAYA").length,
      unknownDays: counted.filter(
        (day) => !day.attire_type || day.attire_type === "UNKNOWN"
      ).length,
      weekComplete: options.weekComplete ?? days.every((day) => day.date < localDateKey(new Date())),
    }),
  };
}
