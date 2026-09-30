import { isJobQueue, jobCollection } from "../stores/jobStore.js";

// The queue depths read the job queues wherever they live; the outbox depths
// read attendance, which is still MongoDB.
function collectionFor(db, name) {
  return isJobQueue(name) ? jobCollection(db, name) : db.collection(name);
}

const workerStates = new Map();
const EXPECTED_WORKERS = ["evaluation", "notification"];
const KNOWN_WORKERS = [...EXPECTED_WORKERS, "storage_cleanup", "mail"];
const DEFAULT_STALE_AFTER_MS = 60000;
const DEFAULT_BUSY_STALE_AFTER_MS = 15 * 60 * 1000;
const DEFAULT_QUEUE_WARNING_AGE_MS = 15 * 60 * 1000;
const DEFAULT_QUEUE_CRITICAL_AGE_MS = 23 * 60 * 60 * 1000;

function iso(value) {
  return value instanceof Date ? value.toISOString() : null;
}

function safeCode(value, fallback = "WORKER_ERROR") {
  const normalized = String(value || fallback).toUpperCase();
  return /^[A-Z][A-Z0-9_]{0,79}$/.test(normalized) ? normalized : fallback;
}

export function createWorkerMonitor(name, {
  busyStaleAfterMs = DEFAULT_BUSY_STALE_AFTER_MS,
  now = () => new Date(),
} = {}) {
  if (!KNOWN_WORKERS.includes(name)) throw new Error(`Unknown worker monitor: ${name}`);
  if (!Number.isFinite(busyStaleAfterMs) || busyStaleAfterMs <= 0) {
    throw new Error("busyStaleAfterMs must be a positive number");
  }
  const startedAt = now();
  const state = {
    name,
    running: true,
    busy: false,
    startedAt,
    lastHeartbeatAt: startedAt,
    lastCycleStartedAt: null,
    lastCycleCompletedAt: null,
    lastProgressAt: startedAt,
    currentPhase: "starting",
    busyStaleAfterMs,
    lastLoopErrorAt: null,
    lastLoopErrorCode: null,
    lastJobErrorAt: null,
    lastJobErrorCode: null,
    completedCycles: 0,
  };
  workerStates.set(name, state);
  const progress = (phase = state.currentPhase) => {
    if (!state.running) return;
    const progressAt = now();
    state.lastHeartbeatAt = progressAt;
    state.lastProgressAt = progressAt;
    state.currentPhase = String(phase || "working").slice(0, 80);
  };

  return {
    cycleStarted() {
      state.busy = true;
      state.lastCycleStartedAt = now();
      progress("cycle_started");
    },
    progress,
    heartbeat() {
      progress("explicit_heartbeat");
    },
    cycleCompleted(loopErrorCode = null) {
      state.busy = false;
      state.lastCycleCompletedAt = now();
      state.completedCycles += 1;
      if (loopErrorCode) {
        state.lastLoopErrorAt = now();
        state.lastLoopErrorCode = safeCode(loopErrorCode);
      }
      progress("idle");
    },
    recordJobError(code) {
      state.lastJobErrorAt = now();
      state.lastJobErrorCode = safeCode(code);
      progress("job_error");
    },
    stop() {
      if (!state.running) return;
      state.running = false;
      state.busy = false;
      state.lastHeartbeatAt = now();
      state.currentPhase = "stopped";
    },
  };
}

export function getWorkerHeartbeatSnapshot({
  now = new Date(),
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
  expectedWorkers = EXPECTED_WORKERS,
} = {}) {
  return expectedWorkers.map((name) => {
    const state = workerStates.get(name);
    if (!state) {
      return { name, running: false, stale: true, state: "missing" };
    }
    const heartbeatAgeMs = Math.max(0, now.getTime() - state.lastHeartbeatAt.getTime());
    const allowedAgeMs = state.busy ? state.busyStaleAfterMs : staleAfterMs;
    const stale = !state.running || heartbeatAgeMs > allowedAgeMs;
    return {
      name,
      running: state.running,
      busy: state.busy,
      stale,
      state: !state.running ? "stopped" : (stale ? "stale" : "ok"),
      heartbeat_age_ms: heartbeatAgeMs,
      heartbeat_stale_after_ms: allowedAgeMs,
      current_phase: state.currentPhase,
      started_at: iso(state.startedAt),
      last_heartbeat_at: iso(state.lastHeartbeatAt),
      last_progress_at: iso(state.lastProgressAt),
      last_cycle_started_at: iso(state.lastCycleStartedAt),
      last_cycle_completed_at: iso(state.lastCycleCompletedAt),
      completed_cycles: state.completedCycles,
      last_loop_error_at: iso(state.lastLoopErrorAt),
      last_loop_error_code: state.lastLoopErrorCode,
      last_job_error_at: iso(state.lastJobErrorAt),
      last_job_error_code: state.lastJobErrorCode,
    };
  });
}

