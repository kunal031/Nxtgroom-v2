import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assessIdentification,
  explainFailure,
  findRetryCandidates,
  identifiedRecordUpdate,
  IDENTIFY_OUTCOMES,
  RETRY_WINDOW_MS,
} from "../src/services/identifyQueue.js";
import { canIdentifyAttendance, DEFAULT_ACCESS_SETTINGS } from "../src/services/accessSettings.js";

/**
 * Resolving check-ins whose face was not recognised.
 *
 * Each decision here can lose or misfile somebody's attendance. Naming a record
 * decides whose day it becomes; suggesting a retry invites an administrator to
 * discard a photograph. Both are pinned rather than trusted to read correctly.
 */

const day = "2026-09-11";
const at = (hours, minutes) => new Date(Date.UTC(2026, 8, 11, hours, minutes));

const unidentified = {
  _id: "unidentified-1",
  instructor_id: null,
  college_id: "college-1",
  attendance_day: day,
  check_in_time: at(9, 0),
  status: "unidentified",
  identification: { method: "FACE", outcome: "NO_MATCH" },
};

const recognisedAt = (minutes, overrides = {}) => ({
  _id: `recognised-${minutes}`,
  instructor_id: "instructor-7",
  instructor_name: "Priya",
  college_id: "college-1",
  attendance_day: day,
  check_in_time: at(9, minutes),
  status: "pending",
  identification: { method: "FACE", outcome: "MATCHED" },
  ...overrides,
});

test("a recognised check-in minutes later is offered as the likely same arrival", () => {
  const candidates = findRetryCandidates(unidentified, [recognisedAt(5)]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].instructor_id, "instructor-7");
  assert.equal(candidates[0].instructor_name, "Priya");
  assert.equal(candidates[0].minutes_later, 5);
});

test("the soonest retry ranks first, because a retake follows a failure closely", () => {
  const candidates = findRetryCandidates(unidentified, [
    recognisedAt(25, { _id: "late", instructor_id: "instructor-9" }),
    recognisedAt(3, { _id: "soon", instructor_id: "instructor-7" }),
  ]);
  assert.deepEqual(candidates.map((item) => item.attendance_id), ["soon", "late"]);
});

test("a check-in before the failure is never a retry of it", () => {
  // It cannot be a retake of something that had not happened yet.
  const candidates = findRetryCandidates(unidentified, [
    recognisedAt(-10, { _id: "earlier" }),
  ]);
  assert.deepEqual(candidates, []);
});

test("a check-in outside the window is not suggested", () => {
  const beyond = Math.floor(RETRY_WINDOW_MS / 60_000) + 5;
  const candidates = findRetryCandidates(unidentified, [
    recognisedAt(beyond, { _id: "much-later" }),
  ]);
  assert.deepEqual(candidates, []);
});

test("another college's check-in is not a retry of this one", () => {
  const candidates = findRetryCandidates(unidentified, [
    recognisedAt(4, { college_id: "college-2" }),
  ]);
  assert.deepEqual(candidates, []);
});

test("another unidentified record is never offered as the explanation", () => {
  // It names nobody, so it cannot account for this one.
  const candidates = findRetryCandidates(unidentified, [
    { ...unidentified, _id: "unidentified-2", check_in_time: at(9, 4) },
  ]);
  assert.deepEqual(candidates, []);
});

test("the record itself is never its own retry", () => {
  assert.deepEqual(findRetryCandidates(unidentified, [unidentified]), []);
});

test("a record with no usable time yields no suggestions rather than throwing", () => {
  assert.deepEqual(findRetryCandidates({ ...unidentified, check_in_time: null }, [recognisedAt(5)]), []);
  assert.deepEqual(findRetryCandidates(unidentified, null), []);
});

test("an already-named record reports that, rather than a generic failure", () => {
  // Two administrators working one queue is ordinary; the second needs to know
  // the work was done, not that something went wrong.
  const assessment = assessIdentification({
    record: { ...unidentified, status: "pending", instructor_id: "instructor-7", instructor_name: "Priya" },
    instructor: { _id: "instructor-7", gender: "FEMALE" },
    existingRecordToday: null,
  });
  assert.equal(assessment.outcome, IDENTIFY_OUTCOMES.ALREADY_IDENTIFIED);
  assert.equal(assessment.instructor_name, "Priya");
});

test("a missing record and a missing instructor are distinguished", () => {
  assert.equal(
    assessIdentification({ record: null, instructor: null }).outcome,
    IDENTIFY_OUTCOMES.NOT_FOUND
  );
  assert.equal(
    assessIdentification({ record: unidentified, instructor: null }).outcome,
    IDENTIFY_OUTCOMES.INSTRUCTOR_NOT_FOUND
  );
});

