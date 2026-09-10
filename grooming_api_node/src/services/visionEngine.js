import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import { z } from "zod";
import { runtimeConfig } from "../config/env.js";
import { incrementMetric, observeDuration } from "./telemetry.js";
import { buildFemaleAttirePrompt, buildSystemPrompt } from "../prompts.js";
import { checkpointSet, INFORMATIONAL_CODES, SECTION_KEYS } from "../checkpoints.js";

const GEMINI_API_ORIGIN = "https://generativelanguage.googleapis.com";
const FEMALE_ATTIRE_TYPES = ["SAREE", "KURTI_WITH_DUPATTA", "FORMAL", "UNKNOWN"];
// Enough room to inspect each body area before committing to a verdict,
// without paying for open-ended reasoning on a bounded checklist. Grooming
// needs the most of it: a beard's cheek line and a moustache's lip edge are
// fine local detail, and at a smaller budget both were passed on a general
// impression of the face rather than on those edges.
const DEFAULT_THINKING_BUDGET = 4096;
// The female classification step answers one multiple-choice question about
// the garment, so it does not need the budget a twenty-checkpoint report does.
const CLASSIFICATION_THINKING_BUDGET = 1024;
const CACHE_RENEWAL_SAFETY_SECONDS = 300;
const CACHE_FAILURE_BACKOFF_MS = 60_000;
// The registry is process-local, so every replica retries a failing cache on
// its own clock. Spreading the retry stops a fleet from hitting cachedContents
// in lockstep each time the backoff expires.
const CACHE_FAILURE_BACKOFF_JITTER_MS = 30_000;

// Process-local registry of Gemini server-side cache resource names. The
// resource itself lives at Gemini; this map merely prevents duplicate cache
// creation and lets concurrent evaluations share the same in-flight promise.
const geminiCacheRegistry = new Map();

const VISIBILITY = z.enum(["VISIBLE", "PARTIAL", "NOT_VISIBLE"]);

/**
 * One checkpoint's verdict.
 *
 * The code and the display name are deliberately absent: they come from the
 * checkpoint table, not from the model, so they cannot be misspelled, renamed
 * or invented. The model supplies only the judgement.
 */
const Entry = z.object({
  status: z.enum(["PASS", "FAIL", "N/A"]),
  observation: z.string(),
  reason: z.string(),
});

const ENTRY_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["PASS", "FAIL", "N/A"] },
    observation: { type: "string" },
    reason: { type: "string" },
  },
  required: ["status", "observation", "reason"],
};

function createGeminiError(message, code, { retryable = false } = {}) {
  const error = new Error(message);
  error.name = code;
  error.code = code;
  error.retryable = retryable;
  return error;
}

function geminiHttpError(status, providerMessage = "") {
  const safeMessage = String(providerMessage).replace(/\s+/g, " ").slice(0, 300);
  if (status === 429) {
    return createGeminiError(
      `Gemini rate limit exceeded${safeMessage ? `: ${safeMessage}` : ""}`,
      "RATE_LIMIT_EXCEEDED",
      { retryable: true }
    );
  }
  if (status === 401 || status === 403) {
    return createGeminiError("Gemini authentication failed", "GEMINI_AUTH_ERROR");
  }
  if (status === 408) {
    return createGeminiError("Gemini request timed out", "GEMINI_TIMEOUT", { retryable: true });
  }
  if (status >= 500) {
    return createGeminiError(
      `Gemini service error (${status})${safeMessage ? `: ${safeMessage}` : ""}`,
      "GEMINI_SERVER_ERROR",
      { retryable: true }
    );
  }
  return createGeminiError(
    `Gemini request failed (${status})${safeMessage ? `: ${safeMessage}` : ""}`,
    "GEMINI_REQUEST_ERROR"
  );
}

function retryAfterMilliseconds(response, attempt) {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(Math.max(date - Date.now(), 0), 60000);
  }
  return Math.min(1000 * (2 ** attempt), 10000);
}

function extractGeminiText(responseBody) {
  return (responseBody?.candidates || [])
    .flatMap((candidate) => candidate?.content?.parts || [])
    .filter((part) => typeof part?.text === "string")
    .map((part) => part.text)
    .join("")
    .trim();
}

