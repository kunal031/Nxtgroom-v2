import { withMongoTransaction } from "../config/db.js";
import { dataRoute } from "../config/dynamo.js";
import { incrementMetric } from "../services/telemetry.js";
import { documentCollection, UNIQUE_KEYS_STORE } from "./dynamoDocuments.js";
import { withDynamoTransaction } from "./dynamoTransaction.js";
import { getPath } from "./dynamoFilter.js";

/**
 * The collections that share MongoDB transactions: colleges, boas, users,
 * password_resets, instructors and attendance. Creating a BOA writes the
 * college, the BOA and the login together; a check-in writes the
 * instructor's guard and the attendance record together. A transaction
 * cannot span two databases, so these six switch to DynamoDB as one group,
 * through DB_WRITE_TO_CORE and DB_READ_FROM_CORE.
 *
 * coreCollection(db, name) returns db.collection(name) or its DynamoDB
 * counterpart, and coreTransaction(db) the matching transaction runner, so
 * the routes keep their MongoDB-shaped code.
 */

export const CORE_STORES = Object.freeze([
  "colleges",
  "boas",
  "users",
  "password_resets",
  "instructors",
  "attendance",
]);

// One switch for the whole group: DB_WRITE_TO_CORE / DB_READ_FROM_CORE.
export const CORE_ROUTE_STORE = "core";

const lower = (value) => (value === null || value === undefined ? null : String(value).toLowerCase());
const asKey = (value) => {
  if (value === null || value === undefined || value === "") return undefined;
  return String(value?._bsontype === "ObjectId" ? value.toHexString() : value);
};

/**
 * The clauses of a filter, including the branches of a single $or. The
 * day filters are written as { $or: [{ attendance_day }, { legacy range }] },
 * so the day has to be found inside the branches.
 */
function clausesOf(filter) {
  const clauses = [filter || {}];
  for (const part of filter?.$and || []) clauses.push(...clausesOf(part));
  return clauses;
}

function branchesOf(filter) {
  const branches = [];
  for (const clause of clausesOf(filter)) {
    if (Array.isArray(clause.$or)) branches.push(...clause.$or);
  }
  return branches;
}

/** An equality a filter pins a field to, ignoring idMatch's $in of variants. */
function pinned(filter, field) {
  const condition = clausesOf(filter).map((clause) => clause[field]).find((value) => value !== undefined);
  if (condition === undefined || condition === null) return undefined;
  if (typeof condition === "string") return condition;
  if (condition?._bsontype === "ObjectId") return condition.toHexString();
  if (Array.isArray(condition.$in)) {
    // idMatch names one id twice, as a string and as an ObjectId, and both
    // become the same key here.
    const values = new Set(condition.$in.map(asKey).filter((value) => value !== undefined));
    return values.size === 1 ? [...values][0] : undefined;
  }
  return undefined;
}

/** A $gte/$lt range a filter pins a date field to, as ISO strings. */
function range(filter, field) {
  const condition = clausesOf(filter).map((clause) => clause[field]).find((value) => value !== undefined);
  if (!condition || typeof condition !== "object" || condition instanceof Date) return null;
  const from = condition.$gte ?? condition.$gt;
  const to = condition.$lte ?? condition.$lt;
  if (from === undefined && to === undefined) return null;
  return {
    from: from instanceof Date ? from.toISOString() : from,
    // $lt is exclusive; DynamoDB's BETWEEN is not, so the extra millisecond
    // is filtered out afterwards by matchesFilter.
    to: to instanceof Date ? to.toISOString() : to,
  };
}

/**
 * The DynamoDB table for each collection: the attributes its indexes are
 * keyed on, which filters those indexes answer, and its unique indexes.
 *
 * include lists the fields an index carries, so a listing whose filter,
 * sort and projection stay within them is answered from the index alone.
 */
