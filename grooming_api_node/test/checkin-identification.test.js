import assert from "node:assert/strict";
import { test } from "node:test";
import { commitUnidentifiedCheckIn } from "../src/routes/attendanceRoutes.js";
import {
  normalizeIdentificationSettings,
  usesFaceIdentification,
} from "../src/services/identificationSettings.js";
import {
  DAILY_ATTENDANCE_INDEX,
  WIDENED_DAILY_ATTENDANCE_INDEX,
} from "../src/config/databasePreflight.js";

/**
 * Check-in when the face decides who the instructor is.
 *
 * Two properties matter more than the happy path. A photograph nobody could be
 * identified from must still be recorded, because refusing it loses the evidence
 * that somebody turned up. And a college still using the selector must behave
 * exactly as it did before, since that is the live attendance path for every
 * college that has not finished enrolling faces.
 */

/** Captures what was inserted, without a database. */
function fakeDb() {
  const inserted = [];
  return {
    inserted,
    collection(name) {
      return {
        async insertOne(document) {
          inserted.push({ collection: name, document });
          return { insertedId: document._id };
        },
      };
    },
  };
}

const tabletUser = {
  email: "boa@college-1.example.com",
  role: "BOA",
  collegeId: "college-1",
  referenceId: "boa-7",
};

const normalizedImage = { mimeType: "image/jpeg", buffer: Buffer.from("jpeg-bytes") };

test("the selector still requires an instructor id, face mode does not", () => {
  // The guard in the route reads exactly this, so a college mid-enrolment keeps
  // the behaviour it has today.
  const selector = normalizeIdentificationSettings({ default_mode: "SELECTOR" });
  const face = normalizeIdentificationSettings({ default_mode: "FACE_ONLY" });
  assert.equal(usesFaceIdentification(selector, "college-1"), false);
  assert.equal(usesFaceIdentification(face, "college-1"), true);
});

test("an unidentified check-in is recorded rather than refused", async () => {
  const db = fakeDb();
  const result = await commitUnidentifiedCheckIn(db, {
    currentUser: tabletUser,
    coordinates: "17.385044,78.486671",
    normalizedImage,
    photoKey: "attendance/2026/09/11/unidentified-checkin-abc.jpg",
    locationAccuracyM: 12,
    recognition: { reason: "NO_MATCH", bestSimilarity: null, candidateInstructorId: null },
  });

  assert.equal(result.outcome, "created_unidentified");
  const [write] = db.inserted;
  assert.equal(write.collection, "attendance");
  // The photograph, the time and the place are the evidence somebody arrived.
  assert.equal(write.document.check_in_photo_key, "attendance/2026/09/11/unidentified-checkin-abc.jpg");
  assert.equal(write.document.location_coordinates, "17.385044,78.486671");
  assert.ok(write.document.check_in_time instanceof Date);
});

test("no analysis is queued and no email is promised", async () => {
  // Gender decides which dress code applies and there is no instructor to take
  // one from, so a report now would be an empty one.
  const db = fakeDb();
  await commitUnidentifiedCheckIn(db, {
    currentUser: tabletUser,
    coordinates: null,
    normalizedImage,
    photoKey: "attendance/key.jpg",
    recognition: { reason: "NO_MATCH" },
  });
  const { document } = db.inserted[0];

  assert.equal(document.status, "unidentified");
  assert.equal(document.evaluation_queue_status, null);
  assert.equal(document.checkin_email_status, "not_requested");
  assert.equal(document.compliance_status, null);
  // No outbox, so no worker will pick this up and analyse it.
  assert.equal(document._private_evaluation_outbox, undefined);
});

test("the record carries the tablet's college, so the queue is visible to its BOA", async () => {
  // attendanceScope filters a BOA to their own college. Without this the person
  // who took the photograph could not see it.
  const db = fakeDb();
  await commitUnidentifiedCheckIn(db, {
    currentUser: tabletUser,
    coordinates: null,
    normalizedImage,
    photoKey: "attendance/key.jpg",
    recognition: { reason: "NO_MATCH" },
  });
  const { document } = db.inserted[0];
  assert.equal(document.college_id, "college-1");
  assert.equal(document.boa_id, "boa-7");
});

