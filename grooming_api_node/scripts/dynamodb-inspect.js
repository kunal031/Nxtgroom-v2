import "dotenv/config";
import { DescribeTableCommand, DescribeTimeToLiveCommand } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { createDynamoClient, dynamoConfig, dynamoTableName } from "../src/config/dynamo.js";
import { CORE_ROUTE_STORE, CORE_STORES, UNIQUE_KEYS_STORE } from "../src/stores/coreStore.js";
import { DYNAMO_TABLES, dynamoTableDefinition } from "../src/stores/dynamoTables.js";

/**
 * Look at what is actually in DynamoDB, while the app is running.
 *
 *   npm run dynamo:inspect                     every table: item count and indexes
 *   npm run dynamo:inspect -- --store attendance        the rows, newest first
 *   npm run dynamo:inspect -- --store attendance --index by_day --key 2026-10-06
 *   npm run dynamo:inspect -- --store users --limit 5
 *   npm run dynamo:inspect -- --watch           re-read every 2 s until Ctrl-C
 *
 * Read-only: it never writes. Point it at a local DynamoDB with
 * DYNAMODB_ENDPOINT, or leave that unset to look at the real tables.
 */

const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(`--${name}`);
  return at > -1 ? argv[at + 1] : undefined;
};
const has = (name) => argv.includes(`--${name}`);

const store = flag("store");
const index = flag("index");
const key = flag("key");
const limit = Number(flag("limit") || 10);
const watch = has("watch");

const config = dynamoConfig();
const raw = createDynamoClient(config);
const client = DynamoDBDocumentClient.from(raw);

const stores = DYNAMO_TABLES.map((table) => table.store);

function expand(name) {
  return name === CORE_ROUTE_STORE ? [...CORE_STORES, UNIQUE_KEYS_STORE] : [name];
}

async function overview() {
  console.log(`\nDynamoDB at ${config.endpoint || "AWS " + config.region}, prefix "${config.tablePrefix}"`);
  console.log("".padEnd(78, "-"));
  for (const name of stores) {
    const table = dynamoTableName(name);
    try {
      const { Table } = await raw.send(new DescribeTableCommand({ TableName: table }));
      let expiry = "";
      const definition = dynamoTableDefinition(name);
      if (definition.ttlAttribute) {
        const ttl = await raw.send(new DescribeTimeToLiveCommand({ TableName: table }));
        expiry = ` ttl=${ttl.TimeToLiveDescription?.TimeToLiveStatus ?? "?"}`;
      }
      const indexes = (Table.GlobalSecondaryIndexes || []).map((gsi) => gsi.IndexName);
      console.log(
        `${name.padEnd(22)} ${String(Table.ItemCount).padStart(7)} items  ${Table.TableStatus}${expiry}`
        + (indexes.length ? `\n${"".padEnd(23)}indexes: ${indexes.join(", ")}` : "")
      );
    } catch (error) {
      const why = error.name === "ResourceNotFoundException" ? "not created yet" : error.name;
      console.log(`${name.padEnd(22)} ${why}`);
    }
  }
  console.log(
    "\nItem counts are updated by AWS about every six hours, so they lag."
    + "\nUse --store <name> to read the rows themselves.\n"
  );
}

async function rows(name) {
  const table = dynamoTableName(name);
  // A consistent read is not allowed on a global secondary index.
  const input = { TableName: table, Limit: limit, ConsistentRead: !index };
  let command;
  if (index) {
    if (!key) throw new Error("--index needs --key, the value to look up");
    const { attribute } = dynamoTableDefinition(name).indexes.find((one) => one.name === index)
      ?? (() => { throw new Error(`${name} has no index "${index}"`); })();
    command = new QueryCommand({
      ...input,
      IndexName: index,
      KeyConditionExpression: "#partition = :value",
      ExpressionAttributeNames: { "#partition": attribute },
      ExpressionAttributeValues: { ":value": key },
      ScanIndexForward: false,
    });
  } else {
    command = new ScanCommand(input);
  }

  const { Items = [], Count, ScannedCount } = await client.send(command);
  const how = index ? `index ${index} where ${key}` : "scan";
  console.log(`\n${table} (${how}) - ${Count} row(s)${ScannedCount ? `, ${ScannedCount} read` : ""}`);
  console.log("".padEnd(78, "-"));
  for (const item of Items) console.log(JSON.stringify(item, null, 2));
  if (!Items.length) console.log("(empty)");
  console.log();
}

async function run() {
  if (!store) return overview();
  for (const name of expand(store)) {
    if (!stores.includes(name)) throw new Error(`Unknown store "${name}". Known: ${stores.join(", ")}`);
    await rows(name);
  }
  return undefined;
}

try {
  if (watch) {
    for (;;) {
      process.stdout.write("\x1Bc");
      await run();
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  } else {
    await run();
  }
} catch (error) {
  console.error(`Inspect failed (${error?.name || "Error"}): ${error?.message || ""}`);
  process.exitCode = 1;
} finally {
  if (!watch) raw.destroy();
}
