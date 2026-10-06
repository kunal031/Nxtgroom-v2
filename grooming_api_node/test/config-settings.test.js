import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  clearConfigSettingsCache,
  DEFAULT_CONFIG_SETTINGS,
  getConfigSettings,
  normalizeConfigSettings,
  saveConfigSettings,
  validateConfigSettings,
} from "../src/services/configSettings.js";
import { updateInstructorGuarded } from "../src/routes/instructorRoutes.js";

function settingsDb() {
  const docs = new Map();
  return {
    docs,
    collection(name) {
      assert.equal(name, "app_settings");
      return {
        findOne: async ({ _id }) => docs.get(_id) || null,
        updateOne: async ({ _id }, update) => {
          docs.set(_id, { ...(docs.get(_id) || update.$setOnInsert || {}), ...update.$set });
          return { matchedCount: 1 };
        },
      };
    },
  };
}

test("moving a checked-in instructor is off until the switch is turned on", () => {
  assert.deepEqual(DEFAULT_CONFIG_SETTINGS, { allow_move_while_checked_in: false });
  assert.deepEqual(normalizeConfigSettings({}), { allow_move_while_checked_in: false });
  assert.deepEqual(normalizeConfigSettings({ allow_move_while_checked_in: "yes" }), { allow_move_while_checked_in: false });
  assert.deepEqual(normalizeConfigSettings({ allow_move_while_checked_in: true }), { allow_move_while_checked_in: true });
});

test("only the known switch, as true or false, is accepted", () => {
  assert.deepEqual(validateConfigSettings({ allow_move_while_checked_in: true }), { valid: true });
  assert.equal(validateConfigSettings({ allow_move_while_checked_in: "on" }).valid, false);
  assert.equal(validateConfigSettings({ something_else: true }).valid, false);
  assert.equal(validateConfigSettings([]).valid, false);
  assert.equal(validateConfigSettings(null).valid, false);
});

test("the switch is saved and read back", async () => {
  clearConfigSettingsCache();
  const db = settingsDb();
  assert.deepEqual(await getConfigSettings(db), { allow_move_while_checked_in: false });
  assert.deepEqual(await saveConfigSettings(db, { allow_move_while_checked_in: true }, "admin@x"), { allow_move_while_checked_in: true });
  assert.deepEqual(await getConfigSettings(db), { allow_move_while_checked_in: true });
  assert.equal(db.docs.get("config_settings").updated_by, "admin@x");
  clearConfigSettingsCache();
});

function instructorDb() {
  let attendanceQueried = false;
  let saved = null;
  const db = {
    collection(name) {
      if (name === "instructors") return {
        findOne: async (filter) => (filter?._id?.$ne ? null : { _id: "i1", college_id: "c1", employee_id: "E1" }),
        updateOne: async (_filter, update) => { saved = update.$set; return { matchedCount: 1 }; },
      };
      if (name === "attendance") return {
        findOne: async () => { attendanceQueried = true; return { _id: "open-check-in" }; },
      };
      if (name === "colleges") return {
        findOne: async () => ({ _id: "c2" }),
        updateOne: async () => ({ matchedCount: 1 }),
      };
      throw new Error(`unexpected ${name}`);
    },
  };
  return { db, queried: () => attendanceQueried, saved: () => saved };
}

test("with the switch on, a checked-in instructor moves to another institute", async () => {
  const run = async (work) => work({});
  const input = { name: "Ravi", college_id: "c2", employee_id: "E1" };

  const blocked = instructorDb();
  assert.equal((await updateInstructorGuarded(blocked.db, "i1", input, run)).outcome, "active_attendance", "off by default");
  assert.equal((await updateInstructorGuarded(blocked.db, "i1", input, run, { allowMoveWhileCheckedIn: false })).outcome, "active_attendance");

  const allowed = instructorDb();
  const result = await updateInstructorGuarded(allowed.db, "i1", input, run, { allowMoveWhileCheckedIn: true });
  assert.equal(result.outcome, "updated");
  assert.equal(allowed.queried(), false, "the open check-in is not looked for");
  assert.equal(allowed.saved().college_id, "c2");
});

test("editing and importing read the switch; Settings serves and saves it", async () => {
  const routes = await readFile(new URL("../src/routes/instructorRoutes.js", import.meta.url), "utf8");
  assert.equal((routes.match(/const \{ allow_move_while_checked_in: allowMoveWhileCheckedIn \} = await getConfigSettings\(db\);/g) || []).length, 2);
  assert.match(routes, /req\.validatedBody,\s*(?:withMongoTransaction|null),\s*\{ allowMoveWhileCheckedIn \}/);
  assert.match(routes, /updateInstructor: \(database, instructorId, fields\) => updateInstructorGuarded\(\s*database,\s*instructorId,\s*fields,\s*(?:withMongoTransaction|null),\s*\{ allowMoveWhileCheckedIn \},\s*\)/);
  const admin = await readFile(new URL("../src/routes/adminRoutes.js", import.meta.url), "utf8");
  assert.match(admin, /adminRouter\.get\(\s*"\/settings\/config",\s*requireSuperAdmin,/);
  assert.match(admin, /adminRouter\.put\(\s*"\/settings\/config",\s*requireSuperAdmin,/);
});