export const CORE_DEFINITIONS = Object.freeze({
  colleges: {
    scanOk: true, // tens of rows
    derive: () => ({}),
    indexes: {},
    plan: () => null,
    uniques: [
      { name: "name_location", key: (college) => (college.deleted_at ? null : `${lower(college.name)}|${lower(college.location)}`) },
      { name: "institute_id", key: (college) => asKey(college.institute_id) ?? null },
    ],
  },
  boas: {
    scanOk: true, // hundreds of rows
    derive: (boa) => ({ college_key: asKey(boa.college_id) }),
    indexes: { by_college: { attribute: "college_key" } },
    plan: (filter) => {
      const college = pinned(filter, "college_id");
      return college ? { queries: [{ index: "by_college", key: college }] } : null;
    },
    uniques: [{ name: "employee_id", key: (boa) => (boa.deleted_at ? null : asKey(boa.employee_id) ?? null) }],
  },
  users: {
    scanOk: true, // tens of rows
    derive: (user) => ({ reference_key: asKey(user.reference_id) }),
    indexes: { by_reference: { attribute: "reference_key" } },
    plan: (filter) => {
      const reference = pinned(filter, "reference_id");
      return reference ? { queries: [{ index: "by_reference", key: reference }] } : null;
    },
    // The email is the account: no two users may share one, case ignored.
    uniques: [{ name: "email", key: (user) => lower(user.email) }],
  },
  password_resets: {
    scanOk: true, // one live token per person
    derive: (reset) => ({ token_key: asKey(reset.token_hash), email_key: lower(reset.email) ?? undefined }),
    indexes: { by_token: { attribute: "token_key" }, by_email: { attribute: "email_key" } },
    plan: (filter) => {
      const token = pinned(filter, "token_hash");
      if (token) return { queries: [{ index: "by_token", key: token }] };
      const email = pinned(filter, "email");
      return email ? { queries: [{ index: "by_email", key: lower(email) }] } : null;
    },
    uniques: [
      { name: "email", key: (reset) => lower(reset.email) },
      { name: "token_hash", key: (reset) => asKey(reset.token_hash) ?? null },
    ],
  },
  instructors: {
    // Thousands of rows, and the admin roster lists them all; the listings
    // are answered from by_college, which carries every field they use.
    scanOk: true,
    derive: (instructor) => ({
      college_key: asKey(instructor.college_id) ?? "UNASSIGNED",
      name_key: `${instructor.name ?? ""}\u0000${asKey(instructor._id) ?? ""}`,
      report_token_key: asKey(instructor.report_token),
      instructor_user_key: asKey(instructor.instructor_user_id),
    }),
    indexes: {
      by_college: {
        attribute: "college_key",
        sortAttribute: "name_key",
        include: [
          "name", "college_id", "deleted_at", "role", "instructor_role", "gender", "email",
          "employee_id", "phone_no", "report_token", "face_ids", "instructor_user_id",
          "institute_name", "source", "synced_at", "created_at", "updated_at",
          "reference_photo_key", "face_indexed_at", "instructor_category",
        ],
      },
      by_report_token: { attribute: "report_token_key" },
      by_instructor_user: { attribute: "instructor_user_key" },
    },
    plan: (filter) => {
      const token = pinned(filter, "report_token");
      if (token) return { queries: [{ index: "by_report_token", key: token }] };
      const userId = pinned(filter, "instructor_user_id");
      if (userId) return { queries: [{ index: "by_instructor_user", key: userId }] };
      const college = pinned(filter, "college_id");
      if (college) return { queries: [{ index: "by_college", key: college }] };
      return null;
    },
    uniques: [
      { name: "employee_id", key: (instructor) => (typeof instructor.employee_id === "string" ? instructor.employee_id : null) },
      { name: "report_token", key: (instructor) => (typeof instructor.report_token === "string" ? instructor.report_token : null) },
      { name: "instructor_user_id", key: (instructor) => (typeof instructor.instructor_user_id === "string" ? instructor.instructor_user_id : null) },
    ],
  },
  attendance: {
    // Millions of rows over time: never scanned. Every read goes through a
    // day, an instructor, a college or a photo key.
    scanOk: false,
    derive: (attendance) => {
      const day = attendance.attendance_day
        ?? (attendance.check_in_time || attendance.date
          ? new Date(attendance.check_in_time || attendance.date).toISOString().slice(0, 10)
          : undefined);
      const at = attendance.date || attendance.check_in_time;
      const dateKey = at ? new Date(at).toISOString() : undefined;
      const instructor = asKey(attendance.instructor_id);
      return {
        day_key: day,
        date_key: dateKey,
        instructor_key: instructor,
        checkin_at_key: attendance.check_in_time ? new Date(attendance.check_in_time).toISOString() : dateKey,
        college_key: asKey(attendance.college_id) ?? "UNASSIGNED",
        // Only while unidentified, so the queue reads a short index.
        unidentified_key: instructor === undefined && attendance.status === "unidentified"
          ? (asKey(attendance.college_id) ?? "UNASSIGNED")
          : undefined,
        checkin_photo_key: asKey(attendance.check_in_photo_key),
        checkout_photo_key: asKey(attendance.check_out_photo_key),
        evaluation_outbox_key: attendance._private_evaluation_outbox ? "PENDING" : undefined,
        checkin_outbox_key: attendance._private_checkin_outbox ? "PENDING" : undefined,
        checkout_outbox_key: attendance._private_checkout_outbox ? "PENDING" : undefined,
        outbox_created_key: getPath(attendance, "_private_evaluation_outbox.created_at")
          ? new Date(attendance._private_evaluation_outbox.created_at).toISOString()
          : undefined,
        checkin_outbox_created_key: getPath(attendance, "_private_checkin_outbox.created_at")
          ? new Date(attendance._private_checkin_outbox.created_at).toISOString()
          : undefined,
        checkout_outbox_created_key: getPath(attendance, "_private_checkout_outbox.created_at")
          ? new Date(attendance._private_checkout_outbox.created_at).toISOString()
          : undefined,
      };
    },
    indexes: {
      by_day: { attribute: "day_key", sortAttribute: "date_key" },
      by_instructor: { attribute: "instructor_key", sortAttribute: "checkin_at_key" },
      by_college: { attribute: "college_key", sortAttribute: "date_key" },
      unidentified: { attribute: "unidentified_key", sortAttribute: "checkin_at_key" },
      by_checkin_photo: { attribute: "checkin_photo_key" },
      by_checkout_photo: { attribute: "checkout_photo_key" },
      evaluation_outbox: { attribute: "evaluation_outbox_key", sortAttribute: "outbox_created_key" },
      checkin_outbox: { attribute: "checkin_outbox_key", sortAttribute: "checkin_outbox_created_key" },
      checkout_outbox: { attribute: "checkout_outbox_key", sortAttribute: "checkout_outbox_created_key" },
    },
    plan: (filter) => {
      const instructor = pinned(filter, "instructor_id");
      if (instructor) {
        const window = range(filter, "check_in_time");
        return { queries: [{ index: "by_instructor", key: instructor, from: window?.from, to: window?.to }] };
      }
      const instructors = clausesOf(filter).map((clause) => clause.instructor_id?.$in).find(Array.isArray);
      if (instructors?.length && instructors.length <= MAX_KEY_FANOUT && instructors.every((id) => asKey(id))) {
        const keys = [...new Set(instructors.map(asKey))];
        return { queries: keys.map((key) => ({ index: "by_instructor", key })) };
      }
      // The orphan scan asks for one photo key in either half:
      // { $or: [{ check_in_photo_key }, { check_out_photo_key }] }.
      const photoQueries = [];
      for (const [field, index] of [
        ["check_in_photo_key", "by_checkin_photo"],
        ["check_out_photo_key", "by_checkout_photo"],
      ]) {
        for (const clause of [filter, ...branchesOf(filter)]) {
          const key = pinned(clause, field);
          if (key) photoQueries.push({ index, key });
        }
      }
      if (photoQueries.length) return { queries: photoQueries };
      for (const [field, index] of [
        ["_private_evaluation_outbox", "evaluation_outbox"],
        ["_private_checkin_outbox", "checkin_outbox"],
        ["_private_checkout_outbox", "checkout_outbox"],
      ]) {
        if (filter?.[field]?.$exists === true) return { queries: [{ index, key: "PENDING" }] };
      }
      // A day, or a range of days, of one college or of every college.
      // The day may sit inside the $or that also allows the legacy
      // check_in_time range for records written before attendance_day.
      const college = pinned(filter, "college_id");
      const day = pinned(filter, "attendance_day")
        ?? branchesOf(filter).map((branch) => branch.attendance_day).find((value) => typeof value === "string");
      if (typeof day === "string") return { queries: [{ index: "by_day", key: day }] };
      const days = clausesOf(filter).map((clause) => clause.attendance_day?.$in).find(Array.isArray);
      if (days?.length && days.length <= MAX_KEY_FANOUT) {
        return { queries: days.map((value) => ({ index: "by_day", key: String(value) })) };
      }
      if (pinned(filter, "status") === "unidentified") {
        return { queries: [{ index: "unidentified", key: college ?? "UNASSIGNED" }] };
      }
      const window = range(filter, "date")
        || range(filter, "check_in_time")
        || branchesOf(filter).map((branch) => range(branch, "check_in_time")).find(Boolean);
      if (college && window?.from && window?.to) {
        return { queries: [{ index: "by_college", key: college, from: window.from, to: window.to }] };
      }
      if (window?.from && window?.to) {
        return { queries: daysBetween(window) };
      }
      // "Everything older than the retention cutoff", the photo purge. It
      // walks whole days backwards from the cutoff, oldest first, taking the
      // days that still hold photographs. Open-ended, so it is answered by
      // a fixed window of days per batch rather than one query.
      if (window?.to && !window.from) {
        const to = new Date(window.to);
        const from = new Date(to);
        from.setUTCDate(from.getUTCDate() - PURGE_WINDOW_DAYS);
        return { queries: daysBetween({ from: from.toISOString(), to: window.to }, { limit: PURGE_WINDOW_DAYS + 1 }) };
      }
      return null;
    },
    uniques: [
      // One attendance per instructor per day, the MongoDB partial unique
      // index. Unidentified records have no instructor and are exempt.
      {
        name: "day",
        key: (attendance) => (typeof attendance.instructor_id === "string" && typeof attendance.attendance_day === "string"
          ? `${attendance.instructor_id}#${attendance.attendance_day}`
          : null),
      },
    ],
  },
});

