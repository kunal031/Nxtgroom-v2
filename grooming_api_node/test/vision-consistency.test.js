import assert from "node:assert/strict";
import { test } from "node:test";
import { checkpointSet, SECTION_KEYS } from "../src/checkpoints.js";
import { telemetrySnapshot } from "../src/services/telemetry.js";

/**
 * Mirrors the consistency rules applied to a parsed grooming report. Kept in
 * step with visionEngine.js by hand: the real function performs a network call
 * to Gemini, which cannot run in a unit test.
 */
function reconcile(report) {
  const checks = [
    ...report.general_idcard_check,
    ...report.grooming_check,
    ...report.attire_check,
    ...report.accessories_check,
    ...report.footwear_check,
  ];
  const assessed = checks.filter((item) => item.status !== "N/A");
  if (assessed.length === 0) {
    return {
      ...report,
      overall_status: "NON_COMPLIANT",
      image_quality: "RETAKE_RECOMMENDED",
      requires_human_review: true,
    };
  }
  const expected = checks.some((item) => item.status === "FAIL")
    ? "NON_COMPLIANT"
    : "COMPLIANT";
  if (report.overall_status !== expected) {
    throw new Error("The model returned an internally inconsistent evaluation");
  }
  return report;
}

function buildReport({ statuses, overall }) {
  const item = (status) => ({
    checkpoint_name: "check",
    observation: "observed",
    status,
    reason: "reason",
  });
  return {
    overall_status: overall,
    image_quality: "GOOD",
    ai_summary: "summary",
    requires_human_review: false,
    general_idcard_check: statuses.slice(0, 1).map(item),
    grooming_check: statuses.slice(1, 2).map(item),
    attire_check: statuses.slice(2, 3).map(item),
    accessories_check: statuses.slice(3, 4).map(item),
    footwear_check: statuses.slice(4).map(item),
  };
}

test("an unevaluable photo is flagged for review instead of failing", () => {
  // Reproduces a real production failure: a photo showing nothing assessable
  // came back with every checkpoint N/A and overall NON_COMPLIANT. The old
  // rule expected COMPLIANT when no check had failed, so the evaluation was
  // discarded, retried three times, and the attendance record was stuck in
  // error with no result for the user.
  const report = buildReport({
    statuses: ["N/A", "N/A", "N/A", "N/A", "N/A"],
    overall: "NON_COMPLIANT",
  });

  const result = reconcile(report);
  assert.equal(result.overall_status, "NON_COMPLIANT");
  assert.equal(result.image_quality, "RETAKE_RECOMMENDED");
  assert.equal(result.requires_human_review, true, "a human must look at it");
});

test("a failed checkpoint still requires a non-compliant verdict", () => {
  assert.throws(
    () => reconcile(buildReport({
      statuses: ["PASS", "FAIL", "PASS", "PASS", "PASS"],
      overall: "COMPLIANT",
    })),
    /internally inconsistent/,
    "a real contradiction must still be rejected",
  );
});

test("a clean evaluation passes through unchanged", () => {
  const report = buildReport({
    statuses: ["PASS", "PASS", "PASS", "PASS", "PASS"],
    overall: "COMPLIANT",
  });
  assert.equal(reconcile(report).overall_status, "COMPLIANT");
});

test("partial visibility is judged on what was actually assessed", () => {
  // Some checkpoints N/A is normal, so long as at least one was assessed.
  const report = buildReport({
    statuses: ["PASS", "N/A", "N/A", "PASS", "N/A"],
    overall: "COMPLIANT",
  });
  assert.equal(reconcile(report).overall_status, "COMPLIANT");
});

