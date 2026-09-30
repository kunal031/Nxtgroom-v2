import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { CreateTableCommand } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { ObjectId } from "mongodb";
import { createDynamoClient, setDynamoDocumentClient } from "../src/config/dynamo.js";
import { documentCollection, UNIQUE_KEYS_STORE } from "../src/stores/dynamoDocuments.js";
import { withDynamoTransaction } from "../src/stores/dynamoTransaction.js";
import { applyUpdate, project, upsertDocument } from "../src/stores/dynamoUpdate.js";
import { dynamoLocalJar, startDynamo, TRANSACTIONS_UNAVAILABLE } from "./helpers/dynamoLocal.js";

/**
 * The engine the transactional collections run on: MongoDB collection calls
 * answered from DynamoDB, unique indexes as reservation items, and
 * all-or-nothing writes with the conflict detection MongoDB's snapshot
 * transactions gave the guarded create, update and delete paths.
 */

const PREFIX = "docs-";
const ENV_KEYS = ["DYNAMODB_REGION", "DYNAMODB_ENDPOINT", "DYNAMODB_TABLE_PREFIX"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
let dynamo;
let rawClient;
let client;
// Everything here writes through TransactWriteItems when more than one item
// is involved, which dynalite does not implement. Decided as the file loads,
// before before() has run, so it cannot ask whether the server started.
const skip = () => (dynamoLocalJar() ? false : TRANSACTIONS_UNAVAILABLE);

/** A collection standing in for the shapes the real ones use. */
const people = documentCollection({
  store: "people",
  scanOk: true,
  derive: (person) => ({
    college_key: person.college_id === null || person.college_id === undefined ? undefined : String(person.college_id),
    name_key: person.name,
  }),
  indexes: { by_college: { attribute: "college_key", sortAttribute: "name_key", include: ["name", "college_id", "role"] } },
  plan: (filter) => (typeof filter.college_id === "string"
    ? { queries: [{ index: "by_college", key: filter.college_id }] }
    : null),
  uniques: [
    { name: "email", key: (person) => (person.email ? String(person.email).toLowerCase() : null) },
    { name: "employee_id", key: (person) => person.employee_id ?? null },
  ],
});

async function createTables() {
  await rawClient.send(new CreateTableCommand({
    TableName: `${PREFIX}people`,
    BillingMode: "PAY_PER_REQUEST",
    AttributeDefinitions: [
      { AttributeName: "_id", AttributeType: "S" },
      { AttributeName: "college_key", AttributeType: "S" },
      { AttributeName: "name_key", AttributeType: "S" },
    ],
    KeySchema: [{ AttributeName: "_id", KeyType: "HASH" }],
    GlobalSecondaryIndexes: [{
      IndexName: "by_college",
      KeySchema: [
        { AttributeName: "college_key", KeyType: "HASH" },
        { AttributeName: "name_key", KeyType: "RANGE" },
      ],
      Projection: { ProjectionType: "ALL" },
    }],
  }));
  await rawClient.send(new CreateTableCommand({
    TableName: `${PREFIX}${UNIQUE_KEYS_STORE}`,
    BillingMode: "PAY_PER_REQUEST",
    AttributeDefinitions: [{ AttributeName: "_id", AttributeType: "S" }],
    KeySchema: [{ AttributeName: "_id", KeyType: "HASH" }],
  }));
}

before(async () => {
  dynamo = await startDynamo({ transactions: true });
  if (!dynamo) return;
  process.env.DYNAMODB_ENDPOINT = dynamo.endpoint;
  process.env.DYNAMODB_REGION = "ap-south-1";
  process.env.DYNAMODB_TABLE_PREFIX = PREFIX;
  rawClient = createDynamoClient();
  client = DynamoDBDocumentClient.from(rawClient, { marshallOptions: { removeUndefinedValues: true } });
  setDynamoDocumentClient(client);
  await createTables();
});

beforeEach(async () => {
  if (!dynamo) return;
  setDynamoDocumentClient(client);
  for (const table of [`${PREFIX}people`, `${PREFIX}${UNIQUE_KEYS_STORE}`]) {
    const { Items = [] } = await client.send(new ScanCommand({ TableName: table }));
    for (const item of Items) await client.send(new DeleteCommand({ TableName: table, Key: { _id: item._id } }));
  }
});

after(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  setDynamoDocumentClient(null);
  rawClient?.destroy();
  await dynamo?.stop();
});

