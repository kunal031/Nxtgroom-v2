import sharp from "sharp";
import { z } from "zod";
import { detectImageMimeType } from "../imageValidation.js";
import { normalizeInstructorImage } from "../imageProcessor.js";
import { checkFaceQuality, isFaceRecognitionConfigured } from "./faceRecognition.js";
import { enrollReferencePhoto } from "./referencePhotos.js";
import {
  fetchPublicUrl,
  isGoogleHost,
  parsePublicUrl,
  RemoteFetchError,
  toDirectFileUrl,
  toSheetCsvUrl,
} from "./remoteFetch.js";
import { coreCollection } from "../stores/coreStore.js";

export const IMPORT_ROLES = ["INSTRUCTOR", "CENTRAL_INSTRUCTOR", "CENTRAL_TEAM", "MENTOR", "OTHER"];

function roleWords(role) {
  return role.toLowerCase().split("_").map((word) => word[0].toUpperCase() + word.slice(1)).join(" ");
}

const ROLE_CHOICES = `${IMPORT_ROLES.slice(0, -1).map(roleWords).join(", ")} or ${roleWords(IMPORT_ROLES.at(-1))}`;

const MULTI_VALUE_SEPARATORS = {
  name: /[\n;|]/,
  email: /[\s,;/|]+/,
  gender: /[\s,;/|]+/,
  role: /[\n,;/|]/,
  institute: /[\n;|]/,
  employee_id: /[\s,;/|]+/,
  phone_no: /[\n,;/|]/,
  photo_url: /[\s,;|]+/,
};

export function firstValue(field, value) {
  const whole = text(value);
  const separator = MULTI_VALUE_SEPARATORS[field];
  if (!whole || !separator) return whole;
  return whole.split(separator).map((part) => part.trim()).find(Boolean) ?? "";
}

export const MAX_PREVIEW_ROWS = 50;
export const MAX_COMMIT_ROWS = 25;
const PHOTO_CONCURRENCY = 12;
const COMMIT_CONCURRENCY = 6;

export function createLimiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || !queue.length) return;
    active += 1;
    const { task, resolve, reject } = queue.shift();
    Promise.resolve().then(task).then(resolve, reject).finally(() => {
      active -= 1;
      next();
    });
  };
  return (task) => new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    next();
  });
}

const positiveInt = (value, fallback) => {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
};
const downloadSlots = createLimiter(positiveInt(process.env.IMPORT_DOWNLOAD_CONCURRENCY, 12));
const faceSlots = createLimiter(positiveInt(process.env.IMPORT_FACE_CONCURRENCY, 8));

