import "dotenv/config";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { MongoClient } from "mongodb";
import { createDynamoClient, dynamoConfig, DYNAMO_STORES } from "../src/config/dynamo.js";
import { runtimeConfig } from "../src/config/env.js";
import { compareCollectionWithDynamo, copyCollectionToDynamo } from "../src/stores/dynamoSync.js";

/**
 * Copy MongoDB collections into DynamoDB, or compare the two.
 *
 *   npm run dynamo:compare                         every migrated store
 *   npm run dynamo:compare -- --store app_settings one store
 *   npm run dynamo:copy                            count only, writes nothing
 *   npm run dynamo:copy -- --apply                 copy (MongoDB is only read)
 *
 * compare exits 1 when the databases differ, so it can run on a schedule.
 */
const [mode] = process.argv.slice(2);
const apply = process.argv.includes("--apply");
const storeIndex = process.argv.indexOf("--store");
const stores = storeIndex > -1 ? [process.argv[storeIndex + 1]] : DYNAMO_STORES;

if (!["copy", "compare"].includes(mode)) {
  console.error("Usage: node scripts/dynamodb-sync.js copy|compare [--store name] [--apply]");
  process.exitCode = 2;
} else if (stores.some((store) => !DYNAMO_STORES.includes(store))) {
  console.error(`Unknown store. Migrated stores: ${DYNAMO_STORES.join(", ")}`);
  process.exitCode = 2;
} else {
  const config = runtimeConfig();
  const dynamo = dynamoConfig();
  const mongoClient = new MongoClient(config.mongoUri, {
    appName: "facultytrack-dynamodb-sync",
    maxPoolSize: 2,
    serverSelectionTimeoutMS: 10000,
  });
  let rawClient;
  try {
    rawClient = createDynamoClient(dynamo);
    const client = DynamoDBDocumentClient.from(rawClient, { marshallOptions: { removeUndefinedValues: true } });
    await mongoClient.connect();
    const db = mongoClient.db(config.dbName);
    for (const store of stores) {
      const tableName = `${dynamo.tablePrefix}${store}`;
      if (mode === "copy") {
        const result = await copyCollectionToDynamo(db, client, { store, tableName, apply });
        console.log(apply
          ? `${store}: copied ${result.written} document(s) into ${tableName}`
          : `${store}: ${result.documents} document(s) would be copied into ${tableName} (add --apply)`);
      } else {
        const result = await compareCollectionWithDynamo(db, client, { store, tableName });
        console.log(result.matches
          ? `${store}: identical (${result.mongoCount} document(s))`
          : `${store}: DIFFERENT. MongoDB ${result.mongoCount}, DynamoDB ${result.dynamoCount}\n`
            + `  only in MongoDB:  ${result.onlyInMongo.join(", ") || "-"}\n`
            + `  only in DynamoDB: ${result.onlyInDynamo.join(", ") || "-"}\n`
            + `  different:        ${result.different.join(", ") || "-"}`);
        if (!result.matches) process.exitCode = 1;
      }
    }
  } catch (error) {
    console.error(`DynamoDB ${mode} failed (${error?.name || "Error"}): ${error?.message || ""}`);
    process.exitCode = 2;
  } finally {
    await mongoClient.close().catch(() => {});
    rawClient?.destroy();
  }
}
