import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import dynalite from "dynalite";
import { ObjectId } from "mongodb";
import { createDynamoClient, setDynamoDocumentClient } from "../src/config/dynamo.js";
import { deliverAttendanceReminders } from "../src/routes/reportRoutes.js";
import { compareCollectionWithDynamo, copyCollectionToDynamo } from "../src/stores/dynamoSync.js";
import { ensureDynamoTables } from "../src/stores/dynamoTables.js";
import {
  completeDeliveryRunIfDone,
  recordDeliveryOutcome,
  saveDeliveryRun,
} from "../src/stores/deliveryRunStore.js";
import {
  deleteEvaluation,
  deleteEvaluationsForAttendance,
  failedCheckpointRows,
  getEvaluation,
  saveEvaluation,
} from "../src/stores/evaluationStore.js";

const PREFIX = "test-";
const EVALUATIONS = `${PREFIX}evaluations`;
const RUNS = `${PREFIX}report_delivery_runs`;
const ENV_KEYS = ["DB_WRITE_TO", "DB_READ_FROM", "DYNAMODB_REGION", "DYNAMODB_ENDPOINT", "DYNAMODB_TABLE_PREFIX"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

let server;
let rawClient;
let client;

function setRoute(writeTo, readFrom) {
  process.env.DB_WRITE_TO = writeTo;
  process.env.DB_READ_FROM = readFrom;
}

before(async () => {
  server = dynalite({ createTableMs: 0 });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.DYNAMODB_ENDPOINT = `http://127.0.0.1:${server.address().port}`;
  process.env.DYNAMODB_REGION = "ap-south-1";
  process.env.DYNAMODB_TABLE_PREFIX = PREFIX;
  rawClient = createDynamoClient();
  client = DynamoDBDocumentClient.from(rawClient, { marshallOptions: { removeUndefinedValues: true } });
  await ensureDynamoTables(rawClient, { prefix: PREFIX, apply: true, protect: false });
});

beforeEach(async () => {
  setDynamoDocumentClient(client);
  setRoute("mongo", "mongo");
  delete process.env.DB_WRITE_TO_REPORT_DELIVERY_RUNS;
  delete process.env.DB_READ_FROM_REPORT_DELIVERY_RUNS;
  for (const [table, key] of [[EVALUATIONS, ["attendance_id", "kind"]], [RUNS, ["_id"]]]) {
    const { Items = [] } = await client.send(new ScanCommand({ TableName: table }));
    for (const item of Items) {
      await client.send(new DeleteCommand({
        TableName: table,
        Key: Object.fromEntries(key.map((name) => [name, item[name]])),
      }));
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

const untouchableMongo = {
  collection() {
    throw new Error("MongoDB was used while the store was switched to DynamoDB only");
  },
};

function memoryEvaluations() {
  const documents = [];
  const matches = (document, filter) => Object.entries(filter).every(([field, condition]) => (
    condition && typeof condition === "object" && "$ne" in condition
      ? document[field] !== condition.$ne
      : document[field] === condition
  ));
  return {
    documents,
    collection(name) {
      assert.equal(name, "evaluations");
      return {
        async findOne(filter) {
          const found = documents.find((document) => matches(document, filter));
          return found ? structuredClone(found) : null;
        },
        async updateOne(filter, update, { upsert }) {
          let document = documents.find((candidate) => matches(candidate, filter));
          if (!document && upsert) {
            document = { ...structuredClone(update.$setOnInsert) };
            for (const [field, condition] of Object.entries(filter)) {
              if (typeof condition !== "object") document[field] = condition;
            }
            documents.push(document);
          }
          if (document) Object.assign(document, structuredClone(update.$set));
        },
        async deleteMany(filter) {
          for (let index = documents.length - 1; index >= 0; index -= 1) {
            if (matches(documents[index], filter)) documents.splice(index, 1);
          }
        },
        find() {
          return (async function* all() {
            for (const document of documents) yield { ...document };
          }());
        },
      };
    },
  };
}

function report(kind, { remarks = "ok", failing = [] } = {}) {
  return {
    kind,
    overall_status: failing.length ? "NON_COMPLIANT" : "COMPLIANT",
    ai_summary: remarks,
    grooming_check: [
      { code: "G1", checkpoint_name: "Hair", status: failing.includes("G1") ? "FAIL" : "PASS" },
      { code: "G2", checkpoint_name: "Beard", status: failing.includes("G2") ? "FAIL" : "PASS" },
    ],
    footwear_check: [{ code: "F1", checkpoint_name: "Shoes", status: failing.includes("F1") ? "FAIL" : "PASS" }],
    processed_at: new Date("2026-09-29T03:31:00.000Z"),
  };
}

async function evaluationScenario(db) {
  const first = new Date("2026-09-29T03:31:00.000Z");
  const later = new Date("2026-09-29T12:40:00.000Z");
  const seen = {};
  await saveEvaluation(db, "a1", "checkin", report("checkin", { failing: ["G1"] }), first);
  await saveEvaluation(db, "a1", "checkout", report("checkout", { failing: ["F1"] }), later);
  await saveEvaluation(db, "a2", "checkin", report("checkin"), first);
  seen.a1CheckinId = (await getEvaluation(db, "a1", "checkin"))._id;

  await saveEvaluation(db, "a1", "checkin", report("checkin", { remarks: "re-run", failing: ["G1", "G2"] }), later);
  const rerun = await getEvaluation(db, "a1", "checkin");
  seen.rerunKeptId = rerun._id === seen.a1CheckinId;
  delete seen.a1CheckinId;
  seen.rerun = { ...rerun, _id: undefined };
  seen.checkout = { ...(await getEvaluation(db, "a1", "checkout")), _id: undefined };
  seen.missing = await getEvaluation(db, "a3", "checkin");

  await deleteEvaluation(db, "a1", "checkout");
  seen.afterCheckoutDelete = [
    Boolean(await getEvaluation(db, "a1", "checkin")),
    Boolean(await getEvaluation(db, "a1", "checkout")),
  ];
  await deleteEvaluationsForAttendance(db, "a2");
  seen.afterPurge = await getEvaluation(db, "a2", "checkin");
  return seen;
}

test("the DynamoDB evaluation store gives the same results as the MongoDB one", async () => {
  setRoute("mongo", "mongo");
  const fromMongo = await evaluationScenario(memoryEvaluations());
  setRoute("dynamo", "dynamo");
  const fromDynamo = await evaluationScenario(untouchableMongo);
  assert.deepEqual(fromDynamo, fromMongo);

  assert.equal(fromMongo.rerunKeptId, true, "id set only when first stored");
  assert.equal(fromMongo.rerun.ai_summary, "re-run");
  assert.equal(fromMongo.rerun.created_at.toISOString(), "2026-09-29T03:31:00.000Z");
  assert.equal(fromMongo.checkout.kind, "checkout");
  assert.equal(fromMongo.missing, null);
  assert.deepEqual(fromMongo.afterCheckoutDelete, [true, false], "deleting one half keeps the other");
  assert.equal(fromMongo.afterPurge, null);
});

test("failed checkpoints are read from DynamoDB for the dashboard", async () => {
  setRoute("dynamo", "dynamo");
  await saveEvaluation(untouchableMongo, "a1", "checkin", report("checkin", { failing: ["G1", "G2"] }));
  await saveEvaluation(untouchableMongo, "a1", "checkout", report("checkout", { failing: ["F1"] }));
  await saveEvaluation(untouchableMongo, "a2", "checkin", report("checkin"));

  const rows = await failedCheckpointRows(untouchableMongo, ["a1", "a2", "a3"]);
  const key = (row) => `${row.attendance_id}:${row.kind}:${row.code}`;
  assert.deepEqual(rows.map(key).sort(), ["a1:checkin:G1", "a1:checkin:G2", "a1:checkout:F1"]);
  assert.equal(rows.find((row) => row.code === "F1").name, "Shoes");
  assert.deepEqual(await failedCheckpointRows(untouchableMongo, []), []);
});

test("the dashboard reads more sessions than one DynamoDB batch holds", async () => {
  setRoute("dynamo", "dynamo");
  const ids = Array.from({ length: 120 }, (_, index) => `s${index}`);
  for (const id of ids) await saveEvaluation(untouchableMongo, id, "checkin", report("checkin", { failing: ["G1"] }));
  const rows = await failedCheckpointRows(untouchableMongo, ids);
  assert.equal(rows.length, 120);
});

test("writing evaluations to both databases keeps them identical", async () => {
  setRoute("both", "mongo");
  const mongo = memoryEvaluations();
  await evaluationScenario(mongo);
  const comparison = await compareCollectionWithDynamo(mongo, client, { store: "evaluations", tableName: EVALUATIONS });
  assert.equal(comparison.matches, true, JSON.stringify(comparison));
});

test("copy gives legacy evaluations a kind and a string attendance id", async () => {
  const mongo = memoryEvaluations();
  const legacyAttendance = new ObjectId();
  mongo.documents.push({ _id: "old", attendance_id: legacyAttendance, ai_summary: "legacy" });
  mongo.documents.push({ _id: "new", attendance_id: "a9", kind: "checkout", ai_summary: "current" });
  const options = { store: "evaluations", tableName: EVALUATIONS };

  await copyCollectionToDynamo(mongo, client, { ...options, apply: true });
  const { Item } = await client.send(new GetCommand({
    TableName: EVALUATIONS,
    Key: { attendance_id: legacyAttendance.toHexString(), kind: "checkin" },
  }));
  assert.equal(Item.ai_summary, "legacy");
  assert.equal((await compareCollectionWithDynamo(mongo, client, options)).matches, true);

  setRoute("dynamo", "dynamo");
  assert.equal((await getEvaluation(untouchableMongo, legacyAttendance.toHexString(), "checkin")).ai_summary, "legacy");
});

test("a delivery run counts outcomes and completes only when all are in", async () => {
  setRoute("dynamo", "dynamo");
  const now = new Date("2026-09-29T14:30:00.000Z");
  assert.equal(await recordDeliveryOutcome(untouchableMongo, "missing", "sent", now), null);
  const { Item: absent } = await client.send(new GetCommand({ TableName: RUNS, Key: { _id: "missing" } }));
  assert.equal(absent, undefined, "counting never creates a run");

  await saveDeliveryRun(untouchableMongo, "run", {
    set: { status: "producing" },
    setOnInsert: { sent: 0, failed: 0, terminal: 0, created_at: now },
  });
  const first = await recordDeliveryOutcome(untouchableMongo, "run", "sent", now);
  assert.deepEqual([first.sent, first.terminal], [1, 1]);
  assert.ok(first.updated_at instanceof Date);

  await saveDeliveryRun(untouchableMongo, "run", {
    set: { queued: 2, status: "queued" },
    setOnInsert: { sent: 0, failed: 0, terminal: 0, created_at: now },
  });
  await completeDeliveryRunIfDone(untouchableMongo, "run", { status: "completed" });
  let { Item } = await client.send(new GetCommand({ TableName: RUNS, Key: { _id: "run" } }));
  assert.equal(Item.status, "queued", "1 of 2 delivered");
  assert.equal(Item.sent, 1, "counters are not reset by a later save");

  const second = await recordDeliveryOutcome(untouchableMongo, "run", "failed", now);
  assert.deepEqual([second.sent, second.failed, second.terminal], [1, 1, 2]);
  await completeDeliveryRunIfDone(untouchableMongo, "run", { status: "completed" });
  ({ Item } = await client.send(new GetCommand({ TableName: RUNS, Key: { _id: "run" } })));
  assert.equal(Item.status, "completed");
});

test("the reminder cron keeps its run on DynamoDB while everything else stays on MongoDB", async () => {
  // Only the delivery runs move: mail_jobs and the core collections have
  // their own switches and must stay on the MongoDB double below.
  setRoute("mongo", "mongo");
  process.env.DB_WRITE_TO_REPORT_DELIVERY_RUNS = "dynamo";
  process.env.DB_READ_FROM_REPORT_DELIVERY_RUNS = "dynamo";
  const mailJobs = [];
  const { recordRunTerminal } = await import("../src/services/mailWorker.js");
  const db = {
    collection(name) {
      if (name === "attendance") {
        return {
          find: () => ({
            toArray: async () => [
              { _id: "x", instructor_id: "i1", check_in_time: new Date(), check_out_time: null },
              { _id: "y", instructor_id: "i2", check_in_time: new Date(), check_out_time: null },
            ],
          }),
        };
      }
      if (name === "instructors") return { findOne: async () => ({ email: "instructor@example.com" }) };
      if (name === "mail_jobs") {
        return {
          async updateOne({ _id }, update) {
            mailJobs.push(_id);
            await recordRunTerminal(db, update.$setOnInsert.run_id, "sent", new Date());
          },
        };
      }
      throw new Error(`${name} should not be read from MongoDB`);
    },
  };
  await deliverAttendanceReminders(db);
  assert.equal(mailJobs.length, 2);
  const { Items } = await client.send(new ScanCommand({ TableName: RUNS }));
  assert.equal(Items.length, 1);
  assert.deepEqual([Items[0].queued, Items[0].sent, Items[0].terminal, Items[0].status], [2, 2, 2, "completed"]);
});
