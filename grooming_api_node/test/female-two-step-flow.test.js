import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * The female path now asks for the garment first and the checkpoints second.
 * These cover what that split has to guarantee: the report request is made
 * against the family that was actually identified, and it is not made at all
 * when there is nothing to report on.
 */

const GEMINI_ENV = [
  "GEMINI_API_KEY",
  "GEMINI_MODEL",
  "GEMINI_TIMEOUT_MS",
  "GEMINI_MAX_RETRIES",
  "GEMINI_EXPLICIT_CACHE",
];

function withStubbedGemini(responses) {
  const originalFetch = globalThis.fetch;
  const original = Object.fromEntries(GEMINI_ENV.map((name) => [name, process.env[name]]));
  process.env.GEMINI_API_KEY = "test-only-gemini-key";
  process.env.GEMINI_MODEL = "gemini-2.5-flash-lite";
  process.env.GEMINI_TIMEOUT_MS = "120000";
  process.env.GEMINI_MAX_RETRIES = "0";
  // Off, so each call is one request and the counts read directly.
  process.env.GEMINI_EXPLICIT_CACHE = "false";

  const requests = [];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    const payload = responses[requests.length - 1];
    if (!payload) throw new Error(`unexpected Gemini request #${requests.length}`);
    return new Response(JSON.stringify({
      candidates: [{
        content: { role: "model", parts: [{ text: JSON.stringify(payload) }] },
        finishReason: "STOP",
      }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  return {
    requests,
    restore() {
      globalThis.fetch = originalFetch;
      for (const [name, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    },
  };
}

const ALL_VISIBLE = {
  face: "VISIBLE",
  upper_body: "VISIBLE",
  lower_body: "VISIBLE",
  footwear: "VISIBLE",
  id_card: "VISIBLE",
  hands: "VISIBLE",
};

const image = () => Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

test("a photograph with no person costs one request, not two", async () => {
  const stub = withStubbedGemini([{
    subject_visible: false,
    attire_type: "UNKNOWN",
    image_quality: "RETAKE_RECOMMENDED",
    visible_regions: { ...ALL_VISIBLE, face: "NOT_VISIBLE" },
  }]);
  try {
    const { evaluateImage } = await import("../src/services/visionEngine.js");
    const result = await evaluateImage(image(), "image/jpeg", "FEMALE");

    assert.equal(stub.requests.length, 1, "there is nothing to run checkpoints against");
    assert.equal(result.overall_status, "UNASSESSED");
    assert.equal(result.unassessed_reason, "NO_PERSON_VISIBLE");
    assert.deepEqual(result.attire_check, []);
  } finally {
    stub.restore();
  }
});

test("an unidentifiable outfit is still reported on, minus the attire rows", async () => {
  const { checkpointSet, SECTION_KEYS } = await import("../src/checkpoints.js");
  const sections = checkpointSet("FEMALE", "UNKNOWN");
  const regions = { ...ALL_VISIBLE, lower_body: "NOT_VISIBLE" };
  const report = {
    subject_visible: true,
    image_quality: "RETAKE_RECOMMENDED",
    ai_summary: "The outfit could not be identified.",
    visible_regions: regions,
  };
  for (const key of SECTION_KEYS) {
    if (!sections[key].length) continue;
    report[key] = Object.fromEntries(sections[key].map((item) => [item.code, {
      status: "PASS",
      observation: "Visible and acceptable.",
      reason: "Meets the checkpoint.",
    }]));
  }

  const stub = withStubbedGemini([
    {
      subject_visible: true,
      attire_type: "UNKNOWN",
      image_quality: "RETAKE_RECOMMENDED",
      visible_regions: regions,
    },
    report,
  ]);
  try {
    const { evaluateImage } = await import("../src/services/visionEngine.js");
    const result = await evaluateImage(image(), "image/jpeg", "FEMALE");

    assert.equal(result.overall_status, "UNASSESSED", "no garment means no dress-code verdict");
    assert.equal(result.unassessed_reason, "ATTIRE_NOT_IDENTIFIED");
    assert.equal(result.visible_regions.lower_body, "NOT_VISIBLE");

    // The garment-independent rows do not depend on the family and were
    // reported before the split; dropping them would lose real findings.
    assert.deepEqual(
      result.general_idcard_check.map((item) => item.code),
      sections.general_idcard_check.map((item) => item.code),
    );
    assert.ok(result.grooming_check.length > 0);
    assert.ok(result.footwear_check.length > 0);
    assert.deepEqual(result.attire_check, [], "there is no family to score attire against");

    // An empty section is left out of the schema rather than requested as an
    // empty object.
    const reportSchema = stub.requests[1].generationConfig.responseJsonSchema;
    assert.equal("attire_check" in reportSchema.properties, false);
    assert.equal(reportSchema.required.includes("attire_check"), false);
  } finally {
    stub.restore();
  }
});

test("the report request follows whichever family was classified", async () => {
  const { checkpointSet, SECTION_KEYS } = await import("../src/checkpoints.js");
  const sections = checkpointSet("FEMALE", "KURTI_WITH_DUPATTA");
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

  const stub = withStubbedGemini([
    {
      subject_visible: true,
      attire_type: "KURTI_WITH_DUPATTA",
      image_quality: "ADEQUATE",
      visible_regions: ALL_VISIBLE,
    },
    report,
  ]);
  try {
    const { evaluateImage } = await import("../src/services/visionEngine.js");
    const result = await evaluateImage(image(), "image/jpeg", "FEMALE");

    assert.equal(stub.requests.length, 2);
    assert.equal(result.attire_type, "KURTI_WITH_DUPATTA");
    assert.equal(result.overall_status, "COMPLIANT");
    assert.deepEqual(
      result.attire_check.map((item) => item.code),
      sections.attire_check.map((item) => item.code),
    );

    // The second request must be built for the classified family, not the
    // default one, or the rows would be scored against the wrong dress code.
    const reportSchema = stub.requests[1].generationConfig.responseJsonSchema;
    assert.deepEqual(
      Object.keys(reportSchema.properties.attire_check.properties),
      sections.attire_check.map((item) => item.code),
    );
  } finally {
    stub.restore();
  }
});

test("the classification step spends less reasoning budget than the report", async () => {
  const stub = withStubbedGemini([{
    subject_visible: false,
    attire_type: "UNKNOWN",
    image_quality: "RETAKE_RECOMMENDED",
    visible_regions: ALL_VISIBLE,
  }]);
  try {
    const { evaluateImage } = await import("../src/services/visionEngine.js");
    await evaluateImage(image(), "image/jpeg", "FEMALE");

    const config = stub.requests[0].generationConfig;
    assert.ok(
      config.thinkingConfig.thinkingBudget < 4096,
      "one multiple-choice question does not need a full report's budget"
    );
    assert.ok(config.maxOutputTokens > config.thinkingConfig.thinkingBudget);
  } finally {
    stub.restore();
  }
});