async function reservations() {
  const { Items = [] } = await client.send(new ScanCommand({ TableName: `${PREFIX}${UNIQUE_KEYS_STORE}` }));
  return Items.map((item) => item._id).sort();
}

// ------------------------------------------------------ update semantics

test("MongoDB update operators are applied as MongoDB applies them", () => {
  const before = { _id: "a", count: 1, tags: ["x"], nested: { kept: 1, gone: 2 } };
  assert.deepEqual(
    applyUpdate(before, {
      $set: { "nested.added": 3, name: "n" },
      $unset: { "nested.gone": "" },
      $inc: { count: 2, fresh: 5 },
      $push: { tags: "y" },
      $addToSet: { tags: "y" },
    }),
    { _id: "a", count: 3, tags: ["x", "y"], nested: { kept: 1, added: 3 }, name: "n", fresh: 5 }
  );
  assert.deepEqual(applyUpdate(before, { $pull: { tags: "x" } }).tags, []);
  assert.deepEqual(applyUpdate(before, { $setOnInsert: { seeded: true } }), before, "no insert, no effect");
  assert.deepEqual(applyUpdate(before, { $setOnInsert: { seeded: true } }, { inserting: true }).seeded, true);
  assert.throws(() => applyUpdate(before, { $rename: { a: "b" } }), /Unsupported/);
  // The original is untouched.
  assert.deepEqual(before.nested, { kept: 1, gone: 2 });
});

test("an upsert seeds the document from its filter, as MongoDB does", () => {
  assert.deepEqual(
    upsertDocument({ email: "a@x.com", status: { $in: ["queued"] } }, { $set: { name: "A" }, $setOnInsert: { created: 1 } }),
    { email: "a@x.com", name: "A", created: 1 }
  );
});

test("projections include and exclude as MongoDB does", () => {
  const document = { _id: "a", name: "n", secret: "s", nested: { keep: 1, drop: 2 } };
  assert.deepEqual(project(document, { name: 1, "nested.keep": 1 }), { _id: "a", name: "n", nested: { keep: 1 } });
  assert.deepEqual(project(document, { name: 1, _id: 0 }), { name: "n" });
  assert.deepEqual(project(document, { secret: 0 }), { _id: "a", name: "n", nested: { keep: 1, drop: 2 } });
});

// ------------------------------------------------------- collection calls

test("documents round-trip with dates, nulls and legacy ObjectIds intact", { skip: skip() }, async () => {
  const at = new Date("2026-09-30T04:00:00.000Z");
  const legacy = new ObjectId();
  await people.insertOne({ _id: "p1", name: "Asha", college_id: null, joined_at: at, ref: legacy });
  const found = await people.findOne({ _id: "p1" });
  assert.equal(found.name, "Asha");
  assert.equal(found.college_id, null);
  assert.equal(found.joined_at.getTime(), at.getTime());
  assert.equal(found.ref, legacy.toHexString(), "an ObjectId is stored as its hex string");
  assert.equal(await people.findOne({ _id: "missing" }), null);
  // A legacy ObjectId _id is found by its string form.
  await people.insertOne({ _id: legacy, name: "Legacy" });
  assert.ok(await people.findOne({ _id: legacy }));
  assert.ok(await people.findOne({ _id: legacy.toHexString() }));
});

test("find supports sort, skip, limit, projection and a cursor", { skip: skip() }, async () => {
  for (const name of ["Cara", "Asha", "Bina"]) {
    await people.insertOne({ _id: name, name, college_id: "c1", role: "INSTRUCTOR" });
  }
  await people.insertOne({ _id: "Dev", name: "Dev", college_id: "c2", role: "INSTRUCTOR" });
  const page = await people.find({ college_id: "c1" }, { projection: { name: 1 } })
    .sort({ name: 1 }).skip(1).limit(1).toArray();
  assert.deepEqual(page, [{ _id: "Bina", name: "Bina" }]);
  assert.equal(await people.countDocuments({ college_id: "c1" }), 3);
  assert.deepEqual((await people.distinct("college_id")).sort(), ["c1", "c2"]);

  const seen = [];
  for await (const person of people.find({ college_id: "c1" }).sort({ name: -1 })) seen.push(person.name);
  assert.deepEqual(seen, ["Cara", "Bina", "Asha"]);
});

