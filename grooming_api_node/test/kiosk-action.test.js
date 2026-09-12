import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decideKioskAction,
  describeKioskAction,
  kioskActionRecorded,
  KIOSK_ACTIONS,
} from "../src/services/kioskAction.js";

/**
 * What one photograph at the tablet does.
 *
 * There is no button to press and no confirmation to read afterwards, so a
 * wrong branch here is invisible: somebody walks away believing their day was
 * recorded. Every state the day can be in is pinned.
 */

test("a recognised instructor with no record today checks in", () => {
  assert.equal(
    decideKioskAction({ matched: true, availability: "not_checked_in_today" }),
    KIOSK_ACTIONS.CHECK_IN,
  );
});

test("a recognised instructor with an open record checks out", () => {
  assert.equal(
    decideKioskAction({ matched: true, availability: "available" }),
    KIOSK_ACTIONS.CHECK_OUT,
  );
});

test("too soon to close the day records nothing", () => {
  // The timing rules live in checkoutAvailability, so this branch only has to
  // carry the refusal through rather than restate noon and ten minutes.
  assert.equal(
    decideKioskAction({ matched: true, availability: "too_early" }),
    KIOSK_ACTIONS.TOO_EARLY,
  );
  assert.equal(kioskActionRecorded(KIOSK_ACTIONS.TOO_EARLY), false);
});

test("a day already closed records nothing", () => {
  assert.equal(
    decideKioskAction({ matched: true, availability: "already_checked_out_today" }),
    KIOSK_ACTIONS.ALREADY_DONE,
  );
  assert.equal(kioskActionRecorded(KIOSK_ACTIONS.ALREADY_DONE), false);
});

test("an unrecognised face still checks in", () => {
  // The asymmetry the design rests on: a check-in creates a record somebody can
  // name later, while a check-out must close one specific session.
  assert.equal(
    decideKioskAction({ matched: false, availability: "not_checked_in_today" }),
    KIOSK_ACTIONS.UNIDENTIFIED,
  );
  assert.equal(kioskActionRecorded(KIOSK_ACTIONS.UNIDENTIFIED), true);
});

test("an unrecognised face is unidentified whatever the day looks like", () => {
  // Without a match there is no instructor whose day could be consulted, so no
  // availability verdict can turn this into a check-out.
  for (const availability of ["available", "too_early", "already_checked_out_today"]) {
    assert.equal(
      decideKioskAction({ matched: false, availability }),
      KIOSK_ACTIONS.UNIDENTIFIED,
      `${availability} must not produce a check-out for an unmatched face`,
    );
  }
});

test("an unknown verdict never becomes a check-in", () => {
  // A second check-in for a day that already has one is the one outcome that
  // silently corrupts the record, so the fallback refuses instead.
  for (const availability of [undefined, null, "", "something_new"]) {
    assert.equal(
      decideKioskAction({ matched: true, availability }),
      KIOSK_ACTIONS.ALREADY_DONE,
      `${String(availability)} must not be treated as a fresh arrival`,
    );
  }
});

test("both recorded outcomes are reported as recorded", () => {
  assert.equal(kioskActionRecorded(KIOSK_ACTIONS.CHECK_IN), true);
  assert.equal(kioskActionRecorded(KIOSK_ACTIONS.CHECK_OUT), true);
});

test("the popup names the person and what was recorded", () => {
  // The only confirmation anybody gets, so a bare "done" is not enough: it has
  // to be readable at arm's length and name who it was about.
  assert.match(describeKioskAction(KIOSK_ACTIONS.CHECK_IN, { instructorName: "Priya" }).title, /Priya checked in/);
  assert.match(describeKioskAction(KIOSK_ACTIONS.CHECK_OUT, { instructorName: "Priya" }).title, /Priya checked out/);
});

test("a missing name still produces a sentence rather than a blank", () => {
  const described = describeKioskAction(KIOSK_ACTIONS.CHECK_IN, {});
  assert.match(described.title, /Instructor checked in/);
});

test("too early says when check-out opens", () => {
  const withTime = describeKioskAction(KIOSK_ACTIONS.TOO_EARLY, {
    instructorName: "Priya",
    opensAtLabel: "12:00 pm",
  });
  assert.match(withTime.title, /already checked in/i);
  assert.match(withTime.detail, /12:00 pm/);

  // Falls back to a duration when no wall-clock time is available.
  const withMinutes = describeKioskAction(KIOSK_ACTIONS.TOO_EARLY, {
    instructorName: "Priya",
    minutesRemaining: 7,
  });
  assert.match(withMinutes.detail, /7 minutes/);

  // And says something rather than nothing when neither is known.
  assert.ok(describeKioskAction(KIOSK_ACTIONS.TOO_EARLY, {}).detail.length > 10);
});

test("one minute remaining is not pluralised", () => {
  const described = describeKioskAction(KIOSK_ACTIONS.TOO_EARLY, { minutesRemaining: 1 });
  assert.match(described.detail, /1 minute\b/);
  assert.ok(!/1 minutes/.test(described.detail));
});

test("an unrecognised face is told what happened and what to do", () => {
  // It is the one outcome where the person cannot tell from the screen whether
  // anything was saved, so the message says both.
  const described = describeKioskAction(KIOSK_ACTIONS.UNIDENTIFIED, {});
  assert.match(described.title, /not recognised/i);
  assert.match(described.detail, /administrator/i);
  assert.equal(described.tone, "warning");
});

test("nothing-recorded outcomes are toned apart from successes", () => {
  // The tablet colours the popup from this, so a refusal must not read as a
  // confirmation at a glance.
  assert.equal(describeKioskAction(KIOSK_ACTIONS.CHECK_IN, {}).tone, "success");
  assert.equal(describeKioskAction(KIOSK_ACTIONS.CHECK_OUT, {}).tone, "success");
  assert.equal(describeKioskAction(KIOSK_ACTIONS.TOO_EARLY, {}).tone, "info");
  assert.equal(describeKioskAction(KIOSK_ACTIONS.ALREADY_DONE, {}).tone, "info");
});
