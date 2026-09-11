// The server destroys a socket that outlives this, so anything running inside
// a request must finish first. Exported so server.js and the check below can
// never drift apart.
export const HTTP_REQUEST_TIMEOUT_MS = 60000;

const DEV_JWT_SECRET = "development-only-secret-change-before-production";
const EXAMPLE_JWT_SECRET = "replace-with-at-least-32-random-characters";
const EXAMPLE_ADMIN_PASSWORD = "replace-with-a-unique-password-of-at-least-12-characters";

function parseInteger(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  const normalized = raw == null ? "" : String(raw).trim();
  if (normalized && !/^[+-]?\d+$/.test(normalized)) {
    throw new Error(`${name} must be a whole integer`);
  }
  const value = normalized === "" ? fallback : Number.parseInt(normalized, 10);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function parseBoolean(name, fallback) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === "") return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  throw new Error(`${name} must be true or false`);
}

export function isProduction() {
  return process.env.NODE_ENV === "production";
}

/**
 * HTTP methods the browser is allowed to preflight.
 *
 * Exported so it can be asserted against the routes the API actually serves.
 * It lived inline in server.js and fell out of date the moment a PATCH route
 * was added: the route worked, but every browser call failed at preflight,
 * which no route test would have caught.
 */
export const CORS_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

