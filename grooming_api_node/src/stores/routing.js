import { dataRoute } from "../config/dynamo.js";
import { incrementMetric } from "../services/telemetry.js";

/**
 * Transient faults - a throttle, a dropped socket, a brief unavailability -
 * usually succeed on a second attempt moments later. A rejection the write
 * itself caused, such as a failed condition, will never succeed on a retry,
 * so it is reported immediately rather than retried.
 */
const SHADOW_RETRY_DELAYS_MS = [50, 250, 1000];

const PERMANENT_ERRORS = new Set([
  "ConditionalCheckFailedException",
  "ValidationException",
  "ResourceNotFoundException",
  "AccessDeniedException",
  "MongoServerError",
]);

function isPermanent(error) {
  return PERMANENT_ERRORS.has(String(error?.name || "")) || error?.code === 11000;
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * Every shadow write that never landed, newest last, so the divergence is
 * visible rather than buried in the logs. /health/metrics reports the count
 * and the oldest entry; dynamo:compare names the rows.
 */
const failures = [];
const MAX_REMEMBERED_FAILURES = 100;

export function shadowFailures() {
  return [...failures];
}

export function clearShadowFailures() {
  failures.length = 0;
}

function recordFailure(entry) {
  failures.push(entry);
  if (failures.length > MAX_REMEMBERED_FAILURES) failures.shift();
}

/**
 * Runs the shadow write, retrying a transient failure a few times.
 *
 * The write still returns the primary's result either way: a shadow is a
 * copy, and failing the user's request because the copy did not land would
 * make "both" less reliable than either database alone. What changes here is
 * that a lost copy is retried first, and then remembered.
 */
async function writeShadow(store, operation, shadow, shadowName, sleep) {
  let lastError;
  for (let attempt = 0; attempt <= SHADOW_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      await shadow();
      if (attempt > 0) incrementMetric(`shadow_write_recovered_${shadowName}`);
      return true;
    } catch (error) {
      lastError = error;
      if (isPermanent(error) || attempt === SHADOW_RETRY_DELAYS_MS.length) break;
      await sleep(SHADOW_RETRY_DELAYS_MS[attempt]);
    }
  }

  incrementMetric(`shadow_write_failed_${shadowName}`);
  const entry = {
    at: new Date().toISOString(),
    database: shadowName,
    store,
    operation,
    error: String(lastError?.name || "Error"),
    permanent: isPermanent(lastError),
  };
  recordFailure(entry);
  console.error(JSON.stringify({
    event: "shadow_write_failed",
    ...entry,
    message: String(lastError?.message || "").slice(0, 200),
    hint: `${store} now differs between the databases; run npm run dynamo:compare`,
  }));
  return false;
}

export async function routedWrite(store, operation, { mongo, dynamo }, { sleep = wait } = {}) {
  const { writeTo, readFrom } = dataRoute(store);
  if (writeTo === "mongo") return mongo();
  if (writeTo === "dynamo") return dynamo();

  const [primary, shadow, shadowName] = readFrom === "dynamo"
    ? [dynamo, mongo, "mongo"]
    : [mongo, dynamo, "dynamo"];
  const result = await primary();
  await writeShadow(store, operation, shadow, shadowName, sleep);
  return result;
}

export async function routedRead(store, { mongo, dynamo }) {
  return dataRoute(store).readFrom === "dynamo" ? dynamo() : mongo();
}