/** Records provider-reported usage without logging prompts, images or people. */
function recordGeminiUsage(responseBody) {
  const usage = responseBody?.usageMetadata || {};
  const inputTokens = Number(usage.promptTokenCount || 0);
  const outputTokens = Number(usage.candidatesTokenCount || 0);
  // Recorded so the distance between real responses and maxOutputTokens is
  // visible. Without it, a ceiling quietly becoming too tight for the schema
  // showed up only as MAX_TOKENS failures after the fact.
  if (Number.isFinite(outputTokens) && outputTokens > 0) {
    observeDuration("gemini_output_tokens", outputTokens);
  }
  const cachedTokens = Number(usage.cachedContentTokenCount || 0);
  if (Number.isFinite(inputTokens) && inputTokens > 0) {
    incrementMetric("gemini_input_tokens_total", inputTokens);
  }
  if (Number.isFinite(outputTokens) && outputTokens > 0) {
    incrementMetric("gemini_output_tokens_total", outputTokens);
  }
  if (Number.isFinite(cachedTokens) && cachedTokens > 0) {
    incrementMetric("gemini_cached_input_tokens_total", cachedTokens);
  }
  // Provider usage metadata covers both the explicit prompt cache used here
  // and Gemini's automatic implicit prefix cache on an uncached fallback.
  incrementMetric("gemini_prompt_cache_requests_total");
  incrementMetric(cachedTokens > 0
    ? "gemini_prompt_cache_hits_total"
    : "gemini_prompt_cache_misses_total");
}

function geminiPart(part) {
  if (part?.type === "input_text") return { text: part.text };
  if (part?.type === "input_image") {
    return {
      inlineData: {
        mimeType: part.mimeType,
        data: part.data,
      },
    };
  }
  throw createGeminiError("Unsupported Gemini input part", "GEMINI_REQUEST_ERROR");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function cacheRegistryKey({ apiKey, model, namespace, systemInstruction }) {
  // Hash the credential instead of retaining a secret in a long-lived map key.
  return [sha256(apiKey).slice(0, 16), model, namespace, sha256(systemInstruction)].join(":");
}

function cachedContentModel(model) {
  return model.startsWith("models/") ? model : `models/${model}`;
}

function safeProviderMessage(body) {
  return String(body?.error?.message || "")
    .replace(/\s+/g, " ")
    .slice(0, 200);
}

/**
 * Creates or reuses one explicit Gemini context cache for a stable prompt.
 *
 * Male and female calls use different namespaces and different prompt hashes,
 * so one gender can never receive the other gender's cached instructions.
 * A null result is deliberate: the caller continues through the existing
 * uncached request path when caching is unavailable for any reason.
 */
async function ensureGeminiPromptCache({ apiKey, config, namespace, systemInstruction }) {
  if (!config.geminiExplicitCache) return null;

  const registryKey = cacheRegistryKey({
    apiKey,
    model: config.geminiModel,
    namespace,
    systemInstruction,
  });
  const now = Date.now();
  const existing = geminiCacheRegistry.get(registryKey);
  if (existing && existing.expiresAt > now) {
    return existing.namePromise.then((name) => (name ? { name, registryKey } : null));
  }

  const reuseSeconds = Math.max(
    config.geminiCacheTtlSeconds - CACHE_RENEWAL_SAFETY_SECONDS,
    Math.floor(config.geminiCacheTtlSeconds / 2),
  );
  const entry = {
    expiresAt: now + reuseSeconds * 1000,
    namePromise: Promise.resolve(null),
  };

  entry.namePromise = (async () => {
    incrementMetric("gemini_explicit_cache_create_attempts_total");
    try {
      const response = await fetch(`${GEMINI_API_ORIGIN}/v1beta/cachedContents`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          model: cachedContentModel(config.geminiModel),
          displayName: `nxtgroom-${namespace}-${sha256(systemInstruction).slice(0, 12)}`.slice(0, 128),
          systemInstruction: { parts: [{ text: systemInstruction }] },
          ttl: `${config.geminiCacheTtlSeconds}s`,
        }),
        signal: AbortSignal.timeout(Math.min(config.geminiTimeoutMs, 30_000)),
      });
      const bodyText = await response.text();
      let body = {};
      try {
        body = bodyText ? JSON.parse(bodyText) : {};
      } catch {
        // An unreadable cache response is treated exactly like no cache.
      }
      const name = typeof body?.name === "string" ? body.name : null;
      if (!response.ok || !name) {
        incrementMetric("gemini_explicit_cache_create_failures_total");
        entry.expiresAt = Date.now() + CACHE_FAILURE_BACKOFF_MS
          + Math.floor(Math.random() * CACHE_FAILURE_BACKOFF_JITTER_MS);
        console.warn(
          `Gemini explicit prompt cache unavailable for ${namespace} (${response.status}`
          + `${safeProviderMessage(body) ? `: ${safeProviderMessage(body)}` : ""}); using uncached evaluation.`
        );
        return null;
      }
      incrementMetric("gemini_explicit_cache_create_successes_total");
      return name;
    } catch (error) {
      incrementMetric("gemini_explicit_cache_create_failures_total");
      entry.expiresAt = Date.now() + CACHE_FAILURE_BACKOFF_MS
        + Math.floor(Math.random() * CACHE_FAILURE_BACKOFF_JITTER_MS);
      console.warn(
        `Gemini explicit prompt cache unavailable for ${namespace} (${error?.name || "request error"}); using uncached evaluation.`
      );
      return null;
    }
  })();

  geminiCacheRegistry.set(registryKey, entry);
  const name = await entry.namePromise;
  return name ? { name, registryKey } : null;
}