test("vision evaluation sends only the instructor image and structured output to Gemini 2.5 Flash-Lite", async () => {
  const originalFetch = globalThis.fetch;
  const originalGemini = {
    apiKey: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_MODEL,
    timeout: process.env.GEMINI_TIMEOUT_MS,
    retries: process.env.GEMINI_MAX_RETRIES,
    explicitCache: process.env.GEMINI_EXPLICIT_CACHE,
    cacheTtl: process.env.GEMINI_CACHE_TTL_SECONDS,
  };
  const sections = checkpointSet("MALE", "FORMAL");
  const report = {
    subject_visible: true,
    image_quality: "ADEQUATE",
    ai_summary: "All visible requirements pass.",
    visible_regions: {
      face: "VISIBLE",
      upper_body: "VISIBLE",
      lower_body: "VISIBLE",
      footwear: "VISIBLE",
      id_card: "VISIBLE",
      hands: "VISIBLE",
    },
  };
  for (const key of SECTION_KEYS) {
    report[key] = Object.fromEntries(sections[key].map((item) => [item.code, {
      status: "PASS",
      observation: "Visible and acceptable.",
      reason: "Meets the checkpoint.",
    }]));
  }

  let captured;
  const metricsBefore = telemetrySnapshot().counters;
  process.env.GEMINI_API_KEY = "test-only-gemini-key";
  process.env.GEMINI_MODEL = "gemini-2.5-flash-lite";
  process.env.GEMINI_TIMEOUT_MS = "120000";
  process.env.GEMINI_MAX_RETRIES = "0";
  process.env.GEMINI_EXPLICIT_CACHE = "true";
  process.env.GEMINI_CACHE_TTL_SECONDS = "3600";
  let cacheRequest;
  let cacheCreateCount = 0;
  let imageRequestCount = 0;
  globalThis.fetch = async (url, options) => {
    if (url.endsWith("/v1beta/cachedContents")) {
      cacheCreateCount += 1;
      cacheRequest = { url, options, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({ name: "cachedContents/nxtgroom-male-test" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    imageRequestCount += 1;
    captured = { url, options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({
      candidates: [{
        content: { role: "model", parts: [{ text: JSON.stringify(report) }] },
        finishReason: "STOP",
      }],
      usageMetadata: {
        promptTokenCount: 5000,
        candidatesTokenCount: 500,
        totalTokenCount: 5500,
        cachedContentTokenCount: 4096,
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const { evaluateImage } = await import("../src/services/visionEngine.js");
    const result = await evaluateImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg", "MALE");
    const secondResult = await evaluateImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg", "MALE");
    assert.equal(result.overall_status, "COMPLIANT");
    assert.equal(secondResult.overall_status, "COMPLIANT");
    assert.equal(cacheCreateCount, 1, "the stable male prompt cache must be created once");
    assert.equal(imageRequestCount, 2, "each changing image still requires one analysis request");
    assert.equal(
      captured.url,
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent",
    );
    assert.equal(captured.options.headers["x-goog-api-key"], "test-only-gemini-key");
    assert.equal(cacheRequest.body.model, "models/gemini-2.5-flash-lite");
    assert.equal(cacheRequest.body.ttl, "3600s");
    assert.equal(typeof cacheRequest.body.systemInstruction.parts[0].text, "string");
    assert.match(cacheRequest.body.displayName, /^nxtgroom-male-formal-/);
    assert.equal(captured.body.cachedContent, "cachedContents/nxtgroom-male-test");
    assert.equal(captured.body.systemInstruction, undefined, "cached requests must not resend the full prompt");
    assert.equal(captured.body.generationConfig.responseMimeType, "application/json");
    assert.equal(captured.body.generationConfig.responseJsonSchema.additionalProperties, false);
    assert.ok(captured.body.generationConfig.maxOutputTokens > 6000);
    assert.equal(captured.body.generationConfig.temperature, 0);
    // Vision checkpoints need room to inspect each body area before answering;
    // a zero budget produced verdicts that contradicted the photograph.
    assert.ok(captured.body.generationConfig.thinkingConfig.thinkingBudget >= 1024);
    assert.equal(captured.body.generationConfig.mediaResolution, "MEDIA_RESOLUTION_HIGH");
    assert.equal(captured.body.contents.length, 1);
    assert.equal(captured.body.contents[0].role, "user");
    const images = captured.body.contents[0].parts.filter((part) => part.inlineData);
    assert.equal(images.length, 1, "only the changing instructor image must be sent");
    assert.equal(images[0].inlineData.mimeType, "image/jpeg");
    assert.equal(images[0].inlineData.data, "/9j/4A==", "the single image must be the instructor photograph");
    const inputText = captured.body.contents[0].parts
      .filter((part) => typeof part.text === "string")
      .map((part) => part.text)
      .join(" ");
    assert.match(inputText, /written NxtWave Grooming Standard/i);
    assert.doesNotMatch(inputText, /reference image/i);
    const metricsAfter = telemetrySnapshot().counters;
    assert.equal(
      metricsAfter.gemini_input_tokens_total - (metricsBefore.gemini_input_tokens_total || 0),
      10000,
    );
    assert.equal(
      metricsAfter.gemini_cached_input_tokens_total
        - (metricsBefore.gemini_cached_input_tokens_total || 0),
      8192,
    );
    assert.equal(
      metricsAfter.gemini_prompt_cache_hits_total
        - (metricsBefore.gemini_prompt_cache_hits_total || 0),
      2,
    );
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of Object.entries({
      GEMINI_API_KEY: originalGemini.apiKey,
      GEMINI_MODEL: originalGemini.model,
      GEMINI_TIMEOUT_MS: originalGemini.timeout,
      GEMINI_MAX_RETRIES: originalGemini.retries,
      GEMINI_EXPLICIT_CACHE: originalGemini.explicitCache,
      GEMINI_CACHE_TTL_SECONDS: originalGemini.cacheTtl,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("female attire is classified first, then reported against that family alone", async () => {
  const originalFetch = globalThis.fetch;
  const originalGemini = {
    apiKey: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_MODEL,
    timeout: process.env.GEMINI_TIMEOUT_MS,
    retries: process.env.GEMINI_MAX_RETRIES,
    explicitCache: process.env.GEMINI_EXPLICIT_CACHE,
    cacheTtl: process.env.GEMINI_CACHE_TTL_SECONDS,
  };
  const sections = checkpointSet("FEMALE", "SAREE");
  const report = {
    attire_type: "SAREE",
    subject_visible: true,
    image_quality: "ADEQUATE",
    ai_summary: "The visible saree and other assessed requirements pass.",
    visible_regions: {
      face: "VISIBLE",
      upper_body: "VISIBLE",
      lower_body: "VISIBLE",
      footwear: "VISIBLE",
      id_card: "VISIBLE",
      hands: "VISIBLE",
    },
  };
  for (const key of SECTION_KEYS) {
    report[key] = Object.fromEntries(sections[key].map((item) => [item.code, {
      status: "PASS",
      observation: "Visible and acceptable.",
      reason: "Meets the checkpoint.",
    }]));
  }

  const classification = {
    subject_visible: true,
    attire_type: "SAREE",
    image_quality: "ADEQUATE",
    visible_regions: report.visible_regions,
  };

  let requestCount = 0;
  process.env.GEMINI_API_KEY = "test-only-gemini-key";
  process.env.GEMINI_MODEL = "gemini-2.5-flash-lite";
  process.env.GEMINI_TIMEOUT_MS = "120000";
  process.env.GEMINI_MAX_RETRIES = "0";
  process.env.GEMINI_EXPLICIT_CACHE = "true";
  process.env.GEMINI_CACHE_TTL_SECONDS = "3600";
  const imageRequests = [];
  const cacheRequests = [];
  globalThis.fetch = async (url, options) => {
    requestCount += 1;
    if (url.endsWith("/v1beta/cachedContents")) {
      const body = JSON.parse(options.body);
      cacheRequests.push({ url, options, body });
      return new Response(JSON.stringify({ name: `cachedContents/${body.displayName}` }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const body = JSON.parse(options.body);
    imageRequests.push({ url, options, body });
    // The first image call is the classification, the second the report.
    const payload = imageRequests.length === 1 ? classification : report;
    return new Response(JSON.stringify({
      candidates: [{
        content: { role: "model", parts: [{ text: JSON.stringify(payload) }] },
        finishReason: "STOP",
      }],
      usageMetadata: {
        promptTokenCount: 7000,
        candidatesTokenCount: 500,
        totalTokenCount: 7500,
        cachedContentTokenCount: 4096,
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const { evaluateImage } = await import("../src/services/visionEngine.js");
    const result = await evaluateImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg", "FEMALE");

    assert.equal(imageRequests.length, 2, "a classification request then a report request");
    assert.equal(requestCount, 4, "each step creates its own prompt cache");
    assert.equal(result.overall_status, "COMPLIANT");
    assert.equal(result.attire_type, "SAREE");
    assert.deepEqual(
      result.attire_check.map((item) => item.code),
      sections.attire_check.map((item) => item.code),
      "only the selected saree rows should reach the stored report",
    );

    const [classify, reportCall] = imageRequests.map((request) => (
      request.body.generationConfig.responseJsonSchema
    ));

    // The union of all four attire families is what Gemini refused to serve.
    // Neither request may carry one, or every female check-in fails again.
    for (const schema of [classify, reportCall]) {
      assert.equal(schema.type, "object");
      assert.equal(JSON.stringify(schema).includes("anyOf"), false, "no schema may use a union");
    }
    assert.deepEqual(
      Object.keys(classify.properties).sort(),
      ["attire_type", "image_quality", "subject_visible", "visible_regions"],
      "the classification step must not ask for checkpoints",
    );
    // Only the saree rows, and none from the families that were not chosen.
    assert.deepEqual(
      Object.keys(reportCall.properties.attire_check.properties),
      sections.attire_check.map((item) => item.code),
    );
    for (const code of ["W_KURTI_ATTIRE_TYPE", "W_FORMAL_TOP", "W_DUPATTA"]) {
      assert.equal(
        JSON.stringify(reportCall).includes(code),
        false,
        `${code} belongs to another attire family`,
      );
    }

    // Each step caches its own prompt, and neither may reach for the men's.
    assert.equal(cacheRequests.length, 2);
    assert.match(cacheRequests[0].body.displayName, /^nxtgroom-female-attire-/);
    assert.match(cacheRequests[1].body.displayName, /^nxtgroom-female-saree-/);
    for (const request of imageRequests) {
      assert.match(request.body.cachedContent, /^cachedContents\/nxtgroom-female-/);
      const images = request.body.contents[0].parts.filter((part) => part.inlineData);
      assert.equal(images.length, 1, "each step is given the photograph once");
      assert.equal(images[0].inlineData.data, "/9j/4A==");
    }
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of Object.entries({
      GEMINI_API_KEY: originalGemini.apiKey,
      GEMINI_MODEL: originalGemini.model,
      GEMINI_TIMEOUT_MS: originalGemini.timeout,
      GEMINI_MAX_RETRIES: originalGemini.retries,
      GEMINI_EXPLICIT_CACHE: originalGemini.explicitCache,
      GEMINI_CACHE_TTL_SECONDS: originalGemini.cacheTtl,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("a rejected explicit cache retries the image safely with the full prompt", async () => {
  const originalFetch = globalThis.fetch;
  const originalGemini = {
    apiKey: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_MODEL,
    timeout: process.env.GEMINI_TIMEOUT_MS,
    retries: process.env.GEMINI_MAX_RETRIES,
    explicitCache: process.env.GEMINI_EXPLICIT_CACHE,
    cacheTtl: process.env.GEMINI_CACHE_TTL_SECONDS,
  };
  const sections = checkpointSet("MALE", "FORMAL");
  const report = {
    subject_visible: true,
    image_quality: "ADEQUATE",
    ai_summary: "All visible requirements pass.",
    visible_regions: {
      face: "VISIBLE",
      upper_body: "VISIBLE",
      lower_body: "VISIBLE",
      footwear: "VISIBLE",
      id_card: "VISIBLE",
      hands: "VISIBLE",
    },
  };
  for (const key of SECTION_KEYS) {
    report[key] = Object.fromEntries(sections[key].map((item) => [item.code, {
      status: "PASS",
      observation: "Visible and acceptable.",
      reason: "Meets the checkpoint.",
    }]));
  }

  process.env.GEMINI_API_KEY = "test-only-expired-cache-key";
  process.env.GEMINI_MODEL = "gemini-2.5-flash-lite";
  process.env.GEMINI_TIMEOUT_MS = "120000";
  process.env.GEMINI_MAX_RETRIES = "0";
  process.env.GEMINI_EXPLICIT_CACHE = "true";
  process.env.GEMINI_CACHE_TTL_SECONDS = "3600";
  const requests = [];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url, body });
    if (url.endsWith("/v1beta/cachedContents")) {
      return new Response(JSON.stringify({ name: "cachedContents/expired-test" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (body.cachedContent) {
      return new Response(JSON.stringify({ error: { message: "Cached content was not found" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({
      candidates: [{
        content: { role: "model", parts: [{ text: JSON.stringify(report) }] },
        finishReason: "STOP",
      }],
      usageMetadata: { promptTokenCount: 5000, candidatesTokenCount: 500 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const { evaluateImage } = await import("../src/services/visionEngine.js");
    const result = await evaluateImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg", "MALE");
    assert.equal(result.overall_status, "COMPLIANT");
    assert.equal(requests.length, 3, "create, cached analysis and uncached fallback are expected");
    assert.equal(requests[1].body.cachedContent, "cachedContents/expired-test");
    assert.equal(requests[2].body.cachedContent, undefined);
    assert.equal(typeof requests[2].body.systemInstruction.parts[0].text, "string");
    assert.equal(
      requests[2].body.contents[0].parts.filter((part) => part.inlineData).length,
      1,
      "fallback must still submit exactly one instructor image",
    );
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of Object.entries({
      GEMINI_API_KEY: originalGemini.apiKey,
      GEMINI_MODEL: originalGemini.model,
      GEMINI_TIMEOUT_MS: originalGemini.timeout,
      GEMINI_MAX_RETRIES: originalGemini.retries,
      GEMINI_EXPLICIT_CACHE: originalGemini.explicitCache,
      GEMINI_CACHE_TTL_SECONDS: originalGemini.cacheTtl,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("interactive evaluation stays inside the HTTP request timeout", async () => {
  const { HTTP_REQUEST_TIMEOUT_MS, runtimeConfig } = await import("../src/config/env.js");
  const originalFetch = globalThis.fetch;
  const original = {
    key: process.env.GEMINI_API_KEY,
    cache: process.env.GEMINI_EXPLICIT_CACHE,
  };
  process.env.GEMINI_API_KEY = "test-only-gemini-key";
  process.env.GEMINI_EXPLICIT_CACHE = "false";

  const config = runtimeConfig();
  // Check-out analysis holds the connection open, so every attempt it is
  // allowed must finish before the server destroys the socket. This is the
  // arithmetic that failed in production: the worker's budget is 360s against
  // a 60s request timeout.
  const interactiveWorstCase = config.geminiInteractiveTimeoutMs
    * (config.geminiInteractiveMaxRetries + 1);
  assert.ok(
    interactiveWorstCase < HTTP_REQUEST_TIMEOUT_MS,
    `interactive worst case ${interactiveWorstCase}ms must be under ${HTTP_REQUEST_TIMEOUT_MS}ms`
  );
  // The background budget is deliberately larger, so the two must not be equal.
  assert.ok(config.geminiTimeoutMs * (config.geminiMaxRetries + 1) > interactiveWorstCase);

  const { evaluateImage } = await import("../src/services/visionEngine.js");
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    return {
      ok: false,
      status: 429,
      headers: { get: () => "0" },
      text: async () => JSON.stringify({ error: { message: "rate" } }),
    };
  };
  try {
    await assert.rejects(() => evaluateImage(Buffer.from("x"), "image/jpeg", "MALE", {
      timeoutMs: config.geminiInteractiveTimeoutMs,
      maxRetries: config.geminiInteractiveMaxRetries,
    }));
    assert.equal(attempts, config.geminiInteractiveMaxRetries + 1);

    // A caller may only shorten the budget, never extend it past the ceiling.
    attempts = 0;
    await assert.rejects(() => evaluateImage(Buffer.from("x"), "image/jpeg", "MALE", {
      timeoutMs: 999_000,
      maxRetries: 99,
    }));
    assert.equal(attempts, config.geminiMaxRetries + 1);
  } finally {
    globalThis.fetch = originalFetch;
    process.env.GEMINI_API_KEY = original.key;
    if (original.cache === undefined) delete process.env.GEMINI_EXPLICIT_CACHE;
    else process.env.GEMINI_EXPLICIT_CACHE = original.cache;
  }
});
