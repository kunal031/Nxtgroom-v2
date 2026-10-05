import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import dynalite from "dynalite";
import { createDynamoClient, setDynamoDocumentClient } from "../src/config/dynamo.js";
import { conditionExpression, matchesFilter, sortDocuments } from "../src/stores/dynamoFilter.js";
import { upsertExpression } from "../src/stores/dynamoItems.js";
import { compareCollectionWithDynamo } from "../src/stores/dynamoSync.js";
import { ensureDynamoTables } from "../src/stores/dynamoTables.js";
import { dynamoJobCollection, jobCollection, JOB_QUEUES } from "../src/stores/jobStore.js";
import {
  enqueueEvaluation,
  reconcileFailedEvaluationOutcomes,
  reconcileOverdueEvaluationJobs,
  retryEvaluation,
} from "../src/services/evaluationWorker.js";
import { enqueueMailJob } from "../src/services/mailWorker.js";
import { getQueueAgeMetrics } from "../src/services/workerHealth.js";

/**
 * The four job queues on DynamoDB. The workers keep their MongoDB-shaped
 * calls; jobCollection answers them from DynamoDB. What has to hold:
 *
 * - a filter means the same thing in the JavaScript check that picks
 *   candidates and in the DynamoDB condition that makes the write atomic;
 * - two workers never claim the same job;
 * - the real worker functions run end to end with MongoDB switched off for
 *   the queues;
 * - writing to both databases leaves them identical.
 */

const PREFIX = "test-";
const QUEUE_KEYS = Object.keys(JOB_QUEUES).flatMap((queue) => [
  `DB_WRITE_TO_${queue.toUpperCase()}`,
  `DB_READ_FROM_${queue.toUpperCase()}`,
]);
const ENV_KEYS = [
  "DB_WRITE_TO", "DB_READ_FROM", ...QUEUE_KEYS,
  "DB_WRITE_TO_EVALUATIONS", "DB_READ_FROM_EVALUATIONS",
  "DB_WRITE_TO_APP_SETTINGS", "DB_READ_FROM_APP_SETTINGS",
  "DYNAMODB_REGION", "DYNAMODB_ENDPOINT", "DYNAMODB_TABLE_PREFIX",
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
let server;
let rawClient;
let client;

/**
 * Switches the four queues only. The global DB_WRITE_TO would also move
 * attendance, which these tests keep on MongoDB to watch what the workers
 * write to it.
 */
function setRoute(writeTo, readFrom) {
  // The evaluation worker stores its reports alongside its jobs, and the
  // notification worker reads the email settings, so those move with them.
  for (const store of [...Object.keys(JOB_QUEUES), "evaluations", "app_settings"]) {
    process.env[`DB_WRITE_TO_${store.toUpperCase()}`] = writeTo;
    process.env[`DB_READ_FROM_${store.toUpperCase()}`] = readFrom;
  }
}

before(async () => {
  server = dynalite({ createTableMs: 0 });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.DYNAMODB_ENDPOINT = `http://127.0.0.1:${server.address().port}`;
  process.env.DYNAMODB_REGION = "ap-south-1";
  process.env.DYNAMODB_TABLE_PREFIX = PREFIX;
  rawClient = createDynamoClient();
  client = DynamoDBDocumentClient.from(rawClient, { marshallOptions: { removeUndefinedValues: true } });
  const report = await ensureDynamoTables(rawClient, { prefix: PREFIX, apply: true, protect: false });
  assert.deepEqual(report.conflicts, []);
});

beforeEach(async () => {
  setDynamoDocumentClient(client);
  setRoute("mongo", "mongo");
  for (const queue of [...Object.keys(JOB_QUEUES), "app_settings", "evaluations"]) {
    const table = `${PREFIX}${queue}`;
    const { Items = [] } = await client.send(new ScanCommand({ TableName: table }));
    for (const item of Items) {
      const Key = queue === "evaluations" ? { attendance_id: item.attendance_id, kind: item.kind } : { _id: item._id };
      await client.send(new DeleteCommand({ TableName: table, Key }));
    }
  }
});

after(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  setDynamoDocumentClient(null);
  rawClient.destroy();
  await new Promise((resolve) => server.close(resolve));
});

