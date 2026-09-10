import assert from "node:assert/strict";
import { test } from "node:test";
import { onEvaluationQueued } from "../src/services/evaluationWorker.js";

/**
 * A check-in returns 202 and the analysis runs on the worker. The loop already
 * drains back-to-back while jobs exist and waits only when it finds the queue
 * empty — which is exactly the state a fresh check-in arrives into. That wait
 * was dead time between accepting the photograph and starting the analysis,
 * caused only by the next poll not having come round yet.
 *
 * enqueueEvaluation now signals the idle loop. The polling is still what
 * guarantees delivery: the signal is in-process, so it reaches nobody when the
 * API and the workers run as separate services.
 */

function fakeDb() {
  const jobs = new Map();
  return {
    collection(name) {
      if (name === "evaluation_jobs") {
        return {
          async updateOne(filter, update, options = {}) {
            if (!jobs.has(filter._id) && options.upsert) {
              jobs.set(filter._id, { ...(update.$setOnInsert || {}) });
            }
            return { matchedCount: 1 };
          },
          async findOne(filter) {
            return jobs.get(filter._id) || null;
          },
        };
      }
      return { async updateOne() { return { matchedCount: 1 }; } };
    },
  };
}

const payload = () => ({
  attendanceId: "a1",
  instructor: { id: "i1", name: "Asha", email: "a@example.com", gender: "FEMALE" },
  photoKey: "attendance/2026/09/10/a1-checkin.jpg",
  mimeType: "image/jpeg",
  checkInTime: new Date(),
  deadlineAt: new Date(Date.now() + 3600_000),
});

test("queueing a check-in signals a waiting worker", async () => {
  const { enqueueEvaluation } = await import("../src/services/evaluationWorker.js");
  let woken = 0;
  const stop = onEvaluationQueued(() => { woken += 1; });
  try {
    await enqueueEvaluation(fakeDb(), payload());
    assert.equal(woken, 1, "an idle worker must not wait for its next poll");
  } finally {
    stop();
  }
});

test("the signal arrives after the job is readable, not before", async () => {
  const { enqueueEvaluation } = await import("../src/services/evaluationWorker.js");
  const db = fakeDb();
  let jobVisibleWhenWoken = null;
  const stop = onEvaluationQueued(async () => {
    jobVisibleWhenWoken = await db.collection("evaluation_jobs").findOne({ _id: "a1:evaluation" });
  });
  try {
    await enqueueEvaluation(db, payload());
    // Waking before the write lands would send the worker to an empty queue,
    // and it would go back to sleep having done nothing.
    assert.ok(jobVisibleWhenWoken, "the job must exist by the time the worker is woken");
  } finally {
    stop();
  }
});

test("a listener that throws cannot fail the check-in", async () => {
  const { enqueueEvaluation } = await import("../src/services/evaluationWorker.js");
  const stop = onEvaluationQueued(() => { throw new Error("worker exploded"); });
  try {
    // The photograph is already stored and the record already written. A
    // wake-up is an optimisation and must never turn that into a failure.
    await enqueueEvaluation(fakeDb(), payload());
  } finally {
    stop();
  }
});

test("unsubscribing stops the signal", async () => {
  const { enqueueEvaluation } = await import("../src/services/evaluationWorker.js");
  let woken = 0;
  const stop = onEvaluationQueued(() => { woken += 1; });
  stop();
  await enqueueEvaluation(fakeDb(), payload());
  assert.equal(woken, 0, "a stopped worker must not be signalled");
});
