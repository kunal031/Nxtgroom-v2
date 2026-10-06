import { createHash } from "node:crypto";
import { BatchWriteCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { DATE_FIELDS } from "./dynamoItems.js";
import { dynamoTableDefinition } from "./dynamoTables.js";

/**
 * One-off copy of a MongoDB collection into its DynamoDB table, and the
 * comparison that proves the two agree while writes go to both.
 *
 * MongoDB is only ever read here. The copy overwrites DynamoDB items with the
 * MongoDB version, which is the source of truth until reads move.
 */
const BATCH_SIZE = 25;
const MAX_BATCH_ATTEMPTS = 8;
const REPORT_LIMIT = 50;

async function writeBatch(client, tableName, items) {
  let pending = { [tableName]: items.map((Item) => ({ PutRequest: { Item } })) };
  for (let attempt = 1; attempt <= MAX_BATCH_ATTEMPTS; attempt += 1) {
    const { UnprocessedItems } = await client.send(new BatchWriteCommand({ RequestItems: pending }));
    if (!UnprocessedItems || !Object.keys(UnprocessedItems).length) return;
    pending = UnprocessedItems;
    await new Promise((resolve) => setTimeout(resolve, Math.min(2000, 50 * 2 ** attempt)));
  }
  throw new Error(`${tableName}: DynamoDB kept returning unprocessed items`);
}

export async function copyCollectionToDynamo(db, client, { store, tableName, apply = false }) {
  const { itemFromDocument } = dynamoTableDefinition(store);
  let copied = 0;
  let batch = [];
  for await (const document of db.collection(store).find({})) {
    copied += 1;
    if (!apply) continue;
    batch.push(itemFromDocument(document));
    if (batch.length === BATCH_SIZE) {
      await writeBatch(client, tableName, batch);
      batch = [];
    }
  }
  if (apply && batch.length) await writeBatch(client, tableName, batch);
  return { store, tableName, documents: copied, written: apply ? copied : 0 };
}

/** Every item in the table, a page at a time, so no page is held after use. */
async function* scanPages(client, tableName) {
  let ExclusiveStartKey;
  do {
    const page = await client.send(new ScanCommand({ TableName: tableName, ExclusiveStartKey, ConsistentRead: true }));
    yield* page.Items || [];
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
}

export class MissingTableError extends Error {
  constructor(tableName) {
    super(`${tableName} does not exist; run npm run dynamo:tables:apply`);
    this.name = "MissingTableError";
    this.tableName = tableName;
  }
}

/** Stable JSON: object keys sorted, so field order never counts as a difference. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function compareCollectionWithDynamo(db, client, { store, tableName }) {
  const { itemFromDocument, keyOf, ignoreOnCompare = [] } = dynamoTableDefinition(store);
  // A digest rather than the row: evaluations grows without bound, and
  // holding every document of both databases at once is what would stop
  // this command working on exactly the table that most needs checking.
  const fingerprint = (item) => {
    const copy = { ...item };
    // Every stored item records which fields were dates; MongoDB has no
    // such field, so it is never a difference.
    delete copy[DATE_FIELDS];
    for (const field of ignoreOnCompare) delete copy[field];
    return createHash("sha1").update(canonical(copy)).digest("base64");
  };

  const mongo = new Map();
  for await (const document of db.collection(store).find({})) {
    const item = itemFromDocument(document);
    mongo.set(keyOf(item), fingerprint(item));
  }

  // Walking DynamoDB second lets each item be matched and dropped as it
  // arrives, so only the unmatched keys are still held at the end.
  const onlyInDynamo = [];
  const different = [];
  let dynamoCount = 0;
  let onlyInDynamoCount = 0;
  // An absent table is a deployment step that has not run, not a table whose
  // rows are missing: saying "DynamoDB 0" for it reads as lost data. The scan
  // is still consumed a page at a time, so nothing is buffered to find out.
  const scan = scanPages(client, tableName)[Symbol.asyncIterator]();
  const nextItem = async () => {
    try {
      return await scan.next();
    } catch (error) {
      if (error?.name === "ResourceNotFoundException") throw new MissingTableError(tableName);
      throw error;
    }
  };
  for (let step = await nextItem(); !step.done; step = await nextItem()) {
    const item = step.value;
    dynamoCount += 1;
    const key = keyOf(item);
    if (!mongo.has(key)) {
      onlyInDynamoCount += 1;
      if (onlyInDynamo.length < REPORT_LIMIT) onlyInDynamo.push(key);
      continue;
    }
    if (mongo.get(key) !== fingerprint(item)) {
      if (different.length < REPORT_LIMIT) different.push(key);
    }
    // Matched either way: what stays in the map is what DynamoDB lacks.
    mongo.delete(key);
  }

  const mongoCount = mongo.size + dynamoCount - onlyInDynamoCount;
  const onlyInMongo = [...mongo.keys()];
  return {
    store,
    tableName,
    mongoCount,
    dynamoCount,
    matches: !onlyInMongo.length && !onlyInDynamo.length && !different.length,
    onlyInMongo: onlyInMongo.slice(0, REPORT_LIMIT),
    onlyInDynamo,
    different,
  };
}