function nestedValue(document, path) {
  return path.split(".").reduce((value, key) => value?.[key], document);
}

function queueMetric(name, document, datePath, now, warningAgeMs, criticalAgeMs, depth = null) {
  const rawDate = nestedValue(document, datePath);
  const parsed = rawDate ? new Date(rawDate) : null;
  const validDate = parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
  const ageMs = validDate ? Math.max(0, now.getTime() - validDate.getTime()) : null;
  const invalidTimestamp = Boolean(document) && !validDate;
  return {
    name,
    has_pending_work: Boolean(document),
    depth,
    oldest_created_at: validDate?.toISOString() || null,
    oldest_age_ms: ageMs,
    invalid_timestamp: invalidTimestamp,
    warning: invalidTimestamp || (ageMs != null && ageMs >= warningAgeMs),
    critical: invalidTimestamp || (ageMs != null && ageMs >= criticalAgeMs),
  };
}

async function oldest(db, collectionName, filter, sortField) {
  return collectionFor(db, collectionName).findOne(
    filter,
    {
      projection: { _id: 1, [sortField]: 1 },
      sort: { [sortField]: 1 },
      maxTimeMS: 1500,
    }
  );
}

async function queueDepth(db, collectionName, filter) {
  const collection = collectionFor(db, collectionName);
  if (typeof collection.countDocuments !== "function") return null;
  return collection.countDocuments(filter, { maxTimeMS: 1500 });
}

export async function getQueueAgeMetrics(db, {
  now = new Date(),
  warningAgeMs = DEFAULT_QUEUE_WARNING_AGE_MS,
  criticalAgeMs = DEFAULT_QUEUE_CRITICAL_AGE_MS,
} = {}) {
  const specs = [
    {
      name: "evaluation_jobs",
      collection: "evaluation_jobs",
      filter: {
        $or: [
          { status: { $in: ["queued", "processing", "recovering"] } },
          { status: "failed", failure_synced_at: { $exists: false } },
        ],
      },
      datePath: "created_at",
    },
    {
      name: "notification_jobs",
      collection: "notification_jobs",
      filter: {
        $or: [
          { status: { $in: ["queued", "processing"] } },
          {
            status: { $in: ["sent", "failed", "delivery_unknown"] },
            attendance_synced_at: { $exists: false },
          },
        ],
      },
      datePath: "created_at",
    },
    {
      name: "mail_jobs",
      collection: "mail_jobs",
      filter: { status: { $in: ["queued", "processing"] } },
      datePath: "created_at",
    },
    {
      name: "storage_cleanup_jobs",
      collection: "storage_cleanup_jobs",
      filter: { status: { $in: ["queued", "processing"] } },
      datePath: "created_at",
    },
    {
      name: "evaluation_outbox",
      collection: "attendance",
      filter: { "_private_evaluation_outbox": { $exists: true } },
      datePath: "_private_evaluation_outbox.created_at",
    },
    {
      name: "checkin_notification_outbox",
      collection: "attendance",
      filter: { "_private_checkin_outbox": { $exists: true } },
      datePath: "_private_checkin_outbox.created_at",
    },
    {
      name: "checkout_notification_outbox",
      collection: "attendance",
      filter: { "_private_checkout_outbox": { $exists: true } },
      datePath: "_private_checkout_outbox.created_at",
    },
  ];
  const documents = await Promise.all(specs.map((spec) => (
    oldest(db, spec.collection, spec.filter, spec.datePath)
  )));
  const depths = await Promise.all(specs.map((spec) => (
    queueDepth(db, spec.collection, spec.filter)
  )));
  return specs.map((spec, index) => queueMetric(
    spec.name,
    documents[index],
    spec.datePath,
    now,
    warningAgeMs,
    criticalAgeMs,
    depths[index]
  ));
}

export async function getWorkerReadiness(db, options = {}) {
  const now = options.now || new Date();
  const workers = getWorkerHeartbeatSnapshot({
    now,
    staleAfterMs: options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS,
    expectedWorkers: options.expectedWorkers,
  });
  const reasons = workers
    .filter((worker) => worker.stale)
    .map((worker) => `WORKER_${worker.name.toUpperCase()}_${worker.state.toUpperCase()}`);
  let queues = [];
  try {
    queues = await getQueueAgeMetrics(db, { ...options, now });
    for (const queue of queues) {
      if (queue.critical) reasons.push(`QUEUE_${queue.name.toUpperCase()}_CRITICAL_AGE`);
    }
  } catch {
    reasons.push("QUEUE_METRICS_UNAVAILABLE");
  }
  return {
    ready: reasons.length === 0,
    status: reasons.length ? "degraded" : "ok",
    reasons,
    workers,
    queues,
  };
}

export function resetWorkerHealthForTests() {
  workerStates.clear();
}
