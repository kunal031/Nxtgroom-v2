import { randomUUID } from "node:crypto";
import { deletePhoto } from "./photoStorage.js";
import { runtimeConfig } from "../config/env.js";
import { createWorkerMonitor } from "./workerHealth.js";
import { createIdleBackoff } from "./workerPacing.js";
import { jobCollection } from "../stores/jobStore.js";

const WORKER_ID = randomUUID();
const LEASE_MS = 60_000;
const MAX_ATTEMPTS = 10;

async function claimCleanup(db) {
  const now = new Date();
  const result = await jobCollection(db, "storage_cleanup_jobs").findOneAndUpdate(
    {
      attempts: { $lt: MAX_ATTEMPTS },
      $or: [
        { status: "queued", available_at: { $lte: now } },
        { status: "processing", lease_until: { $lte: now } },
      ],
    },
    {
      $set: {
        status: "processing",
        worker_id: WORKER_ID,
        lease_until: new Date(now.getTime() + LEASE_MS),
        updated_at: now,
      },
      $inc: { attempts: 1 },
    },
    { sort: { created_at: 1 }, returnDocument: "after" }
  );
  return result?.value || result;
}

async function processCleanup(db, job) {
  const removed = await deletePhoto(job.key);
  if (removed.deleted) {
    await jobCollection(db, "storage_cleanup_jobs").deleteOne({
      _id: job._id,
      status: "processing",
      worker_id: WORKER_ID,
    });
    return;
  }
  const delay = Math.min(60 * 60_000, 5_000 * (2 ** Math.max(0, job.attempts - 1)));
  await jobCollection(db, "storage_cleanup_jobs").updateOne(
    { _id: job._id, status: "processing", worker_id: WORKER_ID },
    {
      $set: {
        status: job.attempts >= MAX_ATTEMPTS ? "failed" : "queued",
        available_at: new Date(Date.now() + delay),
        last_error: removed.reason || "delete_failed",
        updated_at: new Date(),
      },
      $unset: { worker_id: "", lease_until: "" },
    }
  );
}

export function startStorageCleanupWorker(db) {
  let stopped = false;
  let timer = null;
  let inFlight = Promise.resolve();
  const monitor = createWorkerMonitor("storage_cleanup", { busyStaleAfterMs: LEASE_MS + 60_000 });
  const backoff = createIdleBackoff({ minMs: 2_000, maxMs: runtimeConfig().workerIdleMaxPollMs });
  const tick = () => {
    monitor.cycleStarted();
    let loopError = null;
    let job = null;
    inFlight = (async () => {
      try {
        job = await claimCleanup(db);
        monitor.progress(job ? "job_claimed" : "queue_idle");
        if (job) await processCleanup(db, job);
      } catch (error) {
        loopError = String(error?.code || error?.name || "STORAGE_CLEANUP_ERROR");
        console.error(`Storage cleanup worker error (${loopError})`);
      } finally {
        monitor.cycleCompleted(loopError);
        const delay = backoff.afterCycle(Boolean(job));
        if (!stopped) timer = setTimeout(tick, loopError ? Math.max(10_000, delay) : delay);
      }
    })();
  };
  timer = setTimeout(tick, 0);
  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inFlight;
    },
  };
}
