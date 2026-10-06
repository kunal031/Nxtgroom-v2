import { createDynamoClient, dynamoConfig, DYNAMO_STORES, usesDynamo } from "../config/dynamo.js";
import { CORE_ROUTE_STORE, CORE_STORES, UNIQUE_KEYS_STORE } from "./coreStore.js";
import { dynamoTableDefinition, ensureDynamoTables } from "./dynamoTables.js";

/**
 * The tables the current switches actually need.
 *
 * A store still on MongoDB needs no table, so a half-finished migration is
 * not asked for tables nobody reads yet. The core group is one switch over
 * six collections, and it also needs the reservation table that stands in
 * for their unique indexes.
 */
export function requiredDynamoStores(stores = DYNAMO_STORES) {
  const required = [];
  for (const store of stores) {
    if (!usesDynamo(store)) continue;
    if (store === CORE_ROUTE_STORE) required.push(...CORE_STORES, UNIQUE_KEYS_STORE);
    else required.push(store);
  }
  return required;
}

/**
 * Checks, before the process serves anything, that every table the switches
 * point at exists and has the indexes its queries read.
 *
 * Nothing is created: a missing table is a deployment step that has not been
 * run, and creating it here would hide that while serving empty results. The
 * check is skipped entirely while everything is on MongoDB, so it costs
 * nothing until a store actually moves.
 */
export async function verifyDynamoTables({ client, log = console.log } = {}) {
  const stores = requiredDynamoStores();
  if (!stores.length) return { checked: [], skipped: true };

  const config = dynamoConfig();
  const owned = !client;
  const dynamo = client || createDynamoClient(config);
  try {
    const report = await ensureDynamoTables(dynamo, {
      prefix: config.tablePrefix,
      apply: false,
      tables: stores.map(dynamoTableDefinition),
    });
    const problems = [
      ...report.missing.map((name) => `${name} does not exist`),
      ...report.conflicts,
    ];
    if (problems.length) {
      throw new Error(
        `DynamoDB is not ready for the configured switches: ${problems.join("; ")}. `
        + "Run npm run dynamo:tables:apply, or move the store back to MongoDB."
      );
    }
    log(`DynamoDB ready: ${report.existing.join(", ")}.`);
    return { checked: report.existing, skipped: false };
  } finally {
    if (owned) dynamo.destroy();
  }
}
