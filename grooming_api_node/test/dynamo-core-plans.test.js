import assert from "node:assert/strict";
import { test } from "node:test";
import { CORE_DEFINITIONS } from "../src/stores/coreStore.js";
import { idMatch } from "../src/middleware/auth.js";
import { matchesFilter } from "../src/stores/dynamoFilter.js";
import { attendanceOnLocalDay } from "../src/routes/attendanceRoutes.js";
import { openCheckInFilter } from "../src/services/openCheckIns.js";

/**
 * DynamoDB answers a query only from a planned index. attendance is far too
 * large to scan, so every filter the application issues against it must be
 * recognised by its plan(); one that is not would fail at run time, in the
 * 9 AM rush, rather than here.
 *
 * These are the filters the code actually builds, taken from the routes and
 * services that read attendance.
 */

const DAY = "2026-09-30";
const START = new Date("2026-09-29T18:30:00.000Z");
const END = new Date("2026-09-30T18:30:00.000Z");
const ID = "instructor-1";
// A legacy id, which idMatch names twice: as a string and as an ObjectId.
const LEGACY_ID = "6a82eb647377e77789a4be3f";
const idMatchOf = (id) => idMatch(id);

function planFor(store, filter) {
  return CORE_DEFINITIONS[store].plan(filter);
}

function usesIndex(store, filter, index) {
  const plan = planFor(store, filter);
  assert.ok(plan, `no index answers ${JSON.stringify(filter)}`);
  for (const query of plan.queries) {
    assert.ok(
      CORE_DEFINITIONS[store].indexes[query.index],
      `${query.index} is not an index of ${store}`
    );
  }
  if (index) assert.equal(plan.queries[0].index, index, JSON.stringify(filter));
  return plan;
}

test("today's record for one instructor is read by instructor", () => {
  // attendanceOnLocalDay: the day, or the legacy check_in_time range.
  const filter = attendanceOnLocalDay(ID, new Date("2026-09-30T04:00:00.000Z"));
  usesIndex("attendance", filter, "by_instructor");
  // The kiosk, check-in, check-out, identify and group paths all use it.
  usesIndex("attendance", { ...filter, college_id: "c1" }, "by_instructor");
});

test("an instructor's history over a window is read by instructor", () => {
  // The public report pages and the weekly email.
  usesIndex("attendance", { instructor_id: ID, check_in_time: { $gte: START, $lte: END } }, "by_instructor");
  usesIndex("attendance", {
    instructor_id: ID,
    check_out_time: null,
    check_in_time: { $gte: START, $lt: END },
  }, "by_instructor");
});

test("the escalation count reads the week's days for a list of instructors", () => {
  const plan = usesIndex("attendance", {
    instructor_id: { $in: ["i1", "i2", "i3"] },
    attendance_day: { $in: [DAY, "2026-09-29"] },
    deleting_at: { $exists: false },
  });
  assert.equal(plan.queries.length, 3, "one query per instructor");
  // The weekly non-compliance count for one instructor.
  usesIndex("attendance", {
    instructor_id: idMatch(ID),
    attendance_day: { $gte: "2026-09-28", $lte: DAY },
    deleting_at: { $exists: false },
  }, "by_instructor");
});

test("the daily records list reads a day range, of one college or of all", () => {
  usesIndex("attendance", { date: { $gte: START, $lt: END } }, "by_day");
  usesIndex("attendance", { date: { $gte: START, $lt: END }, college_id: idMatchOf(LEGACY_ID) }, "by_college");
  // A UUID college id is named once, with no ObjectId variant.
  usesIndex("attendance", { date: { $gte: START, $lt: END }, college_id: idMatch("c1") }, "by_college");
  // A month of history, the default Daily Records range.
  const monthAgo = new Date(END.getTime() - 30 * 24 * 60 * 60 * 1000);
  usesIndex("attendance", { date: { $gte: monthAgo, $lt: END } }, "by_day");
  // With the delta refresh the dashboard adds.
  usesIndex("attendance", {
    date: { $gte: START, $lt: END },
    updated_at: { $gt: START },
    deleting_at: { $exists: false },
  }, "by_day");
});

test("the midnight close and the reminder cron read one day", () => {
  usesIndex("attendance", openCheckInFilter(DAY), "by_day");
  usesIndex("attendance", { check_in_time: { $gte: START, $lte: END }, check_out_time: null }, "by_day");
  // The weekly cron's distinct over the working week.
  usesIndex("attendance", { check_in_time: { $gte: START, $lte: END } }, "by_day");
});

test("the unidentified queue reads its own index", () => {
  usesIndex("attendance", {
    status: "unidentified",
    instructor_id: null,
    deleting_at: { $exists: false },
  }, "unidentified");
  usesIndex("attendance", {
    status: "unidentified",
    instructor_id: null,
    deleting_at: { $exists: false },
    college_id: idMatchOf(LEGACY_ID),
  }, "unidentified");
});