test("an instructor who already checked in is reported, not refused outright", () => {
  // Usually the retry case the queue has not caught up with. The useful answer
  // is to say so and let the administrator decide.
  const assessment = assessIdentification({
    record: unidentified,
    instructor: { _id: "instructor-7", gender: "FEMALE" },
    existingRecordToday: recognisedAt(5),
  });
  assert.equal(assessment.outcome, IDENTIFY_OUTCOMES.INSTRUCTOR_ALREADY_CHECKED_IN);
  assert.equal(assessment.existing_attendance_id, "recognised-5");
  // Whether that record was recognised is what separates a retry from two
  // genuinely separate arrivals.
  assert.equal(assessment.existing_was_recognised, true);
});

test("a nameable instructor with no gender is flagged but not blocked", () => {
  // The attendance is the point. Gender only decides which dress code an
  // analysis would apply, and that can follow.
  const assessment = assessIdentification({
    record: unidentified,
    instructor: { _id: "instructor-7", gender: null },
    existingRecordToday: null,
  });
  assert.equal(assessment.outcome, IDENTIFY_OUTCOMES.NO_GENDER);
});

test("a clean assignment is accepted", () => {
  const assessment = assessIdentification({
    record: unidentified,
    instructor: { _id: "instructor-7", gender: "FEMALE" },
    existingRecordToday: null,
  });
  assert.equal(assessment.outcome, IDENTIFY_OUTCOMES.OK);
  assert.equal(assessment.instructor_id, "instructor-7");
});

test("naming a record keeps what happened and changes only who it happened to", () => {
  const update = identifiedRecordUpdate({
    instructor: { _id: "instructor-7", name: "Priya", instructor_role: "INSTRUCTOR", college_id: "college-9", gender: "FEMALE" },
    record: unidentified,
    identifiedBy: "admin@example.com",
    now: at(10, 0),
  });

  assert.equal(update.instructor_id, "instructor-7");
  assert.equal(update.instructor_name, "Priya");
  assert.equal(update.status, "pending");
  // The instructor's own college owns the record once the person is known.
  assert.equal(update.college_id, "college-9");
  // Nothing about the arrival itself is rewritten.
  assert.equal(update.check_in_time, undefined);
  assert.equal(update.check_in_photo_key, undefined);
  assert.equal(update.location_coordinates, undefined);
});

test("the original recognition failure survives the correction", () => {
  // This is the evidence that one instructor's face is not matching reliably,
  // which is the reason to add another reference photo for them.
  const update = identifiedRecordUpdate({
    instructor: { _id: "instructor-7", name: "Priya", college_id: "college-9" },
    record: unidentified,
    identifiedBy: "admin@example.com",
  });
  assert.equal(update.identification.original_outcome, "NO_MATCH");
  assert.equal(update.identification.outcome, "IDENTIFIED");
  assert.equal(update.identification.method, "ADMIN");
  assert.equal(update.identification.identified_by, "admin@example.com");
});

test("a record whose college is unknown keeps the one it had", () => {
  const update = identifiedRecordUpdate({
    instructor: { _id: "instructor-7", name: "Priya", college_id: null },
    record: { ...unidentified, college_id: "college-1" },
  });
  assert.equal(update.college_id, "college-1");
});

test("each failure reason is explained in words an operator can act on", () => {
  for (const outcome of ["NO_MATCH", "BELOW_THRESHOLD", "NO_FACE", "MULTIPLE_FACES", "POOR_QUALITY", "PROVIDER_ERROR", "NOT_CONFIGURED"]) {
    const explanation = explainFailure(outcome);
    assert.ok(explanation.length > 10, `${outcome} needs an explanation`);
    // Never echo the raw provider code at somebody triaging a queue.
    assert.ok(!explanation.includes(outcome));
  }
  // An unrecognised code still says something rather than rendering blank.
  assert.ok(explainFailure("SOMETHING_NEW").length > 10);
  assert.ok(explainFailure(undefined).length > 10);
});

test("identifying is off for a BOA until it is granted, and always on for admins", () => {
  assert.equal(canIdentifyAttendance({ role: "BOA" }, DEFAULT_ACCESS_SETTINGS), false);
  assert.equal(canIdentifyAttendance({ role: "BOA" }, { boa_can_identify: true }), true);
  // A personal override wins in both directions, like the delete permissions.
  assert.equal(canIdentifyAttendance({ role: "BOA", can_identify: true }, DEFAULT_ACCESS_SETTINGS), true);
  assert.equal(canIdentifyAttendance({ role: "BOA", can_identify: false }, { boa_can_identify: true }), false);
  assert.equal(canIdentifyAttendance({ role: "ADMIN" }, DEFAULT_ACCESS_SETTINGS), true);
  assert.equal(canIdentifyAttendance({ role: "SUPER_ADMIN" }, DEFAULT_ACCESS_SETTINGS), true);
  assert.equal(canIdentifyAttendance(null, DEFAULT_ACCESS_SETTINGS), false);
});

test("identifying is not implied by the delete permissions", () => {
  // Discarding a photograph and deciding whose attendance it becomes are
  // different powers; granting one must not silently grant the other.
  assert.equal(
    canIdentifyAttendance({ role: "BOA" }, { boa_can_delete_records: true, boa_can_identify: false }),
    false
  );
});