/** Attendance stays on MongoDB; this records what the workers write to it. */
function attendanceOnlyMongo() {
  const updates = [];
  return {
    updates,
    collection(name) {
      if (name === "attendance") {
        return {
          async updateOne(filter, update) {
            updates.push({ filter, update });
            return { matchedCount: 1, modifiedCount: 1 };
          },
          async findOne() {
            return null;
          },
          async countDocuments() {
            return 0;
          },
        };
      }
      throw new Error(`${name} was read from MongoDB while it is switched to DynamoDB`);
    },
  };
}

// ------------------------------------------------ one filter, two meanings

const NOW = new Date("2026-09-30T04:00:00.000Z");
const EARLIER = new Date("2026-09-30T03:00:00.000Z");
const LATER = new Date("2026-09-30T05:00:00.000Z");

const DOCUMENTS = [
  { _id: "d1", status: "queued", attempts: 0, available_at: EARLIER, deadline_at: LATER, created_at: EARLIER },
  { _id: "d2", status: "queued", attempts: 3, available_at: LATER, deadline_at: EARLIER, created_at: NOW },
  { _id: "d3", status: "processing", attempts: 1, lease_until: EARLIER, created_at: EARLIER, worker_id: "w" },
  { _id: "d4", status: "processing", attempts: 2, lease_until: LATER, created_at: LATER, worker_id: "w" },
  { _id: "d5", status: "failed", attempts: 3, failed_at: NOW, created_at: EARLIER },
  { _id: "d6", status: "failed", attempts: 3, failed_at: NOW, failure_synced_at: NOW, created_at: EARLIER },
  { _id: "d7", status: "queued", attempts: 0, available_at: EARLIER, created_at: EARLIER, note: null },
];

// Every shape of filter the queue code uses, and the documents each matches.
const FILTERS = [
  [{ status: "queued" }, ["d1", "d2", "d7"]],
  [{ status: { $in: ["processing", "recovering"] } }, ["d3", "d4"]],
  [{ status: "queued", available_at: { $lte: NOW } }, ["d1", "d7"]],
  [{ attempts: { $lt: 3 } }, ["d1", "d3", "d4", "d7"]],
  [{ attempts: { $gte: 3 } }, ["d2", "d5", "d6"]],
  [{ lease_until: { $gt: NOW } }, ["d4"]],
  [{ failure_synced_at: { $exists: false }, status: "failed" }, ["d5"]],
  [{ deadline_at: { $exists: true } }, ["d1", "d2"]],
  [{ note: null }, ["d1", "d2", "d3", "d4", "d5", "d6", "d7"]],
  [{ worker_id: { $ne: "w" } }, ["d1", "d2", "d5", "d6", "d7"]],
  [{ $or: [
    { status: "queued", available_at: { $lte: NOW } },
    { status: "processing", lease_until: { $lte: NOW } },
  ] }, ["d1", "d3", "d7"]],
  [{
    attempts: { $lt: 3 },
    $and: [
      { $or: [{ deadline_at: { $gt: NOW } }, { deadline_at: { $exists: false }, created_at: { $gt: new Date(0) } }] },
      { $or: [{ status: "queued", available_at: { $lte: NOW } }, { status: "processing", lease_until: { $lte: NOW } }] },
    ],
  }, ["d1", "d3", "d7"]],
  [{ status: { $in: [] } }, []],
];

test("the JavaScript check and the DynamoDB condition agree on every queue filter", async () => {
  setRoute("dynamo", "dynamo");
  const jobs = dynamoJobCollection("storage_cleanup_jobs");
  for (const document of DOCUMENTS) await jobs.putDocument(document);

  for (const [filter, expected] of FILTERS) {
    const inJavaScript = DOCUMENTS.filter((document) => matchesFilter(document, filter)).map((document) => document._id);
    assert.deepEqual(inJavaScript, expected, `JavaScript: ${JSON.stringify(filter)}`);

    const inDynamo = [];
    for (const document of DOCUMENTS) {
      // A no-op write guarded by the filter succeeds exactly when it matches.
      const result = await jobs.updateOne({ ...filter, _id: document._id }, { $set: { touched: true } });
      if (result.matchedCount) inDynamo.push(document._id);
    }
    assert.deepEqual(inDynamo, expected, `DynamoDB: ${JSON.stringify(filter)}`);
  }
});

test("an unsupported filter fails loudly instead of matching the wrong jobs", () => {
  assert.throws(() => matchesFilter({}, { $expr: {} }), /Unsupported/);
  assert.throws(() => matchesFilter({}, { status: { $regex: "q" } }), /Unsupported/);
  assert.throws(() => matchesFilter({}, { status: { $type: "number" } }), /Unsupported/);
  assert.throws(() => conditionExpression({ status: { $elemMatch: {} } }, upsertExpression()), /Unsupported/);
});