function invalidateGeminiPromptCache(cacheReference) {
  if (!cacheReference) return;
  geminiCacheRegistry.delete(cacheReference.registryKey);
}

function buildGeminiRequestBody({
  systemInstruction,
  input,
  jsonSchema,
  maxOutputTokens,
  cacheName,
  thinkingBudget = DEFAULT_THINKING_BUDGET,
}) {
  return {
    ...(cacheName
      ? { cachedContent: cacheName }
      : { systemInstruction: { parts: [{ text: systemInstruction }] } }),
    contents: [{
      role: "user",
      parts: input.map(geminiPart),
    }],
    generationConfig: {
      responseMimeType: "application/json",
      responseJsonSchema: jsonSchema,
      maxOutputTokens,
      temperature: 0,
      // A grooming report is ~20 independent visual judgements over one
      // photograph, each needing the model to look at a specific body area
      // before committing to PASS/FAIL/N/A. With no thinking budget the model
      // answered the whole schema in one pass and produced confident text that
      // contradicted the image: a visible beard scored PASS, hair across the
      // forehead scored PASS, and lower-body checkpoints were asserted from a
      // face-only photograph. Give it room to inspect before it answers.
      thinkingConfig: { thinkingBudget },
      mediaResolution: "MEDIA_RESOLUTION_HIGH",
    },
  };
}

async function requestGeminiStructured({
  systemInstruction,
  cacheNamespace,
  input,
  jsonSchema,
  validator,
  maxOutputTokens,
  thinkingBudget,
  limits,
}) {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw createGeminiError("GEMINI_API_KEY is not configured", "GEMINI_AUTH_ERROR");

  const config = runtimeConfig();
  // A caller holding an HTTP connection open cannot wait for the background
  // worker's budget, so it may shorten both the per-attempt timeout and the
  // retry count. Nothing may exceed the configured ceiling.
  const ceiling = Math.min(limits?.timeoutMs ?? config.geminiTimeoutMs, config.geminiTimeoutMs);
  const maxRetries = Math.min(limits?.maxRetries ?? config.geminiMaxRetries, config.geminiMaxRetries);
  // A caller may also cap the whole evaluation rather than each request, which
  // is what an interactive check-out needs: it makes two calls for a woman and
  // one for a man, so a per-request budget let the female path reach twice the
  // worst case the request timeout was sized for. Whatever remains of the
  // shared deadline bounds this attempt.
  const remaining = limits?.deadlineAt
    ? limits.deadlineAt - Date.now()
    : Number.POSITIVE_INFINITY;
  if (remaining <= 0) {
    throw createGeminiError("Gemini evaluation ran out of time", "GEMINI_TIMEOUT", { retryable: false });
  }
  const timeoutMs = Math.max(1, Math.min(ceiling, remaining));
  const endpoint = `${GEMINI_API_ORIGIN}/v1beta/models/${encodeURIComponent(config.geminiModel)}:generateContent`;
  let cacheReference = await ensureGeminiPromptCache({
    apiKey,
    config,
    namespace: cacheNamespace,
    systemInstruction,
  });
  let requestBody = buildGeminiRequestBody({
    systemInstruction,
    input,
    jsonSchema,
    maxOutputTokens,
    thinkingBudget,
    cacheName: cacheReference?.name,
  });

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const requestStartedAt = Date.now();
    incrementMetric("gemini_requests_total");
    if (attempt > 0) incrementMetric("gemini_retries_total");
    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(timeoutMs),
      });
      observeDuration("gemini_request_latency", Date.now() - requestStartedAt);
    } catch (cause) {
      observeDuration("gemini_request_latency", Date.now() - requestStartedAt);
      incrementMetric("gemini_request_failures_total");
      const timedOut = cause?.name === "TimeoutError" || cause?.name === "AbortError";
      const error = createGeminiError(
        timedOut ? "Gemini request timed out" : "Gemini request could not reach the service",
        timedOut ? "GEMINI_TIMEOUT" : "GEMINI_NETWORK_ERROR",
        { retryable: true }
      );
      if (attempt === maxRetries) throw error;
      await delay(Math.min(1000 * (2 ** attempt), 10000));
      continue;
    }

    const bodyText = await response.text();
    let body;
    try {
      body = bodyText ? JSON.parse(bodyText) : {};
    } catch {
      throw createGeminiError("Gemini returned an unreadable response", "GEMINI_INVALID_RESPONSE");
    }

    if (!response.ok) {
      incrementMetric("gemini_request_failures_total");
      // An expired, deleted or provider-rejected cache must never strand an
      // attendance evaluation. Retry this same attempt once with the original
      // full system instruction, then retain the normal retry policy.
      if (cacheReference && (response.status === 400 || response.status === 404)) {
        invalidateGeminiPromptCache(cacheReference);
        cacheReference = null;
        requestBody = buildGeminiRequestBody({
          systemInstruction,
          input,
          jsonSchema,
          maxOutputTokens,
          thinkingBudget,
          cacheName: null,
        });
        incrementMetric("gemini_explicit_cache_fallbacks_total");
        console.warn(`Gemini rejected the cached ${cacheNamespace} prompt; retrying uncached.`);
        attempt -= 1;
        continue;
      }
      const error = geminiHttpError(response.status, body?.error?.message);
      if (!error.retryable || attempt === maxRetries) throw error;
      await delay(retryAfterMilliseconds(response, attempt));
      continue;
    }
    recordGeminiUsage(body);
    const finishReason = body?.candidates?.[0]?.finishReason;
    if (finishReason && finishReason !== "STOP") {
      // MAX_TOKENS is a configuration problem, not provider flakiness: the
      // report plus the thinking budget did not fit in maxOutputTokens. It was
      // counted with every other incomplete response, so an outgrown ceiling
      // was invisible while paying for a full retry on each occurrence.
      incrementMetric(finishReason === "MAX_TOKENS"
        ? "gemini_max_output_tokens_total"
        : "gemini_incomplete_responses_total");
      throw createGeminiError(
        `Gemini did not complete the evaluation (finish reason: ${finishReason})`,
        "GEMINI_INCOMPLETE_RESPONSE"
      );
    }

    const text = extractGeminiText(body);
    if (!text) {
      const blockReason = body?.promptFeedback?.blockReason;
      throw createGeminiError(
        blockReason
          ? `Gemini blocked the evaluation (${blockReason})`
          : "Gemini returned no structured evaluation",
        blockReason ? "GEMINI_BLOCKED_RESPONSE" : "GEMINI_INVALID_RESPONSE"
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw createGeminiError("Gemini returned invalid structured JSON", "GEMINI_INVALID_RESPONSE");
    }
    incrementMetric("gemini_request_success_total");
    return validator.parse(parsed);
  }

  throw createGeminiError("Gemini evaluation failed", "GEMINI_REQUEST_ERROR");
}

