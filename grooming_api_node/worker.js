import "dotenv/config";
import { closeMongoConnection, connectToMongo } from "./src/config/db.js";
import { validateEnvironment } from "./src/config/env.js";
import { startEvaluationWorker } from "./src/services/evaluationWorker.js";
import { startNotificationWorker } from "./src/services/notificationWorker.js";
import { startStorageCleanupWorker } from "./src/services/storageCleanupWorker.js";
import { startMailWorker } from "./src/services/mailWorker.js";
import { verifyDynamoTables } from "./src/stores/dynamoStartup.js";

async function startWorkers() {
  const config = validateEnvironment();
  if (config.processRole !== "worker") {
    throw new Error("worker.js requires PROCESS_ROLE=worker");
  }
  await verifyDynamoTables();
  const db = await connectToMongo();
  if (!db) throw new Error("MongoDB is required to start workers");
  const workers = [
    startEvaluationWorker(db),
    startNotificationWorker(db),
    startStorageCleanupWorker(db),
    startMailWorker(db),
  ];
  console.log("FacultyTrack workers started.");

  let stopping = false;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`Received ${signal}; stopping workers.`);
    const forceExit = setTimeout(() => {
      console.error("Graceful shutdown timed out.");
      process.exit(1);
    }, 20_000);
    forceExit.unref();
    await Promise.allSettled(workers.map((worker) => worker.stop()));
    await closeMongoConnection();
    clearTimeout(forceExit);
  };
  const fatalShutdown = (error) => {
    process.exitCode = 1;
    console.error(`Fatal worker error: ${error?.name || "Error"}`);
    void stop("fatal error");
  };
  process.once("SIGTERM", () => void stop("SIGTERM"));
  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("uncaughtException", fatalShutdown);
  process.once("unhandledRejection", fatalShutdown);
}

startWorkers().catch((error) => {
  console.error(`Failed to start workers: ${error.message}`);
  process.exit(1);
});