/** The days a date range covers, for fanning a range out over by_day. */
const MAX_DAY_FANOUT = 45;
// Instructor ids or days a filter may list before it stops being a lookup.
const MAX_KEY_FANOUT = 40;
// Days of history one photo-purge batch looks back over. The purge runs
// daily and clears the photo keys it handles, so each run only has to reach
// the oldest day still holding photographs, not the whole archive.
const PURGE_WINDOW_DAYS = 40;
function daysBetween({ from, to }, { limit = MAX_DAY_FANOUT, index = "by_day" } = {}) {
  if (!from || !to) throw new Error("attendance: an open-ended date range has no DynamoDB index");
  const days = [];
  for (let at = new Date(from); at <= new Date(to); at.setUTCDate(at.getUTCDate() + 1)) {
    days.push({ index, key: at.toISOString().slice(0, 10) });
    if (days.length > limit) {
      throw new Error(`attendance: a range of more than ${limit} days has no DynamoDB index`);
    }
  }
  return days;
}

const collections = new Map();

export function dynamoCoreCollection(store) {
  if (!CORE_DEFINITIONS[store]) throw new Error(`Unknown core store: ${store}`);
  if (!collections.has(store)) {
    collections.set(store, documentCollection({ store, ...CORE_DEFINITIONS[store] }));
  }
  return collections.get(store);
}

