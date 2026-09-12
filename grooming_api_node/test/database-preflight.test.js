import assert from "node:assert/strict";
import { test } from "node:test";
import { ObjectId } from "mongodb";
import {
  applyDatabaseIndexes,
  auditDatabasePreflight,
  DATABASE_INDEX_APPLY_CONFIRMATION,
  DAILY_ATTENDANCE_INDEX,
  DatabasePreflightError,
  EVALUATION_IDENTITY_INDEX,
  formatDatabasePreflightReport,
  migrateLegacyActiveAttendanceIndex,
  migrateLegacyEvaluationIdentityIndex,
  REQUIRED_DATABASE_INDEXES,
} from "../src/config/databasePreflight.js";

function preflightDb(rows = {}, initialIndexes = {}) {
  const indexes = new Map(Object.entries(initialIndexes));
  const createCalls = [];
  const dropCalls = [];
  const updateCalls = [];
  return {
    createCalls,
    dropCalls,
    updateCalls,
    rows,
    collection(name) {
      return {
        find() {
          return { toArray: async () => rows[name] || [] };
        },
        listIndexes() {
          return { toArray: async () => indexes.get(name) || [] };
        },
        async createIndex(key, options) {
          createCalls.push({ collection: name, key, options });
          const existing = indexes.get(name) || [];
          existing.push({ key, ...options });
          indexes.set(name, existing);
          return options.name;
        },
        async dropIndex(indexName) {
          dropCalls.push({ collection: name, index: indexName });
          indexes.set(name, (indexes.get(name) || []).filter((index) => index.name !== indexName));
          return { ok: 1 };
        },
        async updateMany(filter, update) {
          updateCalls.push({ collection: name, filter, update });
          let modifiedCount = 0;
          for (const row of rows[name] || []) {
            if (filter.kind?.$exists === false && !("kind" in row)) {
              row.kind = update.$set.kind;
              modifiedCount += 1;
            }
          }
          return { matchedCount: modifiedCount, modifiedCount };
        },
      };
    },
  };
}

test("read-only preflight detects semantic collisions without exposing email values", async () => {
  const db = preflightDb({
    users: [
      { _id: "user-1", email: "Admin@Example.com" },
      { _id: "user-2", email: " admin@example.com " },
    ],
    boas: [
      { _id: "boa-1", employee_id: "BOA-1", college_id: "college-1" },
      { _id: "boa-2", employee_id: "BOA-1", college_id: "college-1" },
    ],
    colleges: [
      { _id: "college-1", name: "NxtWave Campus", location: "Hyderabad" },
      { _id: "college-2", name: "nxtwave campus", location: " HYDERABAD " },
    ],
    instructors: [
      {
        _id: "instructor-1",
        employee_id: "INST-1",
        college_id: "college-1",
        email: "",
      },
      {
        _id: "instructor-2",
        employee_id: "INST-1",
        college_id: "college-1",
        email: "not-an-email",
      },
    ],
    attendance: [
      { _id: "attendance-1", instructor_id: "instructor-1" },
      { _id: "attendance-2", instructor_id: "instructor-1" },
    ],
    evaluations: [
      { _id: "evaluation-1", attendance_id: "attendance-1" },
      { _id: "evaluation-2", attendance_id: "attendance-1" },
    ],
  });

  const report = await auditDatabasePreflight(db, {
    now: new Date("2026-08-14T12:00:00.000Z"),
  });
  assert.equal(report.status, "blocked");
  assert.equal(report.safe_to_apply_indexes, false);
  assert.deepEqual(report.findings.map((item) => item.code), [
    "USER_EMAIL_NONCANONICAL",
    "USER_EMAIL_COLLISION",
    "BOA_EMPLOYEE_ID_COLLISION",
    "COLLEGE_UNIQUE_KEY_COLLISION",
    "INSTRUCTOR_EMPLOYEE_ID_COLLISION",
    "INSTRUCTOR_EMAIL_INVALID",
    "ACTIVE_ATTENDANCE_COLLISION",
    "EVALUATION_IDENTITY_COLLISION",
  ]);
  assert.equal(db.createCalls.length, 0);
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /Admin@Example\.com|admin@example\.com|not-an-email/);
  assert.match(formatDatabasePreflightReport(report), /Choose the authoritative attendance/);
});

