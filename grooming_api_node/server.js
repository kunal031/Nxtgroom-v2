import "dotenv/config";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import {
  checkMongoConnection,
  closeMongoConnection,
  connectToMongo,
} from "./src/config/db.js";
import { CORS_METHODS, HTTP_REQUEST_TIMEOUT_MS, isProduction, runtimeConfig, validateEnvironment } from "./src/config/env.js";
import {
  getCurrentUser,
  getPasswordHash,
  requireCronSecret,
  requireDatabase,
  ROLES,
} from "./src/middleware/auth.js";
import { adminRouter } from "./src/routes/adminRoutes.js";
import { attendanceRouter } from "./src/routes/attendanceRoutes.js";
import { authRouter } from "./src/routes/authRoutes.js";
import { dashboardRouter } from "./src/routes/dashboardRoutes.js";
import { instructorRouter } from "./src/routes/instructorRoutes.js";
import { reportRouter } from "./src/routes/reportRoutes.js";
import { startEvaluationWorker } from "./src/services/evaluationWorker.js";
import { startNotificationWorker } from "./src/services/notificationWorker.js";
import { startStorageCleanupWorker } from "./src/services/storageCleanupWorker.js";
import { startMailWorker } from "./src/services/mailWorker.js";
import { startDailyReportScheduler } from "./src/services/dailyReportScheduler.js";
import { startAttendanceReminderScheduler } from "./src/services/attendanceReminders.js";
import { checkPhotoStorageConnection } from "./src/services/photoStorage.js";
import { getWorkerReadiness } from "./src/services/workerHealth.js";
import { createDocument } from "./src/utils.js";
import { telemetrySnapshot } from "./src/services/telemetry.js";
import { coreCollection } from "./src/stores/coreStore.js";
import { checkDynamoConnection, verifyDynamoTables } from "./src/stores/dynamoStartup.js";

const config = runtimeConfig();

export function loggedPath(path) {
  return String(path)
    .replace(/^(\/api\/v2\/reports\/)(?!cron(?:\/|$))[^/]+/, "$1<token>")
    .replace(/^(\/api\/v2\/auth\/reset-password\/)[^/]+/, "$1<token>");
}

export const app = express();
app.disable("x-powered-by");
if (isProduction()) app.set("trust proxy", config.trustProxyHops);

app.use((req, res, next) => {
  const startedAt = Date.now();
  const path = loggedPath(req.path);
  req.requestId = randomUUID();
  res.set("X-Request-ID", req.requestId);
  if (req.path.startsWith("/api/")) res.set("Cache-Control", "no-store");
  res.once("finish", () => {
    console.log(JSON.stringify({
      event: "http_request",
      request_id: req.requestId,
      method: req.method,
      path,
      status: res.statusCode,
      duration_ms: Date.now() - startedAt,
    }));
  });
  next();
});
app.use(helmet());
app.use(cors({
  origin(origin, callback) {
    if (!origin || config.origins.includes(origin.replace(/\/$/, ""))) {
      return callback(null, true);
    }
    const error = new Error("Origin is not allowed by CORS");
    error.statusCode = 403;
    return callback(error);
  },
  methods: CORS_METHODS,
  allowedHeaders: ["Authorization", "Content-Type"],
  credentials: true,
  maxAge: 86400,
}));
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: isProduction() ? 600 : 5000,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skip: (req) => req.method === "OPTIONS"
    || req.path === "/health"
    || req.path === "/health/live"
    || req.path === "/health/ready",
  message: { detail: "Too many requests. Please try again later." },
}));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false, limit: "32kb" }));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: isProduction() ? 10 : 100,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { detail: "Too many login attempts. Please try again later." },
});

app.get("/", (_req, res) => {
  res.json({ message: "NxtWave Grooming Standards API", version: "2" });
});
app.get("/health/live", (_req, res) => {
  res.json({ status: "ok" });
});
app.get("/health/metrics", requireCronSecret, (_req, res) => res.json(telemetrySnapshot()));

