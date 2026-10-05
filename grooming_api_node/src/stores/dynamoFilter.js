import { toItem } from "./dynamoItems.js";

/**
 * The subset of MongoDB query language the application's filters use,
 * translated two ways:
 *
 * - conditionExpression: a DynamoDB ConditionExpression, so a write happens
 *   only if the item still matches (an atomic claim, a guarded delete).
 * - matchesFilter: the same test in JavaScript, to pick candidates from a
 *   Query before the conditional write confirms them.
 *
 * Supported: equality (including null, which like MongoDB also matches a
 * missing field), $ne, $lt, $lte, $gt, $gte, $in, $nin, $exists,
 * $type: "string", $and, $or, and dotted paths into nested objects.
 * Anything else throws, so an unsupported filter fails a test rather than
 * silently matching the wrong documents.
 */

const COMPARISONS = { $lt: "<", $lte: "<=", $gt: ">", $gte: ">=" };
const OPERATORS = new Set(["$ne", "$in", "$nin", "$exists", "$type", ...Object.keys(COMPARISONS)]);

/** The value at a dotted path, e.g. "_private_evaluation_outbox.created_at". */
export function getPath(document, path) {
  let value = document;
  for (const part of path.split(".")) {
    if (value === null || value === undefined || typeof value !== "object") return undefined;
    value = value[part];
  }
  return value;
}

function isOperatorObject(value) {
  return Boolean(value)
    && typeof value === "object"
    && !(value instanceof Date)
    && !Array.isArray(value)
    && value._bsontype === undefined
    && Object.keys(value).length > 0
    && Object.keys(value).every((key) => key.startsWith("$"));
}

function unsupported(what) {
  return new Error(`Unsupported filter for DynamoDB: ${what}`);
}

// ------------------------------------------------------------- JavaScript

function comparable(value) {
  if (value instanceof Date) return value.getTime();
  if (value?._bsontype === "ObjectId") return value.toHexString();
  return value;
}

function equal(left, right) {
  return comparable(left) === comparable(right);
}

function compare(left, operator, right) {
  if (left === undefined || left === null) return false;
  const a = comparable(left);
  const b = comparable(right);
  // MongoDB compares only values of the same kind (a date with a date).
  if (typeof a !== typeof b) return false;
  if (operator === "$lt") return a < b;
  if (operator === "$lte") return a <= b;
  if (operator === "$gt") return a > b;
  return a >= b;
}

function fieldMatches(value, condition) {
  if (!isOperatorObject(condition)) {
    if (condition === null) return value === null || value === undefined;
    return equal(value, condition);
  }
  return Object.entries(condition).every(([operator, operand]) => {
    if (!OPERATORS.has(operator)) throw unsupported(operator);
    if (operator === "$exists") return operand ? value !== undefined : value === undefined;
    if (operator === "$ne") {
      return operand === null ? value !== null && value !== undefined : !equal(value, operand);
    }
    if (operator === "$in") return operand.some((candidate) => fieldMatches(value, candidate));
    if (operator === "$nin") return !operand.some((candidate) => fieldMatches(value, candidate));
    if (operator === "$type") {
      if (operand !== "string") throw unsupported(`$type ${operand}`);
      return typeof value === "string";
    }
    return compare(value, operator, operand);
  });
}

export function matchesFilter(document, filter = {}) {
  return Object.entries(filter).every(([field, condition]) => {
    if (field === "$and") return condition.every((part) => matchesFilter(document, part));
    if (field === "$or") return condition.some((part) => matchesFilter(document, part));
    if (field.startsWith("$")) throw unsupported(field);
    return fieldMatches(getPath(document, field), condition);
  });
}

/** MongoDB's order for a single-field sort: missing and null first ascending. */
export function sortDocuments(documents, sort) {
  const entries = Object.entries(sort || {});
  if (!entries.length) return documents;
  if (entries.length > 1) throw unsupported("sort on more than one field");
  const [[field, direction]] = entries;
  return [...documents].sort((left, right) => {
    const a = comparable(getPath(left, field));
    const b = comparable(getPath(right, field));
    const aMissing = a === undefined || a === null;
    const bMissing = b === undefined || b === null;
    let order = 0;
    if (aMissing || bMissing) order = aMissing === bMissing ? 0 : aMissing ? -1 : 1;
    else order = a < b ? -1 : a > b ? 1 : 0;
    return direction === -1 ? -order : order;
  });
}

// ----------------------------------------------------------------- DynamoDB

/**
 * Appends the filter's condition to an expression built with
 * upsertExpression() (its name() and value() placeholders), and returns the
 * condition text; "" for an empty filter.
 */
export function conditionExpression(filter, expression, { keyAttribute = "_id" } = {}) {
  // Always true and always false, for an empty {} inside $or and for $in: [].
  const always = () => `attribute_exists(${expression.name(keyAttribute)})`;
  const never = () => `attribute_not_exists(${expression.name(keyAttribute)})`;
  const clauses = Object.entries(filter || {}).map(([field, condition]) => {
    if (field === "$and" || field === "$or") {
      const parts = condition.map((part) => conditionExpression(part, expression, { keyAttribute }) || always());
      if (!parts.length) return field === "$and" ? always() : never();
      return `(${parts.join(field === "$and" ? " AND " : " OR ")})`;
    }
    if (field.startsWith("$")) throw unsupported(field);
    return fieldCondition(field, condition, expression, never);
  });
  return clauses.join(" AND ");
}

function fieldCondition(field, condition, expression, never) {
  // Registered only when used: DynamoDB rejects a name no expression uses.
  // A dotted path becomes one placeholder per segment: #a.#b.
  const name = () => field.split(".").map((part) => expression.name(part)).join(".");
  if (!isOperatorObject(condition)) {
    if (condition === null) return `(attribute_not_exists(${name()}) OR ${name()} = ${expression.value(null)})`;
    return `${name()} = ${expression.value(condition)}`;
  }
  return Object.entries(condition).map(([operator, operand]) => {
    if (!OPERATORS.has(operator)) throw unsupported(operator);
    if (operator === "$exists") return operand ? `attribute_exists(${name()})` : `attribute_not_exists(${name()})`;
    if (operator === "$ne") {
      return operand === null
        ? `(attribute_exists(${name()}) AND ${name()} <> ${expression.value(null)})`
        : `(attribute_not_exists(${name()}) OR ${name()} <> ${expression.value(operand)})`;
    }
    if (operator === "$in") {
      if (!operand.length) return never();
      if (operand.some((value) => value === null)) throw unsupported("$in with null");
      return `${name()} IN (${operand.map((value) => expression.value(value)).join(", ")})`;
    }
    if (operator === "$nin") {
      // Excluding nothing: always true. The key attribute always exists.
      if (!operand.length) return `attribute_exists(${expression.name("_id")})`;
      if (operand.some((value) => value === null)) throw unsupported("$nin with null");
      return `(attribute_not_exists(${name()}) OR NOT (${name()} IN (${operand.map((value) => expression.value(value)).join(", ")})))`;
    }
    if (operator === "$type") {
      if (operand !== "string") throw unsupported(`$type ${operand}`);
      return `attribute_type(${name()}, ${expression.value("S")})`;
    }
    return `${name()} ${COMPARISONS[operator]} ${expression.value(operand)}`;
  }).join(" AND ");
}

/** The value a filter pins a field to, when it is a plain equality. */
export function equalityValue(filter, field) {
  const condition = filter?.[field];
  if (condition === undefined || isOperatorObject(condition)) return undefined;
  return toItem(condition);
}