test("check-in and checkout evaluations are distinct identities", async () => {
  const db = preflightDb({
    evaluations: [
      { _id: "evaluation-checkin", attendance_id: "attendance-1", kind: "checkin" },
      { _id: "evaluation-checkout", attendance_id: "attendance-1", kind: "checkout" },
    ],
  });

  const report = await auditDatabasePreflight(db);
  assert.equal(
    report.findings.some((item) => item.code === "EVALUATION_IDENTITY_COLLISION"),
    false
  );
});

test("legacy evaluation index migration backfills kinds before replacing uniqueness", async () => {
  const db = preflightDb(
    {
      evaluations: [{ _id: "evaluation-1", attendance_id: "attendance-1" }],
    },
    {
      evaluations: [
        { name: "_id_", key: { _id: 1 }, unique: true },
        { name: "attendance_id_1", key: { attendance_id: 1 }, unique: true },
      ],
    }
  );

  const first = await migrateLegacyEvaluationIdentityIndex(db);
  assert.deepEqual(first, {
    migrated: true,
    backfilled: 1,
    created: true,
    dropped: ["attendance_id_1"],
  });
  assert.equal(db.rows.evaluations[0].kind, "checkin");
  assert.deepEqual(db.createCalls, [{
    collection: "evaluations",
    key: EVALUATION_IDENTITY_INDEX.key,
    options: EVALUATION_IDENTITY_INDEX.options,
  }]);
  assert.deepEqual(db.dropCalls, [{ collection: "evaluations", index: "attendance_id_1" }]);

  const second = await migrateLegacyEvaluationIdentityIndex(db);
  assert.deepEqual(second, { migrated: false, backfilled: 0, created: false, dropped: [] });
  assert.equal(db.createCalls.length, 1);
  assert.equal(db.dropCalls.length, 1);
});

test("legacy global active-attendance index migrates to daily uniqueness", async () => {
  const db = preflightDb({}, {
    attendance: [
      { name: "_id_", key: { _id: 1 }, unique: true },
      {
        name: "one_active_attendance",
        key: { instructor_id: 1 },
        unique: true,
        partialFilterExpression: { check_out_time: null },
      },
    ],
  });

  const first = await migrateLegacyActiveAttendanceIndex(db);
  assert.deepEqual(first, {
    migrated: true,
    created: true,
    dropped: ["one_active_attendance"],
  });
  assert.deepEqual(db.createCalls, [{
    collection: "attendance",
    key: DAILY_ATTENDANCE_INDEX.key,
    options: DAILY_ATTENDANCE_INDEX.options,
  }]);
  assert.deepEqual(db.dropCalls, [{
    collection: "attendance",
    index: "one_active_attendance",
  }]);

  const second = await migrateLegacyActiveAttendanceIndex(db);
  assert.deepEqual(second, { migrated: false, created: false, dropped: [] });
});

test("unfinished attendances on different local days are not a collision", async () => {
  const db = preflightDb({
    users: [{ _id: "user-1", email: "admin@example.com" }],
    colleges: [{ _id: "college-1", name: "Campus", location: "Hyderabad" }],
    instructors: [{
      _id: "instructor-1",
      employee_id: "INST-1",
      college_id: "college-1",
      email: "instructor@example.com",
    }],
    attendance: [
      {
        _id: "attendance-21",
        instructor_id: "instructor-1",
        check_in_time: new Date("2026-08-21T05:00:00.000Z"),
      },
      {
        _id: "attendance-24",
        instructor_id: "instructor-1",
        attendance_day: "2026-08-24",
        check_in_time: new Date("2026-08-24T05:00:00.000Z"),
      },
    ],
  });

  const report = await auditDatabasePreflight(db);
  assert.equal(
    report.findings.some((item) => item.code === "ACTIVE_ATTENDANCE_COLLISION"),
    false
  );
});

