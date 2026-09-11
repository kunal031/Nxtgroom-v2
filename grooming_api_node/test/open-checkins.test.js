import assert from "node:assert/strict";
import { test } from "node:test";
import {
  closeOpenCheckIns,
  dayToClose,
  NOT_CHECKED_OUT,
  openCheckInFilter,
} from "../src/services/openCheckIns.js";

/**
 * Marking the days nobody closed.
 *
 * The risk here is marking the wrong day. Closing today instead of yesterday
 * would mark every check-in the moment it was made, so an instructor who had
 * just arrived would be recorded as having never checked out — and the run is
 * scheduled for midnight, the one moment when "today" and "the day that just
 * ended" differ.
 */

const zone = "Asia/Kolkata";
/** 11 September 2026 at the given IST wall-clock time. */
const ist = (hour, minute = 0) => new Date(Date.UTC(2026, 8, 11, hour - 5, minute - 30));

function fakeDb() {
  const calls = [];
  return {
    calls,
    collection() {
      return {
        async updateMany(filter, update) {
          calls.push({ filter, update });
          return { modifiedCount: 2 };
        },
        async countDocuments() {
          return 7;
        },
      };
    },
  };
}

test("a midnight run closes the day that just ended, not the one starting", () => {
  // 00:05 IST on the 12th: the day to close is the 11th. Using today's key
  // would mark check-ins made seconds earlier.
  const justAfterMidnight = new Date(Date.UTC(2026, 8, 11, 18, 35));
  assert.equal(dayToClose(justAfterMidnight, { timeZone: zone }), "2026-09-11");
});

test("a run at midnight exactly still closes yesterday", () => {
  // 00:00 IST on the 12th is 18:30 UTC on the 11th.
  const atMidnight = new Date(Date.UTC(2026, 8, 11, 18, 30));
  assert.equal(dayToClose(atMidnight, { timeZone: zone }), "2026-09-11");
});

test("a run late in the evening would close the same day, which is why it is scheduled for midnight", () => {
  // Stated so the scheduling requirement is recorded rather than assumed: at
  // 23:00 the day is not over, and an hour earlier is still the same day.
  assert.equal(dayToClose(ist(23, 0), { timeZone: zone }), "2026-09-11");
});

test("only records with no check-out are matched", () => {
  const filter = openCheckInFilter("2026-09-11", { timeZone: zone });
  assert.equal(filter.check_out_time, null);
});

test("already marked records are skipped, so a repeat run writes nothing", () => {
  const filter = openCheckInFilter("2026-09-11", { timeZone: zone });
  assert.deepEqual(filter.checkout_status, { $ne: NOT_CHECKED_OUT });
});

test("unidentified records are left to the identify queue", () => {
  // They have no instructor, so there is no day to close on anybody's behalf.
  const filter = openCheckInFilter("2026-09-11", { timeZone: zone });
  assert.deepEqual(filter.instructor_id, { $type: "string" });
});

test("records being deleted are not touched", () => {
  const filter = openCheckInFilter("2026-09-11", { timeZone: zone });
  assert.deepEqual(filter.deleting_at, { $exists: false });
});

test("older records without a day key are matched by their check-in instant", () => {
  // Otherwise the oldest records, the ones most likely to have been abandoned,
  // would be the only ones never marked.
  const filter = openCheckInFilter("2026-09-11", { timeZone: zone });
  const [byDay, byInstant] = filter.$or;
  assert.equal(byDay.attendance_day, "2026-09-11");
  assert.deepEqual(byInstant.attendance_day, { $exists: false });
  assert.ok(byInstant.check_in_time.$gte instanceof Date);
  assert.ok(byInstant.check_in_time.$lt instanceof Date);
  // The window is one local day wide.
  const hours = (byInstant.check_in_time.$lt - byInstant.check_in_time.$gte) / 3_600_000;
  assert.equal(hours, 24);
});

test("marking writes the status and when it was set, and reports the count", async () => {
  const db = fakeDb();
  const now = ist(23, 59);
  const result = await closeOpenCheckIns(db, { dayKey: "2026-09-11", now });

  assert.equal(result.day, "2026-09-11");
  assert.equal(result.marked, 2);

  const [{ update }] = db.calls;
  assert.equal(update.$set.checkout_status, NOT_CHECKED_OUT);
  // Separate from updated_at, so it is clear this came from the scheduled close
  // rather than somebody editing the record.
  assert.equal(update.$set.checkout_status_set_at, now);
  assert.equal(update.$set.updated_at, now);
});

test("nothing about the check-in itself is rewritten", async () => {
  // The arrival happened; only the absence of a departure is being recorded.
  const db = fakeDb();
  await closeOpenCheckIns(db, { dayKey: "2026-09-11" });
  const [{ update }] = db.calls;
  for (const field of ["check_in_time", "check_in_photo_key", "location_coordinates", "status", "instructor_id"]) {
    assert.equal(update.$set[field], undefined, `${field} must not be rewritten`);
  }
  // And no check-out time is invented.
  assert.equal(update.$set.check_out_time, undefined);
});

test("the day defaults to yesterday when none is given", async () => {
  const db = fakeDb();
  const result = await closeOpenCheckIns(db, { now: new Date(Date.UTC(2026, 8, 11, 18, 35)) });
  assert.equal(result.day, "2026-09-11");
});
