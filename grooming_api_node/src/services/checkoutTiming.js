import { runtimeConfig } from "../config/env.js";

/**
 * When an instructor may check out, given when they checked in.
 *
 * A check-out that happens moments after a check-in records a working day that
 * did not happen, so there is a minimum wait. Which minimum depends on when they
 * arrived:
 *
 * - Checked in before noon: check-out opens at noon. Somebody who arrives in the
 *   morning is there for the morning, and noon is the boundary the college
 *   already works to.
 * - Checked in at or after noon: check-out opens ten minutes later. There is no
 *   later boundary to wait for, so the rule only has to stop an immediate
 *   check-out.
 *
 * Noon means noon where the instructor is, which is why every comparison goes
 * through the configured time zone rather than the server's.
 *
 * Deliberately a pure function taking `now`: a rule about clock time that reads
 * the clock itself cannot be tested at the boundaries that matter.
 */

/** Local hour after which a check-in no longer waits for noon. */
export const NOON_HOUR = 12;

/** The wait applied to an afternoon check-in. */
export const AFTERNOON_MINIMUM_MS = 10 * 60_000;

export const CHECKOUT_TIMING = Object.freeze({
  ALLOWED: "allowed",
  TOO_EARLY: "too_early",
});

/** The local wall-clock parts of an instant, in the configured zone. */
function localParts(value, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  return Object.fromEntries(
    parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)])
  );
}

/**
 * The instant at which local noon occurs on the same local day as `reference`.
 *
 * Derived by measuring the zone's offset at that moment rather than assuming a
 * fixed one, so a zone that shifts between the check-in and noon still resolves
 * to the correct instant.
 */
function localNoonOn(reference, timeZone) {
  const { year, month, day } = localParts(reference, timeZone);
  const target = Date.UTC(year, month - 1, day, NOON_HOUR, 0, 0);
  let candidate = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = localParts(new Date(candidate), timeZone);
    const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    const drift = target - asUtc;
    if (drift === 0) break;
    candidate += drift;
  }
  return new Date(candidate);
}

/**
 * Whether this check-in may be closed yet, and when it can be.
 *
 * Returns the opening instant even when the answer is "allowed", so a caller can
 * say what the rule was rather than only that it passed.
 */
export function checkoutTiming(checkInTime, { now = new Date(), timeZone = runtimeConfig().appTimeZone } = {}) {
  // null and "" are rejected before Date sees them: new Date(null) is the epoch
  // rather than an invalid date, so a NaN check alone would treat a missing
  // check-in time as 1 January 1970 and apply the afternoon rule to it.
  const hasValue = checkInTime instanceof Date
    || (typeof checkInTime === "string" && checkInTime.trim() !== "")
    || typeof checkInTime === "number";
  const checkedInAt = hasValue ? new Date(checkInTime) : new Date(NaN);
  if (Number.isNaN(checkedInAt.getTime())) {
    // A record with no usable check-in time cannot be reasoned about. Allowing
    // the check-out is the safer failure: refusing would strand somebody over a
    // data fault that is not theirs.
    return { state: CHECKOUT_TIMING.ALLOWED, opens_at: null, rule: "unknown_check_in_time" };
  }

  const noon = localNoonOn(checkedInAt, timeZone);
  const beforeNoon = checkedInAt.getTime() < noon.getTime();
  const opensAt = beforeNoon
    ? noon
    : new Date(checkedInAt.getTime() + AFTERNOON_MINIMUM_MS);
  const rule = beforeNoon ? "morning_waits_for_noon" : "afternoon_waits_ten_minutes";

  if (now.getTime() >= opensAt.getTime()) {
    return { state: CHECKOUT_TIMING.ALLOWED, opens_at: opensAt, rule };
  }
  return {
    state: CHECKOUT_TIMING.TOO_EARLY,
    opens_at: opensAt,
    rule,
    minutes_remaining: Math.max(1, Math.ceil((opensAt.getTime() - now.getTime()) / 60_000)),
  };
}

/**
 * What to tell somebody standing at the tablet.
 *
 * An early appearance records nothing, so the screen has to explain itself or it
 * looks broken: the instructor pressed a button, no row changed, and nothing
 * said why.
 */
export function describeCheckoutTiming(timing, { timeZone = runtimeConfig().appTimeZone } = {}) {
  if (timing.state === CHECKOUT_TIMING.ALLOWED) return null;
  const opensAtLabel = new Intl.DateTimeFormat("en-IN", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(timing.opens_at);
  return timing.rule === "morning_waits_for_noon"
    ? `Already checked in this morning. Check-out opens at ${opensAtLabel}.`
    : `Already checked in. Check-out opens at ${opensAtLabel}, about ${timing.minutes_remaining} minute${timing.minutes_remaining === 1 ? "" : "s"} from now.`;
}
