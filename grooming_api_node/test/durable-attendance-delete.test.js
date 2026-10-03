import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ROUTES = new URL("../src/routes/attendanceRoutes.js", import.meta.url);

/**
 * The source of one route handler, from its own `attendanceRouter.<verb>(` to
 * the next route of any verb.
 *
 * Matched on verb and path together: "/:attendanceId" is registered twice, as
 * a GET and a DELETE, so a path-only search silently returns the wrong handler.
 */
async function routeSource(pathLiteral, verb = "post") {
  const source = await readFile(ROUTES, "utf8");
  const opener = `attendanceRouter.${verb}(`;
  for (let at = source.indexOf(opener); at >= 0; at = source.indexOf(opener, at + 1)) {
    const after = source.slice(at + opener.length);
    const nextOffset = after.search(/attendanceRouter\.(get|post|put|patch|delete)\(/);
    const body = nextOffset < 0 ? after : after.slice(0, nextOffset);
    // The path is the first argument, so it sits before any nested route text.
    if (body.slice(0, 200).includes(`"${pathLiteral}"`)) return body;
  }
  throw new assert.AssertionError({
    message: `${verb.toUpperCase()} ${pathLiteral} must remain identifiable`,
    actual: false,
    expected: true,
  });
}

async function functionSource(declaration) {
  const source = await readFile(ROUTES, "utf8");
  const start = source.indexOf(declaration);
  assert.ok(start >= 0, `${declaration} must remain in the module`);
  // The next top-level declaration ends it; every helper here is followed by
  // either another function or a doc comment at column zero.
  const after = source.slice(start + declaration.length);
  const nextOffset = after.search(/\n(?:async function |function |\/\*\*|export )/);
  return after.slice(0, nextOffset < 0 ? undefined : nextOffset);
}

test("an abandoned deletion tombstone is taken over instead of blocking forever", async () => {
  const purge = await functionSource("async function purgeAttendance(");

  /**
   * Backing off on somebody else's tombstone is right for a deletion that is
   * genuinely in flight, and was wrong for one that died mid-way: every retry
   * saw the mark, reported success and did nothing, leaving a record that could
   * never be deleted and photographs the orphan scanner would not reclaim
   * because the record still referenced them.
   */
  assert.ok(
    purge.includes("ABANDONED_DELETION_MS"),
    "a stale tombstone must be distinguished from a deletion in flight"
  );
  assert.ok(
    purge.includes("attendance = current"),
    "taking the deletion over must resume from the record's own stored keys"
  );
});

test("a photograph R2 will not remove is queued for cleanup, and the record still goes", async () => {
  const purge = await functionSource("async function purgeAttendance(");

  /**
   * The record is removed and the bytes are chased separately. Throwing before
   * the record was deleted stranded it behind its own tombstone, which is the
   * state this whole path exists to avoid.
   */
  assert.ok(
    purge.includes('compensateUploadedPhoto(db, key, "attendance_deleted")'),
    "an undeletable photo must become a durable cleanup job"
  );
  assert.ok(
    purge.includes("PHOTO_DELETE_DEFERRED"),
    "the deferred case must be reported under its own code"
  );
  assert.equal(
    purge.includes("PHOTO_DELETE_FAILED"),
    false,
    "the old fail-and-strand code must be gone from the deletion path"
  );

  const deleteOneIndex = purge.indexOf('deleteOne({ _id: attendance._id, deleting_at:');
  const throwIndex = purge.indexOf('error.code = "PHOTO_DELETE_DEFERRED"');
  assert.ok(deleteOneIndex >= 0 && throwIndex >= 0, "both steps must remain present");
  assert.ok(
    deleteOneIndex < throwIndex,
    "the record must be deleted before the deferred photo is reported"
  );
});

test("both deletion routes treat a deferred photo as a completed deletion", async () => {
  const single = await routeSource("/:attendanceId", "delete");
  assert.ok(
    single.includes("PHOTO_DELETE_DEFERRED"),
    "the single delete must recognise the deferred case"
  );
  assert.equal(
    single.includes("res.status(503)"),
    false,
    "the record is gone, so the caller must not be asked to retry the deletion"
  );
  assert.ok(
    single.includes('return res.json({ message: "Attendance record deleted" });'),
    "a deferred photo must still report the deletion that happened"
  );

  const bulk = await routeSource("/bulk-delete");
  assert.ok(
    bulk.includes("PHOTO_DELETE_DEFERRED"),
    "bulk delete must recognise the deferred case"
  );
  assert.ok(
    bulk.includes("deletedIds.push(attendanceId);\n          continue;"),
    "a deferred photo must count the record as deleted rather than failed"
  );
});