/** The whole-document operations mirroring needs, on a MongoDB collection. */
function mongoDocuments(collection) {
  return {
    getDocument: (id) => collection.findOne({ _id: id }),
    putDocument: (document) => collection.replaceOne({ _id: document._id }, document, { upsert: true }),
    deleteDocument: (id) => collection.deleteOne({ _id: id }),
    findIds: async (filter) => (await collection.find(filter, { projection: { _id: 1 } }).toArray())
      .map((document) => document._id),
  };
}

const READ_ONLY = ["findOne", "find", "countDocuments", "distinct", "aggregate"];
const WRITES = ["insertOne", "updateOne", "updateMany", "findOneAndUpdate", "deleteOne", "deleteMany", "bulkWrite", "replaceOne"];

/**
 * Reads from the primary; writes to the primary, then copies each changed
 * document to the other database. Copying the result rather than running
 * each write twice keeps generated ids and any read-modify-write identical
 * in both. A failed copy is logged and counted, never shown to the user:
 * the compare script finds and repairs the difference.
 *
 * Inside a transaction nothing is mirrored, because nothing is committed
 * until the transaction ends; mirrorTransaction does it afterwards.
 */
function mirrored(store, primary, primaryDocuments, shadowDocuments, shadowName, pending) {
  const handler = {};
  for (const call of READ_ONLY) handler[call] = (...args) => primary[call](...args);
  for (const call of WRITES) {
    handler[call] = async (...args) => {
      const [filter] = args;
      const session = args.find((argument) => argument && typeof argument === "object" && argument.session)?.session;
      const before = call === "insertOne" ? [] : await primaryDocuments.findIds(filter).catch(() => []);
      const result = await primary[call](...args);
      const ids = new Set(before.map(String));
      if (result?.insertedId !== undefined) ids.add(String(result.insertedId));
      if (result?.upsertedId !== undefined) ids.add(String(result.upsertedId));
      if (filter?._id !== undefined && typeof filter._id !== "object") ids.add(String(filter._id));
      if (session) pending.add(store, ids);
      else await copy(store, ids, primaryDocuments, shadowDocuments, shadowName);
      return result;
    };
  }
  return handler;
}