test("safe apply requires explicit confirmation and creates only missing indexes idempotently", async () => {
  const db = preflightDb({
    users: [{ _id: "user-1", email: "admin@example.com" }],
    colleges: [{ _id: "college-1", name: "Campus", location: "Hyderabad" }],
    instructors: [{
      _id: "instructor-1",
      employee_id: "INST-1",
      college_id: "college-1",
      email: "instructor@example.com",
    }],
    attendance: [{ _id: "attendance-1", instructor_id: "instructor-1" }],
  });

  const readOnly = await auditDatabasePreflight(db);
  assert.equal(readOnly.status, "safe_to_apply_indexes");
  assert.equal(db.createCalls.length, 0);
  await assert.rejects(
    applyDatabaseIndexes(db),
    /DATABASE_PREFLIGHT_APPLY=CREATE_INDEXES/
  );
  assert.equal(db.createCalls.length, 0);

  const first = await applyDatabaseIndexes(db, {
    confirmation: DATABASE_INDEX_APPLY_CONFIRMATION,
  });
  assert.equal(first.applied.length, REQUIRED_DATABASE_INDEXES.length);
  assert.equal(first.indexes.ready, true);
  const second = await applyDatabaseIndexes(db, {
    confirmation: DATABASE_INDEX_APPLY_CONFIRMATION,
  });
  assert.equal(second.applied.length, 0);
  assert.equal(db.createCalls.length, REQUIRED_DATABASE_INDEXES.length);
});

test("apply refuses conflicting index options instead of dropping or replacing indexes", async () => {
  const db = preflightDb(
    {
      users: [{ _id: "user-1", email: "admin@example.com" }],
      colleges: [{ _id: "college-1", name: "Campus", location: "Hyderabad" }],
      instructors: [{
        _id: "instructor-1",
        employee_id: "INST-1",
        college_id: "college-1",
        email: "instructor@example.com",
      }],
      attendance: [],
    },
    { users: [{ name: "email_1", key: { email: 1 }, unique: false }] }
  );
  const report = await auditDatabasePreflight(db);
  assert.equal(report.status, "blocked");
  assert.equal(report.safe_to_apply_indexes, false);
  assert.equal(report.indexes.conflicts.length, 1);
  await assert.rejects(
    applyDatabaseIndexes(db, { confirmation: DATABASE_INDEX_APPLY_CONFIRMATION }),
    DatabasePreflightError
  );
  assert.equal(db.createCalls.length, 0);
});

test("preflight blocks invalid unique keys and orphaned active college assignments", async () => {
  const db = preflightDb({
    users: [{ _id: "user-1", email: "admin@example.com" }],
    boas: [{ _id: "boa-1", employee_id: " BOA-1 ", college_id: "missing-college" }],
    colleges: [{
      _id: "archived-college",
      name: "Archived",
      location: "Hyderabad",
      deleted_at: new Date("2026-01-01T00:00:00.000Z"),
    }],
    instructors: [
      {
        _id: "instructor-active",
        employee_id: "",
        college_id: "archived-college",
        email: " active@example.com ",
      },
      {
        _id: "instructor-archived",
        employee_id: "INST-2",
        college_id: "missing-college",
        email: "",
        deleted_at: new Date("2026-01-01T00:00:00.000Z"),
      },
    ],
    evaluations: [{ _id: "evaluation-1", attendance_id: "" }],
  });

  const report = await auditDatabasePreflight(db);
  const codes = report.findings.map((item) => item.code);
  assert.ok(codes.includes("BOA_EMPLOYEE_ID_INVALID"));
  assert.ok(codes.includes("ACTIVE_BOA_COLLEGE_INVALID"));
  assert.ok(codes.includes("INSTRUCTOR_EMPLOYEE_ID_INVALID"));
  assert.ok(codes.includes("INSTRUCTOR_EMAIL_INVALID"));
  assert.ok(codes.includes("ACTIVE_INSTRUCTOR_COLLEGE_INVALID"));
  assert.ok(codes.includes("EVALUATION_ATTENDANCE_ID_INVALID"));
  assert.equal(
    report.findings.find((item) => item.code === "INSTRUCTOR_EMAIL_INVALID").affected_records,
    1
  );
  assert.equal(db.createCalls.length, 0);
});

