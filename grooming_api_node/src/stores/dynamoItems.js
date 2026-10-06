const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Fields whose name says they hold a moment in time. A counter update can
 * set one of these without rewriting the item's date-field list, so an
 * ISO-shaped value in one is still read as a Date. User-entered fields -
 * a name, a remark - never match, which is the case this fixes.
 */
const TIMESTAMP_FIELD = /(?:^|_)(?:at|time|until|on)$|_at$|^expires$|^date$/;

/**
 * Dates in a stored document are written as { $date: "..." } rather than as
 * a bare ISO string.
 *
 * A bare string cannot be told apart from text a user typed that happens to
 * look like a timestamp, so reading it back meant guessing, and the guess
 * was always "Date". An instructor's name or a remark of
 * "2024-01-02T03:04:05.123Z" came back as a Date object and no longer
 * matched the string MongoDB would have returned. Marking the ones we wrote
 * removes the guess.
 *
 * Index keys and filter values are not written through this: they are
 * compared against DynamoDB's own key attributes, which must stay plain
 * strings, so those keep using toItem.
 */
/**
 * The paths of the fields that held a Date, stored alongside the item.
 *
 * Dates themselves stay plain ISO strings, because DynamoDB compares and
 * sorts them directly: a job claim asks for available_at <= now, and the
 * outbox sweeps sort on a timestamp. Wrapping the value would break both.
 * Recording which fields were dates keeps the values comparable and still
 * removes the guesswork when reading them back.
 *
 * An item written before this existed has no list, and its ISO-shaped
 * strings are read back as Dates, which is what those rows meant.
 */
export const DATE_FIELDS = "_dates";

function collectDates(value, paths, prefix) {
  if (value instanceof Date) {
    if (!Number.isNaN(value.getTime())) paths.push(prefix);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((field, at) => collectDates(field, paths, `${prefix}${prefix ? "." : ""}${at}`));
    return;
  }
  if (value && typeof value === "object" && !(value instanceof Uint8Array) && !value._bsontype) {
    for (const [key, field] of Object.entries(value)) {
      if (field === undefined) continue;
      collectDates(field, paths, `${prefix}${prefix ? "." : ""}${key}`);
    }
  }
}

export function toItem(value) {
  // An unparseable Date throws from toISOString, which would fail the write
  // rather than the validation that should have caught it.
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (value?._bsontype === "ObjectId") return value.toHexString();
  if (Array.isArray(value)) return value.map(toItem);
  if (value && typeof value === "object" && !(value instanceof Uint8Array)) {
    const item = {};
    for (const [key, field] of Object.entries(value)) {
      if (field !== undefined) item[key] = toItem(field);
    }
    return item;
  }
  return value;
}

/**
 * toItem, plus the list of fields that were Dates, so reading the item back
 * does not have to guess from the shape of a string.
 */
export function toStoredItem(document) {
  const item = toItem(document);
  if (!item || typeof item !== "object" || Array.isArray(item)) return item;
  const paths = [];
  collectDates(document, paths, "");
  item[DATE_FIELDS] = paths;
  return item;
}

function reviveAt(target, path, depth = 0) {
  const parts = path.split(".");
  const key = parts[depth];
  if (target === null || typeof target !== "object") return;
  if (depth === parts.length - 1) {
    if (typeof target[key] === "string") target[key] = new Date(target[key]);
    return;
  }
  reviveAt(target[key], path, depth + 1);
}

function guessDates(value) {
  if (typeof value === "string") return ISO_TIMESTAMP.test(value) ? new Date(value) : value;
  if (Array.isArray(value)) return value.map(guessDates);
  if (value instanceof Set) return [...value].map(guessDates);
  if (value && typeof value === "object" && !(value instanceof Uint8Array)) {
    const document = {};
    for (const [key, field] of Object.entries(value)) document[key] = guessDates(field);
    return document;
  }
  return value;
}

function plain(value) {
  if (Array.isArray(value)) return value.map(plain);
  if (value instanceof Set) return [...value].map(plain);
  if (value && typeof value === "object" && !(value instanceof Uint8Array)) {
    const document = {};
    for (const [key, field] of Object.entries(value)) document[key] = plain(field);
    return document;
  }
  return value;
}

export function fromItem(value) {
  const listed = value && typeof value === "object" && !Array.isArray(value)
    ? value[DATE_FIELDS]
    : undefined;
  // No list: written before the fields were recorded, so fall back to
  // reading an ISO-shaped string as a Date.
  if (!Array.isArray(listed)) return guessDates(value);

  // Every field the writer recorded as a date becomes one. A field it did
  // not record is left as written, so text that merely looks like a
  // timestamp survives - except where an update set a timestamp outside
  // this list, which keeps the old guess rather than losing the date.
  const document = plain(value);
  delete document[DATE_FIELDS];
  for (const path of listed) {
    if (typeof path === "string" && path) reviveAt(document, path);
  }
  for (const [key, field] of Object.entries(document)) {
    if (typeof field !== "string" || listed.includes(key)) continue;
    if (TIMESTAMP_FIELD.test(key) && ISO_TIMESTAMP.test(field)) document[key] = new Date(field);
  }
  return document;
}

export function upsertExpression({ set = {}, setOnInsert = {} } = {}, { keyNames = ["_id"] } = {}) {
  const names = {};
  const values = {};
  const clauses = [];
  let nameCount = 0;
  let valueCount = 0;
  const name = (field) => {
    const placeholder = `#f${nameCount++}`;
    names[placeholder] = field;
    return placeholder;
  };
  const value = (fieldValue) => {
    const placeholder = `:v${valueCount++}`;
    values[placeholder] = toItem(fieldValue);
    return placeholder;
  };
  for (const [field, fieldValue] of Object.entries(set)) {
    if (keyNames.includes(field) || fieldValue === undefined) continue;
    clauses.push(`${name(field)} = ${value(fieldValue)}`);
  }
  // An upsert writes fields, not a whole document, so it records the date
  // fields among them; without that the item would be read by guessing.
  const dateFields = [];
  for (const [field, fieldValue] of [...Object.entries(set), ...Object.entries(setOnInsert)]) {
    if (keyNames.includes(field) || fieldValue === undefined) continue;
    collectDates(fieldValue, dateFields, field);
  }
  if (clauses.length) clauses.push(`${name(DATE_FIELDS)} = ${value(dateFields)}`);
  for (const [field, fieldValue] of Object.entries(setOnInsert)) {
    if (keyNames.includes(field) || fieldValue === undefined || field in set) continue;
    const fieldName = name(field);
    clauses.push(`${fieldName} = if_not_exists(${fieldName}, ${value(fieldValue)})`);
  }
  return { clauses, names, values, name, value };
}

export function isConditionFailure(error) {
  return error?.name === "ConditionalCheckFailedException";
}

export function upsertCommandInput(tableName, key, { set = {}, setOnInsert } = {}) {
  const expression = upsertExpression({ set, setOnInsert }, { keyNames: Object.keys(key) });
  if (!expression.clauses.length) return null;
  return {
    TableName: tableName,
    Key: key,
    UpdateExpression: `SET ${expression.clauses.join(", ")}`,
    ExpressionAttributeNames: expression.names,
    ExpressionAttributeValues: expression.values,
  };
}