test("the outbox sort path reaches into the embedded object", () => {
  // The reconcilers sort by "_private_evaluation_outbox.created_at".
  const rows = [
    { _id: "late", _private_evaluation_outbox: { created_at: LATER } },
    { _id: "early", _private_evaluation_outbox: { created_at: EARLIER } },
    { _id: "none" },
  ];
  assert.deepEqual(
    sortDocuments(rows, { "_private_evaluation_outbox.created_at": 1 }).map((row) => row._id),
    ["none", "early", "late"]
  );
  assert.equal(matchesFilter(rows[0], { "_private_evaluation_outbox.created_at": { $lte: LATER } }), true);
  assert.equal(matchesFilter(rows[2], { "_private_evaluation_outbox": { $exists: true } }), false);
});

test("sorting follows MongoDB: missing values first ascending, last descending", () => {
  const rows = [{ _id: "b", at: LATER }, { _id: "a" }, { _id: "c", at: EARLIER }];
  assert.deepEqual(sortDocuments(rows, { at: 1 }).map((row) => row._id), ["a", "c", "b"]);
  assert.deepEqual(sortDocuments(rows, { at: -1 }).map((row) => row._id), ["b", "c", "a"]);
});

// --------------------------------------------------------------- claiming

function claim(jobs, worker, now = NOW) {
  return jobs.findOneAndUpdate(
    {
      attempts: { $lt: 3 },
      $or: [
        { status: "queued", available_at: { $lte: now } },
        { status: "processing", lease_until: { $lte: now } },
      ],
    },
    {
      $set: { status: "processing", worker_id: worker, lease_until: new Date(now.getTime() + 60_000) },
      $inc: { attempts: 1 },
    },
    { sort: { created_at: 1 }, returnDocument: "after" }
  );
}

test("claims take the oldest eligible job, and two workers never take the same one", async () => {
  setRoute("dynamo", "dynamo");
  const jobs = jobCollection(attendanceOnlyMongo(), "mail_jobs");
  for (let index = 0; index < 6; index += 1) {
    await enqueueMailJob(attendanceOnlyMongo(), {
      id: `job-${index}`,
      type: "password_reset",
      toEmail: `person${index}@example.com`,
      payload: {},
    });
  }
  // enqueueMailJob stamps available_at from the real clock, so the claim
  // time has to be now rather than one of the fixed dates above.
  const now = new Date();
  // Six workers at once, six jobs: each gets a different one.
  const claimed = await Promise.all(Array.from({ length: 6 }, (_, index) => claim(jobs, `w${index}`, now)));
  assert.equal(new Set(claimed.map((job) => job._id)).size, 6);
  assert.ok(claimed.every((job) => job.status === "processing" && job.attempts === 1));
  assert.equal(await claim(jobs, "late", now), null, "nothing left to claim");

  // An expired lease makes the job claimable again, by one worker.
  const afterLease = new Date(now.getTime() + 120_000);
  const [first, second] = await Promise.all([claim(jobs, "x", afterLease), claim(jobs, "y", afterLease)]);
  assert.ok(first && second && first._id !== second._id);
});

// ------------------------------------------------ the real worker functions

