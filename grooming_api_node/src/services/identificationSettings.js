/**
 * How a check-in decides who the instructor is.
 *
 * FACE_ONLY recognises the person from their photograph and offers no selector.
 * SELECTOR keeps the dropdown a BOA picks from. The mode is settable per college
 * over a global default, because reference faces are enrolled a campus at a
 * time: one college can be recognising faces while another is still collecting
 * photographs, and a single workspace-wide switch would force the slowest
 * college to decide for everyone.
 *
 * The college is the one the tablet is logged in as, not one derived from the
 * instructor: the mode has to be known before anybody has been identified.
 *
 * Enrolment is reported alongside the mode but never overrides it. A college set
 * to FACE_ONLY with few enrolled faces is warned about and left alone —
 * switching it back automatically would override a deliberate choice by the
 * administrator who set it, and the unidentified queue already catches what
 * recognition misses.
 */

const SETTINGS_ID = "identification_settings";

export const IDENTIFICATION_MODES = Object.freeze(["FACE_ONLY", "SELECTOR"]);

/**
 * FACE_ONLY is the default because it is the intended operating mode, and a
 * college with no enrolled faces still records attendance: every check-in is
 * saved as unidentified for an admin to resolve rather than refused. The
 * enrolment warning exists so that state is visible rather than surprising.
 */
export const DEFAULT_IDENTIFICATION_SETTINGS = Object.freeze({
  default_mode: "FACE_ONLY",
  /** College id -> mode. Only colleges that differ from the default appear. */
  college_modes: Object.freeze({}),
});

/** Below this share of enrolled faces a FACE_ONLY college is flagged. */
export const LOW_ENROLMENT_WARNING_RATIO = 0.8;

function isMode(value) {
  return typeof value === "string" && IDENTIFICATION_MODES.includes(value);
}

export function normalizeIdentificationSettings(raw = {}) {
  const defaultMode = isMode(raw?.default_mode)
    ? raw.default_mode
    : DEFAULT_IDENTIFICATION_SETTINGS.default_mode;

  const collegeModes = {};
  const stored = raw?.college_modes;
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    for (const [collegeId, mode] of Object.entries(stored)) {
      // An unreadable entry is dropped rather than defaulted: a college whose
      // override cannot be parsed should follow the global default, which is
      // what its absence means.
      if (!collegeId || !isMode(mode)) continue;
      // An override equal to the default carries no information and would
      // survive a later change to that default, silently pinning the college.
      if (mode === defaultMode) continue;
      collegeModes[String(collegeId)] = mode;
    }
  }
  return { default_mode: defaultMode, college_modes: collegeModes };
}

/** Rejects unknown keys and bad modes so a typo cannot disable recognition. */
export function validateIdentificationSettings(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { valid: false, detail: "Identification settings must be an object" };
  }
  const allowed = ["default_mode", "college_modes"];
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    return { valid: false, detail: `Unsupported identification settings: ${unknown.join(", ")}` };
  }
  if ("default_mode" in body && !isMode(body.default_mode)) {
    return { valid: false, detail: `default_mode must be one of ${IDENTIFICATION_MODES.join(", ")}` };
  }
  if ("college_modes" in body) {
    const modes = body.college_modes;
    if (!modes || typeof modes !== "object" || Array.isArray(modes)) {
      return { valid: false, detail: "college_modes must be an object of college id to mode" };
    }
    for (const [collegeId, mode] of Object.entries(modes)) {
      if (!collegeId || collegeId.length > 100) {
        return { valid: false, detail: "college_modes contains an invalid college id" };
      }
      // null is how the UI clears an override, so it is accepted and dropped by
      // normalization rather than rejected here.
      if (mode === null) continue;
      if (!isMode(mode)) {
        return { valid: false, detail: `college_modes.${collegeId} must be one of ${IDENTIFICATION_MODES.join(", ")}` };
      }
    }
  }
  return { valid: true };
}

// Read on every check-in, so the document is held briefly rather than fetched
// per request. A change made through the API clears this immediately; the
// window only matters for an edit made straight in the database.
const CACHE_TTL_MS = 30_000;
let cache = null;

export function clearIdentificationSettingsCache() {
  cache = null;
}

export async function getIdentificationSettings(db, { now = Date.now() } = {}) {
  if (!db) return normalizeIdentificationSettings();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.settings;
  const stored = await db.collection("app_settings").findOne({ _id: SETTINGS_ID });
  const settings = normalizeIdentificationSettings(stored || {});
  cache = { settings, at: now };
  return settings;
}

