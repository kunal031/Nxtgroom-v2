import { dataRoute, dynamoTableName } from "../config/dynamo.js";
import { incrementMetric } from "../services/telemetry.js";
import { dynamoCollection } from "./dynamoCollection.js";

/**
 * The four durable job queues: evaluation_jobs, notification_jobs,
 * mail_jobs and storage_cleanup_jobs.
 *
 * jobCollection(db, name) returns something that answers the same calls as
 * db.collection(name), so the workers keep their MongoDB-shaped code:
 *
 *   DB_WRITE_TO=mongo   the MongoDB collection itself, exactly as before
 *   DB_WRITE_TO=dynamo  the DynamoDB table
 *   DB_WRITE_TO=both    the database reads come from does the work; after
 *                       each change the resulting job is copied to the other
 *
 * Copying the result, rather than running each change twice, matters for a
 * queue: two databases each choosing "the oldest eligible job" could choose
 * different ones, and the copies would drift apart.
 */

// A job is "active" while a worker or a sweep may still look for it by
// status. Only active jobs are in the index those lookups read, so the
// thousands of finished jobs kept for a week are never scanned.
const TERMINAL_NOTIFICATION = new Set(["sent", "failed", "delivery_unknown"]);

export const JOB_QUEUES = Object.freeze({
  evaluation_jobs: {
    states: ["queued", "processing", "recovering", "failed_unsynced"],
    state: (job) => {
      if (["queued", "processing", "recovering"].includes(job.status)) return job.status;
      if (job.status === "failed" && job.failure_synced_at === undefined) return "failed_unsynced";
      return undefined;
    },
  },
  notification_jobs: {
    states: ["queued", "processing", "terminal_unsynced"],
    state: (job) => {
      if (["queued", "processing"].includes(job.status)) return job.status;
      if (TERMINAL_NOTIFICATION.has(job.status) && job.attendance_synced_at === undefined) return "terminal_unsynced";
      return undefined;
    },
  },
  mail_jobs: {
    states: ["queued", "processing"],
    state: (job) => (["queued", "processing"].includes(job.status) ? job.status : undefined),
  },
  storage_cleanup_jobs: {
    states: ["queued", "processing"],
    state: (job) => (["queued", "processing"].includes(job.status) ? job.status : undefined),
  },
});

export const JOB_INDEXES = Object.freeze({
  active: { indexName: "active", attribute: "queue_state" },
  byAttendance: { indexName: "by_attendance", attribute: "attendance_key" },
});

/**
 * Attributes DynamoDB needs that MongoDB does not store: the active state,
 * the attendance id as a string (an index key cannot be null), and `ttl`,
 * the epoch-seconds form of expires_at that DynamoDB's expiry reads.
 */
export function jobDerivedAttributes(queue, job) {
  const expiresAt = job.expires_at ? new Date(job.expires_at) : null;
  const attendanceId = job.attendance_id;
  return {
    queue_state: JOB_QUEUES[queue].state(job),
    attendance_key: attendanceId === null || attendanceId === undefined || attendanceId === ""
      ? undefined
      : String(attendanceId?._bsontype === "ObjectId" ? attendanceId.toHexString() : attendanceId),
    ttl: expiresAt && !Number.isNaN(expiresAt.getTime()) ? Math.floor(expiresAt.getTime() / 1000) : undefined,
  };
}

const dynamoQueues = new Map();

export function dynamoJobCollection(queue) {
  if (!JOB_QUEUES[queue]) throw new Error(`Unknown job queue: ${queue}`);
  if (!dynamoQueues.has(queue)) {
    dynamoQueues.set(queue, dynamoCollection({
      tableName: () => dynamoTableName(queue),
      derive: (job) => jobDerivedAttributes(queue, job),
      active: { ...JOB_INDEXES.active, values: JOB_QUEUES[queue].states },
      byField: { ...JOB_INDEXES.byAttendance, field: "attendance_id" },
    }));
  }
  return dynamoQueues.get(queue);
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

function idOf(filter) {
  const id = filter?._id;
  return typeof id === "string" || id?._bsontype === "ObjectId" ? id : undefined;
}

function mirrored(queue, primary, primaryDocuments, shadowDocuments, shadowName) {
  async function mirror(operation, ids) {
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
          store: queue,
          operation,
          id: String(id),
          error: String(error?.name || "Error"),
          message: String(error?.message || "").slice(0, 200),
        }));
      }
    }
  }
  const idsFor = async (filter) => {
    const id = idOf(filter);
    return id !== undefined ? [id] : primaryDocuments.findIds(filter);
  };
  return {
    findOne: (...args) => primary.findOne(...args),
    countDocuments: (...args) => primary.countDocuments(...args),
    async updateOne(filter, update, options) {
      const ids = await idsFor(filter);
      const result = await primary.updateOne(filter, update, options);
      await mirror("updateOne", ids);
      return result;
    },
    async findOneAndUpdate(filter, update, options) {
      const result = await primary.findOneAndUpdate(filter, update, options);
      const document = result?.value !== undefined ? result.value : result;
      const id = document?._id ?? idOf(filter);
      if (id !== undefined) await mirror("findOneAndUpdate", [id]);
      return result;
    },
    async deleteOne(filter) {
      const ids = (await idsFor(filter)).slice(0, 1);
      const result = await primary.deleteOne(filter);
      await mirror("deleteOne", ids);
      return result;
    },
    async deleteMany(filter) {
      const ids = await idsFor(filter);
      const result = await primary.deleteMany(filter);
      await mirror("deleteMany", ids);
      return result;
    },
  };
}

/** db.collection(queue), or its DynamoDB counterpart, as the switches say. */
export function jobCollection(db, queue) {
  const { writeTo, readFrom } = dataRoute(queue);
  if (writeTo === "mongo") return db.collection(queue);
  const dynamo = dynamoJobCollection(queue);
  if (writeTo === "dynamo") return dynamo;
  const mongo = db.collection(queue);
  return readFrom === "dynamo"
    ? mirrored(queue, dynamo, dynamo, mongoDocuments(mongo), "mongo")
    : mirrored(queue, mongo, mongoDocuments(mongo), dynamo, "dynamo");
}

export function isJobQueue(name) {
  return Object.hasOwn(JOB_QUEUES, name);
}