async function copy(store, ids, primaryDocuments, shadowDocuments, shadowName) {
  for (const id of ids) {
    try {
      const document = await primaryDocuments.getDocument(id);
      if (document) await shadowDocuments.putDocument(document);
      else await shadowDocuments.deleteDocument(id);
    } catch (error) {
      incrementMetric(`shadow_write_failed_${shadowName}`);
      console.error(JSON.stringify({
        event: "shadow_write_failed",
        database: shadowName,
        store,
        id: String(id),
        error: String(error?.name || "Error"),
        message: String(error?.message || "").slice(0, 200),
      }));
    }
  }
}

/** Documents a transaction changed, copied once it has committed. */
function createPending() {
  const byStore = new Map();
  return {
    add(store, ids) {
      const existing = byStore.get(store) || new Set();
      for (const id of ids) existing.add(id);
      byStore.set(store, existing);
    },
    entries: () => [...byStore.entries()],
    clear: () => byStore.clear(),
  };
}

const pendingMirrors = createPending();

export function coreCollection(db, store) {
  const { writeTo, readFrom } = dataRoute(CORE_ROUTE_STORE);
  if (writeTo === "mongo") return db.collection(store);
  const dynamo = dynamoCoreCollection(store);
  if (writeTo === "dynamo") return dynamo;
  const mongo = db.collection(store);
  return readFrom === "dynamo"
    ? mirrored(store, dynamo, dynamo, mongoDocuments(mongo), "mongo", pendingMirrors)
    : mirrored(store, mongo, mongoDocuments(mongo), dynamo, "dynamo", pendingMirrors);
}

/** withMongoTransaction, or its DynamoDB counterpart, as the switches say. */
export function coreTransaction(db) {
  const { writeTo, readFrom } = dataRoute(CORE_ROUTE_STORE);
  if (writeTo === "mongo") return withMongoTransaction;
  const runner = readFrom === "dynamo" || writeTo === "dynamo" ? withDynamoTransaction : withMongoTransaction;
  if (writeTo !== "both") return runner;
  // Both: commit on the primary, then copy what changed to the other.
  return async (work) => {
    pendingMirrors.clear();
    const result = await runner(work);
    const entries = pendingMirrors.entries();
    pendingMirrors.clear();
    for (const [store, ids] of entries) {
      const primary = readFrom === "dynamo" ? dynamoCoreCollection(store) : mongoDocuments(db.collection(store));
      const shadow = readFrom === "dynamo" ? mongoDocuments(db.collection(store)) : dynamoCoreCollection(store);
      await copy(store, ids, primary, shadow, readFrom === "dynamo" ? "mongo" : "dynamo");
    }
    return result;
  };
}

export function isCoreStore(name) {
  return CORE_STORES.includes(name);
}

export { UNIQUE_KEYS_STORE };
