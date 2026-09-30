import {
  CreateTableCommand,
  DescribeTableCommand,
  UpdateContinuousBackupsCommand,
  UpdateTimeToLiveCommand,
  waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";
import { toItem } from "./dynamoItems.js";
import { dynamoJobCollection, JOB_INDEXES, JOB_QUEUES } from "./jobStore.js";
import { CORE_DEFINITIONS, dynamoCoreCollection, UNIQUE_KEYS_STORE } from "./coreStore.js";

/**
 * Every DynamoDB table the application uses, in one place, so the setup
 * script, the tests and the migration plan cannot drift apart. Names are
 * prefixed with DYNAMODB_TABLE_PREFIX (facultytrack- by default).
 *
 * Tables are added here as their stores move off MongoDB. itemFromDocument
 * turns a MongoDB document into its DynamoDB item for the copy and compare
 * scripts, keyOf identifies an item for the comparison, and ignoreOnCompare
 * lists bookkeeping attributes MongoDB does not have. indexes are global
 * secondary indexes keyed on one attribute (all attributes projected), and
 * ttlAttribute names the epoch-seconds attribute DynamoDB expires items by.
 */
const byId = {
  attributes: [{ AttributeName: "_id", AttributeType: "S" }],
  keySchema: [{ AttributeName: "_id", KeyType: "HASH" }],
  itemFromDocument: (document) => toItem(document),
  keyOf: (item) => String(item._id),
};

export const DYNAMO_TABLES = Object.freeze([
  { store: "app_settings", ...byId },
  { store: "report_delivery_runs", ...byId },
  {
    store: "evaluations",
    // The pair is the MongoDB unique index (attendance_id, kind).
    attributes: [
      { AttributeName: "attendance_id", AttributeType: "S" },
      { AttributeName: "kind", AttributeType: "S" },
    ],
    keySchema: [
      { AttributeName: "attendance_id", KeyType: "HASH" },
      { AttributeName: "kind", KeyType: "RANGE" },
    ],
    // Evaluations stored before check-out analysis existed have no kind;
    // all of them are check-ins (see evaluationFilter).
    itemFromDocument: (document) => {
      const item = toItem(document);
      return { ...item, attendance_id: String(item.attendance_id), kind: item.kind === "checkout" ? "checkout" : "checkin" };
    },
    keyOf: (item) => `${item.attendance_id}#${item.kind}`,
  },
  // The four job queues (see jobStore.js). "active" lists jobs a worker or
  // sweep may look for by status; "by_attendance" answers the deletes that
  // cancel every job of an attendance record.
  ...Object.keys(JOB_QUEUES).map((store) => ({
    store,
    attributes: [
      { AttributeName: "_id", AttributeType: "S" },
      { AttributeName: JOB_INDEXES.active.attribute, AttributeType: "S" },
      { AttributeName: JOB_INDEXES.byAttendance.attribute, AttributeType: "S" },
    ],
    keySchema: [{ AttributeName: "_id", KeyType: "HASH" }],
    indexes: [
      { name: JOB_INDEXES.active.indexName, attribute: JOB_INDEXES.active.attribute },
      { name: JOB_INDEXES.byAttendance.indexName, attribute: JOB_INDEXES.byAttendance.attribute },
    ],
    ttlAttribute: "ttl",
    itemFromDocument: (document) => dynamoJobCollection(store).itemFromDocument(document),
    keyOf: (item) => String(item._id),
    ignoreOnCompare: ["rev"],
  })),
  // The collections that share transactions, and the reservation items that
  // stand in for their unique indexes.
  ...Object.entries(CORE_DEFINITIONS).map(([store, definition]) => {
    const indexes = Object.entries(definition.indexes || {});
    const attributes = new Map([["_id", "S"]]);
    for (const [, index] of indexes) {
      attributes.set(index.attribute, "S");
      if (index.sortAttribute) attributes.set(index.sortAttribute, "S");
    }
    return {
      store,
      attributes: [...attributes].map(([AttributeName, AttributeType]) => ({ AttributeName, AttributeType })),
      keySchema: [{ AttributeName: "_id", KeyType: "HASH" }],
      indexes: indexes.map(([name, index]) => ({
        name,
        attribute: index.attribute,
        sortAttribute: index.sortAttribute,
      })),
      itemFromDocument: (document) => dynamoCoreCollection(store).itemFromDocument(document),
      keyOf: (item) => String(item._id),
      ignoreOnCompare: ["rev", ...Object.keys(definition.derive({}))],
    };
  }),
  { store: UNIQUE_KEYS_STORE, ...byId },
]);

export function dynamoTableDefinition(store) {
  const definition = DYNAMO_TABLES.find((table) => table.store === store);
  if (!definition) throw new Error(`No DynamoDB table is defined for ${store}`);
  return definition;
}

function sameKeySchema(actual = [], expected = []) {
  const normalise = (schema) => schema.map((key) => `${key.AttributeName}:${key.KeyType}`).join(",");
  return normalise(actual) === normalise(expected);
}

// Right after CreateTable, AWS is still setting up backups for the table and
// refuses to change them for a minute or two.
const BACKUP_RETRY_DELAYS_MS = [5_000, 10_000, 20_000, 30_000, 30_000, 30_000, 30_000, 30_000];

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * Turns point-in-time recovery on. Asking again when it is already on
 * changes nothing, so this runs for every table on each --apply: a table
 * whose first attempt failed is fixed by simply running the command again.
 */
async function enableBackups(client, name, sleep) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await client.send(new UpdateContinuousBackupsCommand({
        TableName: name,
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      }));
      return true;
    } catch (error) {
      if (error?.name !== "ContinuousBackupsUnavailableException") throw error;
      if (attempt >= BACKUP_RETRY_DELAYS_MS.length) return false;
      await sleep(BACKUP_RETRY_DELAYS_MS[attempt]);
    }
  }
}

