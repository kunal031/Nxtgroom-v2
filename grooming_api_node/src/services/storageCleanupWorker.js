import { randomUUID } from "node:crypto";
import { deletePhoto, listPhotoObjects } from "./photoStorage.js";
import { runtimeConfig } from "../config/env.js";
import { createWorkerMonitor } from "./workerHealth.js";
import { createIdleBackoff } from "./workerPacing.js";
import { getSetting, saveSetting } from "../stores/settingsStore.js";
import { jobCollection } from "../stores/jobStore.js";
import { coreCollection } from "../stores/coreStore.js";

const WORKER_ID = randomUUID();
const LEASE_MS = 60_000;
const MAX_ATTEMPTS = 10;
const ORPHAN_GRACE_MS = 60 * 60 * 1000;
const SCAN_INTERVAL_MS = 6 * 60 * 60 * 1000;

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

export async function reconcileOrphanPhotos(db, now = new Date()) {
  const stateId = "storage_orphan_scan";
  const state = await getSetting(db, stateId);
  if (state?.next_scan_at && new Date(state.next_scan_at) > now) return 0;

  const page = await listPhotoObjects({ continuationToken: state?.continuation_token || null });
  let queued = 0;
  for (const object of page.objects) {
    if (!object.lastModified || now.getTime() - new Date(object.lastModified).getTime() < ORPHAN_GRACE_MS) continue;
    const referenced = await coreCollection(db, "attendance").findOne(
      { $or: [{ check_in_photo_key: object.key }, { check_out_photo_key: object.key }] },
      { projection: { _id: 1 } }
    );
    if (referenced) continue;
    await jobCollection(db, "storage_cleanup_jobs").updateOne(
      { _id: object.key },
      {
        $setOnInsert: {
          _id: object.key,
          key: object.key,
          reason: "orphan_reconciliation",
          status: "queued",
          attempts: 0,
          available_at: now,
          created_at: now,
        },
        $set: { updated_at: now },
      },
      { upsert: true }
    );
    queued += 1;
  }

  await saveSetting(db, stateId, {
    set: page.nextToken
      ? { continuation_token: page.nextToken, next_scan_at: now, updated_at: now }
      : { continuation_token: null, next_scan_at: new Date(now.getTime() + SCAN_INTERVAL_MS), updated_at: now },
  });
  return queued;
}

export function startStorageCleanupWorker(db) {
  let stopped = false;
  let timer = null;
  let inFlight = Promise.resolve();
  const monitor = createWorkerMonitor("storage_cleanup", { busyStaleAfterMs: LEASE_MS + 60_000 });
  // Photo deletion is never urgent, so an idle worker needs no wake-up; it
  // backs off like the others and drains without pause once it finds work.
  const backoff = createIdleBackoff({ minMs: 2_000, maxMs: runtimeConfig().workerIdleMaxPollMs });
  const tick = () => {
    monitor.cycleStarted();
    let loopError = null;
    let job = null;
    let orphansQueued = 0;
    inFlight = (async () => {
      try {
        orphansQueued = await reconcileOrphanPhotos(db);
        job = await claimCleanup(db);
        monitor.progress(job ? "job_claimed" : "queue_idle");
        if (job) await processCleanup(db, job);
      } catch (error) {
        loopError = String(error?.code || error?.name || "STORAGE_CLEANUP_ERROR");
        console.error(`Storage cleanup worker error (${loopError})`);
      } finally {
        monitor.cycleCompleted(loopError);
        const delay = backoff.afterCycle(Boolean(job) || orphansQueued > 0);
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
