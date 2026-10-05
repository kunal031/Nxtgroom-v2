import { dateBoundsInTimeZone } from "../utils.js";
import { runtimeConfig } from "../config/env.js";
import { coreCollection } from "../stores/coreStore.js";

export const NOT_CHECKED_OUT = "not_checked_out";

export function openCheckInFilter(dayKey, { timeZone = runtimeConfig().appTimeZone } = {}) {
  const { start, end } = dateBoundsInTimeZone(dayKey, timeZone);
  return {
    check_out_time: null,
    checkout_status: { $ne: NOT_CHECKED_OUT },
    instructor_id: { $type: "string" },
    deleting_at: { $exists: false },
    $or: [
      { attendance_day: dayKey },
      {
        attendance_day: { $exists: false },
        check_in_time: { $gte: start, $lt: end },
      },
    ],
  };
}

export function dayToClose(now = new Date(), { timeZone = runtimeConfig().appTimeZone } = {}) {
  const insideYesterday = new Date(now.getTime() - 60 * 60_000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(insideYesterday);
}

export async function closeOpenCheckIns(db, { dayKey, now = new Date() } = {}) {
  const day = dayKey || dayToClose(now);
  const filter = openCheckInFilter(day);
  const result = await coreCollection(db, "attendance").updateMany(filter, {
    $set: {
      checkout_status: NOT_CHECKED_OUT,
      checkout_status_set_at: now,
      updated_at: now,
    },
  });
  return { day, marked: result.modifiedCount || 0 };
}
