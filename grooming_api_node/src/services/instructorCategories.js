import { getSetting, saveSetting } from "../stores/settingsStore.js";
import { coreCollection } from "../stores/coreStore.js";

const SETTINGS_ID = "config_settings";
const FIELD = "instructor_categories";
export const CATEGORY_MAX_LENGTH = 60;

const ACTIVE_INSTRUCTOR = { $or: [{ deleted_at: null }, { deleted_at: { $exists: false } }] };

export function normalizeCategoryName(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

export function validateCategoryName(value) {
  const name = normalizeCategoryName(value);
  if (!name) return { valid: false, detail: "Enter a category name" };
  if (name.length > CATEGORY_MAX_LENGTH) {
    return { valid: false, detail: `A category name can be at most ${CATEGORY_MAX_LENGTH} characters` };
  }
  return { valid: true, name };
}

function sameName(left, right) {
  return left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0;
}

function sortNames(names) {
  return [...names].sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" }));
}

function uniqueNames(values) {
  const names = [];
  for (const value of values) {
    const name = normalizeCategoryName(value);
    if (name && !names.some((existing) => sameName(existing, name))) names.push(name);
  }
  return names;
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function nameFilter(name) {
  return { $regex: `^\\s*${escapeRegex(name).replace(/ /g, "\\s+")}\\s*$`, $options: "i" };
}

async function categoryUsage(db) {
  const rows = await coreCollection(db, "instructors").aggregate([
    { $match: { $and: [ACTIVE_INSTRUCTOR, { instructor_category: { $type: "string", $ne: "" } }] } },
    { $group: { _id: "$instructor_category", count: { $sum: 1 } } },
  ]).toArray();
  return rows
    .map((row) => ({ name: normalizeCategoryName(row._id), count: Number(row.count) || 0 }))
    .filter((row) => row.name);
}

function countFor(usage, name) {
  return usage.filter((row) => sameName(row.name, name)).reduce((total, row) => total + row.count, 0);
}

async function saveNames(db, names, updatedBy) {
  await saveSetting(db, SETTINGS_ID, {
    set: { [FIELD]: names, updated_at: new Date(), updated_by: updatedBy },
    setOnInsert: { _id: SETTINGS_ID, created_at: new Date() },
  });
}

async function loadCategories(db, updatedBy = null) {
  const [stored, usage] = await Promise.all([getSetting(db, SETTINGS_ID), categoryUsage(db)]);
  const storedNames = Array.isArray(stored?.[FIELD]) ? uniqueNames(stored[FIELD]) : null;
  const names = sortNames(uniqueNames([...(storedNames ?? []), ...usage.map((row) => row.name)]));
  const changed = !storedNames
    || names.length !== storedNames.length
    || names.some((name, index) => name !== storedNames[index]);
  if (changed) await saveNames(db, names, updatedBy);
  return { names, usage };
}

function withCounts({ names, usage }) {
  return names.map((name) => ({ name, count: countFor(usage, name) }));
}

export async function listInstructorCategories(db) {
  return withCounts(await loadCategories(db));
}

export async function addInstructorCategory(db, value, updatedBy = null) {
  const check = validateCategoryName(value);
  if (!check.valid) return { outcome: "invalid", detail: check.detail };
  const current = await loadCategories(db, updatedBy);
  if (current.names.some((name) => sameName(name, check.name))) return { outcome: "duplicate" };
  const names = sortNames([...current.names, check.name]);
  await saveNames(db, names, updatedBy);
  return { outcome: "added", categories: withCounts({ names, usage: current.usage }) };
}

export async function renameInstructorCategory(db, fromValue, toValue, updatedBy = null) {
  const check = validateCategoryName(toValue);
  if (!check.valid) return { outcome: "invalid", detail: check.detail };
  const from = normalizeCategoryName(fromValue);
  const current = await loadCategories(db, updatedBy);
  const existing = current.names.find((name) => sameName(name, from));
  if (!existing) return { outcome: "not_found" };
  if (current.names.some((name) => name !== existing && sameName(name, check.name))) return { outcome: "duplicate" };

  let moved = 0;
  if (existing !== check.name) {
    const result = await coreCollection(db, "instructors").updateMany(
      { instructor_category: nameFilter(existing) },
      { $set: { instructor_category: check.name, updated_at: new Date() } }
    );
    moved = Number(result?.modifiedCount) || 0;
  }
  const names = sortNames(current.names.map((name) => (name === existing ? check.name : name)));
  await saveNames(db, names, updatedBy);
  const usage = await categoryUsage(db);
  return { outcome: "renamed", moved, categories: withCounts({ names, usage }) };
}

export async function deleteInstructorCategory(db, value, updatedBy = null) {
  const target = normalizeCategoryName(value);
  const current = await loadCategories(db, updatedBy);
  const existing = current.names.find((name) => sameName(name, target));
  if (!existing) return { outcome: "not_found" };
  const inUse = countFor(current.usage, existing);
  if (inUse) return { outcome: "in_use", count: inUse };
  const names = current.names.filter((name) => name !== existing);
  await saveNames(db, names, updatedBy);
  return { outcome: "deleted", categories: withCounts({ names, usage: current.usage }) };
}
