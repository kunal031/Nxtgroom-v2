import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { checkoutAvailability } from "../src/routes/attendanceRoutes.js";
import { decideKioskAction, KIOSK_ACTIONS } from "../src/services/kioskAction.js";

/**
 * The attendance endpoint that has no buttons.
 *
 * One photograph decides whether somebody arrived or left, and nobody reviews
 * the result. The properties pinned here are the ones that fail quietly: a photo
 * stored for a record that was never written, an unrecognised face closing a
 * session it cannot identify, or a literal path read as an attendance id.
 */

async function routeSource(path) {
  const source = await readFile(new URL("../src/routes/attendanceRoutes.js", import.meta.url), "utf8");
  const name = source.indexOf(`"${path}"`);
  const start = source.lastIndexOf("attendanceRouter.post(", name);
  const after = source.indexOf("attendanceRouter.post(", name);
  return { source, route: source.slice(start, after > start ? after : undefined) };
}

test("/auto is registered before any parameterised route", async () => {
  // Express matches in registration order, so a literal path declared after
  // "/:attendanceId/..." is read as an attendance id and never runs. This has
  // been the failure twice in this work, so it is asserted rather than assumed.
  const source = await readFile(new URL("../src/routes/attendanceRoutes.js", import.meta.url), "utf8");

  // Read the registrations themselves rather than any occurrence of the text:
  // the docblock above this very route quotes "/:attendanceId/..." while
  // explaining the hazard, and matching that comment made this test fail while
  // the ordering was correct.
  //
  // Scoped to POST, because Express only resolves a path against routes of the
  // same method: a GET "/:attendanceId" cannot shadow a POST "/auto".
  const posts = [...source.matchAll(/attendanceRouter\.post\(\s*"([^"]+)"/g)]
    .map((match) => match[1]);

  const auto = posts.indexOf("/auto");
  const firstParameterised = posts.findIndex((path) => path.startsWith("/:"));
  assert.ok(auto >= 0, "the kiosk route must exist");
  assert.ok(firstParameterised >= 0, "there should be parameterised POST routes to order against");
  assert.ok(
    auto < firstParameterised,
    `/auto must be registered before the first parameterised POST route, got ${posts.join(", ")}`,
  );
});

test("an outcome that records nothing stores no photograph", async () => {
  // Too early and already-done both return before the upload. A photograph kept
  // for a record that was never written is somebody's picture with nothing
  // explaining why it is held.
  const { route } = await routeSource("/auto");
  const refusal = route.indexOf("KIOSK_ACTIONS.TOO_EARLY || action === KIOSK_ACTIONS.ALREADY_DONE");
  const store = route.indexOf("storeAttendancePhoto(");
  assert.ok(refusal >= 0, "the route must handle the outcomes that record nothing");
  assert.ok(store > refusal, "nothing may be stored before those outcomes have returned");
});

test("the photograph is decoded once and reused", async () => {
  // Recognising one encoding and storing another would make a refused or
  // mistaken match impossible to reproduce from the record.
  const { route } = await routeSource("/auto");
  assert.equal(
    (route.match(/normalizeInstructorImage\(/g) || []).length,
    1,
    "the upload must be normalized exactly once",
  );
  const normalize = route.indexOf("normalizeInstructorImage(");
  const search = route.indexOf("searchFaceByImage(normalizedImage.buffer)");
  assert.ok(search > normalize, "the match must run on the normalized bytes");
});

test("an unrecognised face is recorded as an arrival, never as a departure", async () => {
  // A check-out closes one specific open session; there is no way to tell which
  // one an unidentified photograph belongs to.
  const { route } = await routeSource("/auto");
  const unidentified = route.indexOf("action === KIOSK_ACTIONS.UNIDENTIFIED");
  const commitUnidentified = route.indexOf("commitUnidentifiedCheckIn(");
  assert.ok(unidentified >= 0 && commitUnidentified > unidentified);
  // And it returns before ever reaching the check-out update.
  const checkoutUpdate = route.indexOf("check_out_time: null");
  assert.ok(
    commitUnidentified < checkoutUpdate,
    "the unidentified branch must return before the check-out path",
  );
});

test("the check-out update is guarded so one session cannot be closed twice", async () => {
  // Two photographs taken moments apart would otherwise both close it, and the
  // second would overwrite the first departure time.
  const { route } = await routeSource("/auto");
  assert.ok(
    route.includes("check_out_time: null"),
    "the update must match only a session that is still open",
  );
  assert.ok(
    route.includes("kiosk_duplicate_checkout"),
    "a lost race must discard its photograph rather than orphan it",
  );
});

test("a failed commit discards the photograph it had already stored", async () => {
  // The upload happens before the write, so every path that fails to write has
  // to clean up after itself.
  const { route } = await routeSource("/auto");
  for (const reason of [
    "kiosk_checkin_commit_failed",
    "kiosk_duplicate_checkout",
  ]) {
    assert.ok(route.includes(reason), `${reason} must compensate its stored photo`);
  }
});

test("the check-out half is queued for the worker, like the check-in half", async () => {
  const { route } = await routeSource("/auto");
  assert.ok(route.includes('kind: "checkout"'), "the checkout job must be the checkout half");
  assert.equal(
    route.includes("evaluateCheckoutNow("),
    false,
    "the kiosk must not hold the request open for a vision call",
  );
});

test("the decision matches what the day actually looks like", () => {
  // Wired through the real availability function rather than a fixture, so the
  // route and the decision cannot drift apart.
  const morning = new Date(Date.UTC(2026, 8, 11, 3, 30));   // 09:00 IST
  const beforeNoon = new Date(Date.UTC(2026, 8, 11, 6, 0)); // 11:30 IST
  const afternoon = new Date(Date.UTC(2026, 8, 11, 12, 0)); // 17:30 IST

  const noRecord = decideKioskAction({
    matched: true,
    availability: checkoutAvailability(null, afternoon),
  });
  assert.equal(noRecord, KIOSK_ACTIONS.CHECK_IN);

  const open = { check_in_time: morning, check_out_time: null };
  assert.equal(
    decideKioskAction({ matched: true, availability: checkoutAvailability(open, beforeNoon) }),
    KIOSK_ACTIONS.TOO_EARLY,
  );
  assert.equal(
    decideKioskAction({ matched: true, availability: checkoutAvailability(open, afternoon) }),
    KIOSK_ACTIONS.CHECK_OUT,
  );

  const closed = { check_in_time: morning, check_out_time: afternoon };
  assert.equal(
    decideKioskAction({ matched: true, availability: checkoutAvailability(closed, afternoon) }),
    KIOSK_ACTIONS.ALREADY_DONE,
  );
});

test("an unmatched face is an arrival whatever the day looks like", () => {
  const open = { check_in_time: new Date(Date.UTC(2026, 8, 11, 3, 30)), check_out_time: null };
  const afternoon = new Date(Date.UTC(2026, 8, 11, 12, 0));
  assert.equal(
    decideKioskAction({ matched: false, availability: checkoutAvailability(open, afternoon) }),
    KIOSK_ACTIONS.UNIDENTIFIED,
  );
});