export function createKeyedLock() {
  const tails = new Map();
  return async (key, task) => {
    if (!key) return task();
    const previous = tails.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    tails.set(key, tail);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
}

const collegeLock = createKeyedLock();

export class PhotoCache {
  constructor({ maxBytes = positiveInt(process.env.IMPORT_PHOTO_CACHE_MB, 200) * 1024 * 1024, ttlMs = 30 * 60_000, now = Date.now } = {}) {
    this.maxBytes = maxBytes;
    this.ttlMs = ttlMs;
    this.now = now;
    this.entries = new Map();
    this.bytes = 0;
  }

  get(link) {
    const entry = this.entries.get(link);
    if (!entry) return null;
    if (this.now() - entry.at > this.ttlMs) {
      this.delete(link);
      return null;
    }
    return entry.photo;
  }

  set(link, photo) {
    const size = photo?.normalized?.buffer?.length || 0;
    if (!size || size > this.maxBytes) return;
    this.delete(link);
    while (this.bytes + size > this.maxBytes && this.entries.size) {
      this.delete(this.entries.keys().next().value);
    }
    this.entries.set(link, { photo, at: this.now(), size });
    this.bytes += size;
  }

  delete(link) {
    const entry = this.entries.get(link);
    if (!entry) return;
    this.entries.delete(link);
    this.bytes -= entry.size;
  }
}

const sharedPhotoCache = new PhotoCache();
const MAX_SHEET_BYTES = 2 * 1024 * 1024;

const emailSchema = z.string().email().max(254);

function activeFilter(extra = {}) {
  return {
    $and: [
      extra,
      { $or: [{ deleted_at: null }, { deleted_at: { $exists: false } }] },
    ],
  };
}

function text(value) {
  return value == null ? "" : String(value).trim();
}

function comparable(value) {
  return text(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

export function normalizeImportRole(value) {
  const key = comparable(value);
  return IMPORT_ROLES.find((role) => comparable(role) === key) ?? null;
}

export function normalizeImportGender(value) {
  const key = comparable(value);
  if (["m", "male", "man"].includes(key)) return "MALE";
  if (["f", "female", "woman"].includes(key)) return "FEMALE";
  return null;
}

export function matchCollege(value, colleges) {
  const wanted = text(value);
  if (!wanted) return { error: "Institute is missing" };
  const byId = colleges.find((college) => String(college._id) === wanted);
  if (byId) return { college: byId };
  const byName = colleges.filter((college) => comparable(college.name) === comparable(wanted));
  if (byName.length === 1) return { college: byName[0] };
  if (byName.length > 1) {
    return { error: `Institute "${wanted}" matches ${byName.length} institutes; use its institute ID instead` };
  }
  return { error: `Institute "${wanted}" was not found` };
}

export function photoLinkError(photoUrl) {
  if (!photoUrl) return "Photo link is missing";
  try {
    parsePublicUrl(photoUrl);
    return null;
  } catch (error) {
    return `Photo link: ${error.message}`;
  }
}

export function validateImportFields(raw, colleges, { requirePhoto = true, keptRole = "" } = {}) {
  const errors = [];
  const cell = (field) => firstValue(field, raw?.[field]);
  const name = cell("name").replace(/\s+/g, " ");
  if (!name) errors.push("Name is missing");
  else if (name.length < 2) errors.push("Name must be at least 2 characters");
  else if (name.length > 120) errors.push("Name is longer than 120 characters");

  const emailText = cell("email");
  const email = emailText.toLowerCase();
  if (!email) errors.push("Email is missing");
  else if (!emailSchema.safeParse(email).success) errors.push(`Email "${emailText}" is not a valid address`);

  const genderText = cell("gender");
  const gender = normalizeImportGender(genderText);
  if (!genderText) errors.push("Gender is missing");
  else if (!gender) errors.push(`Gender "${genderText}" must be Male or Female`);

  const roleText = cell("role");
  const role = normalizeImportRole(roleText)
    ?? (keptRole && comparable(roleText) === comparable(keptRole) ? keptRole : null);
  if (!roleText) errors.push("Role is missing");
  else if (!role) errors.push(`Role "${roleText}" must be ${ROLE_CHOICES}`);

  const institute = matchCollege(cell("institute"), colleges);
  if (institute.error) errors.push(institute.error);

  const employeeId = cell("employee_id");
  if (!employeeId) errors.push("Employee ID is missing");
  else if (employeeId.length > 50) errors.push("Employee ID is longer than 50 characters");

  const phone = cell("phone_no");
  if (phone) {
    const digits = phone.replace(/\D/g, "").length;
    if (!/^[+()\-\s\d]*$/.test(phone) || phone.length > 30 || digits < 7 || digits > 15) {
      errors.push(`Phone "${phone}" is not a valid phone number`);
    }
  }

  const photoUrl = cell("photo_url");
  const photoError = photoLinkError(photoUrl);
  if (requirePhoto && photoError) errors.push(photoError);

  const keys = { email, employee_id: employeeId };
  if (errors.length) return { errors, keys, photoError };
  return {
    errors,
    keys,
    photoError,
    value: {
      name,
      email,
      employee_id: employeeId,
      role,
      instructor_role: role,
      gender,
      college_id: String(institute.college._id),
      ...(phone ? { phone_no: phone } : {}),
      photo_url: photoUrl,
    },
    collegeName: institute.college.name || "",
  };
}

export async function findMatchingInstructors(db, keys) {
  const emails = [...new Set(keys.map((key) => key.email).filter(Boolean))];
  const employeeIds = [...new Set(keys.map((key) => key.employee_id).filter(Boolean))];
  const found = { byEmail: new Map(), byEmployeeId: new Map() };
  const clauses = [];
  if (emails.length) clauses.push({ email: { $in: emails } });
  if (employeeIds.length) clauses.push({ employee_id: { $in: employeeIds } });
  if (!clauses.length) return found;

  const rows = await coreCollection(db, "instructors")
    .find({ $or: clauses }, {
      projection: {
        name: 1, email: 1, employee_id: 1, deleted_at: 1, face_ids: 1,
        gender: 1, role: 1, instructor_role: 1, college_id: 1, phone_no: 1,
      },
    })
    .toArray();
  const add = (map, key, row) => map.set(key, [...(map.get(key) || []), row]);
  for (const row of rows) {
    if (row.email) add(found.byEmail, String(row.email).toLowerCase(), row);
    if (row.employee_id) add(found.byEmployeeId, String(row.employee_id), row);
  }
  return found;
}

export function matchExisting(keys, found) {
  const isActive = (row) => !row.deleted_at;
  const byEmail = (found.byEmail.get(keys.email) || []).filter(isActive);
  const byId = found.byEmployeeId.get(keys.employee_id) || [];
  if (byEmail.length > 1) {
    return { error: `Email ${keys.email} is used by ${byEmail.length} instructors; use an email only one of them has` };
  }
  const idOwner = byId.find(isActive) || byId[0];
  if (idOwner?.deleted_at) {
    return { error: `Employee ID ${keys.employee_id} belonged to ${idOwner.name || "an instructor"} who was removed; use a different Employee ID` };
  }
  const emailOwner = byEmail[0];
  if (emailOwner && idOwner && String(emailOwner._id) !== String(idOwner._id)) {
    return {
      error: `Email ${keys.email} belongs to ${emailOwner.name || "one instructor"} but Employee ID ${keys.employee_id} belongs to ${idOwner.name || "another"}; change one of them`,
    };
  }
  const target = emailOwner || idOwner;
  if (!target) return { existing: null };
  return {
    existing: {
      _id: target._id,
      id: String(target._id),
      name: target.name || "",
      hasFace: Array.isArray(target.face_ids) && target.face_ids.some(Boolean),
      record: target,
    },
  };
}

export async function loadImportPhoto(link, { fetcher = fetchPublicUrl } = {}) {
  let response;
  try {
    response = await fetcher(toDirectFileUrl(link));
  } catch (error) {
    throw new Error(`Photo link: ${error instanceof RemoteFetchError ? error.message : "could not be opened"}`);
  }
  if (!detectImageMimeType(response.buffer)) {
    if (String(response.contentType || "").includes("html")) {
      throw new Error("Photo link opens a web page, not an image. Share the file publicly or use a direct image link");
    }
    throw new Error("Photo link is not a JPEG, PNG or WebP image");
  }
  try {
    return await normalizeInstructorImage(response.buffer);
  } catch (error) {
    throw new Error(`Photo: ${error.message}`);
  }
}

export async function photoThumbnail(buffer) {
  const small = await sharp(buffer)
    .resize(96, 96, { fit: "cover", position: "attention" })
    .jpeg({ quality: 70 })
    .toBuffer();
  return `data:image/jpeg;base64,${small.toString("base64")}`;
}

async function checkPhoto(link, deps) {
  let normalized;
  try {
    normalized = await downloadSlots(() => loadImportPhoto(link, deps));
  } catch (error) {
    return { error: error.message };
  }
  if (!deps.faceConfigured) return { normalized, quality: null };
  const quality = await faceSlots(() => deps.checkQuality(normalized.buffer));
  if (!quality.ok) return { error: `Photo: ${quality.message}` };
  return { normalized, quality: quality.quality };
}

async function mapWithConcurrency(items, limit, work) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function resolveDeps(deps = {}) {
  return {
    fetcher: deps.fetcher || fetchPublicUrl,
    checkQuality: deps.checkQuality || checkFaceQuality,
    faceConfigured: deps.faceConfigured ?? isFaceRecognitionConfigured(),
    createInstructor: deps.createInstructor,
    updateInstructor: deps.updateInstructor,
    photoCache: deps.photoCache !== undefined ? deps.photoCache : (deps.fetcher ? null : sharedPhotoCache),
    enrollPhoto: deps.enrollPhoto || enrollReferencePhoto,
  };
}

async function loadColleges(db) {
  return coreCollection(db, "colleges")
    .find(activeFilter(), { projection: { name: 1, location: 1 } })
    .toArray();
}

export function importKeys(raw) {
  return {
    email: firstValue("email", raw?.email).toLowerCase(),
    employee_id: firstValue("employee_id", raw?.employee_id),
  };
}

const RECORD_VALUES = {
  name: (record) => record.name,
  email: (record) => record.email,
  gender: (record) => record.gender,
  role: (record) => record.instructor_role || record.role,
  institute: (record) => record.college_id,
  employee_id: (record) => record.employee_id,
  phone_no: (record) => record.phone_no,
};

export function fillFromRecord(raw, record) {
  const merged = { ...raw };
  const filled = [];
  for (const [field, read] of Object.entries(RECORD_VALUES)) {
    const current = read(record);
    if (!firstValue(field, raw?.[field]) && current != null && text(current)) {
      merged[field] = String(current);
      filled.push(field);
    }
  }
  return { merged, filled };
}

async function checkRows(db, rows, deps) {
  const colleges = await loadColleges(db);
  const found = await findMatchingInstructors(db, rows.map(importKeys));
  const checked = rows.map((raw) => {
    const match = matchExisting(importKeys(raw), found);
    const { merged, filled } = match.existing
      ? fillFromRecord(raw, match.existing.record)
      : { merged: raw, filled: [] };
    const keptRole = match.existing ? text(RECORD_VALUES.role(match.existing.record)) : "";
    return {
      row: raw?.row ?? null,
      match,
      filled,
      ...validateImportFields(merged, colleges, { requirePhoto: false, keptRole }),
    };
  });
  const seenEmails = new Set();
  const seenIds = new Set();

  const results = checked.map((item) => {
    const errors = [...item.errors];
    const { match } = item;
    if (match.error) errors.push(match.error);
    if (item.value) {
      if (seenEmails.has(item.value.email)) errors.push(`Email ${item.value.email} appears more than once`);
      if (seenIds.has(item.value.employee_id)) errors.push(`Employee ID ${item.value.employee_id} appears more than once`);
      seenEmails.add(item.value.email);
      seenIds.add(item.value.employee_id);
    }
    const needsPhoto = !match.existing?.hasFace;
    if (needsPhoto && item.photoError) errors.push(item.photoError);
    return {
      row: item.row,
      errors,
      value: errors.length ? undefined : item.value,
      collegeName: item.collegeName,
      existing: match.existing ?? null,
      filled: item.filled,
      needsPhoto,
    };
  });

  await mapWithConcurrency(results, PHOTO_CONCURRENCY, async (result) => {
    if (!result.value || !result.needsPhoto) return;
    const link = result.value.photo_url;
    const cached = deps.photoCache?.get(link);
    const photo = cached || await checkPhoto(link, deps);
    if (photo.error) {
      result.errors = [photo.error];
      result.value = undefined;
      return;
    }
    if (!cached) deps.photoCache?.set(link, photo);
    result.photo = photo;
  });
  return results;
}

export async function previewImportRows(db, rows, deps = {}) {
  const resolved = resolveDeps(deps);
  const results = await checkRows(db, rows, resolved);
  return Promise.all(results.map(async (result) => {
    if (!result.value) return { row: result.row, ok: false, errors: result.errors };
    return {
      row: result.row,
      ok: true,
      action: result.existing ? "update" : "create",
      existing: result.existing ? { id: result.existing.id, name: result.existing.name } : null,
      filled: result.filled,
      photo: result.needsPhoto ? "enrol" : "keep",
      value: { ...result.value, institute: result.collegeName },
      thumbnail: result.photo
        ? await photoThumbnail(result.photo.normalized.buffer).catch(() => null)
        : null,
    };
  }));
}

const UPDATE_REFUSALS = {
  not_found: "The instructor was removed while importing",
  active_attendance: "They are checked in today; check them out before moving them to another institute",
  college_not_found: "The institute was removed while importing",
};

export async function commitImportRows(db, rows, deps = {}) {
  const resolved = resolveDeps(deps);
  const results = await checkRows(db, rows, resolved);
  return mapWithConcurrency(results, COMMIT_CONCURRENCY, (result) => applyRow(db, result, resolved));
}

async function applyRow(db, result, resolved) {
  if (!result.value) return { row: result.row, ok: false, errors: result.errors };
  const { photo_url: photoUrl, ...fields } = result.value;
  const refuse = (message) => ({ row: result.row, ok: false, errors: [message] });

  let instructor;
  try {
    const written = await collegeLock(fields.college_id || null, () => (result.existing
      ? resolved.updateInstructor(db, result.existing.id, fields)
      : resolved.createInstructor(db, fields)));
    if (result.existing) {
      if (written.outcome === "duplicate_employee_id") {
        return refuse(`Employee ID ${fields.employee_id} belongs to another instructor`);
      }
      if (written.outcome !== "updated") {
        return refuse(UPDATE_REFUSALS[written.outcome] || "The instructor could not be updated");
      }
      instructor = { _id: result.existing._id, face_ids: [] };
    } else {
      if (written.outcome === "college_not_found") return refuse(UPDATE_REFUSALS.college_not_found);
      if (written.outcome === "duplicate_employee_id") return refuse(`Employee ID ${fields.employee_id} already exists`);
      instructor = written.instructor;
    }
  } catch (error) {
    if (error?.code === 11000) return refuse("Employee ID already exists");
    throw error;
  }

  const verb = result.existing ? "Updated" : "Added";
  const outcome = {
    row: result.row,
    ok: true,
    id: String(instructor._id),
    name: fields.name,
    updated: Boolean(result.existing),
    photo_enrolled: false,
  };
  if (!result.needsPhoto) {
    outcome.photo_kept = true;
  } else if (resolved.faceConfigured) {
    const enrolled = await faceSlots(() => resolved.enrollPhoto(db, instructor, result.photo.normalized, {
      mode: "add",
      checkedQuality: result.photo.quality,
    }));
    if (enrolled.ok) outcome.photo_enrolled = true;
    else outcome.warning = `${verb}, but the photo was not enrolled: ${enrolled.detail}`;
  } else {
    outcome.warning = `${verb}, but the photo was not enrolled: face recognition is not configured`;
  }
  if (photoUrl) resolved.photoCache?.delete(photoUrl);
  return outcome;
}

export async function fetchSheetCsv(link, { fetcher = fetchPublicUrl } = {}) {
  const csvUrl = toSheetCsvUrl(link);
  if (!csvUrl) throw new RemoteFetchError("Paste a Google Sheets link (docs.google.com/spreadsheets/...)");
  const response = await fetcher(csvUrl, {
    maxBytes: MAX_SHEET_BYTES,
    allowHost: isGoogleHost,
  });
  if (String(response.contentType || "").includes("html")) {
    throw new RemoteFetchError(
      "The sheet is not public. In Google Sheets choose Share, then \"Anyone with the link\" can view, and try again"
    );
  }
  return response.buffer.toString("utf8");
}