/**
 * A schema whose keys are exactly this instructor's checkpoint codes.
 *
 * Structured outputs require every object key to be present, so keying by code
 * rather than returning an array makes four whole classes of bad response
 * impossible rather than merely detectable: a checkpoint cannot be omitted,
 * duplicated, returned under a foreign code, or returned out of order. The
 * previous array schema could express all four, and did.
 */
function buildReportSchema(sections, { attireType = null } = {}) {
  const shape = {
    // Asked directly rather than inferred from the checkpoints. "Nothing was
    // examined" and "nothing was wrong" both produce a report with no
    // failures, and only this tells them apart.
    subject_visible: z.boolean(),
    image_quality: z.enum(["ADEQUATE", "RETAKE_RECOMMENDED"]),
    ai_summary: z.string(),
    visible_regions: z.object({
      face: VISIBILITY,
      upper_body: VISIBILITY,
      lower_body: VISIBILITY,
      footwear: VISIBILITY,
      id_card: VISIBILITY,
      hands: VISIBILITY,
    }),
  };
  if (attireType) shape.attire_type = z.literal(attireType);
  for (const key of SECTION_KEYS) {
    // A family with no rows in a section is omitted rather than asked for as
    // an empty object. UNKNOWN attire has no attire_check, and toOrderedRows
    // reads the checkpoint table rather than the response, so nothing looks
    // for a key that was never requested.
    if (!sections[key].length) continue;
    shape[key] = z.object(
      Object.fromEntries(sections[key].map((item) => [item.code, Entry]))
    );
  }
  return z.object(shape);
}

function buildReportJsonSchema(sections, { attireType = null } = {}) {
  const properties = {
    subject_visible: { type: "boolean" },
    image_quality: { type: "string", enum: ["ADEQUATE", "RETAKE_RECOMMENDED"] },
    ai_summary: { type: "string" },
    visible_regions: {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries([
        "face", "upper_body", "lower_body", "footwear", "id_card", "hands",
      ].map((key) => [key, { type: "string", enum: ["VISIBLE", "PARTIAL", "NOT_VISIBLE"] }])),
      required: ["face", "upper_body", "lower_body", "footwear", "id_card", "hands"],
    },
  };
  if (attireType) properties.attire_type = { type: "string", enum: [attireType] };
  const populatedKeys = SECTION_KEYS.filter((key) => sections[key].length);
  for (const key of populatedKeys) {
    properties[key] = {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries(sections[key].map((item) => [item.code, ENTRY_JSON_SCHEMA])),
      required: sections[key].map((item) => item.code),
    };
  }
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required: [
      "subject_visible",
      "image_quality",
      "ai_summary",
      "visible_regions",
      ...(attireType ? ["attire_type"] : []),
      ...populatedKeys,
    ],
  };
}

