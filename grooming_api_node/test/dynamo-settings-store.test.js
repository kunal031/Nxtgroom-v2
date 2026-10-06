import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import dynalite from "dynalite";
import { ObjectId } from "mongodb";
import {
  createDynamoClient,
  dataRoute,
  dynamoConfigurationErrors,
  setDynamoDocumentClient,
} from "../src/config/dynamo.js";
import { fromItem, toItem } from "../src/stores/dynamoItems.js";
import { compareCollectionWithDynamo, copyCollectionToDynamo } from "../src/stores/dynamoSync.js";
import { ensureDynamoTables } from "../src/stores/dynamoTables.js";
import {
  addSettingListValue,
  getSetting,
  removeSettingListValue,
  saveSetting,
} from "../src/stores/settingsStore.js";
import {
  addReportRecipient,
  getReportRecipients,
  removeReportRecipient,
} from "../src/services/reportRecipients.js";
import { getNotificationSettings, saveNotificationSettings } from "../src/services/notificationSettings.js";

const PREFIX = "test-";
const TABLE = `${PREFIX}app_settings`;
const ROUTE_KEYS = [
  "DB_WRITE_TO",
  "DB_READ_FROM",
  "DB_WRITE_TO_APP_SETTINGS",
  "DB_READ_FROM_APP_SETTINGS",
  "DYNAMODB_REGION",
  "DYNAMODB_ENDPOINT",
  "DYNAMODB_TABLE_PREFIX",
  "DYNAMODB_ACCESS_KEY_ID",
  "DYNAMODB_SECRET_ACCESS_KEY",
];
const savedEnv = Object.fromEntries(ROUTE_KEYS.map((key) => [key, process.env[key]]));

let server;
let rawClient;
let client;

function setRoute(writeTo, readFrom) {
  process.env.DB_WRITE_TO = writeTo;
  process.env.DB_READ_FROM = readFrom;
}

function memoryMongo() {
  const documents = new Map();
  const clone = (value) => structuredClone(value);
  return {
    documents,
    collection(name) {
      assert.equal(name, "app_settings");
      return {
        async findOne({ _id }) {
          return documents.has(_id) ? clone(documents.get(_id)) : null;
        },
        async updateOne({ _id }, update, { upsert = false } = {}) {
          const existing = documents.get(_id);
          if (!existing && !upsert) return { matchedCount: 0, modifiedCount: 0 };
          const next = existing ? clone(existing) : { _id };
          if (!existing) Object.assign(next, clone(update.$setOnInsert || {}));
          Object.assign(next, clone(update.$set || {}));
          for (const [field, value] of Object.entries(update.$addToSet || {})) {
            next[field] = Array.isArray(next[field]) ? next[field] : [];
            if (!next[field].includes(value)) next[field].push(value);
          }
          for (const [field, value] of Object.entries(update.$pull || {})) {
            if (Array.isArray(next[field])) next[field] = next[field].filter((entry) => entry !== value);
          }
          documents.set(_id, next);
          return { matchedCount: existing ? 1 : 0, modifiedCount: 1 };
        },
        find() {
          return (async function* all() {
            for (const document of documents.values()) yield clone(document);
          }());
        },
      };
    },
  };
}

const untouchableMongo = {
  collection() {
    throw new Error("MongoDB was used while the store was switched to DynamoDB only");
  },
};

before(async () => {
  server = dynalite({ createTableMs: 0, updateTableMs: 0 });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.DYNAMODB_ENDPOINT = `http://127.0.0.1:${server.address().port}`;
  process.env.DYNAMODB_REGION = "ap-south-1";
  process.env.DYNAMODB_TABLE_PREFIX = PREFIX;
  rawClient = createDynamoClient();
  client = DynamoDBDocumentClient.from(rawClient, { marshallOptions: { removeUndefinedValues: true } });
  setDynamoDocumentClient(client);
  const report = await ensureDynamoTables(rawClient, { prefix: PREFIX, apply: true, protect: false });
  assert.ok(report.created.includes(TABLE));
});

