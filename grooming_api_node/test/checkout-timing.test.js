import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AFTERNOON_MINIMUM_MS,
  CHECKOUT_TIMING,
  checkoutTiming,
  describeCheckoutTiming,
} from "../src/services/checkoutTiming.js";

/**
 * When a check-out is allowed.
 *
 * Every case here is a boundary, because that is where a clock rule goes wrong
 * and where the consequence is somebody being told they cannot leave. Times are
 * written as IST instants — the zone the colleges run on — since the rule is
 * about local noon, not UTC noon.
 */

const zone = "Asia/Kolkata";
/** 11:55 IST on 11 September 2026 is 06:25 UTC: IST is UTC+5:30. */
const ist = (hour, minute = 0) => new Date(Date.UTC(2026, 8, 11, hour - 5, minute - 30));

test("a morning check-in waits for noon, however late in the morning it was", () => {
  // 11:55 is the case that motivated the rule: five minutes later is noon, and
  // noon is the boundary the college works to.
  for (const [hour, minute] of [[7, 0], [9, 30], [11, 55]]) {
    const timing = checkoutTiming(ist(hour, minute), { now: ist(11, 59), timeZone: zone });
    assert.equal(timing.state, CHECKOUT_TIMING.TOO_EARLY, `${hour}:${minute} should wait`);
    assert.equal(timing.rule, "morning_waits_for_noon");
  }
});

test("a morning check-in may close exactly at noon", () => {
  const timing = checkoutTiming(ist(9, 0), { now: ist(12, 0), timeZone: zone });
  assert.equal(timing.state, CHECKOUT_TIMING.ALLOWED);
  assert.equal(timing.rule, "morning_waits_for_noon");
});

test("11:55 can close at 12:00, five minutes later", () => {
  // Deliberate: the morning rule is a boundary, not a minimum duration.
  const atNoon = checkoutTiming(ist(11, 55), { now: ist(12, 0), timeZone: zone });
  assert.equal(atNoon.state, CHECKOUT_TIMING.ALLOWED);

  const justBefore = checkoutTiming(ist(11, 55), { now: ist(11, 59), timeZone: zone });
  assert.equal(justBefore.state, CHECKOUT_TIMING.TOO_EARLY);
});

test("an afternoon check-in waits ten minutes, not for the next noon", () => {
  // Waiting for noon would mean waiting until tomorrow, which is not a rule
  // anybody could follow.
  const checkedIn = ist(14, 0);
  assert.equal(
    checkoutTiming(checkedIn, { now: ist(14, 5), timeZone: zone }).state,
    CHECKOUT_TIMING.TOO_EARLY
  );
  assert.equal(
    checkoutTiming(checkedIn, { now: ist(14, 10), timeZone: zone }).state,
    CHECKOUT_TIMING.ALLOWED
  );
  assert.equal(
    checkoutTiming(checkedIn, { now: ist(14, 5), timeZone: zone }).rule,
    "afternoon_waits_ten_minutes"
  );
});

test("a check-in exactly at noon takes the afternoon rule", () => {
  // Noon is not before noon, so there is nothing left to wait for but the
  // minimum gap.
  const timing = checkoutTiming(ist(12, 0), { now: ist(12, 1), timeZone: zone });
  assert.equal(timing.rule, "afternoon_waits_ten_minutes");
  assert.equal(timing.state, CHECKOUT_TIMING.TOO_EARLY);
  assert.equal(
    checkoutTiming(ist(12, 0), { now: ist(12, 10), timeZone: zone }).state,
    CHECKOUT_TIMING.ALLOWED
  );
});

test("the opening instant is reported, so the screen can name a time", () => {
  const morning = checkoutTiming(ist(9, 0), { now: ist(10, 0), timeZone: zone });
  assert.equal(morning.opens_at.getTime(), ist(12, 0).getTime());

  const afternoon = checkoutTiming(ist(15, 20), { now: ist(15, 21), timeZone: zone });
  assert.equal(afternoon.opens_at.getTime(), ist(15, 20).getTime() + AFTERNOON_MINIMUM_MS);
});

test("an allowed check-out still reports which rule applied", () => {
  // So a caller can explain the decision rather than only that it passed.
  const timing = checkoutTiming(ist(9, 0), { now: ist(17, 0), timeZone: zone });
  assert.equal(timing.state, CHECKOUT_TIMING.ALLOWED);
  assert.equal(timing.rule, "morning_waits_for_noon");
  assert.ok(timing.opens_at instanceof Date);
});

test("minutes remaining is never zero while the answer is still too early", () => {
  // Rounded up: "0 minutes from now" alongside a refusal reads as a bug.
  const timing = checkoutTiming(ist(14, 0), { now: new Date(ist(14, 10).getTime() - 1_000), timeZone: zone });
  assert.equal(timing.state, CHECKOUT_TIMING.TOO_EARLY);
  assert.ok(timing.minutes_remaining >= 1);
});

test("an unusable check-in time allows the check-out rather than stranding anybody", () => {
  // A data fault is not the instructor's, and refusing would leave them unable
  // to close their day at all.
  for (const value of [null, undefined, "", "not a date"]) {
    const timing = checkoutTiming(value, { now: ist(14, 0), timeZone: zone });
    assert.equal(timing.state, CHECKOUT_TIMING.ALLOWED);
    assert.equal(timing.rule, "unknown_check_in_time");
  }
});

test("noon is local noon, not the server's", () => {
  // 08:00 UTC is 13:30 IST, so in IST this is an afternoon check-in even though
  // a UTC reading of the same instant would call it morning.
  const timing = checkoutTiming(new Date(Date.UTC(2026, 8, 11, 8, 0)), {
    now: new Date(Date.UTC(2026, 8, 11, 8, 5)),
    timeZone: zone,
  });
  assert.equal(timing.rule, "afternoon_waits_ten_minutes");
});

test("the message names the time check-out opens", () => {
  const morning = describeCheckoutTiming(
    checkoutTiming(ist(9, 0), { now: ist(10, 0), timeZone: zone }),
    { timeZone: zone }
  );
  assert.match(morning, /already checked in/i);
  assert.match(morning, /12:00/);

  const afternoon = describeCheckoutTiming(
    checkoutTiming(ist(14, 0), { now: ist(14, 2), timeZone: zone }),
    { timeZone: zone }
  );
  assert.match(afternoon, /2:10/);
  assert.match(afternoon, /minute/);
});

test("an allowed timing has nothing to explain", () => {
  const timing = checkoutTiming(ist(9, 0), { now: ist(17, 0), timeZone: zone });
  assert.equal(describeCheckoutTiming(timing, { timeZone: zone }), null);
});