/**
 * The classification step's response: which garment, and what the photograph
 * shows. No checkpoints, so the schema stays small.
 *
 * This replaced a union of all four attire families. Gemini turns a response
 * schema into a constrained-decoding state machine, and that union needed
 * every row of every branch present at once — 71 properties where a man's
 * report needs 20. The provider rejected it with a deterministic 400, "the
 * specified schema produces a constraint that has too many states for
 * serving", which retries could not clear, so every female evaluation failed.
 */
function buildFemaleAttireSchema() {
  return z.object({
    subject_visible: z.boolean(),
    attire_type: z.enum(FEMALE_ATTIRE_TYPES),
    image_quality: z.enum(["ADEQUATE", "RETAKE_RECOMMENDED"]),
    visible_regions: z.object({
      face: VISIBILITY,
      upper_body: VISIBILITY,
      lower_body: VISIBILITY,
      footwear: VISIBILITY,
      id_card: VISIBILITY,
      hands: VISIBILITY,
    }),
  });
}

function buildFemaleAttireJsonSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      subject_visible: { type: "boolean" },
      attire_type: { type: "string", enum: [...FEMALE_ATTIRE_TYPES] },
      image_quality: { type: "string", enum: ["ADEQUATE", "RETAKE_RECOMMENDED"] },
      visible_regions: {
        type: "object",
        additionalProperties: false,
        properties: Object.fromEntries([
          "face", "upper_body", "lower_body", "footwear", "id_card", "hands",
        ].map((key) => [key, { type: "string", enum: ["VISIBLE", "PARTIAL", "NOT_VISIBLE"] }])),
        required: ["face", "upper_body", "lower_body", "footwear", "id_card", "hands"],
      },
    },
    required: ["subject_visible", "attire_type", "image_quality", "visible_regions"],
  };
}

/** Rebuilds the ordered rows the report renders, from the checkpoint table. */
function toOrderedRows(sections, parsed) {
  const result = {};
  for (const key of SECTION_KEYS) {
    result[key] = sections[key].map((item) => {
      const entry = parsed[key][item.code];
      return {
        code: item.code,
        checkpoint_name: item.name,
        status: entry.status,
        observation: String(entry.observation || "").slice(0, 1000) || "Not stated.",
        reason: String(entry.reason || "").slice(0, 1000) || "Not stated.",
      };
    });
  }
  return result;
}

/**
 * Settles an ID card row that abstained while describing a violation.
 *
 * The checkpoint asks one thing — is a card being worn — so the photograph can
 * only fail to answer it when the chest is not shown. Asked directly, the model
 * still returned N/A for a clearly visible chest with no card on it, giving as
 * its reason "the upper body is visible, but no ID card is present": the FAIL
 * condition, stated in full, filed as an abstention. Every rewording of the
 * instruction left some version of that contradiction, so the two visibility
 * regions decide it here instead of the wording.
 *
 * Only this direction is corrected. A PASS is the model reporting a card it can
 * see, which no region flag contradicts, and turning an abstention into a FAIL
 * needs both regions to agree that the chest is shown and the card is not.
 */
export function resolveIdCardAbstention(rows, visibleRegions) {
  const row = (rows.general_idcard_check || []).find((item) => item.code === "ID_PRESENT");
  if (!row || row.status !== "N/A") return rows;
  if (visibleRegions?.upper_body !== "VISIBLE") return rows;
  if (visibleRegions?.id_card !== "NOT_VISIBLE") return rows;
  row.status = "FAIL";
  row.reason = "The upper body is visible and no ID card is being worn.";
  return rows;
}

/**
 * Enforces the small set of men's visibility rules whose result is otherwise
 * easy for a vision model to contradict in its own prose.
 *
 * Tuck and belt are required capture checks: an image that does not show them
 * has not demonstrated compliance, so their checkpoint contract deliberately
 * treats an abstention as a failure. Rings and chains work in the opposite
 * direction: when the relevant area is visible and the model explicitly says
 * the accessory is absent, absence is a PASS rather than N/A.
 */
