import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { DeleteCommand, DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { createDynamoClient, setDynamoDocumentClient } from "../src/config/dynamo.js";
import { CORE_STORES, coreCollection, coreTransaction, UNIQUE_KEYS_STORE } from "../src/stores/coreStore.js";
import { compareCollectionWithDynamo } from "../src/stores/dynamoSync.js";
import { DYNAMO_TABLES, ensureDynamoTables } from "../src/stores/dynamoTables.js";
import { createBoaGuarded, deleteCollegeGuarded, updateBoaGuarded } from "../src/routes/adminRoutes.js";
import { createInstructorGuarded, deleteInstructorGuarded } from "../src/routes/instructorRoutes.js";
import { createDocument } from "../src/utils.js";
import { dynamoLocalJar, startDynamo, TRANSACTIONS_UNAVAILABLE } from "./helpers/dynamoLocal.js";

/**
 * The six collections that share MongoDB transactions, on DynamoDB, driven
 * through the real guarded functions the routes call. What has to hold:
 *
 * - a transaction writes every document or none, including the reservation
 *   items that stand in for the unique indexes;
 * - a duplicate raises MongoDB's code 11000, which the routes turn into 409;
 * - two requests racing over the same college or instructor conflict, as the
 *   guard counters made them conflict on MongoDB;
 * - writing to both databases leaves them identical.
 */

const PREFIX = "core-";
const ENV_KEYS = [
  "DB_WRITE_TO", "DB_READ_FROM", "DB_WRITE_TO_CORE", "DB_READ_FROM_CORE",
  "DYNAMODB_REGION", "DYNAMODB_ENDPOINT", "DYNAMODB_TABLE_PREFIX",
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const skip = () => (dynamoLocalJar() ? false : TRANSACTIONS_UNAVAILABLE);

let dynamo;
let rawClient;
let client;

function setCoreRoute(writeTo, readFrom) {
  process.env.DB_WRITE_TO_CORE = writeTo;
  process.env.DB_READ_FROM_CORE = readFrom;
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
  const report = await ensureDynamoTables(rawClient, { prefix: PREFIX, apply: true, protect: false });
  assert.deepEqual(report.conflicts, []);
});

beforeEach(async () => {
  if (!dynamo) return;
  setDynamoDocumentClient(client);
  process.env.DB_WRITE_TO = "mongo";
  process.env.DB_READ_FROM = "mongo";
  setCoreRoute("dynamo", "dynamo");
  for (const { store } of DYNAMO_TABLES) {
    const table = `${PREFIX}${store}`;
    const { Items = [] } = await client.send(new ScanCommand({ TableName: table }));
    for (const item of Items) {
      const Key = store === "evaluations"
        ? { attendance_id: item.attendance_id, kind: item.kind }
        : { _id: item._id };
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
  rawClient?.destroy();
  await dynamo?.stop();
});

/** Fails the test if MongoDB is touched while the group is on DynamoDB. */
const noMongo = {
  collection(name) {
    throw new Error(`${name} was read from MongoDB while the core group is on DynamoDB`);
  },
};

async function reservations() {
  const { Items = [] } = await client.send(new ScanCommand({ TableName: `${PREFIX}${UNIQUE_KEYS_STORE}` }));
  return Items.map((item) => item._id).sort();
}

async function seedCollege(db, { id = "college-1", name = "Campus One", location = "Hyderabad" } = {}) {
  await coreCollection(db, "colleges").insertOne(createDocument({
    _id: id, name, location, deleted_at: null, created_at: new Date(), updated_at: new Date(),
  }));
  return id;
}

const boaInput = (overrides = {}) => ({
  employee_id: "E100",
  name: "Asha",
  college_id: "college-1",
  email: "asha@nxtwave.com",
  password: "a-long-enough-password",
  ...overrides,
});

test("creating a BOA writes the college guard, the record and the login together", { skip: skip() }, async () => {
  const db = noMongo;
  await seedCollege(db);
  const result = await createBoaGuarded(db, boaInput());
  assert.equal(result.outcome, "created");

  const boa = await coreCollection(db, "boas").findOne({ employee_id: "E100" });
  assert.equal(boa.name, "Asha");
  const user = await coreCollection(db, "users").findOne({ email: "asha@nxtwave.com" });
  assert.equal(user.role, "BOA");
  assert.equal(String(user.reference_id), String(boa._id));
  const college = await coreCollection(db, "colleges").findOne({ _id: "college-1" });
  assert.equal(college._private_assignment_guard_version, 1, "the guard counter was bumped");
  assert.ok((await reservations()).includes("users.email#asha@nxtwave.com"));
  assert.ok((await reservations()).includes("boas.employee_id#E100"));
});

test("a duplicate employee id or email is refused and writes nothing", { skip: skip() }, async () => {
  const db = noMongo;
  await seedCollege(db);
  await createBoaGuarded(db, boaInput());
  const before = await coreCollection(db, "colleges").findOne({ _id: "college-1" });

  // The route checks first and reports an outcome; the reservation items
  // are the second line of defence, for two requests racing each other.
  assert.equal(
    (await createBoaGuarded(db, boaInput({ email: "other@nxtwave.com" }))).outcome,
    "duplicate_employee_id"
  );
  assert.equal(
    (await createBoaGuarded(db, boaInput({ employee_id: "E200" }))).outcome,
    "duplicate_email"
  );
  assert.equal(await coreCollection(db, "boas").countDocuments({ employee_id: "E200" }), 0);
  const after = await coreCollection(db, "colleges").findOne({ _id: "college-1" });
  assert.equal(
    after._private_assignment_guard_version,
    before._private_assignment_guard_version,
    "a refused create leaves the guard counter alone"
  );
});

test("a college assigned to a BOA cannot be deleted, and a deleted one cannot be assigned", { skip: skip() }, async () => {
  const db = noMongo;
  await seedCollege(db);
  await createBoaGuarded(db, boaInput());
  assert.equal((await deleteCollegeGuarded(db, "college-1")).outcome, "assigned_boa");

  await seedCollege(db, { id: "college-2", name: "Campus Two" });
  assert.equal((await deleteCollegeGuarded(db, "college-2")).outcome, "deleted");
  const gone = await coreCollection(db, "colleges").findOne({ _id: "college-2" });
  assert.ok(gone.deleted_at, "soft deleted");
  const result = await createBoaGuarded(db, boaInput({
    employee_id: "E300", email: "new@nxtwave.com", college_id: "college-2",
  }));
  assert.equal(result.outcome, "college_not_found");
});

test("renaming a BOA's email moves its reservation", { skip: skip() }, async () => {
  const db = noMongo;
  await seedCollege(db);
  const { boa } = await createBoaGuarded(db, boaInput());
  const updated = await updateBoaGuarded(db, String(boa._id), boaInput({ email: "renamed@nxtwave.com" }));
  assert.equal(updated.outcome, "updated");
  const keys = await reservations();
  assert.ok(keys.includes("users.email#renamed@nxtwave.com"));
  assert.ok(!keys.includes("users.email#asha@nxtwave.com"), "the old address is free again");
  assert.equal(await coreCollection(db, "users").countDocuments({ email: "renamed@nxtwave.com" }), 1);
});

test("an instructor cannot be created twice, or deleted while checked in", { skip: skip() }, async () => {
  const db = noMongo;
  await seedCollege(db);
  const created = await createInstructorGuarded(db, {
    employee_id: "I100", name: "Bina", college_id: "college-1", email: "bina@nxtwave.com",
  });
  assert.equal(created.outcome, "created");
  assert.equal(
    (await createInstructorGuarded(db, { employee_id: "I100", name: "Other", college_id: "college-1" })).outcome,
    "duplicate_employee_id"
  );

  // An open check-in today blocks the delete, as it does on MongoDB.
  const now = new Date();
  await coreCollection(db, "attendance").insertOne(createDocument({
    instructor_id: String(created.instructor._id),
    attendance_day: now.toISOString().slice(0, 10),
    date: now,
    check_in_time: now,
    check_out_time: null,
    status: "pending",
  }));
  assert.equal(
    (await deleteInstructorGuarded(db, String(created.instructor._id))).outcome,
    "active_attendance"
  );
});

test("two requests enrolling into the same college both land", { skip: skip() }, async () => {
  const db = noMongo;
  await seedCollege(db);
  const [first, second] = await Promise.all([
    createBoaGuarded(db, boaInput({ employee_id: "E1", email: "one@nxtwave.com" })),
    createBoaGuarded(db, boaInput({ employee_id: "E2", email: "two@nxtwave.com" })),
  ]);
  assert.deepEqual([first.outcome, second.outcome], ["created", "created"]);
  assert.equal(await coreCollection(db, "boas").countDocuments({}), 2);
  const college = await coreCollection(db, "colleges").findOne({ _id: "college-1" });
  assert.equal(college._private_assignment_guard_version, 2, "both bumped the guard");
});

test("one attendance record per instructor per day is enforced", { skip: skip() }, async () => {
  const db = noMongo;
  const day = "2026-09-30";
  const record = (overrides) => createDocument({
    instructor_id: "instructor-1",
    attendance_day: day,
    date: new Date(`${day}T04:00:00.000Z`),
    check_in_time: new Date(`${day}T04:00:00.000Z`),
    status: "pending",
    ...overrides,
  });
  await coreCollection(db, "attendance").insertOne(record());
  await assert.rejects(
    coreCollection(db, "attendance").insertOne(record()),
    (error) => error.code === 11000,
    "a second check-in the same day is refused"
  );
  // Another day, and another instructor, are both fine.
  await coreCollection(db, "attendance").insertOne(record({ attendance_day: "2026-10-01" }));
  await coreCollection(db, "attendance").insertOne(record({ instructor_id: "instructor-2" }));
  // Unidentified records have no instructor and are exempt.
  await coreCollection(db, "attendance").insertOne(record({ instructor_id: null, status: "unidentified" }));
  await coreCollection(db, "attendance").insertOne(record({ instructor_id: null, status: "unidentified" }));
  assert.equal(await coreCollection(db, "attendance").countDocuments({ attendance_day: day }), 4);
});

test("writing the core group to both databases leaves them identical", { skip: skip() }, async () => {
  const documents = new Map();
  const mongo = {
    collection(name) {
      if (!documents.has(name)) documents.set(name, new Map());
      const rows = documents.get(name);
      return {
        async findOne(filter) {
          return [...rows.values()].find((row) => String(row._id) === String(filter._id)) || null;
        },
        find(filter) {
          const matched = [...rows.values()].filter((row) => (
            filter?._id === undefined || String(row._id) === String(filter._id)
          ));
          return { toArray: async () => matched, [Symbol.asyncIterator]: async function* it() { yield* matched; } };
        },
        async replaceOne({ _id }, document) { rows.set(String(_id), { ...document }); },
        async deleteOne({ _id }) { rows.delete(String(_id)); },
      };
    },
  };
  setCoreRoute("both", "dynamo");
  await seedCollege(mongo);
  await createBoaGuarded(mongo, boaInput());
  await updateBoaGuarded(
    mongo,
    String((await coreCollection(mongo, "boas").findOne({ employee_id: "E100" }))._id),
    boaInput({ name: "Asha K" })
  );

  for (const store of ["colleges", "boas", "users"]) {
    const comparison = await compareCollectionWithDynamo(mongo, client, {
      store,
      tableName: `${PREFIX}${store}`,
    });
    assert.equal(comparison.matches, true, `${store}: ${JSON.stringify(comparison)}`);
    assert.ok(comparison.mongoCount > 0, `${store} was copied`);
  }
});

test("every core collection has a DynamoDB table", () => {
  const tables = new Set(DYNAMO_TABLES.map((table) => table.store));
  for (const store of CORE_STORES) assert.ok(tables.has(store), `${store} has no table`);
  assert.ok(tables.has(UNIQUE_KEYS_STORE), "the reservation table is missing");
});

test("the transaction runner follows the switch", () => {
  setCoreRoute("mongo", "mongo");
  assert.equal(coreTransaction({}).name, "withMongoTransaction");
  setCoreRoute("dynamo", "dynamo");
  assert.equal(coreTransaction({}).name, "withDynamoTransaction");
});
