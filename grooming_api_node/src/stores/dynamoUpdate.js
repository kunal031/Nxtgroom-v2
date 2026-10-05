import { getPath, matchesFilter } from "./dynamoFilter.js";

/**
 * MongoDB update operators applied to a document in JavaScript, for the
 * collections whose DynamoDB writes read the document, change it here and
 * write it back guarded by its version (see dynamoDocuments.js).
 *
 * Supported: $set, $unset, $inc, $push (one value or { $each }), $addToSet,
 * $pull (equality), and $setOnInsert when inserting. Dotted paths write into
 * nested objects, creating them as MongoDB does.
 */

function unsupported(what) {
  return new Error(`Unsupported update for DynamoDB: ${what}`);
}

function clone(value) {
  if (value instanceof Date) return new Date(value.getTime());
  if (value?._bsontype === "ObjectId") return value;
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === "object" && !(value instanceof Uint8Array)) {
    return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, clone(field)]));
  }
  return value;
}

function setPath(document, path, value) {
  const parts = path.split(".");
  let target = document;
  for (const part of parts.slice(0, -1)) {
    if (target[part] === null || typeof target[part] !== "object" || Array.isArray(target[part])) target[part] = {};
    target = target[part];
  }
  target[parts.at(-1)] = value;
}

function unsetPath(document, path) {
  const parts = path.split(".");
  let target = document;
  for (const part of parts.slice(0, -1)) {
    if (target[part] === null || typeof target[part] !== "object") return;
    target = target[part];
  }
  delete target[parts.at(-1)];
}

function same(left, right) {
  if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime();
  if (left?._bsontype === "ObjectId" || right?._bsontype === "ObjectId") return String(left) === String(right);
  if (left && right && typeof left === "object" && typeof right === "object") {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  return left === right;
}

export function applyUpdate(document, update, { inserting = false } = {}) {
  const next = clone(document);
  for (const [operator, fields] of Object.entries(update)) {
    if (operator === "$setOnInsert") {
      if (inserting) for (const [path, value] of Object.entries(fields)) setPath(next, path, clone(value));
    } else if (operator === "$set") {
      for (const [path, value] of Object.entries(fields)) setPath(next, path, clone(value));
    } else if (operator === "$unset") {
      for (const path of Object.keys(fields)) unsetPath(next, path);
    } else if (operator === "$inc") {
      for (const [path, amount] of Object.entries(fields)) setPath(next, path, (Number(getPath(next, path)) || 0) + amount);
    } else if (operator === "$push") {
      for (const [path, value] of Object.entries(fields)) {
        const values = value && typeof value === "object" && "$each" in value ? value.$each : [value];
        const current = getPath(next, path);
        setPath(next, path, [...(Array.isArray(current) ? current : []), ...values.map(clone)]);
      }
    } else if (operator === "$addToSet") {
      for (const [path, value] of Object.entries(fields)) {
        const current = getPath(next, path);
        const list = Array.isArray(current) ? current : [];
        setPath(next, path, list.some((entry) => same(entry, value)) ? list : [...list, clone(value)]);
      }
    } else if (operator === "$pull") {
      for (const [path, value] of Object.entries(fields)) {
        const current = getPath(next, path);
        if (Array.isArray(current)) setPath(next, path, current.filter((entry) => !same(entry, value)));
      }
    } else {
      throw unsupported(operator);
    }
  }
  return next;
}

/**
 * The document MongoDB inserts for an upsert that matched nothing: the
 * filter's plain equality fields, then the update applied as an insert.
 */
export function upsertDocument(filter, update) {
  const seed = {};
  for (const [field, condition] of Object.entries(filter || {})) {
    if (field.startsWith("$")) continue;
    const isOperator = condition && typeof condition === "object" && !(condition instanceof Date)
      && condition._bsontype === undefined && Object.keys(condition).some((key) => key.startsWith("$"));
    if (!isOperator) setPath(seed, field, clone(condition));
  }
  return applyUpdate(seed, update, { inserting: true });
}

/** A MongoDB projection ({ a: 1, b: 1 } or { a: 0 }) applied to a document. */
export function project(document, projection) {
  if (!document || !projection || !Object.keys(projection).length) return document;
  const entries = Object.entries(projection);
  const including = entries.some(([field, flag]) => field !== "_id" && flag);
  if (including) {
    const result = {};
    if (projection._id !== 0 && projection._id !== false) result._id = document._id;
    for (const [field, flag] of entries) {
      if (!flag || field === "_id") continue;
      const value = getPath(document, field);
      if (value !== undefined) setPath(result, field, value);
    }
    return result;
  }
  const result = clone(document);
  for (const [field] of entries) unsetPath(result, field);
  return result;
}

export function documentsEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export { matchesFilter };
