import assert from "node:assert/strict";
import { test } from "node:test";
import { HTTP_REQUEST_TIMEOUT_MS } from "../src/config/env.js";

/**
 * Check-out runs its analysis inside the HTTP request, so the whole evaluation
 * has to finish before the server destroys the socket at requestTimeout.
 *
 * The interactive budget was expressed per Gemini request, which was correct
 * while every evaluation made exactly one. A woman's evaluation makes two —
 * classification, then the report — so the same numbers described twice the
 * worst case the caller could actually wait for: 20s x 2 attempts x 2 calls =
 * 80s against a 60s timeout. The BOA would see a failed check-out while the
 * analysis carried on server-side and still emailed the instructor a report.
 *
 * The budget is now one deadline shared across every call in the evaluation.
 */

const GEMINI_ENV = [
  "GEMINI_API_KEY",
  "GEMINI_MODEL",
  "GEMINI_TIMEOUT_MS",
  "GEMINI_MAX_RETRIES",
  "GEMINI_EXPLICIT_CACHE",
];

const ALL_VISIBLE = {
  face: "VISIBLE",
  upper_body: "VISIBLE",
  lower_body: "VISIBLE",
  footwear: "VISIBLE",
  id_card: "VISIBLE",
  hands: "VISIBLE",
};

function stubGemini({ delayMs = 0, delayFor = null, responses = [] }) {
  const originalFetch = globalThis.fetch;
  const original = Object.fromEntries(GEMINI_ENV.map((name) => [name, process.env[name]]));
  process.env.GEMINI_API_KEY = "test-only-gemini-key";
  process.env.GEMINI_MODEL = "gemini-2.5-flash-lite";
  process.env.GEMINI_TIMEOUT_MS = "120000";
  process.env.GEMINI_MAX_RETRIES = "2";
  process.env.GEMINI_EXPLICIT_CACHE = "false";

  const timeouts = [];
  globalThis.fetch = async (_url, options) => {
    // What the caller allowed this attempt, taken from the abort signal the
    // engine built for it.
    timeouts.push(Date.now());
    const call = timeouts.length;
    const payload = responses[call - 1];
    const wait = delayFor ? delayFor(call) : delayMs;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, wait);
      options.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        const error = new Error("aborted");
        error.name = "TimeoutError";
        reject(error);
      }, { once: true });
    });
    return new Response(JSON.stringify({
      candidates: [{
        content: { role: "model", parts: [{ text: JSON.stringify(payload) }] },
        finishReason: "STOP",
      }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  return {
    calls: timeouts,
    restore() {
      globalThis.fetch = originalFetch;
      for (const [name, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    },
  };
}

const image = () => Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

test("a female interactive evaluation cannot outlive the request timeout", async () => {
  // The overrun only appears when the first call succeeds: a first call that
  // fails throws and the second never happens. So the classification returns
  // normally after spending part of the budget, and the report then stalls.
  const stub = stubGemini({
    responses: [{
      subject_visible: true,
      attire_type: "SAREE",
      image_quality: "ADEQUATE",
      visible_regions: ALL_VISIBLE,
    }],
    delayFor: (call) => (call === 1 ? 1200 : 60_000),
  });
  const startedAt = Date.now();
  try {
    const { evaluateImage } = await import("../src/services/visionEngine.js");
    // No retries, so the arithmetic is just the two calls.
    await assert.rejects(() => evaluateImage(image(), "image/jpeg", "FEMALE", {
      timeoutMs: 2000,
      maxRetries: 0,
    }));
    const elapsed = Date.now() - startedAt;

    assert.equal(stub.calls.length, 2, "the report call must have been attempted");
    // Shared: 1200ms spent, 800ms left, so the whole run ends at ~2000ms.
    // Per request: the report call would start a fresh 2000ms of its own and
    // the run would reach ~3200ms - past the budget the caller allowed.
    assert.ok(
      elapsed < 2600,
      `the evaluation took ${elapsed}ms; the caller allowed 2000ms for all of it`
    );
  } finally {
    stub.restore();
  }
});

test("the shipped interactive defaults leave headroom inside the request timeout", async () => {
  const { runtimeConfig } = await import("../src/config/env.js");
  const config = runtimeConfig();

  // The whole evaluation, not one request, now has to fit. This is the sum the
  // env validator checks, and it must stay true however many model calls a
  // gender needs.
  const worstCase = config.geminiInteractiveTimeoutMs * (config.geminiInteractiveMaxRetries + 1);
  assert.ok(
    worstCase < HTTP_REQUEST_TIMEOUT_MS - 5000,
    `interactive worst case ${worstCase}ms leaves no headroom in ${HTTP_REQUEST_TIMEOUT_MS}ms`
  );
});

test("a male evaluation is unaffected by the shared deadline", async () => {
  const { checkpointSet, SECTION_KEYS } = await import("../src/checkpoints.js");
  const sections = checkpointSet("MALE", "FORMAL");
  const report = {
    subject_visible: true,
    image_quality: "ADEQUATE",
    ai_summary: "Assessed.",
    visible_regions: ALL_VISIBLE,
  };
  for (const key of SECTION_KEYS) {
    report[key] = Object.fromEntries(sections[key].map((item) => [item.code, {
      status: "PASS",
      observation: "Visible and acceptable.",
      reason: "Meets the checkpoint.",
    }]));
  }

  const stub = stubGemini({ delayMs: 0, responses: [report] });
  try {
    const { evaluateImage } = await import("../src/services/visionEngine.js");
    const result = await evaluateImage(image(), "image/jpeg", "MALE", {
      timeoutMs: 20000,
      maxRetries: 1,
    });
    assert.equal(result.overall_status, "COMPLIANT");
    assert.equal(stub.calls.length, 1, "one call, as it has always been");
  } finally {
    stub.restore();
  }
});