test("active attendance requires an active instructor and accepts string/ObjectId ID variants", async () => {
  const objectIdInstructor = new ObjectId();
  const stringInstructor = new ObjectId().toHexString();
  const db = preflightDb({
    users: [{ _id: "user-1", email: "admin@example.com" }],
    colleges: [{ _id: "college-1", name: "Campus", location: "Hyderabad" }],
    instructors: [
      {
        _id: objectIdInstructor,
        employee_id: "INST-OBJECT",
        college_id: "college-1",
        email: "object@example.com",
      },
      {
        _id: stringInstructor,
        employee_id: "INST-STRING",
        college_id: "college-1",
        email: "string@example.com",
      },
      {
        _id: "archived-instructor",
        employee_id: "INST-ARCHIVED",
        college_id: "college-1",
        email: "archived@example.com",
        deleted_at: new Date("2026-01-01T00:00:00.000Z"),
      },
    ],
    attendance: [
      { _id: "attendance-string-ref", instructor_id: String(objectIdInstructor) },
      { _id: "attendance-object-ref", instructor_id: new ObjectId(stringInstructor) },
      { _id: "attendance-archived", instructor_id: "archived-instructor" },
      { _id: "attendance-missing", instructor_id: "missing-instructor" },
    ],
  });

  const report = await auditDatabasePreflight(db);
  const finding = report.findings.find(
    (item) => item.code === "ACTIVE_ATTENDANCE_INSTRUCTOR_NOT_ACTIVE"
  );
  assert.equal(report.status, "blocked");
  assert.equal(finding.affected_records, 2);
  assert.deepEqual(
    finding.examples.map((example) => example.attendance_id),
    ["attendance-archived", "attendance-missing"]
  );
  assert.equal(
    report.findings.some((item) => item.code === "ACTIVE_ATTENDANCE_INSTRUCTOR_INVALID"),
    false
  );
  assert.equal(db.createCalls.length, 0);
});

/**
 * An unrecognised check-in is a record the product writes on purpose.
 *
 * Photo-first check-in stores somebody it could not identify with
 * instructor_id: null and status "unidentified", so the evidence that they
 * turned up survives until an administrator names them. Read as damage, that
 * shape stopped the API booting: the preflight blocks startup on any finding,
 * so one unrecognised person anywhere in the database took the whole service
 * down and every redeploy failed the same way.
 *
 * The distinction is narrow on purpose. Only the exact shape the check-in path
 * writes is accepted; a missing, blanked or wrongly typed reference on any
 * other record is still a fault nothing creates deliberately, and is still
 * reported.
 */
test("an unidentified check-in is not a broken instructor reference", async () => {
  const db = preflightDb({
    users: [{ _id: "user-1", email: "admin@example.com" }],
    colleges: [{ _id: "college-1", name: "Campus", location: "Hyderabad" }],
    instructors: [
      {
        _id: "instructor-1",
        employee_id: "INST-1",
        college_id: "college-1",
        email: "instructor@example.com",
      },
    ],
    attendance: [
      // Written by the kiosk when Rekognition matched nobody.
      { _id: "attendance-unidentified", instructor_id: null, status: "unidentified" },
      // Several in one day is normal: each is a different person nobody named.
      { _id: "attendance-unidentified-2", instructor_id: null, status: "unidentified" },
      // Genuinely broken, and still reported: no status explains the missing id.
      { _id: "attendance-null-id", instructor_id: null },
      // Also broken: the right status cannot excuse a corrupted reference type.
      { _id: "attendance-bad-type", instructor_id: 42, status: "unidentified" },
      { _id: "attendance-blank-id", instructor_id: "   ", status: "pending" },
    ],
  });

  const report = await auditDatabasePreflight(db);
  const finding = report.findings.find(
    (item) => item.code === "ACTIVE_ATTENDANCE_INSTRUCTOR_INVALID"
  );

  assert.equal(finding.affected_records, 3, "only the genuinely broken rows are reported");
  assert.deepEqual(
    finding.examples.map((example) => example.attendance_id),
    ["attendance-null-id", "attendance-bad-type", "attendance-blank-id"]
  );
});

/**
 * The case that took production down, start to finish.
 *
 * Nothing else was wrong with the database: one person stood in front of a
 * tablet, was not recognised, and the API would not start again until the
 * record was removed by hand. A preflight that blocks on this is worse than no
 * preflight, because it converts ordinary use into an outage.
 */
test("a database whose only oddity is an unidentified check-in still starts", async () => {
  const db = preflightDb({
    users: [{ _id: "user-1", email: "admin@example.com" }],
    colleges: [{ _id: "college-1", name: "Campus", location: "Hyderabad" }],
    instructors: [
      {
        _id: "instructor-1",
        employee_id: "INST-1",
        college_id: "college-1",
        email: "instructor@example.com",
      },
    ],
    attendance: [
      { _id: "attendance-unidentified", instructor_id: null, status: "unidentified" },
    ],
  });

  const report = await auditDatabasePreflight(db);
  assert.equal(
    report.findings.some((item) => item.code === "ACTIVE_ATTENDANCE_INSTRUCTOR_INVALID"),
    false,
    "an unrecognised check-in must never block startup"
  );
  assert.equal(report.findings.length, 0);
});