export async function saveIdentificationSettings(db, body, updatedBy) {
  const current = await getIdentificationSettings(db);
  const merged = {
    default_mode: "default_mode" in body ? body.default_mode : current.default_mode,
    college_modes: { ...current.college_modes },
  };
  // Merged key by key so one college can be changed without resending the rest,
  // and so null clears a single override instead of replacing the whole map.
  if (body.college_modes && typeof body.college_modes === "object") {
    for (const [collegeId, mode] of Object.entries(body.college_modes)) {
      if (mode === null) delete merged.college_modes[String(collegeId)];
      else merged.college_modes[String(collegeId)] = mode;
    }
  }

  const settings = normalizeIdentificationSettings(merged);
  await db.collection("app_settings").updateOne(
    { _id: SETTINGS_ID },
    {
      $set: { ...settings, updated_at: new Date(), updated_by: updatedBy || null },
      $setOnInsert: { _id: SETTINGS_ID, created_at: new Date() },
    },
    { upsert: true }
  );
  clearIdentificationSettingsCache();
  return settings;
}

/**
 * The mode in force for one college.
 *
 * A college with no override follows the global default, so changing the
 * default moves every college that has not been decided individually.
 */
export function identificationModeForCollege(settings, collegeId) {
  const normalized = normalizeIdentificationSettings(settings);
  if (!collegeId) return normalized.default_mode;
  return normalized.college_modes[String(collegeId)] || normalized.default_mode;
}

/** Whether a check-in in this college identifies from the photograph. */
export function usesFaceIdentification(settings, collegeId) {
  return identificationModeForCollege(settings, collegeId) === "FACE_ONLY";
}

/**
 * Per-college enrolment, for the settings screen.
 *
 * Counts instructors with at least one indexed face against the college roster.
 * A FACE_ONLY college below the warning ratio is flagged rather than changed:
 * the administrator decides, and the flag is what makes that decision informed.
 */
export function describeCollegeIdentification(settings, colleges, enrolment) {
  const normalized = normalizeIdentificationSettings(settings);
  const counts = enrolment instanceof Map ? enrolment : new Map(Object.entries(enrolment || {}));

  return (colleges || []).map((college) => {
    const collegeId = String(college._id);
    const stats = counts.get(collegeId) || { total: 0, enrolled: 0 };
    const total = Number(stats.total) || 0;
    const enrolled = Number(stats.enrolled) || 0;
    const mode = normalized.college_modes[collegeId] || normalized.default_mode;
    const ratio = total > 0 ? enrolled / total : 0;
    return {
      college_id: collegeId,
      college_name: college.name || null,
      mode,
      // Distinguishes "set for this college" from "following the default", so
      // the UI can show whether clearing the override would change anything.
      source: normalized.college_modes[collegeId] ? "COLLEGE" : "DEFAULT",
      instructors: total,
      enrolled,
      enrolled_percent: total > 0 ? Math.round(ratio * 100) : 0,
      // Advisory only. Nothing in the check-in path reads this.
      low_enrolment: mode === "FACE_ONLY" && (total === 0 || ratio < LOW_ENROLMENT_WARNING_RATIO),
    };
  });
}

/**
 * Enrolled-face counts per college, as the settings screen needs them.
 *
 * One grouped aggregate rather than a query per college: the roster is around
 * 600 instructors across a growing number of colleges, and a per-college round
 * trip would make the settings page slower with every campus added.
 */
export async function loadCollegeEnrolment(db) {
  const rows = await db.collection("instructors").aggregate([
    {
      $match: {
        $or: [{ deleted_at: null }, { deleted_at: { $exists: false } }],
      },
    },
    {
      $group: {
        _id: "$college_id",
        total: { $sum: 1 },
        enrolled: {
          $sum: {
            // An instructor counts as enrolled when at least one face is
            // indexed. face_ids is absent on every row until enrollment, so a
            // missing field has to read as zero rather than as an error.
            $cond: [{ $gt: [{ $size: { $ifNull: ["$face_ids", []] } }, 0] }, 1, 0],
          },
        },
      },
    },
  ]).toArray();

  const counts = new Map();
  for (const row of rows) {
    if (row._id == null) continue;
    counts.set(String(row._id), { total: row.total || 0, enrolled: row.enrolled || 0 });
  }
  return counts;
}