async function readinessStatus() {
  const databaseReady = Boolean(app.locals.db) && await checkMongoConnection();
  if (!databaseReady) {
    return {
      ready: false,
      status: "degraded",
      reasons: ["DATABASE_UNAVAILABLE"],
      workers: [],
      queues: [],
    };
  }
  const dynamoReady = await checkDynamoConnection();
  if (!dynamoReady) {
    return {
      ready: false,
      status: "degraded",
      reasons: ["DYNAMODB_UNAVAILABLE"],
      workers: [],
      queues: [],
    };
  }
  const storageReady = await checkPhotoStorageConnection();
  if (!storageReady) {
    return {
      ready: false,
      status: "degraded",
      reasons: ["PHOTO_STORAGE_UNAVAILABLE"],
      workers: [],
      queues: [],
    };
  }
  return getWorkerReadiness(app.locals.db, {
    expectedWorkers: config.processRole === "api"
      ? []
      : ["evaluation", "notification", "storage_cleanup", "mail"],
  });
}

const READINESS_CACHE_MS = 5_000;
let readinessCache = null;
let readinessInFlight = null;

async function cachedReadinessStatus() {
  if (readinessCache && Date.now() - readinessCache.at < READINESS_CACHE_MS) {
    return readinessCache.value;
  }
  if (!readinessInFlight) {
    readinessInFlight = readinessStatus()
      .then((value) => {
        readinessCache = { value, at: Date.now() };
        return value;
      })
      .finally(() => {
        readinessInFlight = null;
      });
  }
  return readinessInFlight;
}

async function readinessHandler(_req, res) {
  const health = await cachedReadinessStatus();
  return res.status(health.ready ? 200 : 503).json(health);
}

app.get("/health/ready", readinessHandler);
app.get("/health", readinessHandler);

app.use("/api/v2/auth/login", loginLimiter);
app.use("/api/v2/auth", requireDatabase, authRouter);
app.use("/api/v2/reports", requireDatabase, reportRouter);
app.use("/api/v2/dashboard", requireDatabase, getCurrentUser, dashboardRouter);
app.use("/api/v2", requireDatabase, getCurrentUser, adminRouter);
app.use("/api/v2/instructors", requireDatabase, getCurrentUser, instructorRouter);
app.use("/api/v2/attendance", requireDatabase, getCurrentUser, attendanceRouter);

app.use((_req, res) => res.status(404).json({ detail: "Not found" }));
app.use((error, req, res, _next) => {
  if (res.headersSent) return;
  if (isProduction()) {
    console.error(`Request ${req.requestId} failed: ${error.name || "Error"}`);
  } else {
    console.error(error);
  }
  if (error.statusCode) return res.status(error.statusCode).json({ detail: error.message });
  if (error.code === 11000) return res.status(409).json({ detail: "A unique value already exists" });
  if (error instanceof SyntaxError && "body" in error) {
    return res.status(400).json({ detail: "Invalid JSON request body" });
  }
  if (error.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ detail: "The image must be 8 MB or smaller" });
  }
  if (error.name === "MulterError" || error.message?.includes("image uploads are allowed")) {
    return res.status(400).json({ detail: error.message });
  }
  return res.status(500).json({ detail: "Internal server error", request_id: req.requestId });
});