export function corsOrigins() {
  return (process.env.CORS_ORIGINS || "http://localhost:5173,http://127.0.0.1:5173")
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

/**
 * Base URL used to build password links in emails. Falls back to the first
 * HTTPS entry in the CORS allowlist, which is already the deployed frontend,
 * so links work without configuring a second copy of the same value. Only an
 * allowlisted origin can ever be used, so this cannot be pointed at an
 * attacker's host by a stray header.
 */
export function appUrl() {
  const configured = (process.env.APP_URL || "").trim().replace(/\/$/, "");
  const allowed = corsOrigins();
  if (configured) {
    if (allowed.includes(configured)) return configured;
    console.warn("APP_URL is not present in CORS_ORIGINS; falling back to the allowlist.");
  }
  // The mobile app's origin is https://localhost, which is a valid CORS entry
  // but must never be used to build an emailed link: a recipient opening it
  // would reach their own machine, not FacultyTrack.
  const isLocal = (origin) => /^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(origin);
  const external = allowed.filter((origin) => !isLocal(origin));
  return external.find((origin) => origin.startsWith("https://")) || external[0] || allowed[0] || "";
}

export function runtimeConfig() {
  return {
    nodeEnv: process.env.NODE_ENV || "development",
    port: parseInteger("PORT", 8000, { min: 1, max: 65535 }),
    mongoUri: process.env.MONGODB_URI || "",
    dbName: process.env.DB_NAME || "grooming_standards",
    jwtSecret: process.env.SECRET_KEY || DEV_JWT_SECRET,
    // Ceiling raised to 43200 (30 days) so operators can trade re-login
    // friction for a longer-lived token. session_version still revokes every
    // token instantly on password change or account disable.
    jwtExpiresMinutes: parseInteger("JWT_EXPIRE_MINUTES", 480, { min: 5, max: 43200 }),
    jwtIssuer: process.env.JWT_ISSUER || "facultytrack-api",
    jwtAudience: process.env.JWT_AUDIENCE || "facultytrack-web",
    adminEmail: (process.env.ADMIN_EMAIL || "admin@nxtwave.com").trim().toLowerCase(),
    adminPassword: process.env.ADMIN_PASSWORD || "admin@123",
    adminPasswordVersion: process.env.ADMIN_PASSWORD_VERSION || "development-v1",
    // Break glass. Only an explicit "true" overwrites a password that already
    // exists in the database; anything else leaves the stored one alone.
    adminPasswordReset: process.env.ADMIN_PASSWORD_RESET === "true",
    origins: corsOrigins(),
    geminiModel: process.env.GEMINI_MODEL || "gemini-2.5-flash-lite",
    geminiTimeoutMs: parseInteger("GEMINI_TIMEOUT_MS", 120000, { min: 10000, max: 600000 }),
    geminiMaxRetries: parseInteger("GEMINI_MAX_RETRIES", 2, { min: 0, max: 2 }),
    // Check-out analysis runs inside the HTTP request, so its worst case must
    // fit within the server's requestTimeout rather than the worker's budget.
    geminiInteractiveTimeoutMs: parseInteger("GEMINI_INTERACTIVE_TIMEOUT_MS", 20000, { min: 5000, max: 120000 }),
    geminiInteractiveMaxRetries: parseInteger("GEMINI_INTERACTIVE_MAX_RETRIES", 1, { min: 0, max: 2 }),
    // Explicit context caching is enabled by default. Unsupported models,
    // undersized prompts and transient cache failures fall back to the normal
    // request path inside visionEngine, so this never blocks an evaluation.
    geminiExplicitCache: parseBoolean("GEMINI_EXPLICIT_CACHE", true),
    geminiCacheTtlSeconds: parseInteger("GEMINI_CACHE_TTL_SECONDS", 3600, { min: 600, max: 86400 }),
    evaluationPollMs: parseInteger("EVALUATION_POLL_MS", 2000, { min: 250, max: 60000 }),
    evaluationLeaseMs: parseInteger("EVALUATION_LEASE_MS", 600000, { min: 60000, max: 3600000 }),
    evaluationMaxAttempts: parseInteger("EVALUATION_MAX_ATTEMPTS", 3, { min: 1, max: 10 }),
    evaluationConcurrency: parseInteger("EVALUATION_CONCURRENCY", 2, { min: 1, max: 20 }),
    checkInConcurrencyLimit: parseInteger("CHECKIN_CONCURRENCY_LIMIT", 5, { min: 1, max: 50 }),
    sesTimeoutMs: parseInteger("SES_TIMEOUT_MS", 30000, { min: 5000, max: 120000 }),
    sesMaxAttempts: parseInteger("SES_MAX_ATTEMPTS", 2, { min: 1, max: 3 }),
    notificationLeaseMs: parseInteger("NOTIFICATION_LEASE_MS", 300000, { min: 60000, max: 600000 }),
    notificationMaxAttempts: parseInteger("NOTIFICATION_MAX_ATTEMPTS", 5, { min: 1, max: 10 }),
    notificationConcurrency: parseInteger("NOTIFICATION_CONCURRENCY", 2, { min: 1, max: 20 }),
    processRole: process.env.PROCESS_ROLE || "all",
    appTimeZone: process.env.APP_TIME_ZONE || "Asia/Kolkata",
    // Face identification. Absent configuration is not an error: the flow is
    // being built before the AWS collection exists, and check-in must keep
    // working until it does, so faceRecognition reports NOT_CONFIGURED.
    rekognitionCollectionId: (process.env.REKOGNITION_COLLECTION_ID || "").trim(),
    // Face recognition lives in its own AWS account, so it carries its own
    // credentials and its own region. Deliberately no fallback to the SES key:
    // the accounts are unrelated, so silently reusing the mail credential would
    // authenticate against the wrong account and fail as AccessDenied, which
    // reads like a broken policy rather than a missing setting.
    rekognitionRegion: (process.env.AWS_REKOGNITION_REGION || "").trim(),
    rekognitionAccessKeyId: (process.env.REKOGNITION_ACCESS_KEY_ID || "").trim(),
    rekognitionSecretAccessKey: (process.env.REKOGNITION_SECRET_ACCESS_KEY || "").trim(),
    // A wrong identity files one instructor's grooming record under another
    // name, so the floor is deliberately high: below this the record is saved
    // unidentified for an admin to resolve, which is recoverable.
    rekognitionMatchThreshold: parseInteger("REKOGNITION_MATCH_THRESHOLD", 95, { min: 80, max: 100 }),
    rekognitionMaxFacesPerInstructor: parseInteger(
      "REKOGNITION_MAX_FACES_PER_INSTRUCTOR",
      6,
      { min: 1, max: 20 }
    ),
    // More than one candidate is requested because the nearest faces are often
    // other embeddings of the same person; they are grouped by instructor
    // before the best score is compared.
    rekognitionSearchCandidates: parseInteger("REKOGNITION_SEARCH_CANDIDATES", 8, { min: 2, max: 50 }),
    // Quality floors for a reference photograph, applied before indexing. A
    // blurry reference never fails loudly; it produces confident wrong matches
    // for as long as it stays in the collection.
    rekognitionMinFaceConfidence: parseInteger("REKOGNITION_MIN_FACE_CONFIDENCE", 90, { min: 50, max: 100 }),
    rekognitionMinSharpness: parseInteger("REKOGNITION_MIN_SHARPNESS", 20, { min: 0, max: 100 }),
    rekognitionMinBrightness: parseInteger("REKOGNITION_MIN_BRIGHTNESS", 20, { min: 0, max: 100 }),
    // Identification runs inside the check-in request, so its worst case has to
    // leave room for the rest of the handler inside HTTP_REQUEST_TIMEOUT_MS.
    rekognitionTimeoutMs: parseInteger("REKOGNITION_TIMEOUT_MS", 10000, { min: 2000, max: 30000 }),
    rekognitionMaxAttempts: parseInteger("REKOGNITION_MAX_ATTEMPTS", 2, { min: 1, max: 4 }),
  };
}

export function validateEnvironment() {
  const config = runtimeConfig();
  if (!["development", "test", "production"].includes(config.nodeEnv)) {
    throw new Error("NODE_ENV must be development, test, or production");
  }
  if (!isProduction()) return config;

  const errors = [];
  const required = [
    "MONGODB_URI",
    "GEMINI_API_KEY",
    "SECRET_KEY",
    "ADMIN_EMAIL",
    "ADMIN_PASSWORD",
    "ADMIN_PASSWORD_VERSION",
    "CORS_ORIGINS",
    "APP_URL",
    "CRON_SECRET",
    "R2_ENDPOINT",
    "R2_BUCKET",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "AWS_REGION",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "SES_FROM_EMAIL",
  ];
  for (const name of required) {
    if (!process.env[name]?.trim()) errors.push(`${name} is required`);
  }
  if (
    config.jwtSecret.length < 32
    || config.jwtSecret === DEV_JWT_SECRET
    || config.jwtSecret === EXAMPLE_JWT_SECRET
  ) {
    errors.push("SECRET_KEY must be a unique secret of at least 32 characters");
  }
  if (
    config.adminPassword.length < 12
    || config.adminPassword === "admin@123"
    || config.adminPassword === EXAMPLE_ADMIN_PASSWORD
  ) {
    errors.push("ADMIN_PASSWORD must be at least 12 characters and cannot use the development default");
  }
  if (config.adminPassword.toLowerCase().includes(config.adminEmail.split("@")[0])) {
    errors.push("ADMIN_PASSWORD cannot contain the administrator email name");
  }
  // Emails carry links built from this. A localhost value is valid CORS — the
  // mobile shell uses https://localhost — but as a link it sends the recipient
  // to their own machine, so the report is simply unreachable and nothing in
  // the system notices.
  const resolvedAppUrl = appUrl();
  if (!/^https:\/\//.test(resolvedAppUrl) || /^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(resolvedAppUrl)) {
    errors.push(
      "CORS_ORIGINS must contain the public HTTPS address of the site, since emailed report links are built from it"
    );
  }
  if (config.origins.includes("*")) {
    errors.push("CORS_ORIGINS cannot contain * in production");
  }
  if (!config.origins.includes((process.env.APP_URL || "").trim().replace(/\/$/, ""))) {
    errors.push("APP_URL must be one of the exact CORS_ORIGINS values");
  }
  try {
    const r2Endpoint = new URL(process.env.R2_ENDPOINT || "");
    if (r2Endpoint.protocol !== "https:" || r2Endpoint.pathname !== "/") {
      errors.push("R2_ENDPOINT must be an HTTPS origin without a path");
    }
  } catch {
    errors.push("R2_ENDPOINT must be a valid HTTPS URL");
  }
  if (!/^[A-Za-z0-9._-]{3,255}$/.test(process.env.R2_BUCKET || "")) {
    errors.push("R2_BUCKET is invalid");
  }
  if (!config.processRole || !["all", "api", "worker"].includes(config.processRole)) {
    errors.push("PROCESS_ROLE must be all, api, or worker");
  }
  if (config.origins.length === 0) {
    errors.push("CORS_ORIGINS must contain at least one exact HTTPS origin");
  }
  for (const origin of config.origins) {
    try {
      const url = new URL(origin);
      if (url.protocol !== "https:" || url.origin !== origin) {
        errors.push(`Production CORS origin must be an exact HTTPS origin: ${origin}`);
      }
    } catch {
      errors.push(`Production CORS origin is invalid: ${origin}`);
    }
  }
  if (config.mongoUri && !/^mongodb(?:\+srv)?:\/\//.test(config.mongoUri)) {
    errors.push("MONGODB_URI must start with mongodb:// or mongodb+srv://");
  } else if (config.mongoUri.startsWith("mongodb://")) {
    try {
      const uri = new URL(config.mongoUri);
      const tls = (uri.searchParams.get("tls") || uri.searchParams.get("ssl") || "").toLowerCase();
      if (tls !== "true") {
        errors.push("Production mongodb:// connections must explicitly set tls=true; prefer mongodb+srv://");
      }
    } catch {
      errors.push("MONGODB_URI is invalid");
    }
  } else if (config.mongoUri.startsWith("mongodb+srv://")) {
    try {
      const uri = new URL(config.mongoUri);
      const tls = (uri.searchParams.get("tls") || uri.searchParams.get("ssl") || "").toLowerCase();
      if (tls === "false") errors.push("MONGODB_URI cannot disable TLS in production");
    } catch {
      errors.push("MONGODB_URI is invalid");
    }
  }
  if (config.geminiModel !== "gemini-2.5-flash-lite") {
    errors.push("GEMINI_MODEL must use the pinned Gemini model gemini-2.5-flash-lite");
  }
  // Check-out analysis holds the HTTP connection open, so its worst case has
  // to complete before the server destroys the socket. Without this the
  // instructor sees a failure while the evaluation continues server-side and
  // still emails them a report.
  const interactiveWorstCase = config.geminiInteractiveTimeoutMs
    * (config.geminiInteractiveMaxRetries + 1);
  if (interactiveWorstCase >= HTTP_REQUEST_TIMEOUT_MS - 5000) {
    errors.push(
      `GEMINI_INTERACTIVE_TIMEOUT_MS times attempts must leave headroom inside the ${HTTP_REQUEST_TIMEOUT_MS}ms request timeout`
    );
  }
  const minimumEvaluationLease = config.geminiTimeoutMs * (config.geminiMaxRetries + 1) + 60000;
  if (config.evaluationLeaseMs < minimumEvaluationLease) {
    errors.push(
      `EVALUATION_LEASE_MS must be at least ${minimumEvaluationLease} for the configured Gemini timeout and retries`
    );
  }
  if (config.notificationLeaseMs < config.sesTimeoutMs + 60000) {
    errors.push("NOTIFICATION_LEASE_MS must be at least SES_TIMEOUT_MS plus 60000");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.adminEmail)) {
    errors.push("ADMIN_EMAIL must be a valid email address");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(process.env.SES_FROM_EMAIL || "")) {
    errors.push("SES_FROM_EMAIL must be a valid email address");
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: config.appTimeZone }).format();
  } catch {
    errors.push("APP_TIME_ZONE must be a valid IANA time zone");
  }
  if (errors.length) {
    throw new Error(`Invalid production environment:\n- ${errors.join("\n- ")}`);
  }
  return config;
}
