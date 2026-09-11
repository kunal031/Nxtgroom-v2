import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_IDENTIFICATION_SETTINGS,
  describeCollegeIdentification,
  identificationModeForCollege,
  normalizeIdentificationSettings,
  usesFaceIdentification,
  validateIdentificationSettings,
} from "../src/services/identificationSettings.js";

/**
 * Which colleges identify an instructor from their photograph.
 *
 * The mode decides whether a BOA sees a camera or a dropdown, so a setting that
 * resolves wrongly either hides the selector from a college with no enrolled
 * faces, or keeps it in front of one that has finished enrolling. Both are
 * visible immediately, but only to the BOA standing at the tablet, so they are
 * pinned here instead.
 */

test("a college with no override follows the global default", () => {
  const settings = normalizeIdentificationSettings({ default_mode: "FACE_ONLY" });
  assert.equal(identificationModeForCollege(settings, "college-1"), "FACE_ONLY");
  assert.equal(usesFaceIdentification(settings, "college-1"), true);
});

test("an override wins over the default, in both directions", () => {
  const faceDefault = normalizeIdentificationSettings({
    default_mode: "FACE_ONLY",
    college_modes: { "college-2": "SELECTOR" },
  });
  assert.equal(identificationModeForCollege(faceDefault, "college-2"), "SELECTOR");
  assert.equal(identificationModeForCollege(faceDefault, "college-1"), "FACE_ONLY");

  const selectorDefault = normalizeIdentificationSettings({
    default_mode: "SELECTOR",
    college_modes: { "college-9": "FACE_ONLY" },
  });
  assert.equal(identificationModeForCollege(selectorDefault, "college-9"), "FACE_ONLY");
  assert.equal(identificationModeForCollege(selectorDefault, "college-1"), "SELECTOR");
});

test("face identification is the default for a workspace that has set nothing", () => {
  // The intended operating mode. A college with no enrolled faces still records
  // attendance, because an unrecognised check-in is saved as unidentified.
  assert.equal(DEFAULT_IDENTIFICATION_SETTINGS.default_mode, "FACE_ONLY");
  assert.equal(usesFaceIdentification(undefined, "college-1"), true);
  assert.equal(usesFaceIdentification({}, null), true);
});

test("an override equal to the default is not stored", () => {
  // Keeping it would pin that college silently: a later change to the default
  // would move every college except this one, for no stated reason.
  const settings = normalizeIdentificationSettings({
    default_mode: "FACE_ONLY",
    college_modes: { "college-1": "FACE_ONLY", "college-2": "SELECTOR" },
  });
  assert.deepEqual(settings.college_modes, { "college-2": "SELECTOR" });
});

test("an unreadable mode falls back to the default rather than disabling anything", () => {
  const settings = normalizeIdentificationSettings({
    default_mode: "NONSENSE",
    college_modes: { "college-1": "ALSO_NONSENSE", "college-2": 5, "college-3": null },
  });
  assert.equal(settings.default_mode, "FACE_ONLY");
  assert.deepEqual(settings.college_modes, {});
});

test("a missing college id resolves to the default, never to undefined", () => {
  // The tablet's college is absent for a super admin, who belongs to no college.
  const settings = normalizeIdentificationSettings({ default_mode: "SELECTOR" });
  assert.equal(identificationModeForCollege(settings, null), "SELECTOR");
  assert.equal(identificationModeForCollege(settings, undefined), "SELECTOR");
  assert.equal(identificationModeForCollege(settings, ""), "SELECTOR");
});

test("unknown keys and bad modes are refused", () => {
  assert.equal(validateIdentificationSettings({ mode: "FACE_ONLY" }).valid, false);
  assert.equal(validateIdentificationSettings({ default_mode: "FACES" }).valid, false);
  assert.equal(validateIdentificationSettings({ college_modes: [] }).valid, false);
  assert.equal(validateIdentificationSettings({ college_modes: { "c1": "MAYBE" } }).valid, false);
  assert.equal(validateIdentificationSettings(null).valid, false);

  assert.equal(validateIdentificationSettings({ default_mode: "SELECTOR" }).valid, true);
  assert.equal(validateIdentificationSettings({ college_modes: { "c1": "SELECTOR" } }).valid, true);
  // null is how the UI clears one college's override.
  assert.equal(validateIdentificationSettings({ college_modes: { "c1": null } }).valid, true);
});

test("low enrolment is advisory and never changes the mode", () => {
  // The administrator's choice stands. The flag is what makes it informed.
  const settings = normalizeIdentificationSettings({ default_mode: "FACE_ONLY" });
  const colleges = [
    { _id: "c1", name: "Ready College" },
    { _id: "c2", name: "Partly Enrolled" },
    { _id: "c3", name: "Nothing Enrolled" },
  ];
  const enrolment = new Map([
    ["c1", { total: 100, enrolled: 95 }],
    ["c2", { total: 100, enrolled: 20 }],
    ["c3", { total: 40, enrolled: 0 }],
  ]);

  const described = describeCollegeIdentification(settings, colleges, enrolment);
  const byId = new Map(described.map((row) => [row.college_id, row]));

  assert.equal(byId.get("c1").mode, "FACE_ONLY");
  assert.equal(byId.get("c1").low_enrolment, false);
  assert.equal(byId.get("c1").enrolled_percent, 95);

  // Still FACE_ONLY: flagged, not switched.
  assert.equal(byId.get("c2").mode, "FACE_ONLY");
  assert.equal(byId.get("c2").low_enrolment, true);
  assert.equal(byId.get("c2").enrolled_percent, 20);

  assert.equal(byId.get("c3").mode, "FACE_ONLY");
  assert.equal(byId.get("c3").low_enrolment, true);
  assert.equal(byId.get("c3").enrolled_percent, 0);
});

test("a SELECTOR college is never flagged for low enrolment", () => {
  // It does not use recognition, so enrolment is irrelevant to it.
  const settings = normalizeIdentificationSettings({
    default_mode: "FACE_ONLY",
    college_modes: { "c2": "SELECTOR" },
  });
  const described = describeCollegeIdentification(
    settings,
    [{ _id: "c2", name: "Selector College" }],
    new Map([["c2", { total: 80, enrolled: 0 }]]),
  );
  assert.equal(described[0].mode, "SELECTOR");
  assert.equal(described[0].low_enrolment, false);
});

test("each row says whether the mode was set for the college or inherited", () => {
  const settings = normalizeIdentificationSettings({
    default_mode: "FACE_ONLY",
    college_modes: { "c2": "SELECTOR" },
  });
  const described = describeCollegeIdentification(
    settings,
    [{ _id: "c1", name: "A" }, { _id: "c2", name: "B" }],
    new Map(),
  );
  const byId = new Map(described.map((row) => [row.college_id, row]));
  assert.equal(byId.get("c1").source, "DEFAULT");
  assert.equal(byId.get("c2").source, "COLLEGE");
});

test("a college with no instructors reports zero rather than dividing by zero", () => {
  const described = describeCollegeIdentification(
    normalizeIdentificationSettings({ default_mode: "FACE_ONLY" }),
    [{ _id: "empty", name: "New College" }],
    new Map(),
  );
  assert.equal(described[0].instructors, 0);
  assert.equal(described[0].enrolled, 0);
  assert.equal(described[0].enrolled_percent, 0);
  // Nothing enrolled is exactly the case worth warning about.
  assert.equal(described[0].low_enrolment, true);
});