test("instructor_id is null, which is what will keep several in one day storable", async () => {
  // Written as null rather than omitted so the widened index can exclude these
  // records by type once it is applied.
  //
  // Until that migration runs the day-only filter still covers them, so a second
  // unidentified check-in on the same local day is rejected as a duplicate. That
  // is recorded here rather than left to memory: it is survivable only while
  // check-in identifies by selector, and must be migrated before FACE_ONLY is
  // deployed to a college.
  const db = fakeDb();
  await commitUnidentifiedCheckIn(db, {
    currentUser: tabletUser,
    coordinates: null,
    normalizedImage,
    photoKey: "attendance/key.jpg",
    recognition: { reason: "NO_MATCH" },
  });
  const { document } = db.inserted[0];

  assert.equal(document.instructor_id, null);
  assert.equal(typeof document.attendance_day, "string");

  // After the migration: excluded from the unique index, so several can exist.
  const widened = WIDENED_DAILY_ATTENDANCE_INDEX.options.partialFilterExpression;
  assert.deepEqual(widened.instructor_id, { $type: "string" });
  const coveredAfterMigration = typeof document.instructor_id === "string"
    && typeof document.attendance_day === "string";
  assert.equal(coveredAfterMigration, false);

  // Before the migration: still covered, and therefore still colliding.
  const current = DAILY_ATTENDANCE_INDEX.options.partialFilterExpression;
  assert.equal(current.instructor_id, undefined);
  assert.equal(typeof document.attendance_day === "string", true);
});

test("two unidentified check-ins on one day are both written", async () => {
  const db = fakeDb();
  for (let index = 0; index < 2; index += 1) {
    await commitUnidentifiedCheckIn(db, {
      currentUser: tabletUser,
      coordinates: null,
      normalizedImage,
      photoKey: `attendance/key-${index}.jpg`,
      recognition: { reason: "NO_MATCH" },
    });
  }
  assert.equal(db.inserted.length, 2);
  // Distinct records, not one overwritten by the other.
  assert.notEqual(db.inserted[0].document._id, db.inserted[1].document._id);
  assert.equal(db.inserted[0].document.attendance_day, db.inserted[1].document.attendance_day);
});

test("why recognition failed is recorded, so the queue can be triaged", async () => {
  // "Nobody resembled this face" and "somebody nearly did" need different
  // handling, and an unconfigured collection is neither.
  for (const reason of ["NO_MATCH", "BELOW_THRESHOLD", "NO_FACE", "PROVIDER_ERROR", "NOT_CONFIGURED"]) {
    const db = fakeDb();
    await commitUnidentifiedCheckIn(db, {
      currentUser: tabletUser,
      coordinates: null,
      normalizedImage,
      photoKey: "attendance/key.jpg",
      recognition: { reason, bestSimilarity: null, candidateInstructorId: null },
    });
    const { identification } = db.inserted[0].document;
    assert.equal(identification.method, "FACE");
    assert.equal(identification.outcome, reason);
    assert.ok(identification.attempted_at instanceof Date);
  }
});

test("a missing recognition reason still records something triagable", async () => {
  const db = fakeDb();
  await commitUnidentifiedCheckIn(db, {
    currentUser: tabletUser,
    coordinates: null,
    normalizedImage,
    photoKey: "attendance/key.jpg",
    recognition: null,
  });
  assert.equal(db.inserted[0].document.identification.outcome, "NO_MATCH");
});

test("a super admin with no college records one rather than the string 'null'", async () => {
  // String(undefined) once wrote the literal text "null" into college_id, where
  // it sat looking like a real id and matched nothing anywhere.
  const db = fakeDb();
  await commitUnidentifiedCheckIn(db, {
    currentUser: { email: "admin@example.com", role: "SUPER_ADMIN", collegeId: null, referenceId: null },
    coordinates: null,
    normalizedImage,
    photoKey: "attendance/key.jpg",
    recognition: { reason: "NO_MATCH" },
  });
  const { document } = db.inserted[0];
  assert.equal(document.college_id, null);
  assert.equal(document.boa_id, "super-admin");
});

test("the remark says what has to happen next, in words an operator can act on", async () => {
  const db = fakeDb();
  await commitUnidentifiedCheckIn(db, {
    currentUser: tabletUser,
    coordinates: null,
    normalizedImage,
    photoKey: "attendance/key.jpg",
    recognition: { reason: "NO_MATCH" },
  });
  const { remarks } = db.inserted[0].document;
  assert.match(remarks, /could not be identified/i);
  assert.match(remarks, /administrator/i);
});
