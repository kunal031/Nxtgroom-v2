import "dotenv/config";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { DescribeTableCommand, DescribeTimeToLiveCommand } from "@aws-sdk/client-dynamodb";
import {
  createDynamoClient,
  dataRoute,
  dynamoConfig,
  dynamoConfigurationErrors,
  DYNAMO_STORES,
} from "../src/config/dynamo.js";
import { CORE_ROUTE_STORE, CORE_STORES, UNIQUE_KEYS_STORE } from "../src/stores/coreStore.js";
import { DYNAMO_TABLES, dynamoTableDefinition } from "../src/stores/dynamoTables.js";

/**
 * Is the DynamoDB side still in step with the code?
 *
 *   npm run dynamo:doctor
 *
 * Run it after merging someone else's work. New code that calls
 * db.collection(...) directly keeps reading MongoDB whatever the switches
 * say, so a store already moved to DynamoDB would quietly serve stale data
 * through it. That is the first and most important check here.
 *
 * Read-only: it describes tables and reads source files, and changes
 * nothing. Point it at a local DynamoDB with DYNAMODB_ENDPOINT, or leave
 * that unset to look at the real tables.
 */

const SOURCE_ROOTS = ["src", "."];
// databasePreflight audits MongoDB's own indexes and documents, which stays a
// MongoDB job whatever the routes use.
const ALLOWED_DIRECT = new Set(["src/config/databasePreflight.js"]);

let failures = 0;
let warnings = 0;

const ok = (message) => console.log(`  ok       ${message}`);
const warn = (message) => { warnings += 1; console.log(`  warning  ${message}`); };
const bad = (message) => { failures += 1; console.log(`  PROBLEM  ${message}`); };

async function sourceFiles() {
  const found = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".js")) found.push(full);
    }
  };
  await walk("src");
  for (const name of ["server.js", "worker.js"]) found.push(name);
  return found;
}

async function checkNothingBypassesTheStores() {
  console.log("\n1. Does any code still talk to MongoDB directly?");
  const offenders = [];
  for (const file of await sourceFiles()) {
    if (file.startsWith(path.join("src", "stores")) || ALLOWED_DIRECT.has(file)) continue;
    const source = await readFile(file, "utf8");
    for (const [index, line] of source.split("\n").entries()) {
      const match = line.match(/db\.collection\(\s*"([^"]+)"/);
      if (match) offenders.push(`${file}:${index + 1} reads ${match[1]} directly`);
    }
  }
  if (!offenders.length) {
    ok("every collection call goes through a store");
    return;
  }
  bad(`${offenders.length} call(s) bypass the stores and would ignore the switches:`);
  for (const offender of offenders.slice(0, 20)) console.log(`             ${offender}`);
  if (offenders.length > 20) console.log(`             ... and ${offenders.length - 20} more`);
  console.log("           Route them through coreCollection or jobCollection.");
}

function checkTheSwitchesMakeSense() {
  console.log("\n2. Are the switches valid?");
  const errors = dynamoConfigurationErrors();
  if (errors.length) {
    for (const error of errors) bad(error);
    return [];
  }
  const live = [];
  for (const store of DYNAMO_STORES) {
    const route = dataRoute(store);
    if (route.writeTo === "mongo" && route.readFrom === "mongo") continue;
    live.push({ store, ...route });
  }
  ok(`settings are consistent; ${live.length} store(s) use DynamoDB`);
  for (const { store, writeTo, readFrom } of live) {
    console.log(`           ${store}: write=${writeTo} read=${readFrom}`);
  }
  if (!live.length) console.log("           everything is on MongoDB, which is the default");
  return live;
}

function tablesFor(live) {
  const names = new Set();
  for (const { store } of live) {
    if (store === CORE_ROUTE_STORE) {
      for (const name of [...CORE_STORES, UNIQUE_KEYS_STORE]) names.add(name);
    } else names.add(store);
  }
  return [...names];
}

async function checkTheTables(client, needed) {
  console.log("\n3. Do the tables exist, with the indexes their queries read?");
  const config = dynamoConfig();
  console.log(`   looking at ${config.endpoint || `AWS ${config.region || "(no region)"}`}, prefix "${config.tablePrefix}"`);

  for (const definition of DYNAMO_TABLES) {
    const name = `${config.tablePrefix}${definition.store}`;
    const required = needed.includes(definition.store);
    let table;
    try {
      ({ Table: table } = await client.send(new DescribeTableCommand({ TableName: name })));
    } catch (error) {
      if (error?.name !== "ResourceNotFoundException") throw error;
      if (required) bad(`${name} does not exist, but ${definition.store} is switched to DynamoDB`);
      else console.log(`  -        ${name} not created (not needed yet)`);
      continue;
    }

    const present = new Set((table.GlobalSecondaryIndexes || []).map((index) => index.IndexName));
    const missing = (definition.indexes || []).filter((index) => !present.has(index.name));
    if (missing.length) {
      const detail = `${name} is missing index ${missing.map((index) => index.name).join(", ")}`;
      if (required) bad(detail);
      else warn(detail);
      continue;
    }

    let expiry = "";
    if (definition.ttlAttribute) {
      const { TimeToLiveDescription } = await client.send(new DescribeTimeToLiveCommand({ TableName: name }));
      const status = TimeToLiveDescription?.TimeToLiveStatus;
      if (status !== "ENABLED") {
        // Without expiry the finished jobs are kept for ever; MongoDB drops
        // them with a TTL index.
        if (config.endpoint) expiry = " (expiry off, which DynamoDB Local does not support)";
        else if (required) { warn(`${name} has no expiry; finished jobs will never be removed`); continue; }
        else expiry = " (expiry off)";
      }
    }
    ok(`${name}${expiry}`);
  }
}

async function checkItAnswers(client, needed) {
  console.log("\n4. Does DynamoDB answer?");
  if (!needed.length) {
    ok("nothing to ask: every store is on MongoDB");
    return;
  }
  const config = dynamoConfig();
  const store = needed[0];
  const { keySchema } = dynamoTableDefinition(store);
  const Key = Object.fromEntries(keySchema.map((part) => [part.AttributeName, "__doctor__"]));
  const { GetCommand, DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
  const documents = DynamoDBDocumentClient.from(client);
  try {
    await documents.send(new GetCommand({ TableName: `${config.tablePrefix}${store}`, Key }));
    ok(`a key lookup on ${config.tablePrefix}${store} succeeded`);
  } catch (error) {
    bad(`${error?.name}: ${String(error?.message || "").slice(0, 160)}`);
  }
}

const config = dynamoConfig();
let client;
try {
  await checkNothingBypassesTheStores();
  const live = checkTheSwitchesMakeSense();
  const needed = tablesFor(live);

  if (!config.region && !config.endpoint) {
    console.log("\n3. Tables\n  -        no DYNAMODB_REGION or DYNAMODB_ENDPOINT set, so there is nothing to look at");
  } else {
    client = createDynamoClient(config);
    await checkTheTables(client, needed);
    await checkItAnswers(client, needed);
  }

  console.log(
    `\n${failures ? "PROBLEMS FOUND" : "All good"}: ${failures} problem(s), ${warnings} warning(s).`
    + (failures ? "\nA problem means the running code and DynamoDB disagree." : "")
  );
  if (failures) process.exitCode = 1;
} catch (error) {
  console.error(`\nThe check itself failed (${error?.name || "Error"}): ${error?.message || ""}`);
  process.exitCode = 2;
} finally {
  client?.destroy();
}