beforeEach(async () => {
  setDynamoDocumentClient(client);
  setRoute("mongo", "mongo");
  const { Items = [] } = await client.send(new ScanCommand({ TableName: TABLE }));
  for (const { _id } of Items) await client.send(new DeleteCommand({ TableName: TABLE, Key: { _id } }));
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

test("with nothing set, every store stays on MongoDB", () => {
  delete process.env.DB_WRITE_TO;
  delete process.env.DB_READ_FROM;
  assert.deepEqual(dataRoute("app_settings"), { writeTo: "mongo", readFrom: "mongo" });
  assert.deepEqual(dataRoute("attendance"), { writeTo: "mongo", readFrom: "mongo" }, "not migrated yet");
});

test("a per-store switch overrides the global one", () => {
  setRoute("mongo", "mongo");
  process.env.DB_WRITE_TO_APP_SETTINGS = "both";
  try {
    assert.deepEqual(dataRoute("app_settings"), { writeTo: "both", readFrom: "mongo" });
  } finally {
    delete process.env.DB_WRITE_TO_APP_SETTINGS;
  }
});

test("switch combinations that would lose or hide writes are refused", () => {
  setRoute("mongo", "dynamo");
  assert.throws(() => dataRoute("app_settings"), /reads from DynamoDB but writes only to MongoDB/);
  setRoute("dynamo", "mongo");
  assert.throws(() => dataRoute("app_settings"), /reads from MongoDB but writes only to DynamoDB/);
  setRoute("dynamodb", "mongo");
  assert.throws(() => dataRoute("app_settings"), /DB_WRITE_TO must be one of/);
});

test("DynamoDB credentials are required once a store uses it, unless an endpoint is set", () => {
  setRoute("both", "mongo");
  const endpoint = process.env.DYNAMODB_ENDPOINT;
  try {
    assert.deepEqual(dynamoConfigurationErrors(), [], "DynamoDB Local needs no keys");
    delete process.env.DYNAMODB_ENDPOINT;
    assert.match(dynamoConfigurationErrors().join(), /DYNAMODB_ACCESS_KEY_ID/);
    process.env.DYNAMODB_ACCESS_KEY_ID = "key";
    process.env.DYNAMODB_SECRET_ACCESS_KEY = "secret";
    assert.deepEqual(dynamoConfigurationErrors(), []);
    setRoute("mongo", "mongo");
    delete process.env.DYNAMODB_ACCESS_KEY_ID;
    assert.deepEqual(dynamoConfigurationErrors(), [], "nothing is required while DynamoDB is unused");
  } finally {
    process.env.DYNAMODB_ENDPOINT = endpoint;
    delete process.env.DYNAMODB_ACCESS_KEY_ID;
    delete process.env.DYNAMODB_SECRET_ACCESS_KEY;
  }
});

test("dates, nested values and legacy ObjectIds survive the round trip", () => {
  const at = new Date("2026-09-29T03:30:00.000Z");
  const id = new ObjectId();
  const item = toItem({ _id: id, at, nested: { list: [at, "x"], gone: undefined }, day: "2026-09-29" });
  assert.equal(item._id, id.toHexString());
  assert.equal(item.at, "2026-09-29T03:30:00.000Z");
  assert.equal("gone" in item.nested, false);
  const back = fromItem(item);
  assert.ok(back.at instanceof Date);
  assert.equal(back.at.getTime(), at.getTime());
  assert.ok(back.nested.list[0] instanceof Date);
  assert.equal(back.day, "2026-09-29", "a plain date string stays a string");
});

async function settingsScenario(db) {
  const first = new Date("2026-09-29T03:30:00.000Z");
  const second = new Date("2026-09-29T04:00:00.000Z");
  const seen = {};
  seen.missing = await getSetting(db, "identification_settings");

  await saveSetting(db, "identification_settings", {
    set: { default_mode: "FACE_ONLY", college_modes: { a: "SELECTOR", b: "FACE_ONLY" }, updated_at: first },
    setOnInsert: { _id: "identification_settings", created_at: first },
  });
  await saveSetting(db, "identification_settings", {
    set: { default_mode: "SELECTOR", college_modes: { b: "SELECTOR" }, updated_at: second },
    setOnInsert: { _id: "identification_settings", created_at: second },
  });
  seen.saved = await getSetting(db, "identification_settings");

  for (const email of ["b@x.com", "a@x.com", "b@x.com"]) {
    await addSettingListValue(db, "rp_recipients", "emails", email, {
      set: { updated_at: first, updated_by: email },
      setOnInsert: { _id: "rp_recipients", created_at: first },
    });
  }
  seen.added = await getSetting(db, "rp_recipients");

  await removeSettingListValue(db, "rp_recipients", "emails", "b@x.com", { set: { updated_by: "remover" } });
  await removeSettingListValue(db, "rp_recipients", "emails", "nobody@x.com", { set: { updated_at: second } });
  seen.removed = await getSetting(db, "rp_recipients");

  await removeSettingListValue(db, "never_created", "emails", "a@x.com", { set: { updated_at: second } });
  seen.notCreated = await getSetting(db, "never_created");
  return seen;
}

test("the DynamoDB half gives the same results as the MongoDB half", async () => {
  setRoute("mongo", "mongo");
  const fromMongo = await settingsScenario(memoryMongo());
  setRoute("dynamo", "dynamo");
  const fromDynamo = await settingsScenario(untouchableMongo);
  assert.deepEqual(fromDynamo, fromMongo);

  assert.equal(fromMongo.missing, null);
  assert.equal(fromMongo.saved.default_mode, "SELECTOR");
  assert.deepEqual(fromMongo.saved.college_modes, { b: "SELECTOR" }, "a map is replaced, not merged");
  assert.equal(fromMongo.saved.created_at.toISOString(), "2026-09-29T03:30:00.000Z", "set only on insert");
  assert.deepEqual(fromMongo.added.emails, ["b@x.com", "a@x.com"], "order kept, duplicate ignored");
  assert.equal(fromMongo.added.updated_by, "b@x.com", "a duplicate still applies the other fields");
  assert.deepEqual(fromMongo.removed.emails, ["a@x.com"]);
  assert.equal(fromMongo.removed.updated_by, "remover");
  assert.equal(fromMongo.notCreated, null, "removing from a missing document does not create it");
});

test("settings services work end to end with MongoDB switched off", async () => {
  setRoute("dynamo", "dynamo");
  assert.deepEqual(await getReportRecipients(untouchableMongo), []);
  assert.equal((await addReportRecipient(untouchableMongo, "One@X.com ", "admin@x.com")).ok, true);
  assert.equal((await addReportRecipient(untouchableMongo, "one@x.com", "admin@x.com")).reason, "duplicate");
  await addReportRecipient(untouchableMongo, "two@x.com", "admin@x.com");
  assert.deepEqual(await getReportRecipients(untouchableMongo), ["one@x.com", "two@x.com"]);
  await removeReportRecipient(untouchableMongo, "one@x.com", "admin@x.com");
  assert.deepEqual(await getReportRecipients(untouchableMongo), ["two@x.com"]);

  const saved = await saveNotificationSettings(untouchableMongo, { checkin_email_enabled: false }, "admin@x.com");
  assert.deepEqual(await getNotificationSettings(untouchableMongo), saved);
});

test("writing to both keeps the two databases identical, and reads stay on MongoDB", async () => {
  setRoute("both", "mongo");
  const mongo = memoryMongo();
  await settingsScenario(mongo);
  const comparison = await compareCollectionWithDynamo(mongo, client, { store: "app_settings", tableName: TABLE });
  assert.equal(comparison.matches, true, JSON.stringify(comparison));
});

test("a failing DynamoDB shadow write never fails the request while MongoDB is the source", async (t) => {
  setRoute("both", "mongo");
  const errors = [];
  t.mock.method(console, "error", (line) => errors.push(String(line)));
  setDynamoDocumentClient({ send: async () => { throw Object.assign(new Error("down"), { name: "ServiceUnavailable" }); } });
  const mongo = memoryMongo();
  await saveSetting(mongo, "access_settings", { set: { boa_can_identify: true } });
  assert.equal((await getSetting(mongo, "access_settings")).boa_can_identify, true);
  const logged = errors.map((line) => JSON.parse(line)).find((entry) => entry.event === "shadow_write_failed");
  assert.equal(logged.database, "dynamo");
  assert.equal(logged.store, "app_settings");
});

test("once reads move to DynamoDB, a DynamoDB write failure fails the request", async () => {
  setRoute("both", "dynamo");
  setDynamoDocumentClient({ send: async () => { throw Object.assign(new Error("down"), { name: "ServiceUnavailable" }); } });
  await assert.rejects(
    saveSetting(memoryMongo(), "access_settings", { set: { boa_can_identify: true } }),
    /down/
  );
});

test("copy fills DynamoDB from MongoDB and compare finds any difference", async () => {
  const mongo = memoryMongo();
  setRoute("mongo", "mongo");
  await settingsScenario(mongo);
  const options = { store: "app_settings", tableName: TABLE };

  const before = await compareCollectionWithDynamo(mongo, client, options);
  assert.equal(before.matches, false);
  assert.deepEqual(before.onlyInMongo.sort(), ["identification_settings", "rp_recipients"]);

  const dryRun = await copyCollectionToDynamo(mongo, client, options);
  assert.deepEqual([dryRun.documents, dryRun.written], [2, 0], "without --apply nothing is written");
  await copyCollectionToDynamo(mongo, client, { ...options, apply: true });
  assert.equal((await compareCollectionWithDynamo(mongo, client, options)).matches, true);

  await client.send(new PutCommand({ TableName: TABLE, Item: { _id: "rp_recipients", emails: ["changed@x.com"] } }));
  await client.send(new PutCommand({ TableName: TABLE, Item: { _id: "stray" } }));
  const after = await compareCollectionWithDynamo(mongo, client, options);
  assert.deepEqual(after.different, ["rp_recipients"]);
  assert.deepEqual(after.onlyInDynamo, ["stray"]);

  const { Item } = await client.send(new GetCommand({ TableName: TABLE, Key: { _id: "identification_settings" } }));
  assert.equal(Item.created_at, "2026-09-29T03:30:00.000Z", "dates are stored as sortable ISO strings");
});

test("a table that does not exist is said so, not reported as empty", async () => {
  const mongo = memoryMongo();
  setRoute("mongo", "mongo");
  await settingsScenario(mongo);

  // "DynamoDB 0" for a table nobody created reads as lost data, and the
  // difference it reports would send someone hunting for missing rows.
  await assert.rejects(
    compareCollectionWithDynamo(mongo, client, {
      store: "app_settings",
      tableName: "absent-app_settings",
    }),
    (error) => {
      assert.equal(error.name, "MissingTableError");
      assert.equal(error.tableName, "absent-app_settings");
      assert.match(error.message, /dynamo:tables:apply/, "says how to fix it");
      return true;
    }
  );
});

test("the table check reports existing tables and changes nothing without --apply", async () => {
  const report = await ensureDynamoTables(rawClient, { prefix: PREFIX, apply: false, protect: false });
  assert.ok(report.existing.includes(TABLE));
  assert.deepEqual([report.created, report.missing, report.conflicts], [[], [], []]);
  const other = await ensureDynamoTables(rawClient, { prefix: "absent-", apply: false, protect: false });
  assert.ok(other.missing.includes("absent-app_settings"));
  assert.deepEqual(other.existing, []);
});
