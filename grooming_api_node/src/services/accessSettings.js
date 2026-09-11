import { isElevated } from "../middleware/auth.js";

/**
 * Who may delete an attendance record.
 *
 * Deleting removes the check-in, its evaluation and its photographs, and there
 * is no undo, so the capability is off for BOAs until someone grants it. It is
 * expressed in two places on purpose: a workspace default that covers the
 * common case, and a per-person override for the exceptions — granting it to
 * one BOA should not require opening it to every BOA.
 */

const SETTINGS_ID = "access_settings";

export const DEFAULT_ACCESS_SETTINGS = Object.freeze({
  // Kept as the check-in permission it always was, so an existing setting is
  // not silently reinterpreted. Deleting a check-in removes the whole record.
  boa_can_delete_records: false,
  // Removing a check-out leaves the check-in and its report standing, so it is
  // the lesser of the two and is granted separately.
  boa_can_delete_checkout: false,
  // Naming an unidentified check-in decides whose attendance record it becomes
  // and enrolls that photograph as a face for them, so it is off until somebody
  // grants it. A BOA is usually the only person who can recognise a face from
  // their own campus, which is why the capability exists to be granted at all.
  boa_can_identify: false,
});

const BOOLEAN_KEYS = Object.keys(DEFAULT_ACCESS_SETTINGS);

export function normalizeAccessSettings(raw = {}) {
  const normalized = {};
  for (const key of BOOLEAN_KEYS) {
    normalized[key] = typeof raw?.[key] === "boolean"
      ? raw[key]
      : DEFAULT_ACCESS_SETTINGS[key];
  }
  return normalized;
}

/** Rejects unknown keys so a typo cannot silently persist as a permission. */
export function validateAccessSettings(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { valid: false, detail: "Access settings must be an object" };
  }
  const unknown = Object.keys(body).filter((key) => !BOOLEAN_KEYS.includes(key));
  if (unknown.length) {
    return { valid: false, detail: `Unsupported access settings: ${unknown.join(", ")}` };
  }
  for (const key of BOOLEAN_KEYS) {
    if (key in body && typeof body[key] !== "boolean") {
      return { valid: false, detail: `${key} must be true or false` };
    }
  }
  return { valid: true };
}

// Consulted on every /me, which the app calls on load, so the document is held
// briefly rather than fetched each time. Permissions change rarely and a
// change made here clears the cache immediately; the window only matters for a
// change made directly in the database.
const CACHE_TTL_MS = 30_000;
let cache = null;

export function clearAccessSettingsCache() {
  cache = null;
}

export async function getAccessSettings(db, { now = Date.now() } = {}) {
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.settings;
  const stored = await db.collection("app_settings").findOne({ _id: SETTINGS_ID });
  const settings = normalizeAccessSettings(stored || {});
  cache = { settings, at: now };
  return settings;
}

export async function saveAccessSettings(db, body) {
  const settings = normalizeAccessSettings({ ...(await getAccessSettings(db)), ...body });
  await db.collection("app_settings").updateOne(
    { _id: SETTINGS_ID },
    { $set: { ...settings, updated_at: new Date() } },
    { upsert: true }
  );
  // Cleared rather than replaced so the next read comes from the database and
  // reflects anything else that wrote concurrently.
  clearAccessSettingsCache();
  return settings;
}

/**
 * Whether this user may delete an attendance record.
 *
 * A per-person setting wins over the workspace default in both directions, so
 * one BOA can be granted the capability without opening it to everyone, and
 * one can be denied it while everyone else keeps it. Absent an override the
 * workspace default applies.
 */
export function canDeleteAttendance(user, settings = DEFAULT_ACCESS_SETTINGS) {
  if (!user?.role) return false;
  // Admins own the workspace; the setting exists to widen access, not narrow
  // theirs, so it is not consulted for them.
  if (isElevated(user.role)) return true;
  if (typeof user.can_delete_records === "boolean") return user.can_delete_records;
  return Boolean(settings?.boa_can_delete_records);
}

/**
 * Whether this user may remove a check-out on its own.
 *
 * Anybody who may delete the whole record may certainly delete half of it, so
 * the record permission implies this one.
 */
export function canDeleteCheckout(user, settings = DEFAULT_ACCESS_SETTINGS) {
  if (canDeleteAttendance(user, settings)) return true;
  if (typeof user?.can_delete_checkout === "boolean") return user.can_delete_checkout;
  return Boolean(settings?.boa_can_delete_checkout);
}

/**
 * Whether this user may name an unidentified check-in.
 *
 * Deliberately not implied by the delete permissions: discarding a photograph
 * and deciding whose attendance record it becomes are different powers, and an
 * administrator may well want one without the other.
 */
export function canIdentifyAttendance(user, settings = DEFAULT_ACCESS_SETTINGS) {
  if (!user?.role) return false;
  if (isElevated(user.role)) return true;
  if (typeof user.can_identify === "boolean") return user.can_identify;
  return Boolean(settings?.boa_can_identify);
}

/** The effective capability plus where it came from, for the permissions UI. */
export function describeDeletePermission(user, settings = DEFAULT_ACCESS_SETTINGS) {
  const overridden = typeof user?.can_delete_records === "boolean";
  return {
    can_delete_records: canDeleteAttendance(user, settings),
    // Distinguishes "on because someone chose it for this person" from "on
    // because the workspace default is on", which the toggle needs in order to
    // show whether clearing the override would change anything.
    source: isElevated(user?.role) ? "ROLE" : overridden ? "USER" : "WORKSPACE",
    workspace_default: Boolean(settings?.boa_can_delete_records),
  };
}
