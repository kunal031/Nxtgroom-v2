import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("photographed checkout is queued for the worker rather than analysed in the request", async () => {
  const source = await readFile(new URL("../src/routes/attendanceRoutes.js", import.meta.url), "utf8");
  const routeName = source.indexOf('"/check-out"');
  const start = source.lastIndexOf("attendanceRouter.post(", routeName);
  const nextRouteName = source.indexOf('"/today"', routeName);
  const end = source.lastIndexOf("attendanceRouter.get(", nextRouteName);
  assert.ok(start >= 0 && end > start, "checkout route must remain identifiable");

  const checkoutRoute = source.slice(start, end);
  /**
   * Check-out is analysed by the worker, exactly as check-in is.
   *
   * It ran inline until the tablet became a kiosk. The reason it ran inline was
   * sound — its email must not race ahead of its report — but holding the
   * connection open for a vision call blocks the next person standing at the
   * camera. The worker now stores the report and only then queues the email, so
   * the ordering is preserved somewhere better suited to it.
   *
   * What is asserted here is that the route no longer emails a photographed
   * check-out at all: if it did, that email could describe a report that does
   * not exist yet.
   */
  assert.ok(
    checkoutRoute.includes("enqueueEvaluation(db"),
    "a photographed checkout must be queued for the worker"
  );
  assert.ok(
    checkoutRoute.includes('kind: "checkout"'),
    "the queued job must be the checkout half, not a second check-in"
  );
  assert.equal(
    checkoutRoute.includes("evaluateCheckoutNow(db"),
    false,
    "checkout must not hold the request open for a vision call"
  );
  assert.ok(
    // The only email the route still sends is for a check-out with no photo,
    // which has no report to wait for.
    checkoutRoute.includes("recipient && !req.file"),
    "only a photoless checkout may be emailed from the route"
  );
  assert.ok(
    // The id is resolved before this call rather than read straight from the
    // body: a face-only college sends no instructor_id and the photograph
    // decides whose session is being closed.
    checkoutRoute.includes("attendanceOnLocalDay(instructorId, checkOutTime)"),
    "checkout must use today's attendance rather than an older open record"
  );
  assert.ok(
    // storeAttendancePhoto is the shared helper both halves now use to put an
    // attendance photograph in R2; the literal uploadPhoto call moved inside it.
    checkoutRoute.indexOf("checkoutAvailability(candidate") < checkoutRoute.indexOf("storeAttendancePhoto("),
    "a duplicate checkout must be refused before its photo is stored"
  );
});

test("face identification decodes the photo before the record is known, and only then", async () => {
  // The ordering the previous assertion protected cannot hold for a face-only
  // college: there is no record to check until the face has been matched, so
  // the photograph is decoded first. That is a real cost of photo-first
  // check-out — an already-closed session is discovered after the decode rather
  // than before — and it is recorded here rather than left to be rediscovered.
  //
  // What still holds is that nothing is *stored* or analysed until the record
  // has been found and accepted, and that the decode happens once.
  const source = await readFile(new URL("../src/routes/attendanceRoutes.js", import.meta.url), "utf8");
  const routeName = source.indexOf('"/check-out"');
  const start = source.lastIndexOf("attendanceRouter.post(", routeName);
  const nextRouteName = source.indexOf('"/today"', routeName);
  const end = source.lastIndexOf("attendanceRouter.get(", nextRouteName);
  const checkoutRoute = source.slice(start, end);

  const identifyDecode = checkoutRoute.indexOf("normalizedCheckoutImage = await normalizeInstructorImage");
  const searchAt = checkoutRoute.indexOf("searchFaceByImage(");
  const availabilityAt = checkoutRoute.indexOf("checkoutAvailability(candidate");
  const storeAt = checkoutRoute.indexOf("storeAttendancePhoto(");

  assert.ok(identifyDecode >= 0, "face identification must normalize the upload");
  assert.ok(searchAt > identifyDecode, "the match runs on the normalized image");
  assert.ok(availabilityAt > searchAt, "the record is found from the match, so it is checked after it");
  assert.ok(storeAt > availabilityAt, "nothing is stored until the record has been accepted");

  assert.ok(
    checkoutRoute.includes("normalizedCheckoutImage\n          || await normalizeInstructorImage"),
    "the stored photo reuses the identified bytes rather than decoding the upload twice"
  );
});

test("a failed checkout photo can be retried without adding an AI queue", async () => {
  const source = await readFile(new URL("../src/routes/attendanceRoutes.js", import.meta.url), "utf8");
  const routeName = source.indexOf('"/:attendanceId/checkout-photo"');
  const start = source.lastIndexOf("attendanceRouter.post(", routeName);
  const nextRouteName = source.indexOf('"/:attendanceId/evaluation"', routeName);
  const end = source.lastIndexOf("attendanceRouter.get(", nextRouteName);
  assert.ok(start >= 0 && end > start, "checkout photo recovery route must remain identifiable");

  const retryRoute = source.slice(start, end);
  assert.ok(retryRoute.includes("uploadPhoto("), "retry must store the missing photo");
  assert.ok(retryRoute.includes("evaluateCheckoutNow(db"), "retry must analyse directly");
  assert.ok(retryRoute.includes("enqueueNotification(db"), "retry must email only after analysis");
  assert.equal(
    retryRoute.includes("enqueueEvaluation(db"),
    false,
    "retry must not recreate the removed checkout evaluation queue"
  );
});

test("bulk attendance deletion is restricted to elevated administrators", async () => {
  const source = await readFile(new URL("../src/routes/attendanceRoutes.js", import.meta.url), "utf8");
  const routeName = source.indexOf('"/bulk-delete"');
  const start = source.lastIndexOf("attendanceRouter.post(", routeName);
  const end = source.indexOf("attendanceRouter.delete(", routeName);
  assert.ok(start >= 0 && end > start, "bulk delete route must remain identifiable");

  const bulkRoute = source.slice(start, end);
  assert.ok(bulkRoute.includes("requireSuperAdmin"));
  assert.ok(bulkRoute.includes("await purgeAttendance(db, attendance)"));
  assert.ok(bulkRoute.includes("attendanceIds.length > 100"));
});