test("updateOne, upsert, findOneAndUpdate, delete and updateMany behave as MongoDB", { skip: skip() }, async () => {
  await people.insertOne({ _id: "p1", name: "Asha", visits: 0 });
  assert.deepEqual(
    await people.updateOne({ _id: "p1" }, { $inc: { visits: 1 }, $set: { name: "Asha K" } }),
    { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0 }
  );
  assert.equal((await people.findOne({ _id: "p1" })).visits, 1);

  const missed = await people.updateOne({ _id: "nobody" }, { $set: { name: "x" } });
  assert.deepEqual([missed.matchedCount, missed.upsertedCount], [0, 0]);
  const upserted = await people.updateOne(
    { _id: "p2" },
    { $set: { name: "New" }, $setOnInsert: { created: true } },
    { upsert: true }
  );
  assert.deepEqual([upserted.matchedCount, upserted.upsertedCount], [0, 1]);
  assert.equal((await people.findOne({ _id: "p2" })).created, true);

  const returned = await people.findOneAndUpdate(
    { _id: "p1" },
    { $set: { role: "LEAD" } },
    { returnDocument: "after" }
  );
  assert.equal(returned.role, "LEAD");
  assert.equal(await people.findOneAndUpdate({ _id: "gone" }, { $set: { a: 1 } }, { returnDocument: "after" }), null);

  await people.updateMany({}, { $set: { seen: true } });
  assert.equal(await people.countDocuments({ seen: true }), 2);
  assert.deepEqual(await people.deleteOne({ _id: "p2" }), { acknowledged: true, deletedCount: 1 });
  assert.deepEqual(await people.deleteMany({}), { acknowledged: true, deletedCount: 1 });
});

test("a conditional update applies only while the document still matches", { skip: skip() }, async () => {
  await people.insertOne({ _id: "p1", status: "open" });
  const claimed = await people.updateOne({ _id: "p1", status: "open" }, { $set: { status: "closed" } });
  assert.equal(claimed.matchedCount, 1);
  const again = await people.updateOne({ _id: "p1", status: "open" }, { $set: { status: "closed twice" } });
  assert.equal(again.matchedCount, 0, "the second attempt finds nothing to claim");
});

// -------------------------------------------------------- unique indexes

test("a unique index refuses a duplicate with MongoDB's error", { skip: skip() }, async () => {
  await people.insertOne({ _id: "p1", email: "Asha@Example.com", employee_id: "E1" });
  assert.deepEqual(await reservations(), ["people.email#asha@example.com", "people.employee_id#E1"]);

  await assert.rejects(
    people.insertOne({ _id: "p2", email: "asha@example.com" }),
    (error) => error.code === 11000 && /email/.test(error.message)
  );
  assert.equal(await people.findOne({ _id: "p2" }), null, "nothing was written");

  // A different value is fine, and updating one frees the old reservation.
  await people.insertOne({ _id: "p2", email: "bina@example.com" });
  await people.updateOne({ _id: "p2" }, { $set: { email: "changed@example.com" } });
  assert.deepEqual(await reservations(), [
    "people.email#asha@example.com",
    "people.email#changed@example.com",
    "people.employee_id#E1",
  ]);
  await assert.rejects(people.updateOne({ _id: "p2" }, { $set: { employee_id: "E1" } }), (error) => error.code === 11000);
  assert.equal((await people.findOne({ _id: "p2" })).employee_id, undefined);

  // Deleting releases them.
  await people.deleteOne({ _id: "p1" });
  assert.deepEqual(await reservations(), ["people.email#changed@example.com"]);
  await people.insertOne({ _id: "p3", email: "asha@example.com" }, {});
  assert.ok(await people.findOne({ _id: "p3" }));
});

test("a document keeps its own reservations when other fields change", { skip: skip() }, async () => {
  await people.insertOne({ _id: "p1", email: "a@x.com", employee_id: "E1" });
  await people.updateOne({ _id: "p1" }, { $set: { name: "Asha" } });
  await people.updateOne({ _id: "p1" }, { $set: { name: "Asha K" } });
  assert.equal((await people.findOne({ _id: "p1" })).name, "Asha K");
});