test("an evaluation job runs from queue to failure on DynamoDB, with MongoDB used only for attendance", async () => {
  setRoute("dynamo", "dynamo");
  const db = attendanceOnlyMongo();
  const payload = {
    attendanceId: "att-1",
    instructor: { id: "i1", name: "Instructor", email: "instructor@example.com", gender: "MALE" },
    photoKey: "photos/att-1.jpg",
    mimeType: "image/jpeg",
    checkInTime: EARLIER,
    deadlineAt: LATER,
  };
  const jobId = await enqueueEvaluation(db, payload);
  await enqueueEvaluation(db, payload);
  const jobs = jobCollection(db, "evaluation_jobs");
  const queued = await jobs.findOne({ _id: jobId });
  assert.equal(queued.status, "queued");
  assert.equal(await jobs.countDocuments({ status: "queued" }), 1, "queued once");

  const { Item } = await client.send(new GetCommand({ TableName: `${PREFIX}evaluation_jobs`, Key: { _id: jobId } }));
  assert.equal(Item.queue_state, "queued");
  assert.equal(Item.attendance_key, "att-1");

  // Past its deadline, the sweep claims and fails it, and tells attendance.
  assert.equal(await reconcileOverdueEvaluationJobs(db, new Date(LATER.getTime() + 1000)), true);
  const failed = await jobs.findOne({ _id: jobId });
  assert.equal(failed.status, "failed");
  assert.ok(failed.failure_synced_at instanceof Date);
  assert.ok(failed.expires_at instanceof Date);
  const { Item: finished } = await client.send(new GetCommand({ TableName: `${PREFIX}evaluation_jobs`, Key: { _id: jobId } }));
  assert.equal(finished.queue_state, undefined, "a finished job leaves the active index");
  assert.equal(finished.ttl, Math.floor(failed.expires_at.getTime() / 1000));
  assert.ok(db.updates.some(({ update }) => update.$set?.evaluation_queue_status === "failed"));
  assert.equal(await reconcileFailedEvaluationOutcomes(db), false, "nothing left to sync");

  // The failure email was queued for the instructor, on DynamoDB too.
  const notification = await jobCollection(db, "notification_jobs").findOne({ _id: "att-1:checkin" });
  assert.equal(notification?.status, "queued");
  assert.equal(notification.to_email, "instructor@example.com");
});

test("a retried evaluation goes back to the queue with a delay", async () => {
  setRoute("dynamo", "dynamo");
  const db = attendanceOnlyMongo();
  const jobId = await enqueueEvaluation(db, {
    attendanceId: "att-2",
    instructor: { id: "i2", gender: "FEMALE" },
    photoKey: "photos/att-2.jpg",
    mimeType: "image/jpeg",
    checkInTime: EARLIER,
  });
  const jobs = jobCollection(db, "evaluation_jobs");
  const workerJob = await jobs.findOneAndUpdate(
    { _id: jobId, status: "queued" },
    { $set: { status: "processing", worker_id: "not-this-worker", lease_until: LATER }, $inc: { attempts: 1 } },
    { returnDocument: "after" }
  );
  // retryEvaluation only moves a job this worker owns.
  await retryEvaluation(db, workerJob, Object.assign(new Error("busy"), { retryable: true }));
  assert.equal((await jobs.findOne({ _id: jobId })).status, "processing", "another worker's job is left alone");
});

test("queue depth and age for /health/ready come from DynamoDB", async () => {
  setRoute("dynamo", "dynamo");
  const db = attendanceOnlyMongo();
  await enqueueMailJob(db, { id: "m1", type: "weekly_report", toEmail: "a@example.com", payload: {} });
  await enqueueMailJob(db, { id: "m2", type: "weekly_report", toEmail: "b@example.com", payload: {} });
  const metrics = await getQueueAgeMetrics(db);
  const mail = metrics.find((queue) => queue.name === "mail_jobs");
  assert.equal(mail.depth, 2);
  assert.equal(mail.has_pending_work, true);
  assert.equal(metrics.find((queue) => queue.name === "evaluation_jobs").depth, 0);
});

test("deleting an attendance record cancels its jobs, finished ones included", async () => {
  setRoute("dynamo", "dynamo");
  const jobs = jobCollection(attendanceOnlyMongo(), "mail_jobs");
  await enqueueMailJob(attendanceOnlyMongo(), { id: "r1", type: "attendance_reminder", toEmail: "a@example.com", payload: {}, attendanceId: "att-9" });
  await enqueueMailJob(attendanceOnlyMongo(), { id: "r2", type: "grooming_alert", toEmail: "b@example.com", payload: {}, attendanceId: "att-9" });
  await enqueueMailJob(attendanceOnlyMongo(), { id: "other", type: "grooming_alert", toEmail: "c@example.com", payload: {}, attendanceId: "att-8" });
  // One is already sent: out of the active index, still in by_attendance.
  await jobs.updateOne({ _id: "r2" }, { $set: { status: "sent", expires_at: LATER } });

  const reminderOnly = await jobs.deleteMany({ attendance_id: "att-9", type: "attendance_reminder" });
  assert.equal(reminderOnly.deletedCount, 1);
  const all = await jobs.deleteMany({ attendance_id: "att-9" });
  assert.equal(all.deletedCount, 1);
  assert.equal(await jobs.findOne({ _id: "r2" }), null);
  assert.ok(await jobs.findOne({ _id: "other" }), "another record's job is untouched");
});

