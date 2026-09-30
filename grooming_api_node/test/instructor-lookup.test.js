import assert from "node:assert/strict";
import { test } from "node:test";
import { ObjectId } from "mongodb";
import { idMatch } from "../src/middleware/auth.js";

/**
 * Instructors exist under two kinds of _id. Ones added by hand carry a UUID
 * string; ones imported from BigQuery carry an ObjectId. Attendance always
 * stores instructor_id as a string, so any lookup that compares it directly
 * finds nobody for the imported half of the roster.
 *
 * That is not a visible failure. The alert path treated a missing instructor
 * as "nothing to send" and returned, so no email reached the instructor or any
 * reporting partner, and nothing was logged.
 */

const OBJECT_ID = "6a82eb647377e77789a4bede";
const UUID = "ce4293b8-0eb1-43fa-9181-8ac06081078b";

/** Stands in for MongoDB's equality rules, which compare type as well as value. */
function findOne(documents, filter) {
  const wanted = filter._id?.$in ?? [filter._id];
  return documents.find((document) => wanted.some((candidate) => (
    candidate instanceof ObjectId && document._id instanceof ObjectId
      ? candidate.equals(document._id)
      : String(candidate) === String(document._id) && typeof candidate === typeof document._id
  ))) || null;
}

const roster = [
  { _id: new ObjectId(OBJECT_ID), name: "Imported instructor", email: "imported@nxtwave.co.in" },
  { _id: UUID, name: "Hand-added instructor", email: "manual@nxtwave.co.in" },
];

test("a raw string never matches an imported instructor", () => {
  // The behaviour that broke every alert for the 599 synced instructors.
  assert.equal(findOne(roster, { _id: OBJECT_ID }), null);
});

test("idMatch finds an instructor under either kind of id", () => {
  assert.equal(findOne(roster, { _id: idMatch(OBJECT_ID) })?.email, "imported@nxtwave.co.in");
  assert.equal(findOne(roster, { _id: idMatch(UUID) })?.email, "manual@nxtwave.co.in");
});

test("idMatch offers both forms only when the string really is an ObjectId", () => {
  const objectVariants = idMatch(OBJECT_ID).$in;
  assert.equal(objectVariants.length, 2, "a 24-character hex id must be tried both ways");
  assert.ok(objectVariants.some((value) => value instanceof ObjectId));

  // A UUID is not a valid ObjectId, so converting it would throw. It stays a
  // single string variant.
  assert.deepEqual(idMatch(UUID).$in, [UUID]);
});

test("no instructor lookup outside the roster code compares a raw id", async () => {
  // The three that did — the check-in alert, the weekly report and the 8pm
  // reminder — were the entire outbound email path, and all three failed the
  // same way. This keeps a fourth from being added without notice.
  const { readFile } = await import("node:fs/promises");
  const files = [
    "src/services/evaluationWorker.js",
    "src/routes/reportRoutes.js",
  ];
  for (const file of files) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    // Capture what follows _id: rather than using a lookahead. A lookahead
    // after \s* backtracks to zero width and passes on any whitespace, so it
    // reported a clean file as broken.
    // Matches both db.collection("instructors") and the store call that
    // replaced it, coreCollection(db, "instructors").
    const lookups = [...source.matchAll(
      /[Cc]ollection\((?:db, )?"instructors"\)[\s\S]{0,80}?findOne\(\{\s*_id:\s*([A-Za-z_$][\w$]*)/g
    )];
    assert.ok(lookups.length > 0, `${file} no longer looks up an instructor; update this test`);
    for (const [, expression] of lookups) {
      assert.equal(expression, "idMatch", `${file} looks up an instructor with a raw ${expression}`);
    }
  }
});