test("two writers inserting the same unique value: one wins", { skip: skip() }, async () => {
  const results = await Promise.allSettled([
    people.insertOne({ _id: "a", email: "same@x.com" }),
    people.insertOne({ _id: "b", email: "same@x.com" }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.find((result) => result.status === "rejected").reason.code, 11000);
  assert.equal(await people.countDocuments({ email: "same@x.com" }), 1);
});

// ---------------------------------------------------------- transactions

test("a transaction commits every write together", { skip: skip() }, async () => {
  await people.insertOne({ _id: "college", members: 0 });
  await withDynamoTransaction(async (session) => {
    await people.updateOne({ _id: "college" }, { $inc: { members: 1 } }, { session });
    await people.insertOne({ _id: "member", name: "Asha", email: "asha@x.com" }, { session });
  });
  assert.equal((await people.findOne({ _id: "college" })).members, 1);
  assert.ok(await people.findOne({ _id: "member" }));
  assert.deepEqual(await reservations(), ["people.email#asha@x.com"]);
});

test("a transaction that throws writes nothing", { skip: skip() }, async () => {
  await people.insertOne({ _id: "college", members: 0 });
  await assert.rejects(withDynamoTransaction(async (session) => {
    await people.updateOne({ _id: "college" }, { $inc: { members: 1 } }, { session });
    await people.insertOne({ _id: "member", name: "Asha" }, { session });
    throw new Error("changed my mind");
  }), /changed my mind/);
  assert.equal((await people.findOne({ _id: "college" })).members, 0);
  assert.equal(await people.findOne({ _id: "member" }), null);
});

test("a duplicate inside a transaction rolls the whole transaction back", { skip: skip() }, async () => {
  await people.insertOne({ _id: "existing", email: "taken@x.com" });
  await people.insertOne({ _id: "college", members: 0 });
  await assert.rejects(withDynamoTransaction(async (session) => {
    await people.updateOne({ _id: "college" }, { $inc: { members: 1 } }, { session });
    await people.insertOne({ _id: "member", email: "taken@x.com" }, { session });
  }), (error) => error.code === 11000);
  assert.equal((await people.findOne({ _id: "college" })).members, 0, "the counter was not bumped");
  assert.equal(await people.findOne({ _id: "member" }), null);
});

test("a transaction sees its own writes before they are committed", { skip: skip() }, async () => {
  await withDynamoTransaction(async (session) => {
    await people.insertOne({ _id: "p1", name: "Asha", college_id: "c1" }, { session });
    const seen = await people.findOne({ _id: "p1" }, { session });
    assert.equal(seen.name, "Asha");
    await people.updateOne({ _id: "p1" }, { $set: { role: "LEAD" } }, { session });
  });
  const stored = await people.findOne({ _id: "p1" });
  assert.deepEqual([stored.name, stored.role], ["Asha", "LEAD"]);
});

test("a transaction aborts when a document it read changed underneath it", { skip: skip() }, async () => {
  await people.insertOne({ _id: "college", guard: 0, open: true });
  let interfered = false;
  await assert.rejects(withDynamoTransaction(async (session) => {
    const college = await people.findOne({ _id: "college" }, { session });
    assert.equal(college.open, true);
    if (!interfered) {
      interfered = true;
      // Another request deletes the college between the read and the commit.
      await people.updateOne({ _id: "college" }, { $set: { open: false } });
    }
    if (!(await people.findOne({ _id: "college", open: true }, { session }))) {
      throw new Error("college is closed");
    }
    await people.insertOne({ _id: `member-${Math.random()}`, name: "Asha" }, { session });
  }), /college is closed/);
  assert.equal(await people.countDocuments({ name: "Asha" }), 0);
});

test("two transactions bumping the same guard: one is retried, both land", { skip: skip() }, async () => {
  await people.insertOne({ _id: "college", guard: 0 });
  const enrol = (id) => withDynamoTransaction(async (session) => {
    const college = await people.findOne({ _id: "college" }, { session });
    assert.ok(college);
    await people.updateOne({ _id: "college" }, { $inc: { guard: 1 } }, { session });
    await people.insertOne({ _id: id, name: id }, { session });
  });
  await Promise.all([enrol("m1"), enrol("m2")]);
  assert.equal((await people.findOne({ _id: "college" })).guard, 2);
  assert.equal(await people.countDocuments({ name: "m1" }), 1);
  assert.equal(await people.countDocuments({ name: "m2" }), 1);
});

test("an unplanned filter on a collection that may not be scanned is refused", { skip: skip() }, async () => {
  const strict = documentCollection({ store: "people", plan: () => null, scanOk: false });
  await assert.rejects(strict.findOne({ name: "Asha" }), /no DynamoDB index answers/);
  assert.ok(await strict.findOne({ _id: "anything" }) === null, "an _id lookup is always allowed");
});