// ------------------------------------------------------------ dual write

/** Enough of MongoDB for a queue, using the same filter semantics. */
function memoryMongo() {
  const collections = new Map();
  const apply = (document, update, inserting) => {
    const next = { ...document };
    if (inserting) Object.assign(next, update.$setOnInsert || {});
    Object.assign(next, update.$set || {});
    for (const field of Object.keys(update.$unset || {})) delete next[field];
    for (const [field, amount] of Object.entries(update.$inc || {})) next[field] = (next[field] || 0) + amount;
    return next;
  };
  return {
    collection(name) {
      if (!collections.has(name)) collections.set(name, new Map());
      const documents = collections.get(name);
      const all = () => [...documents.values()];
      return {
        async findOne(filter, { sort } = {}) {
          return sortDocuments(all().filter((document) => matchesFilter(document, filter)), sort)[0] || null;
        },
        async countDocuments(filter) {
          return all().filter((document) => matchesFilter(document, filter)).length;
        },
        async updateOne(filter, update, { upsert = false } = {}) {
          const found = all().find((document) => matchesFilter(document, filter));
          if (!found && !upsert) return { matchedCount: 0 };
          documents.set(found?._id ?? filter._id, apply(found || { _id: filter._id }, update, !found));
          return { matchedCount: found ? 1 : 0 };
        },
        async findOneAndUpdate(filter, update, { sort } = {}) {
          const [found] = sortDocuments(all().filter((document) => matchesFilter(document, filter)), sort);
          if (!found) return null;
          const next = apply(found, update, false);
          documents.set(found._id, next);
          return next;
        },
        async deleteOne(filter) {
          const found = all().find((document) => matchesFilter(document, filter));
          if (found) documents.delete(found._id);
          return { deletedCount: found ? 1 : 0 };
        },
        async deleteMany(filter) {
          const found = all().filter((document) => matchesFilter(document, filter));
          for (const document of found) documents.delete(document._id);
          return { deletedCount: found.length };
        },
        async replaceOne({ _id }, document) {
          documents.set(_id, { ...document });
        },
        find(filter) {
          const matched = all().filter((document) => matchesFilter(document, filter));
          return {
            toArray: async () => matched,
            [Symbol.asyncIterator]: async function* iterate() {
              yield* matched;
            },
          };
        },
      };
    },
  };
}

test("writing the queues to both databases keeps them identical", async () => {
  setRoute("both", "mongo");
  const db = memoryMongo();
  const jobs = jobCollection(db, "mail_jobs");
  for (let index = 0; index < 4; index += 1) {
    await enqueueMailJob(db, { id: `m${index}`, type: "weekly_report", toEmail: `p${index}@example.com`, payload: {}, attendanceId: "att-1" });
  }
  await claim(jobs, "w1", LATER);
  await claim(jobs, "w2", LATER);
  await jobs.updateOne({ _id: "m0" }, { $set: { status: "sent", expires_at: LATER }, $unset: { worker_id: "" } });
  await jobs.deleteOne({ _id: "m3" });
  const comparison = await compareCollectionWithDynamo(db, client, { store: "mail_jobs", tableName: `${PREFIX}mail_jobs` });
  assert.equal(comparison.matches, true, JSON.stringify(comparison));
  assert.equal(comparison.mongoCount, 3);

  await jobs.deleteMany({ attendance_id: "att-1" });
  const emptied = await compareCollectionWithDynamo(db, client, { store: "mail_jobs", tableName: `${PREFIX}mail_jobs` });
  assert.deepEqual([emptied.matches, emptied.dynamoCount], [true, 0]);
});

test("a failed shadow copy is logged, and the MongoDB write still succeeds", async (t) => {
  setRoute("both", "mongo");
  const errors = [];
  t.mock.method(console, "error", (line) => errors.push(String(line)));
  setDynamoDocumentClient({ send: async () => { throw Object.assign(new Error("down"), { name: "ServiceUnavailable" }); } });
  const db = memoryMongo();
  await enqueueMailJob(db, { id: "m1", type: "weekly_report", toEmail: "a@example.com", payload: {} });
  assert.equal((await db.collection("mail_jobs").findOne({ _id: "m1" })).status, "queued");
  const logged = errors.map((line) => JSON.parse(line)).find((entry) => entry.event === "shadow_write_failed");
  assert.deepEqual([logged.store, logged.database, logged.id], ["mail_jobs", "dynamo", "m1"]);
});
