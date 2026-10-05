import "dotenv/config";
import { createDynamoClient, dynamoConfig } from "../src/config/dynamo.js";
import { ensureDynamoTables } from "../src/stores/dynamoTables.js";

/**
 * Checks, and with --apply creates, the DynamoDB tables in DYNAMO_TABLES.
 *
 *   npm run dynamo:tables          report only, changes nothing
 *   npm run dynamo:tables:apply    create the missing tables
 *
 * Uses DYNAMODB_REGION and the DYNAMODB_* keys, or DYNAMODB_ENDPOINT for
 * DynamoDB Local. Existing tables are never changed or deleted.
 */
const apply = process.argv.includes("--apply");
const config = dynamoConfig();

if (!config.region && !config.endpoint) {
  console.error("Set DYNAMODB_REGION (or DYNAMODB_ENDPOINT for DynamoDB Local).");
  process.exitCode = 2;
} else {
  let client;
  try {
    client = createDynamoClient(config);
    const report = await ensureDynamoTables(client, {
      prefix: config.tablePrefix,
      apply,
      protect: !config.endpoint,
    });
    for (const name of report.existing) console.log(`ok       ${name}`);
    for (const name of report.created) console.log(`created  ${name}`);
    for (const name of report.missing) console.log(`missing  ${name}`);
    for (const problem of report.conflicts) console.log(`CONFLICT ${problem}`);
    for (const name of report.backups) console.log(`backups  ${name} (point-in-time recovery on)`);
    for (const name of report.expiry) console.log(`expiry   ${name} (finished jobs removed after a week)`);
    for (const name of report.backupsPending) {
      console.log(`WAITING  ${name}: AWS is still preparing backups; run this command again in a few minutes`);
    }
    if (report.missing.length) {
      console.log("Read-only mode made no changes. Run npm run dynamo:tables:apply to create the missing tables.");
    }
    if (report.conflicts.length || report.backupsPending.length) process.exitCode = 2;
  } catch (error) {
    console.error(`DynamoDB table check failed (${error?.name || "Error"}): ${error?.message || ""}`);
    process.exitCode = 2;
  } finally {
    client?.destroy();
  }
}
