import assert from "node:assert/strict";
import { test } from "node:test";
import { ObjectId } from "mongodb";
import { idMatch } from "../src/middleware/auth.js";

const OBJECT_ID = "6a82eb647377e77789a4bede";
const UUID = "ce4293b8-0eb1-43fa-9181-8ac06081078b";

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

  assert.deepEqual(idMatch(UUID).$in, [UUID]);
});

test("no instructor lookup outside the roster code compares a raw id", async () => {
  const { readFile } = await import("node:fs/promises");
  const files = [
    "src/services/evaluationWorker.js",
    "src/routes/reportRoutes.js",
  ];
  for (const file of files) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    const lookups = [...source.matchAll(
      /[Cc]ollection\((?:[A-Za-z_$][\w$]*,\s*)?"instructors"\)[\s\S]{0,80}?findOne\(\{\s*_id:\s*([A-Za-z_$][\w$]*)/g
    )];
    assert.ok(lookups.length > 0, `${file} no longer looks up an instructor; update this test`);
    for (const [, expression] of lookups) {
      assert.equal(expression, "idMatch", `${file} looks up an instructor with a raw ${expression}`);
    }
  }
});
