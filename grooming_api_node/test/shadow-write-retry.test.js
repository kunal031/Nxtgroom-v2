import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { clearShadowFailures, routedWrite, shadowFailures } from "../src/stores/routing.js";

const nosleep = async () => {};

function fail(name, message = "boom") {
  const error = new Error(message);
  error.name = name;
  return error;
}

function route(writeTo, readFrom = "mongo") {
  process.env.DB_WRITE_TO_APP_SETTINGS = writeTo;
  process.env.DB_READ_FROM_APP_SETTINGS = readFrom;
}

beforeEach(() => {
  clearShadowFailures();
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("DB_WRITE_TO") || key.startsWith("DB_READ_FROM")) delete process.env[key];
  }
});

test("a transient shadow failure is retried until it lands", async () => {
  route("both");
  let attempts = 0;
  const result = await routedWrite("app_settings", "save", {
    mongo: async () => "primary",
    dynamo: async () => {
      attempts += 1;
      if (attempts < 3) throw fail("ProvisionedThroughputExceededException", "throttled");
      return "shadow";
    },
  }, { sleep: nosleep });

  assert.equal(result, "primary");
  assert.equal(attempts, 3, "retried until it succeeded");
  assert.deepEqual(shadowFailures(), [], "a recovered write is not a divergence");
});

test("a failure the write caused is reported without retrying", async () => {
  route("both");
  let attempts = 0;
  await routedWrite("app_settings", "save", {
    mongo: async () => "primary",
    dynamo: async () => {
      attempts += 1;
      throw fail("ValidationException", "bad item");
    },
  }, { sleep: nosleep });

  assert.equal(attempts, 1, "retrying a rejected write would never succeed");
  const [failure] = shadowFailures();
  assert.equal(failure.permanent, true);
  assert.equal(failure.store, "app_settings");
  assert.equal(failure.database, "dynamo");
});

test("a shadow that never lands is remembered, and the write still succeeds", async () => {
  route("both");
  let attempts = 0;
  const result = await routedWrite("app_settings", "save", {
    mongo: async () => "primary",
    dynamo: async () => {
      attempts += 1;
      throw fail("TimeoutError", "unreachable");
    },
  }, { sleep: nosleep });

  assert.equal(result, "primary", "a lost copy must not fail the user's write");
  assert.equal(attempts, 4, "one attempt plus three retries");
  assert.equal(shadowFailures().length, 1);
  assert.equal(shadowFailures()[0].permanent, false);
});

test("the database reads come from is the one that must not fail", async () => {
  route("both", "dynamo");
  await assert.rejects(
    routedWrite("app_settings", "save", {
      mongo: async () => "mongo",
      dynamo: async () => { throw fail("TimeoutError", "primary down"); },
    }, { sleep: nosleep }),
    /primary down/,
    "reading DynamoDB makes DynamoDB the primary, so its failure is the caller's"
  );
  assert.deepEqual(shadowFailures(), [], "the primary failing is not a shadow divergence");
});

test("a single-database route never touches the other one", async () => {
  route("mongo");
  let dynamoCalls = 0;
  assert.equal(await routedWrite("app_settings", "save", {
    mongo: async () => "mongo-only",
    dynamo: async () => { dynamoCalls += 1; return "dynamo"; },
  }, { sleep: nosleep }), "mongo-only");
  assert.equal(dynamoCalls, 0);
  assert.deepEqual(shadowFailures(), []);
});

test("only the last hundred divergences are kept", async () => {
  route("both");
  for (let index = 0; index < 105; index += 1) {
    await routedWrite("app_settings", `save_${index}`, {
      mongo: async () => "primary",
      dynamo: async () => { throw fail("ValidationException", "bad"); },
    }, { sleep: nosleep });
  }
  const failures = shadowFailures();
  assert.equal(failures.length, 100, "bounded so a long outage cannot exhaust memory");
  assert.equal(failures.at(-1).operation, "save_104", "the newest is kept");
  assert.equal(failures[0].operation, "save_5", "the oldest are dropped first");
});
