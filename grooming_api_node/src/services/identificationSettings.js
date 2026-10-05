import { getSetting, saveSetting } from "../stores/settingsStore.js";
import { coreCollection } from "../stores/coreStore.js";

const SETTINGS_ID = "identification_settings";

export const IDENTIFICATION_MODES = Object.freeze(["FACE_ONLY", "SELECTOR"]);

export const DEFAULT_IDENTIFICATION_SETTINGS = Object.freeze({
  default_mode: "FACE_ONLY",
  college_modes: Object.freeze({}),
});

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
      if (!collegeId || !isMode(mode)) continue;
      if (mode === defaultMode) continue;
      collegeModes[String(collegeId)] = mode;
    }
  }
  return { default_mode: defaultMode, college_modes: collegeModes };
}

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
      if (mode === null) continue;
      if (!isMode(mode)) {
        return { valid: false, detail: `college_modes.${collegeId} must be one of ${IDENTIFICATION_MODES.join(", ")}` };
      }
    }
  }
  return { valid: true };
}

const CACHE_TTL_MS = 30_000;
let cache = null;

export function clearIdentificationSettingsCache() {
  cache = null;
}

export async function getIdentificationSettings(db, { now = Date.now() } = {}) {
  if (!db) return normalizeIdentificationSettings();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.settings;
  const stored = await getSetting(db, SETTINGS_ID);
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
  if (body.college_modes && typeof body.college_modes === "object") {
    for (const [collegeId, mode] of Object.entries(body.college_modes)) {
      if (mode === null) delete merged.college_modes[String(collegeId)];
      else merged.college_modes[String(collegeId)] = mode;
    }
  }

  const settings = normalizeIdentificationSettings(merged);
  await saveSetting(db, SETTINGS_ID, {
    set: { ...settings, updated_at: new Date(), updated_by: updatedBy || null },
    setOnInsert: { _id: SETTINGS_ID, created_at: new Date() },
  });
  clearIdentificationSettingsCache();
  return settings;
}

export function identificationModeForCollege(settings, collegeId) {
  const normalized = normalizeIdentificationSettings(settings);
  if (!collegeId) return normalized.default_mode;
  return normalized.college_modes[String(collegeId)] || normalized.default_mode;
}

export function usesFaceIdentification(settings, collegeId) {
  return identificationModeForCollege(settings, collegeId) === "FACE_ONLY";
}

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
      source: normalized.college_modes[collegeId] ? "COLLEGE" : "DEFAULT",
      instructors: total,
      enrolled,
      enrolled_percent: total > 0 ? Math.round(ratio * 100) : 0,
      low_enrolment: mode === "FACE_ONLY" && (total === 0 || ratio < LOW_ENROLMENT_WARNING_RATIO),
    };
  });
}

export async function loadCollegeEnrolment(db) {
  const rows = await coreCollection(db, "instructors").aggregate([
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
