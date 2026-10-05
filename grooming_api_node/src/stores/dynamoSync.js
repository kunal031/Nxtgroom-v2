import { BatchWriteCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
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

async function scanAll(client, tableName) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const page = await client.send(new ScanCommand({ TableName: tableName, ExclusiveStartKey, ConsistentRead: true }));
    items.push(...(page.Items || []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
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
  const comparable = (item) => {
    const copy = { ...item };
    for (const field of ignoreOnCompare) delete copy[field];
    return canonical(copy);
  };
  const mongo = new Map();
  for await (const document of db.collection(store).find({})) {
    const item = itemFromDocument(document);
    mongo.set(keyOf(item), comparable(item));
  }
  const dynamo = new Map();
  for (const item of await scanAll(client, tableName)) dynamo.set(keyOf(item), comparable(item));

  const onlyInMongo = [...mongo.keys()].filter((id) => !dynamo.has(id));
  const onlyInDynamo = [...dynamo.keys()].filter((id) => !mongo.has(id));
  const different = [...mongo.keys()].filter((id) => dynamo.has(id) && dynamo.get(id) !== mongo.get(id));
  return {
    store,
    tableName,
    mongoCount: mongo.size,
    dynamoCount: dynamo.size,
    matches: !onlyInMongo.length && !onlyInDynamo.length && !different.length,
    onlyInMongo: onlyInMongo.slice(0, REPORT_LIMIT),
    onlyInDynamo: onlyInDynamo.slice(0, REPORT_LIMIT),
    different: different.slice(0, REPORT_LIMIT),
  };
}
