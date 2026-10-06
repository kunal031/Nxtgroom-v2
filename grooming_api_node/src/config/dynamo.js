import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

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
    endpoint: (process.env.DYNAMODB_ENDPOINT || "").trim(),
    tablePrefix: (process.env.DYNAMODB_TABLE_PREFIX ?? "facultytrack-").trim(),
    accessKeyId: (process.env.DYNAMODB_ACCESS_KEY_ID || "").trim(),
    secretAccessKey: (process.env.DYNAMODB_SECRET_ACCESS_KEY || "").trim(),
  };
}

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

export function createDynamoClient(config = dynamoConfig()) {
  let credentials;
  if (config.accessKeyId && config.secretAccessKey) {
    credentials = { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey };
  } else if (config.endpoint) {
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

export function getDynamoDocumentClient() {
  if (!documentClient) {
    documentClient = DynamoDBDocumentClient.from(createDynamoClient(), {
      marshallOptions: { removeUndefinedValues: true },
    });
  }
  return documentClient;
}

export function setDynamoDocumentClient(client) {
  documentClient = client;
}

/**
 * Releases the DynamoDB client on shutdown, the counterpart of
 * closeMongoConnection. Safe to call when nothing ever opened one.
 */
export function closeDynamoConnection() {
  if (!documentClient) return;
  try {
    documentClient.destroy();
  } catch {
    // Already torn down, or a test double without destroy: nothing to free.
  }
  documentClient = null;
}
