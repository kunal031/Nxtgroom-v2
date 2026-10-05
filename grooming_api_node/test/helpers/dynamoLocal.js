import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import dynalite from "dynalite";

/**
 * A DynamoDB to test against.
 *
 * dynalite runs in this process and covers everything except
 * TransactWriteItems, which it does not implement at all. The transactional
 * collections therefore need AWS's DynamoDB Local (a Java program): set
 * DYNAMODB_LOCAL_JAR to its DynamoDBLocal.jar and it is started for the
 * test run, in memory.
 *
 *   curl -O https://d1ni2b6xgvw0s0.cloudfront.net/v2.x/dynamodb_local_latest.tar.gz
 *   mkdir -p ~/dynamodb-local && tar xzf dynamodb_local_latest.tar.gz -C ~/dynamodb-local
 *   export DYNAMODB_LOCAL_JAR=~/dynamodb-local/DynamoDBLocal.jar
 *
 * Without it, tests that need transactions skip rather than fail, so the
 * suite still runs anywhere; CI sets the variable so they always run.
 */

export function dynamoLocalJar() {
  const jar = (process.env.DYNAMODB_LOCAL_JAR || "").trim();
  return jar && existsSync(jar) ? jar : null;
}

export const TRANSACTIONS_UNAVAILABLE =
  "DynamoDB transactions need AWS DynamoDB Local; set DYNAMODB_LOCAL_JAR (see test/helpers/dynamoLocal.js)";

async function waitForPort(port, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(`DynamoDB Local exited with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, { method: "GET" });
      // Any HTTP answer means it is listening.
      if (response) return;
    } catch {
      await sleep(100);
    }
  }
  throw new Error("DynamoDB Local did not start in time");
}

/**
 * Starts a DynamoDB and returns { endpoint, stop }. transactions: true uses
 * DynamoDB Local, and returns null when it is not installed.
 */
export async function startDynamo({ transactions = false } = {}) {
  if (!transactions) {
    const server = dynalite({ createTableMs: 0 });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
      endpoint: `http://127.0.0.1:${server.address().port}`,
      stop: () => new Promise((resolve) => server.close(resolve)),
    };
  }

  const jar = dynamoLocalJar();
  if (!jar) return null;
  const port = 8000 + Math.floor(Math.random() * 1000);
  const child = spawn("java", [
    `-Djava.library.path=${jar.replace(/DynamoDBLocal\.jar$/, "DynamoDBLocal_lib")}`,
    "-jar",
    jar,
    "-inMemory",
    "-port",
    String(port),
  ], { stdio: "ignore" });
  child.unref();
  try {
    await waitForPort(port, child);
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
  return {
    endpoint: `http://127.0.0.1:${port}`,
    stop: async () => {
      child.kill("SIGTERM");
      await sleep(50);
      if (child.exitCode === null) child.kill("SIGKILL");
    },
  };
}
