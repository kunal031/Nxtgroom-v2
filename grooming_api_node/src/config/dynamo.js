import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

/**
 * DynamoDB connection and the per-store switches that move data off MongoDB
 * one collection at a time. See docs/DYNAMODB_MIGRATION_PLAN.md.
 *
 * Each store answers two questions, set in the environment:
 *
 *   DB_WRITE_TO   mongo | both | dynamo   where writes go
 *   DB_READ_FROM  mongo | dynamo          where reads come from
 *
 * with an optional per-store override, e.g. DB_READ_FROM_APP_SETTINGS. The
 * default is MongoDB for everything, so an unset environment behaves exactly
 * as before this module existed.
 */

/** Collections that have a DynamoDB implementation. Grows as stores move. */
export const DYNAMO_STORES = Object.freeze([
  "app_settings",
  "report_delivery_runs",
  "evaluations",
  "evaluation_jobs",
  "notification_jobs",
  "mail_jobs",
  "storage_cleanup_jobs",
  // The collections that share MongoDB transactions switch together, under
  // one name: DB_WRITE_TO_CORE / DB_READ_FROM_CORE (see coreStore.js).
  "core",
]);

const WRITE_TARGETS = ["mongo", "both", "dynamo"];
const READ_SOURCES = ["mongo", "dynamo"];

function routeSetting(name, store, allowed) {
  const specific = process.env[`${name}_${store.toUpperCase()}`];
  const raw = specific?.trim() ? specific : process.env[name];
  const value = raw?.trim() ? raw.trim().toLowerCase() : "mongo";
  if (!allowed.includes(value)) {
    const source = specific?.trim() ? `${name}_${store.toUpperCase()}` : name;
    throw new Error(`${source} must be one of: ${allowed.join(", ")}`);
  }
  return value;
}

/**
 * Where one store reads and writes.
 *
 * Reads must come from a database that is written: reading DynamoDB while it
 * receives no writes would serve stale data, and writing only DynamoDB while
 * reading MongoDB would lose every write from the user's point of view.
 */
export function dataRoute(store) {
  if (!DYNAMO_STORES.includes(store)) return { writeTo: "mongo", readFrom: "mongo" };
  const writeTo = routeSetting("DB_WRITE_TO", store, WRITE_TARGETS);
  const readFrom = routeSetting("DB_READ_FROM", store, READ_SOURCES);
  if (readFrom === "dynamo" && writeTo === "mongo") {
    throw new Error(`${store} reads from DynamoDB but writes only to MongoDB; set DB_WRITE_TO to both or dynamo`);
  }
  if (readFrom === "mongo" && writeTo === "dynamo") {
    throw new Error(`${store} reads from MongoDB but writes only to DynamoDB; set DB_WRITE_TO to both or mongo`);
  }
  return { writeTo, readFrom };
}

export function usesDynamo(store) {
  const route = dataRoute(store);
  return route.writeTo !== "mongo" || route.readFrom === "dynamo";
}

export function dynamoConfig() {
  return {
    region: (process.env.DYNAMODB_REGION || "").trim(),
    // Only for DynamoDB Local or a test double. Unset on a real server.
    endpoint: (process.env.DYNAMODB_ENDPOINT || "").trim(),
    tablePrefix: (process.env.DYNAMODB_TABLE_PREFIX ?? "facultytrack-").trim(),
    // Deliberately no fallback to AWS_ACCESS_KEY_ID. That key belongs to the
    // SES sender; reusing it would fail as AccessDenied, which reads like a
    // broken policy rather than a missing setting.
    accessKeyId: (process.env.DYNAMODB_ACCESS_KEY_ID || "").trim(),
    secretAccessKey: (process.env.DYNAMODB_SECRET_ACCESS_KEY || "").trim(),
  };
}

/**
 * Configuration problems, empty when DynamoDB is unused or fully configured.
 * Checked at startup in every environment: a mistyped switch should stop the
 * server, not quietly fall back to MongoDB.
 */
export function dynamoConfigurationErrors() {
  const errors = [];
  let needed = false;
  for (const store of DYNAMO_STORES) {
    try {
      if (usesDynamo(store)) needed = true;
    } catch (error) {
      errors.push(error.message);
    }
  }
  if (!needed) return errors;
  const config = dynamoConfig();
  if (!config.region) errors.push("DYNAMODB_REGION is required when any store uses DynamoDB");
  if (!config.endpoint && (!config.accessKeyId || !config.secretAccessKey)) {
    errors.push("DYNAMODB_ACCESS_KEY_ID and DYNAMODB_SECRET_ACCESS_KEY are required when any store uses DynamoDB");
  }
  if (!/^[A-Za-z0-9._-]*$/.test(config.tablePrefix)) {
    errors.push("DYNAMODB_TABLE_PREFIX may contain only letters, digits, dot, dash and underscore");
  }
  return errors;
}

export function dynamoTableName(store) {
  return `${dynamoConfig().tablePrefix}${store}`;
}

let documentClient = null;

/**
 * Credentials are always passed explicitly. Left out, the AWS SDK would look
 * for AWS_ACCESS_KEY_ID, which on the server is the SES sender's key: a
 * missing DynamoDB key then surfaced as AccessDenied for the mail user, as
 * though the policy were wrong. That is refused here with the actual cause.
 */
export function createDynamoClient(config = dynamoConfig()) {
  let credentials;
  if (config.accessKeyId && config.secretAccessKey) {
    credentials = { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey };
  } else if (config.endpoint) {
    // DynamoDB Local accepts any credentials; they only have to be present.
    credentials = { accessKeyId: "local", secretAccessKey: "local" };
  } else {
    throw new Error(
      "DYNAMODB_ACCESS_KEY_ID and DYNAMODB_SECRET_ACCESS_KEY must both be set "
      + "(the SES key is never used for DynamoDB)"
    );
  }
  return new DynamoDBClient({
    region: config.region || "ap-south-1",
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    credentials,
    maxAttempts: 3,
  });
}

/** The shared document client, created on first use. */
export function getDynamoDocumentClient() {
  if (!documentClient) {
    documentClient = DynamoDBDocumentClient.from(createDynamoClient(), {
      marshallOptions: { removeUndefinedValues: true },
    });
  }
  return documentClient;
}

/** For tests and scripts that bring their own client. null resets it. */
export function setDynamoDocumentClient(client) {
  documentClient = client;
}