/**
 * Creates the tables that are missing and reports the rest. Never deletes or
 * alters an existing table; a table whose key or indexes differ from the
 * definition is reported as a conflict for a person to resolve.
 *
 * Pay-per-request billing (no capacity to plan, no throttling at the 9 AM
 * rush). Deletion protection and point-in-time recovery are on for real AWS
 * tables; DynamoDB Local and test doubles do not support them, so
 * protect: false leaves them, and expiry, out. With apply, backups and
 * expiry are switched on for existing tables too, so a table whose first
 * attempt failed is fixed by running the command again.
 */
/**
 * Switches DynamoDB's expiry on, reading `attribute` (epoch seconds). It is
 * the counterpart of MongoDB's TTL index on expires_at: finished jobs are
 * removed about a week after they end. AWS refuses to enable it twice, which
 * here means it is already on.
 */
async function enableExpiry(client, name, attribute) {
  try {
    await client.send(new UpdateTimeToLiveCommand({
      TableName: name,
      TimeToLiveSpecification: { Enabled: true, AttributeName: attribute },
    }));
    return true;
  } catch (error) {
    if (error?.name === "ValidationException" && /already enabled/i.test(error.message || "")) return true;
    throw error;
  }
}

export async function ensureDynamoTables(client, {
  prefix = "facultytrack-",
  apply = false,
  protect = true,
  tables = DYNAMO_TABLES,
  sleep = wait,
} = {}) {
  const report = {
    existing: [], created: [], missing: [], conflicts: [], backups: [], backupsPending: [], expiry: [],
  };
  const protectTable = async (name, definition) => {
    if (!apply || !protect) return;
    if (await enableBackups(client, name, sleep)) report.backups.push(name);
    else report.backupsPending.push(name);
    if (definition.ttlAttribute && await enableExpiry(client, name, definition.ttlAttribute)) {
      report.expiry.push(name);
    }
  };
  for (const definition of tables) {
    const name = `${prefix}${definition.store}`;
    let description = null;
    try {
      ({ Table: description } = await client.send(new DescribeTableCommand({ TableName: name })));
    } catch (error) {
      if (error?.name !== "ResourceNotFoundException") throw error;
    }

    if (description) {
      const presentIndexes = new Set((description.GlobalSecondaryIndexes || []).map((index) => index.IndexName));
      const missingIndexes = (definition.indexes || []).filter((index) => !presentIndexes.has(index.name));
      if (!sameKeySchema(description.KeySchema, definition.keySchema)) {
        report.conflicts.push(`${name}: key schema differs from the definition`);
      } else if (missingIndexes.length) {
        report.conflicts.push(`${name}: missing index ${missingIndexes.map((index) => index.name).join(", ")}`);
      } else {
        report.existing.push(name);
        await protectTable(name, definition);
      }
      continue;
    }
    if (!apply) {
      report.missing.push(name);
      continue;
    }

    await client.send(new CreateTableCommand({
      TableName: name,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: definition.attributes,
      KeySchema: definition.keySchema,
      ...(definition.indexes?.length ? {
        GlobalSecondaryIndexes: definition.indexes.map((index) => ({
          IndexName: index.name,
          KeySchema: [
            { AttributeName: index.attribute, KeyType: "HASH" },
            ...(index.sortAttribute ? [{ AttributeName: index.sortAttribute, KeyType: "RANGE" }] : []),
          ],
          Projection: { ProjectionType: "ALL" },
        })),
      } : {}),
      ...(protect ? { DeletionProtectionEnabled: true } : {}),
      Tags: [{ Key: "app", Value: "facultytrack" }],
    }));
    // Checked every 2-10 s rather than the SDK's default 20 s: a table with
    // indexes is rarely ready at the first check.
    await waitUntilTableExists({ client, maxWaitTime: 180, minDelay: 2, maxDelay: 10 }, { TableName: name });
    report.created.push(name);
    await protectTable(name, definition);
  }
  return report;
}
