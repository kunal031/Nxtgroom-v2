import { dateBoundsInTimeZone } from "../utils.js";
import { runtimeConfig } from "../config/env.js";

/**
 * Marking check-ins that nobody closed.
 *
 * A forgotten check-out leaves a record open for ever, and nothing in the
 * database says whether that means "still working" or "went home without
 * tapping". At local midnight the day is over, so every record still open is the
 * second case and is marked as such — which is what makes it visible to somebody
 * reading the collection directly rather than inferred by the interface.
 *
 * The mark is descriptive, never a lock. A session that began at 11 PM is
 * genuinely still running when midnight marks it, so the check-out path must
 * keep working on a marked record: closing it simply replaces the mark with a
 * real check-out time. checkoutAvailability keys off check_out_time for exactly
 * this reason and never reads this field.
 */

/** Written to `checkout_status` on a day nobody closed. */
export const NOT_CHECKED_OUT = "not_checked_out";

/**
 * Matches records belonging to one finished local day that were never closed.
 *
 * `attendance_day` is the local date key, so the filter does not have to reason
 * about UTC boundaries. Older rows predate that field and are matched by their
 * check-in instant instead, using the same local-day bounds — otherwise the
 * oldest records, the ones most likely to have been abandoned, would be the only
 * ones never marked.
 */
export function openCheckInFilter(dayKey, { timeZone = runtimeConfig().appTimeZone } = {}) {
  const { start, end } = dateBoundsInTimeZone(dayKey, timeZone);
  return {
    check_out_time: null,
    // Already marked records are skipped, so a repeated run writes nothing and
    // the job is safe to retry or run twice.
    checkout_status: { $ne: NOT_CHECKED_OUT },
    // An unidentified record has no instructor and no day to close on their
    // behalf; it belongs to the identify queue until somebody names it.
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

/**
 * The local day a midnight run should be closing.
 *
 * Run at 00:00 the day that just ended is yesterday, so the key is taken from a
 * moment inside it rather than from `now`. Using today's key would mark the day
 * that has only just started, closing every check-in the moment it was made.
 */
export function dayToClose(now = new Date(), { timeZone = runtimeConfig().appTimeZone } = {}) {
  const insideYesterday = new Date(now.getTime() - 60 * 60_000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(insideYesterday);
}

/**
 * Marks every unclosed check-in for one finished day.
 *
 * Returns what it changed rather than logging it, so the cron response can say
 * plainly how many days were left open — a number worth watching, since a rising
 * count means instructors are not being prompted to check out.
 */
export async function closeOpenCheckIns(db, { dayKey, now = new Date() } = {}) {
  const day = dayKey || dayToClose(now);
  const filter = openCheckInFilter(day);
  const result = await db.collection("attendance").updateMany(filter, {
    $set: {
      checkout_status: NOT_CHECKED_OUT,
      // Recorded separately from updated_at so it is clear this came from the
      // scheduled close rather than from somebody editing the record.
      checkout_status_set_at: now,
      updated_at: now,
    },
  });
  return { day, marked: result.modifiedCount || 0 };
}