export function resolveMaleAttireVisibility(rows, visibleRegions) {
  const find = (section, code) => (rows?.[section] || []).find((item) => item.code === code);

  // Tuck is a separate checkpoint. Correct only the narrow category error in
  // which an untucked waist is used to fail Shirt Fit; genuine fit violations
  // such as pulling, tightness, looseness and bunching remain failures.
  const shirtFit = find("attire_check", "M_SHIRT_FIT");
  if (shirtFit?.status === "FAIL") {
    const text = `${shirtFit.observation || ""} ${shirtFit.reason || ""}`.toLowerCase();
    const mentionsTuck = /\b(?:tuck(?:ed|ing)?|untucked|waist(?:band)?|shirt\s+(?:hem|tail))\b/i.test(text);
    // Bare "loose" is how an untucked hem gets described - "the shirt hangs
    // loose outside the trousers" - so counting it as a fit violation kept the
    // tuck finding filed against Shirt Fit, which is the exact
    // miscategorisation this block exists to undo. Only wording that actually
    // describes how the shirt fits counts.
    const mentionsFitViolation = /\b(?:pull(?:ing|s|ed)?|tight(?:ness)?|bunch(?:ing|ed)?|baggy|looseness|loose[-\s]?fitting|(?:excessively|overly|too|very)\s+loose|ill[-\s]?fitt?ing|poor\s+fit)\b/i.test(text);
    if (mentionsTuck && !mentionsFitViolation) {
      shirtFit.status = "PASS";
      shirtFit.observation = "No shirt-fit violation is identified; shirt tuck is assessed separately.";
      shirtFit.reason = "Tucking is evaluated only in the Shirt Collar / Tuck checkpoint.";
    }
  }

  // The override applied whatever the photograph showed, so a head-and-
  // shoulders picture produced two dress-code failures about a waistband that
  // was never in frame. That contradicts the prompt's own rule - a body area
  // outside the frame must be answered N/A, never inferred - and it only ever
  // applied to men, since the women's path has no equivalent, so identical
  // framing produced a worse verdict for a man. A waist that is genuinely out
  // of frame keeps its abstention; anything else is still a required check
  // the photograph had to evidence.
  const lowerBodyInFrame = visibleRegions?.lower_body !== "NOT_VISIBLE";

  const tuck = find("attire_check", "M_SHIRT_COLLAR_TUCK");
  if (tuck?.status === "N/A" && lowerBodyInFrame) {
    tuck.status = "FAIL";
    tuck.reason = "The submitted photograph does not show the required shirt tuck clearly enough to verify compliance.";
    // Marks the failure as one about the evidence rather than about the
    // clothing, so the advice attached to it can say the same thing the reason
    // does. Internal: the report renders named fields only.
    tuck.evidence = "NOT_SHOWN";
  }

  const belt = find("attire_check", "M_BELT");
  if (belt?.status === "N/A" && lowerBodyInFrame) {
    belt.status = "FAIL";
    belt.reason = "The submitted photograph does not show the required belt clearly enough to verify compliance.";
    belt.evidence = "NOT_SHOWN";
  }

  // Their written standards tell the model to fail these outright when the
  // photograph cannot evidence them, so most such failures arrive as FAIL and
  // never pass through the branches above. The verdict stands - that policy is
  // deliberate - but a failure recorded against a photograph with no lower
  // body in it is a statement about the framing, so mark it as one. Otherwise
  // the advice tells somebody to put on a belt that was never in the picture
  // while the reason on the same row says it could not be seen.
  if (!lowerBodyInFrame) {
    for (const code of ["M_SHIRT_COLLAR_TUCK", "M_BELT"]) {
      const row = find("attire_check", code);
      if (row?.status === "FAIL") row.evidence = "NOT_SHOWN";
    }
  }

  const explicitlyAbsent = (row, itemPattern) => {
    const text = `${row?.observation || ""} ${row?.reason || ""}`.toLowerCase();
    if (/\b(?:cropped|obscured|covered|blurred|unclear|too\s+(?:small|distant)|cannot\s+assess|can't\s+assess|unable\s+to\s+(?:assess|identify|tell))\b/i.test(text)) {
      return false;
    }
    return new RegExp(`(?:no|without)\\s+(?:visible\\s+)?(?:${itemPattern})\\w*\\b|(?:${itemPattern})\\w*[^.]{0,35}\\b(?:not\\s+(?:visible|present|seen|noted)|absent)\\b`, "i").test(text);
  };

  const rings = find("accessories_check", "M_RINGS");
  if (rings?.status === "N/A"
      && visibleRegions?.hands === "VISIBLE"
      && explicitlyAbsent(rings, "ring")) {
    rings.status = "PASS";
    rings.reason = "The hands are clearly visible and no rings are present, which complies with the standard.";
  }

  const chain = find("accessories_check", "M_CHAIN");
  if (chain?.status === "N/A"
      && visibleRegions?.upper_body === "VISIBLE"
      && explicitlyAbsent(chain, "chain|necklace|pendant")) {
    chain.status = "PASS";
    chain.reason = "The neck and collar area are visible and no chain, necklace or pendant is present, which complies with the standard.";
  }

  return rows;
}

/**
 * The compliance verdict, computed from the checkpoints rather than asked for.
 *
 * The model used to be asked for overall_status and then checked against the
 * rows; a disagreement threw away an otherwise sound evaluation and left the
 * attendance record in error. The rule has one line, so there is nothing to
 * ask: any FAIL means non-compliant, and N/A never does.
 */
export function deriveVerdict(rows, { imageQuality } = {}) {
  // Informational rows are excluded outright rather than trusted to come back
  // as PASS. A watch is optional, so a model that returns FAIL for one must
  // not be able to mark somebody non-compliant for wearing it.
  const checks = SECTION_KEYS
    .flatMap((key) => rows[key] || [])
    .filter((item) => !INFORMATIONAL_CODES.has(item.code));
  const anyFail = checks.some((item) => item.status === "FAIL");
  // A photo showing nothing assessable comes back entirely N/A. That is not a
  // verdict about the instructor, so it asks for a retake instead of one.
  const nothingAssessed = checks.length > 0
    && checks.every((item) => item.status === "N/A");

  return {
    // No assessed checkpoint is not evidence of compliance. Treat an empty
    // or all-N/A result as unassessed so a ceiling, group shot, or occluded
    // person can never receive a clean verdict merely because nothing failed.
    overall_status: nothingAssessed || checks.length === 0
      ? "UNASSESSED"
      : anyFail ? "NON_COMPLIANT" : "COMPLIANT",
    image_quality: nothingAssessed ? "RETAKE_RECOMMENDED" : (imageQuality || "ADEQUATE"),
  };
}

function instructorImagePart(imageBuffer, mimeType) {
  return {
    type: "input_image",
    mimeType,
    data: imageBuffer.toString("base64"),
  };
}

/**
 * A result that makes no compliance claim.
 *
 * Used wherever the checkpoints could not meaningfully be applied. The five
 * sections come back empty on purpose: twenty rows of N/A tell a reader
 * nothing they cannot already see from one sentence, and rendering them
 * implies the checks ran and found nothing wrong.
 *
 * overall_status is UNASSESSED rather than COMPLIANT. A report with no
 * failures and a report where nothing was examined are not the same thing, and
 * calling the second one compliant is how a photograph of a ceiling passed.
 */
export function unassessedEvaluation(reason, summary, { imageQuality = "ADEQUATE" } = {}) {
  return {
    overall_status: "UNASSESSED",
    attire_type: "UNKNOWN",
    image_quality: imageQuality,
    ai_summary: summary,
    general_idcard_check: [],
    grooming_check: [],
    attire_check: [],
    accessories_check: [],
    footwear_check: [],
    visible_regions: null,
    unassessed_reason: reason,
  };
}

/**
 * The evaluation returned when no gender is on the instructor record.
 *
 * Every dress-code rule below the ID card differs by gender, so there is no
 * honest verdict to give: assessing against both — which is what happened
 * before — measured men against saree standards and produced failures for
 * rules that never applied to them.
 */
export function unknownGenderEvaluation() {
  return unassessedEvaluation(
    "GENDER_NOT_CONFIGURED",
    "This instructor has no gender recorded, so the applicable dress code could not be determined and no appearance assessment was made. Set the gender on the instructor record; the next check-in will be assessed normally."
  );
}

/**
 * Turns a caller's per-request budget into one deadline for the whole
 * evaluation.
 *
 * The female path makes two model calls, so a limit expressed per request
 * described twice the worst case the caller was actually willing to wait for.
 * An interactive check-out holds an HTTP connection that the server destroys
 * at requestTimeout, and overrunning it shows the instructor a failure while
 * the analysis carries on server-side and still emails them a report.
 */
function sharedDeadline(limits) {
  if (!limits || limits.deadlineAt) return limits;
  const config = runtimeConfig();
  const perAttempt = Math.min(limits.timeoutMs ?? config.geminiTimeoutMs, config.geminiTimeoutMs);
  const attempts = Math.min(limits.maxRetries ?? config.geminiMaxRetries, config.geminiMaxRetries) + 1;
  return { ...limits, deadlineAt: Date.now() + perAttempt * attempts };
}

export async function evaluateImage(imageBuffer, mimeType, gender = null, limits = undefined) {
  if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
    throw new Error("Instructor image is empty or invalid");
  }
  limits = sharedDeadline(limits);
  const normalizedGender = gender?.toUpperCase();
  if (normalizedGender !== "MALE" && normalizedGender !== "FEMALE") {
    return unknownGenderEvaluation();
  }

  const content = [{
    type: "input_text",
    text: "Assess the instructor in the following image against every applicable written NxtWave Grooming Standard in the instructions.",
  }];
  content.push(instructorImagePart(imageBuffer, mimeType));

  let attireType = "FORMAL";
  let parsed;
  if (normalizedGender === "FEMALE") {
    // Which garment, asked on its own. Folding this into the report request
    // meant offering all four attire families in one schema, which Gemini now
    // rejects outright as too many states to serve, so nothing about a woman
    // could be evaluated. See buildFemaleAttirePrompt.
    const classification = await requestGeminiStructured({
      systemInstruction: buildFemaleAttirePrompt(),
      cacheNamespace: "female-attire",
      input: content,
      jsonSchema: buildFemaleAttireJsonSchema(),
      validator: buildFemaleAttireSchema(),
      maxOutputTokens: 512 + CLASSIFICATION_THINKING_BUDGET,
      thinkingBudget: CLASSIFICATION_THINKING_BUDGET,
      limits,
    });
    attireType = classification.attire_type;

    // Both of these end the evaluation, so the checkpoint request is never
    // made. A photograph with nobody in it, or one that cannot show what is
    // being worn, now costs one call rather than the two it would have taken
    // to reach the same answer.
    if (classification.subject_visible === false) {
      incrementMetric("evaluations_unassessed_total");
      return unassessedEvaluation(
        "NO_PERSON_VISIBLE",
        "The photograph does not show the instructor, so no appearance assessment could be made. Retake it as a clear, full-length photo of the person checking in.",
        { imageQuality: "RETAKE_RECOMMENDED" }
      );
    }
    // UNKNOWN attire is not short-circuited. Its checkpoint set still carries
    // the ID card, grooming, accessories and footwear rows, which do not
    // depend on the garment and were reported before this split; only the
    // attire section is empty. The verdict below stays UNASSESSED regardless.

    // One family's rows, through the same flat schema the men's path uses.
    const femaleSections = checkpointSet("FEMALE", attireType);
    parsed = await requestGeminiStructured({
      systemInstruction: buildSystemPrompt("FEMALE", attireType),
      cacheNamespace: `female-${attireType.toLowerCase()}`,
      input: content,
      jsonSchema: buildReportJsonSchema(femaleSections),
      validator: buildReportSchema(femaleSections),
      // Covers the JSON report plus the thinking budget, which Gemini counts
      // against the same ceiling: at 6000 a full checkpoint set could stop on
      // MAX_TOKENS once thinking was enabled.
      maxOutputTokens: 6000 + DEFAULT_THINKING_BUDGET,
      limits,
    });
  } else {
    const maleSections = checkpointSet("MALE", attireType);
    parsed = await requestGeminiStructured({
      systemInstruction: buildSystemPrompt("MALE", attireType),
      cacheNamespace: `male-${attireType.toLowerCase()}`,
      input: content,
      jsonSchema: buildReportJsonSchema(maleSections),
      validator: buildReportSchema(maleSections),
      // Covers the JSON report plus the thinking budget, which Gemini counts
      // against the same ceiling: at 6000 a full checkpoint set could stop on
      // MAX_TOKENS once thinking was enabled.
      maxOutputTokens: 6000 + DEFAULT_THINKING_BUDGET,
      limits,
    });
  }
  const sections = checkpointSet(normalizedGender, attireType);

  // Nothing to tabulate when the photograph does not show the person. The
  // checkpoints are dropped rather than returned as twenty N/A rows, and no
  // verdict is recorded against the instructor for a picture of a wall.
  if (parsed.subject_visible === false) {
    incrementMetric("evaluations_unassessed_total");
    return unassessedEvaluation(
      "NO_PERSON_VISIBLE",
      "The photograph does not show the instructor, so no appearance assessment could be made. Retake it as a clear, full-length photo of the person checking in.",
      { imageQuality: "RETAKE_RECOMMENDED" }
    );
  }

  const rows = toOrderedRows(sections, parsed);
  resolveIdCardAbstention(rows, parsed.visible_regions);
  if (normalizedGender === "MALE") {
    resolveMaleAttireVisibility(rows, parsed.visible_regions);
  }
  // An unidentified garment cannot be scored against a dress code, however
  // many of the garment-independent rows came back.
  const verdict = attireType === "UNKNOWN"
    ? { overall_status: "UNASSESSED", image_quality: "RETAKE_RECOMMENDED" }
    : deriveVerdict(rows, { imageQuality: parsed.image_quality });
  if (verdict.overall_status === "UNASSESSED") incrementMetric("evaluations_unassessed_total");

  return {
    ...verdict,
    attire_type: attireType,
    ai_summary: String(parsed.ai_summary || "").slice(0, 1500),
    visible_regions: parsed.visible_regions,
    ...(attireType === "UNKNOWN" ? { unassessed_reason: "ATTIRE_NOT_IDENTIFIED" } : {}),
    ...rows,
  };
}