test("the outbox reconcilers and the orphan photo scan read their own indexes", () => {
  usesIndex("attendance", { _private_evaluation_outbox: { $exists: true } }, "evaluation_outbox");
  usesIndex("attendance", { _private_checkin_outbox: { $exists: true } }, "checkin_outbox");
  usesIndex("attendance", { _private_checkout_outbox: { $exists: true } }, "checkout_outbox");
  usesIndex("attendance", {
    $or: [{ check_in_photo_key: "photos/a.jpg" }, { check_out_photo_key: "photos/a.jpg" }],
  }, "by_checkin_photo");
});

test("the photo purge walks a bounded window of old days", () => {
  const cutoff = new Date("2026-03-30T00:00:00.000Z");
  const plan = usesIndex("attendance", {
    check_in_time: { $lt: cutoff },
    $or: [
      { check_in_photo_key: { $type: "string" } },
      { check_out_photo_key: { $type: "string" } },
    ],
  }, "by_day");
  assert.ok(plan.queries.length <= 41, "a batch covers a fixed window of days");
  assert.ok(plan.queries.every((query) => query.key <= "2026-03-30"), "only days at or before the cutoff");
});

test("a range too wide for the day index is refused rather than scanned", () => {
  const from = new Date("2025-01-01T00:00:00.000Z");
  assert.throws(
    () => planFor("attendance", { date: { $gte: from, $lt: END } }),
    /no DynamoDB index/,
    "a year of days would be hundreds of queries"
  );
});

test("the other collections' lookups are planned or safely scanned", () => {
  usesIndex("instructors", { report_token: "tok" }, "by_report_token");
  usesIndex("instructors", { instructor_user_id: "u1" }, "by_instructor_user");
  usesIndex("instructors", { college_id: idMatchOf(LEGACY_ID), deleted_at: null }, "by_college");
  usesIndex("users", { reference_id: idMatchOf(LEGACY_ID), role: "BOA" }, "by_reference");
  usesIndex("boas", { college_id: idMatchOf(LEGACY_ID) }, "by_college");
  usesIndex("password_resets", { token_hash: "hash" }, "by_token");
  usesIndex("password_resets", { email: "a@x.com" }, "by_email");
  // These are small enough to scan when nothing is pinned.
  for (const store of ["colleges", "boas", "users", "instructors", "password_resets"]) {
    assert.equal(CORE_DEFINITIONS[store].scanOk, true, store);
  }
  assert.equal(CORE_DEFINITIONS.attendance.scanOk, false, "attendance is never scanned");
});

test("the index keys a document derives match what the filters look for", () => {
  const derive = CORE_DEFINITIONS.attendance.derive;
  const record = {
    _id: "a1",
    instructor_id: ID,
    college_id: "c1",
    attendance_day: DAY,
    date: new Date("2026-09-30T04:00:00.000Z"),
    check_in_time: new Date("2026-09-30T04:00:00.000Z"),
    check_in_photo_key: "photos/a.jpg",
    status: "pending",
  };
  const keys = derive(record);
  assert.equal(keys.day_key, DAY);
  assert.equal(keys.instructor_key, ID);
  assert.equal(keys.college_key, "c1");
  assert.equal(keys.checkin_photo_key, "photos/a.jpg");
  assert.equal(keys.unidentified_key, undefined, "an identified record is out of the queue index");

  // An unidentified record joins the queue index and has no day reservation.
  const unidentified = derive({ ...record, instructor_id: null, status: "unidentified" });
  assert.equal(unidentified.unidentified_key, "c1");
  assert.equal(unidentified.instructor_key, undefined);
  const dayUnique = CORE_DEFINITIONS.attendance.uniques[0];
  assert.equal(dayUnique.key({ ...record, instructor_id: null }), null, "no duplicate rule without an instructor");
  assert.equal(dayUnique.key(record), `${ID}#${DAY}`);

  // A record written before attendance_day existed still lands on its day.
  const legacy = derive({ ...record, attendance_day: undefined });
  assert.equal(legacy.day_key, DAY);
});

test("the day a record lands on is the day its filters ask for", () => {
  // The unique key, the index key and the filter must agree, or a second
  // check-in on the same day would be allowed.
  const record = { _id: "a1", instructor_id: ID, attendance_day: DAY, check_in_time: new Date("2026-09-30T04:00:00.000Z") };
  assert.equal(CORE_DEFINITIONS.attendance.derive(record).day_key, DAY);
  const filter = attendanceOnLocalDay(ID, new Date("2026-09-30T04:00:00.000Z"));
  assert.equal(matchesFilter(record, filter), true, "today's filter finds today's record");
});