export async function seedAdmin(db) {
  const currentConfig = runtimeConfig();
  const now = new Date();
  let user = await coreCollection(db, "users").findOne({ email: currentConfig.adminEmail });
  if (user?.disabled_at) {
    throw new Error("The configured bootstrap administrator account is disabled");
  }

  if (!user) {
    const legacyBootstrap = await coreCollection(db, "users").findOne({
      email: "admin@nxtwave.com",
      role: ROLES.SUPER_ADMIN,
      password_version: { $exists: false },
      disabled_at: { $exists: false },
    });
    if (legacyBootstrap) {
      await coreCollection(db, "users").updateOne(
        { _id: legacyBootstrap._id },
        {
          $set: {
            email: currentConfig.adminEmail,
            password_hash: await getPasswordHash(currentConfig.adminPassword),
            password_version: currentConfig.adminPasswordVersion,
            bootstrap_managed: true,
            updated_at: now,
          },
          $inc: { session_version: 1 },
        }
      );
      console.log("Migrated and rotated the legacy bootstrap administrator.");
      user = {
        ...legacyBootstrap,
        email: currentConfig.adminEmail,
        password_version: currentConfig.adminPasswordVersion,
      };
    } else {
      const unknownLegacyAdmin = await coreCollection(db, "users").findOne({
        role: ROLES.SUPER_ADMIN,
        password_version: { $exists: false },
        disabled_at: { $exists: false },
      });
      if (unknownLegacyAdmin) {
        throw new Error("An unversioned legacy administrator must be migrated or disabled manually");
      }
    }
  }

  if (!user) {
    user = createDocument({
      email: currentConfig.adminEmail,
      password_hash: await getPasswordHash(currentConfig.adminPassword),
      password_version: currentConfig.adminPasswordVersion,
      role: ROLES.SUPER_ADMIN,
      reference_id: null,
      bootstrap_managed: true,
      session_version: 1,
      created_at: now,
      updated_at: now,
    });
    await coreCollection(db, "users").insertOne(user);
    console.log("Created the configured bootstrap administrator.");
  }

  if (user.role !== ROLES.SUPER_ADMIN) {
    throw new Error("ADMIN_EMAIL belongs to a non-administrator account");
  }
  if (currentConfig.adminPasswordReset) {
    await coreCollection(db, "users").updateOne(
      { _id: user._id },
      {
        $set: {
          password_hash: await getPasswordHash(currentConfig.adminPassword),
          password_version: currentConfig.adminPasswordVersion,
          bootstrap_managed: true,
          updated_at: now,
        },
        $inc: { session_version: 1 },
      }
    );
    console.warn(
      "ADMIN_PASSWORD_RESET is set: the administrator password was overwritten from the environment. "
      + "Unset it and redeploy, or the next restart will overwrite it again."
    );
  } else if (user.password_version !== currentConfig.adminPasswordVersion) {
    await coreCollection(db, "users").updateOne(
      { _id: user._id },
      { $set: { password_version: currentConfig.adminPasswordVersion, updated_at: now } }
    );
  }
  const unmanagedLegacyAdmin = await coreCollection(db, "users").findOne(
    {
      role: ROLES.SUPER_ADMIN,
      email: { $ne: currentConfig.adminEmail },
      password_version: { $exists: false },
      disabled_at: { $exists: false },
    }
  );
  if (unmanagedLegacyAdmin) {
    throw new Error("An unversioned legacy administrator must be migrated or disabled manually");
  }
}

export async function startServer() {
  const currentConfig = validateEnvironment();
  await verifyDynamoTables();
  const db = await connectToMongo();
  if (!db) throw new Error("MongoDB is required to start the API");
  app.locals.db = db;
  await seedAdmin(db);

  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(currentConfig.port, "0.0.0.0", () => resolve(listener));
    listener.once("error", reject);
  });
  const workers = currentConfig.processRole === "api" ? [] : [
    startEvaluationWorker(db),
    startNotificationWorker(db),
    startStorageCleanupWorker(db),
    startMailWorker(db),
    startDailyReportScheduler(db),
    startAttendanceReminderScheduler(db),
  ];
  server.requestTimeout = HTTP_REQUEST_TIMEOUT_MS;
  server.headersTimeout = HTTP_REQUEST_TIMEOUT_MS + 5_000;
  server.keepAliveTimeout = 5_000;
  console.log(`Grooming API listening on port ${currentConfig.port}.`);

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}; shutting down.`);
    const forceExit = setTimeout(() => {
      console.error("Graceful shutdown timed out.");
      process.exit(1);
    }, 20_000);
    forceExit.unref();
    await Promise.allSettled([
      new Promise((resolve) => server.close(resolve)),
      ...workers.map((worker) => worker.stop()),
    ]);
    await closeMongoConnection();
    clearTimeout(forceExit);
  };
  const fatalShutdown = (error) => {
    process.exitCode = 1;
    console.error(`Fatal process error: ${error?.name || "Error"}`);
    void shutdown("fatal error");
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("uncaughtException", fatalShutdown);
  process.once("unhandledRejection", fatalShutdown);
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  startServer().catch((error) => {
    console.error(`Failed to start server: ${error.message}`);
    process.exit(1);
  });
}
