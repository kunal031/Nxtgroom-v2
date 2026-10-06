import { Router } from "express";
import {
  getPasswordHash,
  idMatch,
  isElevated,
  requireRootAdmin,
  requireSuperAdmin,
  ROLES,
} from "../middleware/auth.js";
import { asyncRoute, createDocument, serializeDocument } from "../utils.js";
import {
  describeDeletePermission,
  getAccessSettings,
  saveAccessSettings,
  validateAccessSettings,
} from "../services/accessSettings.js";
import {
  getConfigSettings,
  saveConfigSettings,
  validateConfigSettings,
} from "../services/configSettings.js";
import {
  attendanceReminderView,
  getAttendanceReminderSettings,
  saveAttendanceReminderSettings,
  validateAttendanceReminders,
} from "../services/attendanceReminders.js";
import {
  addInstructorCategory,
  deleteInstructorCategory,
  listInstructorCategories,
  renameInstructorCategory,
} from "../services/instructorCategories.js";
import {
  describeCollegeIdentification,
  getIdentificationSettings,
  IDENTIFICATION_MODES,
  loadCollegeEnrolment,
  LOW_ENROLMENT_WARNING_RATIO,
  saveIdentificationSettings,
  validateIdentificationSettings,
} from "../services/identificationSettings.js";
import {
  adminSchema,
  adminUpdateSchema,
  boaSchema,
  boaUpdateSchema,
  collegeSchema,
  setPasswordSchema,
  validate,
} from "../validation.js";
import {
  getNotificationSettings,
  saveNotificationSettings,
  validateNotificationSettings,
} from "../services/notificationSettings.js";
import {
  sendAccountCreatedEmail,
  sendAccountInviteEmail,
} from "../services/emailService.js";
import { INVITE_TTL_MS, issueResetToken } from "../services/passwordResetService.js";
import { clearDashboardCache } from "../services/dashboardStats.js";
import {
  addReportRecipient,
  getRecipientEvents,
  getReportRecipients,
  removeReportRecipient,
  saveRecipientEvents,
} from "../services/reportRecipients.js";
import {
  addDailyReportRecipient,
  dailyReportCampuses,
  dailyReportDays,
  dailyReportSettingsView,
  getDailyReportSettings,
  MONTH_PATTERN,
  removeDailyReportRecipient,
  saveDailyReportSchedule,
} from "../services/dailyReport.js";
import {
  isSyncConfigured,
  readSyncState,
  runInstructorSync,
  runInstituteSync,
} from "../services/instructorSync.js";
import { appUrl } from "../config/env.js";
import { isValidDateKey, localDateKey } from "../services/instructorReports.js";
import { rateLimit } from "express-rate-limit";
import { coreCollection, coreTransaction } from "../stores/coreStore.js";

const COLLEGE_ASSIGNMENT_GUARD = "_private_assignment_guard_version";

const instructorSyncLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { detail: "Too many sync attempts. Please wait a few minutes." },
});

export const adminRouter = Router();

async function sendAccountSetupEmail(db, { email, name, role, hasPassword }) {
  try {
    if (hasPassword) {
      const result = await sendAccountCreatedEmail(email, {
        name,
        email,
        role,
        appUrl: appUrl(),
      });
      return { emailed: result.sent, invited: false, reason: result.reason };
    }

    const token = await issueResetToken(db, { email, kind: "invite", ttlMs: INVITE_TTL_MS });
    const result = await sendAccountInviteEmail(email, {
      name,
      role,
      appUrl: appUrl(),
      token,
      expiresInDays: Math.round(INVITE_TTL_MS / 86400000),
    });
    return { emailed: result.sent, invited: true, reason: result.reason };
  } catch (error) {
    console.error(`Account setup email failed for ${email}: ${error?.name || "Error"}`);
    return { emailed: false, invited: !hasPassword, reason: "send_failed" };
  }
}

function activeFilter(extra = {}) {
  return {
    $and: [
      extra,
      { $or: [{ deleted_at: null }, { deleted_at: { $exists: false } }] },
    ],
  };
}

function activeUserFilter(extra = {}) {
  return {
    $and: [
      extra,
      { $or: [{ disabled_at: null }, { disabled_at: { $exists: false } }] },
    ],
  };
}

export function serializeAdminDocument(document) {
  const serialized = serializeDocument(document);
  for (const key of Object.keys(serialized)) {
    if (key.startsWith("_private_")) delete serialized[key];
  }
  return serialized;
}

export async function listActiveBoasWithAccounts(db) {
  const rows = await coreCollection(db, "boas")
    .find(activeFilter())
    .limit(1000)
    .toArray();
  if (!rows.length) return [];

  const referenceVariants = [];
  const seenVariants = new Set();
  for (const row of rows) {
    for (const variant of idMatch(String(row._id)).$in) {
      const key = `${variant?._bsontype || typeof variant}:${String(variant)}`;
      if (!seenVariants.has(key)) {
        seenVariants.add(key);
        referenceVariants.push(variant);
      }
    }
  }
  const accounts = await coreCollection(db, "users")
    .find(activeUserFilter({
      role: ROLES.BOA,
      reference_id: { $in: referenceVariants },
    }))
    .project({ reference_id: 1, email: 1 })
    .limit(1000)
    .toArray();
  const emailByReference = new Map(
    accounts.map((account) => [String(account.reference_id), account.email])
  );
  return rows
    .filter((row) => emailByReference.has(String(row._id)))
    .map((row) => {
      if (row.email) return row;
      const accountEmail = emailByReference.get(String(row._id));
      return accountEmail ? { ...row, email: accountEmail } : row;
    });
}

function invariantError(message) {
  const error = new Error(message);
  error.code = "TRANSACTION_INVARIANT_FAILED";
  return error;
}

export async function createBoaGuarded(
  db,
  input,
  passwordHash,
  runTransaction = null
) {
  return (runTransaction || coreTransaction(db))(async (session) => {
    const college = await coreCollection(db, "colleges").findOne(
      activeFilter({ _id: idMatch(input.college_id) }),
      { session }
    );
    if (!college) return { outcome: "college_not_found" };
    if (await coreCollection(db, "users").findOne({ email: input.email }, { session })) {
      return { outcome: "duplicate_email" };
    }
    if (await coreCollection(db, "boas").findOne({ employee_id: input.employee_id }, { session })) {
      return { outcome: "duplicate_employee_id" };
    }

    const collegeGuard = await coreCollection(db, "colleges").updateOne(
      activeFilter({ _id: college._id }),
      { $inc: { [COLLEGE_ASSIGNMENT_GUARD]: 1 } },
      { session }
    );
    if (!collegeGuard.matchedCount) return { outcome: "college_not_found" };

    const now = new Date();
    const boa = createDocument({
      employee_id: input.employee_id,
      name: input.name,
      college_id: String(college._id),
      email: input.email,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    });
    const user = createDocument({
      email: input.email,
      password_hash: passwordHash,
      role: ROLES.BOA,
      reference_id: boa._id,
      session_version: 1,
      created_at: now,
      updated_at: now,
    });
    await coreCollection(db, "boas").insertOne(boa, { session });
    await coreCollection(db, "users").insertOne(user, { session });
    return { outcome: "created", boa };
  });
}

export async function updateBoaGuarded(
  db,
  boaId,
  input,
  passwordHash,
  runTransaction = null
) {
  return (runTransaction || coreTransaction(db))(async (session) => {
    const boa = await coreCollection(db, "boas").findOne(
      activeFilter({ _id: idMatch(boaId) }),
      { session }
    );
    if (!boa) return { outcome: "not_found" };
    const user = await coreCollection(db, "users").findOne(
      activeUserFilter({
        reference_id: idMatch(String(boa._id)),
        role: ROLES.BOA,
      }),
      { session }
    );
    if (!user) return { outcome: "account_unavailable" };
    const college = await coreCollection(db, "colleges").findOne(
      activeFilter({ _id: idMatch(input.college_id) }),
      { session }
    );
    if (!college) return { outcome: "college_not_found" };
    if (await coreCollection(db, "users").findOne(
      { email: input.email, _id: { $ne: user._id } },
      { session }
    )) {
      return { outcome: "duplicate_email" };
    }
    if (await coreCollection(db, "boas").findOne(
      { employee_id: input.employee_id, _id: { $ne: boa._id } },
      { session }
    )) {
      return { outcome: "duplicate_employee_id" };
    }

    const collegeGuard = await coreCollection(db, "colleges").updateOne(
      activeFilter({ _id: college._id }),
      { $inc: { [COLLEGE_ASSIGNMENT_GUARD]: 1 } },
      { session }
    );
    if (!collegeGuard.matchedCount) return { outcome: "college_not_found" };

    const now = new Date();
    const boaResult = await coreCollection(db, "boas").updateOne(
      activeFilter({ _id: boa._id }),
      {
        $set: {
          employee_id: input.employee_id,
          name: input.name,
          college_id: String(college._id),
          email: input.email,
          updated_at: now,
        },
      },
      { session }
    );
    const userSet = { email: input.email, updated_at: now };
    if (passwordHash) userSet.password_hash = passwordHash;
    const userResult = await coreCollection(db, "users").updateOne(
      { _id: user._id, role: ROLES.BOA },
      { $set: userSet, $inc: { session_version: 1 } },
      { session }
    );
    if (!boaResult.matchedCount || !userResult.matchedCount) {
      throw invariantError("BOA and user account could not be updated atomically");
    }
    return { outcome: "updated" };
  });
}

export async function deleteBoaGuarded(
  db,
  boaId,
  runTransaction = null
) {
  return (runTransaction || coreTransaction(db))(async (session) => {
    const boa = await coreCollection(db, "boas").findOne(
      activeFilter({ _id: idMatch(boaId) }),
      { session }
    );
    if (!boa) return { outcome: "not_found" };
    const user = await coreCollection(db, "users").findOne(
      {
        reference_id: idMatch(String(boa._id)),
        role: ROLES.BOA,
      },
      { session }
    );
    if (!user) return { outcome: "account_unavailable" };

    const now = new Date();
    const boaResult = await coreCollection(db, "boas").updateOne(
      activeFilter({ _id: boa._id }),
      { $set: { deleted_at: now, updated_at: now } },
      { session }
    );
    const userResult = await coreCollection(db, "users").updateOne(
      { _id: user._id, role: ROLES.BOA },
      {
        $set: { disabled_at: now, updated_at: now },
        $inc: { session_version: 1 },
      },
      { session }
    );
    if (!boaResult.matchedCount || !userResult.matchedCount) {
      throw invariantError("BOA and user account could not be disabled atomically");
    }
    return { outcome: "deleted" };
  });
}

export async function updateCollegeGuarded(
  db,
  collegeId,
  input,
  runTransaction = null
) {
  return (runTransaction || coreTransaction(db))(async (session) => {
    const college = await coreCollection(db, "colleges").findOne(
      activeFilter({ _id: idMatch(collegeId) }),
      { session }
    );
    if (!college) return { outcome: "not_found" };
    if (await coreCollection(db, "colleges").findOne(
      { name: input.name, location: input.location, _id: { $ne: college._id } },
      { session }
    )) {
      return { outcome: "duplicate" };
    }
    const result = await coreCollection(db, "colleges").updateOne(
      activeFilter({ _id: college._id }),
      { $set: { ...input, updated_at: new Date() } },
      { session }
    );
    return result.matchedCount ? { outcome: "updated" } : { outcome: "not_found" };
  });
}

export async function deleteCollegeGuarded(
  db,
  collegeId,
  runTransaction = null
) {
  return (runTransaction || coreTransaction(db))(async (session) => {
    const college = await coreCollection(db, "colleges").findOne(
      activeFilter({ _id: idMatch(collegeId) }),
      { session }
    );
    if (!college) return { outcome: "not_found" };
    const collegeMatch = idMatch(String(college._id));
    if (await coreCollection(db, "boas").findOne(
      activeFilter({ college_id: collegeMatch }),
      { session }
    )) {
      return { outcome: "assigned_boa" };
    }
    if (await coreCollection(db, "instructors").findOne(
      activeFilter({ college_id: collegeMatch }),
      { session }
    )) {
      return { outcome: "assigned_instructor" };
    }

    const now = new Date();
    const result = await coreCollection(db, "colleges").updateOne(
      activeFilter({ _id: college._id }),
      { $set: { deleted_at: now, updated_at: now } },
      { session }
    );
    return result.matchedCount ? { outcome: "deleted" } : { outcome: "not_found" };
  });
}

function duplicateErrorResponse(error, res, detail) {
  if (error.code !== 11000) return false;
  res.status(409).json({ detail });
  return true;
}

adminRouter.post(
  "/boas",
  requireSuperAdmin,
  validate(boaSchema),
  asyncRoute(async (req, res) => {
    const hasPassword = Boolean(req.validatedBody.password);
    const passwordHash = hasPassword
      ? await getPasswordHash(req.validatedBody.password)
      : null;
    let result;
    try {
      result = await createBoaGuarded(
        req.app.locals.db,
        req.validatedBody,
        passwordHash
      );
    } catch (error) {
      if (duplicateErrorResponse(error, res, "Email or employee ID already exists")) return;
      throw error;
    }
    if (result.outcome === "college_not_found") {
      return res.status(400).json({ detail: "Selected college does not exist" });
    }
    if (result.outcome === "duplicate_email") {
      return res.status(400).json({ detail: "Email already registered" });
    }
    if (result.outcome === "duplicate_employee_id") {
      return res.status(400).json({ detail: "Employee ID already exists" });
    }
    const delivery = await sendAccountSetupEmail(req.app.locals.db, {
      email: req.validatedBody.email,
      name: req.validatedBody.name,
      role: ROLES.BOA,
      hasPassword,
    });
    return res.status(201).json({
      message: "BOA created successfully",
      id: result.boa._id,
      ...delivery,
    });
  })
);

adminRouter.get(
  "/boas",
  requireSuperAdmin,
  asyncRoute(async (req, res) => {
    const rows = await listActiveBoasWithAccounts(req.app.locals.db);
    return res.json(rows.map(serializeAdminDocument));
  })
);

adminRouter.put(
  "/boas/:boaId",
  requireSuperAdmin,
  validate(boaUpdateSchema),
  asyncRoute(async (req, res) => {
    const passwordHash = req.validatedBody.password
      ? await getPasswordHash(req.validatedBody.password)
      : null;
    let result;
    try {
      result = await updateBoaGuarded(
        req.app.locals.db,
        req.params.boaId,
        req.validatedBody,
        passwordHash
      );
    } catch (error) {
      if (duplicateErrorResponse(error, res, "Email or employee ID already exists")) return;
      throw error;
    }
    if (result.outcome === "not_found") return res.status(404).json({ detail: "BOA not found" });
    if (result.outcome === "account_unavailable") {
      return res.status(409).json({ detail: "BOA user account is unavailable" });
    }
    if (result.outcome === "college_not_found") {
      return res.status(400).json({ detail: "Selected college does not exist" });
    }
    if (result.outcome === "duplicate_email") {
      return res.status(400).json({ detail: "Email already registered" });
    }
    if (result.outcome === "duplicate_employee_id") {
      return res.status(400).json({ detail: "Employee ID already exists" });
    }
    return res.json({ message: "BOA updated successfully" });
  })
);

adminRouter.delete(
  "/boas/:boaId",
  requireSuperAdmin,
  asyncRoute(async (req, res) => {
    const result = await deleteBoaGuarded(req.app.locals.db, req.params.boaId);
    if (result.outcome === "not_found") return res.status(404).json({ detail: "BOA not found" });
    if (result.outcome === "account_unavailable") {
      return res.status(409).json({ detail: "BOA user account is unavailable" });
    }
    return res.json({ message: "BOA deleted successfully" });
  })
);

adminRouter.post(
  "/colleges",
  requireSuperAdmin,
  validate(collegeSchema),
  asyncRoute(async (req, res) => {
    const now = new Date();
    const college = createDocument({
      ...req.validatedBody,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    });
    try {
      await coreCollection(req.app.locals.db, "colleges").insertOne(college);
    } catch (error) {
      if (duplicateErrorResponse(error, res, "A college with this name and location already exists")) return;
      throw error;
    }
    clearDashboardCache();
    return res.status(201).json({ message: "College created successfully", id: college._id });
  })
);

adminRouter.get(
  "/colleges",
  asyncRoute(async (req, res) => {
    const scope = isElevated(req.currentUser.role)
      ? {}
      : { _id: idMatch(req.currentUser.collegeId) };
    const rows = await coreCollection(req.app.locals.db, "colleges")
      .find(activeFilter(scope))
      .limit(1000)
      .toArray();
    return res.json(rows.map(serializeAdminDocument));
  })
);

adminRouter.put(
  "/colleges/:collegeId",
  requireSuperAdmin,
  validate(collegeSchema),
  asyncRoute(async (req, res) => {
    let result;
    try {
      result = await updateCollegeGuarded(
        req.app.locals.db,
        req.params.collegeId,
        req.validatedBody
      );
    } catch (error) {
      if (duplicateErrorResponse(error, res, "A college with this name and location already exists")) return;
      throw error;
    }
    if (result.outcome === "not_found") return res.status(404).json({ detail: "College not found" });
    if (result.outcome === "duplicate") {
      return res.status(409).json({ detail: "A college with this name and location already exists" });
    }
    clearDashboardCache();
    return res.json({ message: "College updated successfully" });
  })
);

adminRouter.delete(
  "/colleges/:collegeId",
  requireSuperAdmin,
  asyncRoute(async (req, res) => {
    const result = await deleteCollegeGuarded(req.app.locals.db, req.params.collegeId);
    if (result.outcome === "not_found") return res.status(404).json({ detail: "College not found" });
    if (result.outcome === "assigned_boa") {
      return res.status(409).json({ detail: "Reassign or delete active BOAs before deleting this college" });
    }
    if (result.outcome === "assigned_instructor") {
      return res.status(409).json({ detail: "Reassign or delete active instructors before deleting this college" });
    }
    clearDashboardCache();
    return res.json({ message: "College deleted successfully" });
  })
);

adminRouter.get(
  "/settings/notifications",
  requireSuperAdmin,
  asyncRoute(async (req, res) => {
    const settings = await getNotificationSettings(req.app.locals.db);
    return res.json(settings);
  })
);

adminRouter.put(
  "/settings/notifications",
  requireSuperAdmin,
  asyncRoute(async (req, res) => {
    const result = validateNotificationSettings(req.body);
    if (!result.valid) return res.status(422).json({ detail: result.detail });
    const saved = await saveNotificationSettings(
      req.app.locals.db,
      result.value,
      req.currentUser.email
    );
    return res.json(saved);
  })
);

adminRouter.post(
  "/settings/institute-sync",
  requireSuperAdmin,
  instructorSyncLimiter,
  asyncRoute(async (req, res) => {
    if (!isSyncConfigured()) {
      return res.status(503).json({
        detail: "BigQuery is not configured on the server. Add BIGQUERY_CREDENTIALS_JSON and retry.",
      });
    }
    const result = await runInstituteSync(req.app.locals.db, {
      triggeredBy: req.currentUser.email,
    });
    if (!result.ok) return res.status(502).json({ detail: result.last_sync_error, ...result });
    return res.json(result);
  })
);

adminRouter.get(
  "/settings/rp-recipients",
  requireSuperAdmin,
  asyncRoute(async (req, res) => {
    return res.json({ emails: await getReportRecipients(req.app.locals.db) });
  })
);

adminRouter.post(
  "/settings/rp-recipients",
  requireSuperAdmin,
  asyncRoute(async (req, res) => {
    const result = await addReportRecipient(
      req.app.locals.db,
      req.body?.email,
      req.currentUser.email
    );
    if (!result.ok) {
      const detail = result.reason === "duplicate"
        ? "That address is already on the list."
        : result.reason === "limit"
          ? "The recipient list is full."
          : "Enter a valid email address.";
      return res.status(422).json({ detail });
    }
    return res.status(201).json({ emails: result.emails });
  })
);

adminRouter.delete(
  "/settings/rp-recipients/:email",
  requireSuperAdmin,
  asyncRoute(async (req, res) => {
    const result = await removeReportRecipient(
      req.app.locals.db,
      decodeURIComponent(req.params.email),
      req.currentUser.email
    );
    if (!result.ok) return res.status(422).json({ detail: "Enter a valid email address." });
    return res.json({ emails: result.emails });
  })
);

adminRouter.get(
  "/settings/instructor-sync",
  requireSuperAdmin,
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    const syncedFilter = activeFilter({ source: "bigquery" });
    const [state, records, total] = await Promise.all([
      readSyncState(db),
      coreCollection(db, "instructors")
        .find(syncedFilter)
        .project({
          instructor_user_id: 1,
          name: 1,
          instructor_role: 1,
          institute_name: 1,
          instructor_category: 1,
          employee_id: 1,
          phone_no: 1,
          synced_at: 1,
        })
        .sort({ name: 1 })
        .limit(5000)
        .toArray(),
      coreCollection(db, "instructors").countDocuments(syncedFilter),
    ]);
    return res.json({
      configured: isSyncConfigured(),
      last_sync_at: state?.last_sync_at || null,
      last_sync_status: state?.last_sync_status || null,
      last_sync_error: state?.last_sync_error || null,
      record_count: total,
      records: records.map(serializeAdminDocument),
    });
  })
);

adminRouter.post(
  "/settings/instructor-sync",
  requireSuperAdmin,
  instructorSyncLimiter,
  asyncRoute(async (req, res) => {
    if (!isSyncConfigured()) {
      return res.status(503).json({
        detail: "BigQuery is not configured on the server. Add BIGQUERY_CREDENTIALS_JSON and retry.",
      });
    }
    const result = await runInstructorSync(req.app.locals.db, {
      triggeredBy: req.currentUser.email,
    });
    if (!result.ok) {
      return res.status(502).json({ detail: result.last_sync_error, ...result });
    }
    return res.json(result);
  })
);

function serializeUser(user) {
  return {
    _id: String(user._id),
    name: user.name || "",
    email: user.email,
    role: user.role,
    created_at: user.created_at || null,
    disabled_at: user.disabled_at || null,
  };
}

adminRouter.get(
  "/admins",
  requireRootAdmin,
  asyncRoute(async (req, res) => {
    const users = await req.app.locals.db
      .collection("users")
      .find({ role: { $in: [ROLES.SUPER_ADMIN, ROLES.ADMIN] } })
      .sort({ created_at: 1 })
      .toArray();
    return res.json(users.map(serializeUser));
  })
);

adminRouter.post(
  "/admins",
  requireRootAdmin,
  validate(adminSchema),
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    const { name, email, password } = req.validatedBody;

    if (await coreCollection(db, "users").findOne({ email })) {
      return res.status(400).json({ detail: "Email already registered" });
    }

    const hasPassword = Boolean(password);
    const now = new Date();
    const user = createDocument({
      name,
      email,
      password_hash: hasPassword ? await getPasswordHash(password) : null,
      role: ROLES.ADMIN,
      reference_id: null,
      session_version: 0,
      created_at: now,
      updated_at: now,
    });

    try {
      await coreCollection(db, "users").insertOne(user);
    } catch (error) {
      if (duplicateErrorResponse(error, res, "Email already registered")) return;
      throw error;
    }
    const delivery = await sendAccountSetupEmail(db, {
      email,
      name,
      role: ROLES.ADMIN,
      hasPassword,
    });
    return res.status(201).json({
      message: "Administrator created successfully",
      id: user._id,
      ...delivery,
    });
  })
);

adminRouter.put(
  "/admins/:id",
  requireRootAdmin,
  validate(adminUpdateSchema),
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    const { name, email, password } = req.validatedBody;
    const target = await coreCollection(db, "users").findOne({ _id: idMatch(String(req.params.id)) });

    if (!target || ![ROLES.SUPER_ADMIN, ROLES.ADMIN].includes(target.role)) {
      return res.status(404).json({ detail: "Administrator not found" });
    }

    const clash = await coreCollection(db, "users").findOne({ email, _id: { $ne: target._id } });
    if (clash) return res.status(400).json({ detail: "Email already registered" });

    const update = { name, email, updated_at: new Date() };
    const inc = {};
    if (password) {
      update.password_hash = await getPasswordHash(password);
      update.password_changed_at = new Date();
      inc.session_version = 1;
    }
    if (email !== target.email) inc.session_version = 1;

    await coreCollection(db, "users").updateOne(
      { _id: target._id },
      Object.keys(inc).length ? { $set: update, $inc: inc } : { $set: update }
    );
    return res.json({ message: "Administrator updated successfully" });
  })
);

adminRouter.post(
  "/admins/:id/password",
  requireRootAdmin,
  validate(setPasswordSchema),
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    const target = await coreCollection(db, "users").findOne({ _id: idMatch(String(req.params.id)) });
    if (!target || ![ROLES.SUPER_ADMIN, ROLES.ADMIN].includes(target.role)) {
      return res.status(404).json({ detail: "Administrator not found" });
    }

    await coreCollection(db, "users").updateOne(
      { _id: target._id },
      {
        $set: {
          password_hash: await getPasswordHash(req.validatedBody.new_password),
          password_changed_at: new Date(),
          updated_at: new Date(),
        },
        $inc: { session_version: 1 },
      }
    );
    return res.json({ message: "Password updated. The administrator must sign in again." });
  })
);

adminRouter.delete(
  "/admins/:id",
  requireRootAdmin,
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    const target = await coreCollection(db, "users").findOne({ _id: idMatch(String(req.params.id)) });

    if (!target || ![ROLES.SUPER_ADMIN, ROLES.ADMIN].includes(target.role)) {
      return res.status(404).json({ detail: "Administrator not found" });
    }
    if (target.role === ROLES.SUPER_ADMIN) {
      return res.status(400).json({ detail: "The super admin account cannot be deleted" });
    }
    if (target.email === req.currentUser.email) {
      return res.status(400).json({ detail: "You cannot delete your own account" });
    }

    await coreCollection(db, "users").deleteOne({ _id: target._id });
    return res.json({ message: "Administrator deleted successfully" });
  })
);

adminRouter.post(
  "/boas/:id/password",
  requireSuperAdmin,
  validate(setPasswordSchema),
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    const boa = await coreCollection(db, "boas").findOne(
      activeFilter({ _id: idMatch(String(req.params.id)) })
    );
    if (!boa) return res.status(404).json({ detail: "BOA not found" });

    const result = await coreCollection(db, "users").updateOne(
      activeUserFilter({ reference_id: String(boa._id), role: ROLES.BOA }),
      {
        $set: {
          password_hash: await getPasswordHash(req.validatedBody.new_password),
          password_changed_at: new Date(),
          updated_at: new Date(),
        },
        $inc: { session_version: 1 },
      }
    );
    if (!result.matchedCount) {
      return res.status(404).json({ detail: "No active sign-in account for this BOA" });
    }
    return res.json({ message: "Password updated. The BOA must sign in again." });
  })
);

adminRouter.get(
  "/settings/identification",
  requireSuperAdmin,
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    const [settings, colleges, enrolment] = await Promise.all([
      getIdentificationSettings(db),
      coreCollection(db, "colleges")
        .find(
          { $or: [{ deleted_at: null }, { deleted_at: { $exists: false } }] },
          { projection: { name: 1 } }
        )
        .sort({ name: 1 })
        .toArray(),
      loadCollegeEnrolment(db),
    ]);
    return res.json({
      default_mode: settings.default_mode,
      modes: IDENTIFICATION_MODES,
      low_enrolment_percent: Math.round(LOW_ENROLMENT_WARNING_RATIO * 100),
      colleges: describeCollegeIdentification(settings, colleges, enrolment),
    });
  })
);

adminRouter.put(
  "/settings/identification",
  requireSuperAdmin,
  asyncRoute(async (req, res) => {
    const result = validateIdentificationSettings(req.body);
    if (!result.valid) return res.status(422).json({ detail: result.detail });
    const saved = await saveIdentificationSettings(
      req.app.locals.db,
      req.body,
      req.currentUser?.email || null
    );
    return res.json(saved);
  })
);

adminRouter.get(
  "/settings/access",
  requireSuperAdmin,
  asyncRoute(async (req, res) => {
    return res.json(await getAccessSettings(req.app.locals.db));
  })
);

adminRouter.put(
  "/settings/access",
  requireSuperAdmin,
  asyncRoute(async (req, res) => {
    const result = validateAccessSettings(req.body);
    if (!result.valid) return res.status(422).json({ detail: result.detail });
    return res.json(await saveAccessSettings(req.app.locals.db, req.body));
  })
);

adminRouter.get(
  "/settings/attendance-reminders",
  requireSuperAdmin,
  asyncRoute(async (req, res) => {
    return res.json(attendanceReminderView(await getAttendanceReminderSettings(req.app.locals.db)));
  })
);

adminRouter.put(
  "/settings/attendance-reminders",
  requireSuperAdmin,
  asyncRoute(async (req, res) => {
    const result = validateAttendanceReminders(req.body);
    if (!result.valid) return res.status(422).json({ detail: result.detail });
    return res.json(await saveAttendanceReminderSettings(req.app.locals.db, req.body, req.currentUser?.email || null));
  })
);

adminRouter.get(
  "/settings/config",
  requireSuperAdmin,
  asyncRoute(async (req, res) => {
    return res.json(await getConfigSettings(req.app.locals.db));
  })
);

adminRouter.put(
  "/settings/config",
  requireSuperAdmin,
  asyncRoute(async (req, res) => {
    const result = validateConfigSettings(req.body);
    if (!result.valid) return res.status(422).json({ detail: result.detail });
    return res.json(await saveConfigSettings(req.app.locals.db, req.body, req.currentUser?.email || null));
  })
);

function categoryFailure(res, result) {
  if (result.outcome === "invalid") return res.status(422).json({ detail: result.detail });
  if (result.outcome === "duplicate") return res.status(409).json({ detail: "That category already exists" });
  if (result.outcome === "not_found") return res.status(404).json({ detail: "Category not found" });
  if (result.outcome === "in_use") {
    return res.status(409).json({
      detail: `${result.count} ${result.count === 1 ? "instructor uses" : "instructors use"} this category. Move them to another category first.`,
    });
  }
  return null;
}

adminRouter.get(
  "/settings/config/categories",
  requireSuperAdmin,
  asyncRoute(async (req, res) => {
    return res.json(await listInstructorCategories(req.app.locals.db));
  })
);

adminRouter.post(
  "/settings/config/categories",
  requireSuperAdmin,
  asyncRoute(async (req, res) => {
    const result = await addInstructorCategory(req.app.locals.db, req.body?.name, req.currentUser?.email || null);
    return categoryFailure(res, result) ?? res.status(201).json(result.categories);
  })
);

adminRouter.put(
  "/settings/config/categories/:name",
  requireSuperAdmin,
  asyncRoute(async (req, res) => {
    const result = await renameInstructorCategory(req.app.locals.db, req.params.name, req.body?.name, req.currentUser?.email || null);
    return categoryFailure(res, result) ?? res.json({ moved: result.moved, categories: result.categories });
  })
);

adminRouter.delete(
  "/settings/config/categories/:name",
  requireSuperAdmin,
  asyncRoute(async (req, res) => {
    const result = await deleteInstructorCategory(req.app.locals.db, req.params.name, req.currentUser?.email || null);
    return categoryFailure(res, result) ?? res.json(result.categories);
  })
);

adminRouter.get(
  "/users/:userId/permissions",
  requireSuperAdmin,
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    const user = await coreCollection(db, "users").findOne({ _id: idMatch(req.params.userId) });
    if (!user) return res.status(404).json({ detail: "User not found" });
    const settings = await getAccessSettings(db);
    return res.json({
      user_id: String(user._id),
      email: user.email,
      role: user.role,
      ...describeDeletePermission(user, settings),
    });
  })
);

adminRouter.put(
  "/users/:userId/permissions",
  requireSuperAdmin,
  asyncRoute(async (req, res) => {
    const value = req.body?.can_delete_records;
    if (value !== null && typeof value !== "boolean") {
      return res.status(422).json({
        detail: "can_delete_records must be true, false, or null to follow the workspace default",
      });
    }

    const db = req.app.locals.db;
    const user = await coreCollection(db, "users").findOne({ _id: idMatch(req.params.userId) });
    if (!user) return res.status(404).json({ detail: "User not found" });
    if (user.role !== ROLES.BOA) {
      return res.status(422).json({
        detail: "Only BOA accounts have deletion configured; admins always have it",
      });
    }

    await coreCollection(db, "users").updateOne(
      { _id: user._id },
      value === null
        ? { $unset: { can_delete_records: "" }, $set: { updated_at: new Date() } }
        : { $set: { can_delete_records: value, updated_at: new Date() } }
    );
    const settings = await getAccessSettings(db);
    return res.json(describeDeletePermission({ ...user, can_delete_records: value ?? undefined }, settings));
  })
);

adminRouter.get(
  "/settings/daily-report",
  requireSuperAdmin,
  asyncRoute(async (req, res) => {
    return res.json(dailyReportSettingsView(await getDailyReportSettings(req.app.locals.db)));
  })
);

adminRouter.put(
  "/settings/daily-report",
  requireSuperAdmin,
  asyncRoute(async (req, res) => {
    const result = await saveDailyReportSchedule(req.app.locals.db, req.body || {}, req.currentUser.email);
    if (!result.ok) return res.status(422).json({ detail: result.detail });
    return res.json(result.settings);
  })
);

adminRouter.get(
  "/settings/daily-report/days",
  requireSuperAdmin,
  asyncRoute(async (req, res) => {
    const month = typeof req.query.month === "string" && req.query.month
      ? req.query.month
      : localDateKey(new Date()).slice(0, 7);
    if (!MONTH_PATTERN.test(month)) return res.status(422).json({ detail: "Choose a valid month." });
    if (month > localDateKey(new Date()).slice(0, 7)) {
      return res.status(422).json({ detail: "Choose this month or an earlier one." });
    }
    return res.json({ month, days: await dailyReportDays(req.app.locals.db, month) });
  })
);

adminRouter.get(
  "/settings/daily-report/days/:date/campuses",
  requireSuperAdmin,
  asyncRoute(async (req, res) => {
    const date = String(req.params.date || "");
    if (!isValidDateKey(date)) return res.status(422).json({ detail: "Choose a valid date." });
    if (date > localDateKey(new Date())) return res.status(422).json({ detail: "Choose today or an earlier day." });
    return res.json({ date, campuses: await dailyReportCampuses(req.app.locals.db, date) });
  })
);

adminRouter.post(
  "/settings/daily-report/recipients",
  requireSuperAdmin,
  asyncRoute(async (req, res) => {
    const result = await addDailyReportRecipient(req.app.locals.db, req.body?.email, req.currentUser.email);
    if (!result.ok) {
      const detail = result.reason === "duplicate"
        ? "That address is already on the list."
        : result.reason === "limit"
          ? "The recipient list is full."
          : "Enter a valid email address.";
      return res.status(422).json({ detail });
    }
    return res.status(201).json({ emails: result.emails });
  })
);

adminRouter.delete(
  "/settings/daily-report/recipients/:email",
  requireSuperAdmin,
  asyncRoute(async (req, res) => {
    const result = await removeDailyReportRecipient(
      req.app.locals.db,
      decodeURIComponent(req.params.email),
      req.currentUser.email
    );
    if (!result.ok) return res.status(422).json({ detail: "Enter a valid email address." });
    return res.json({ emails: result.emails });
  })
);

adminRouter.get(
  "/settings/rp-recipients/events",
  requireSuperAdmin,
  asyncRoute(async (req, res) => {
    return res.json(await getRecipientEvents(req.app.locals.db));
  })
);

adminRouter.put(
  "/settings/rp-recipients/events",
  requireSuperAdmin,
  asyncRoute(async (req, res) => {
    for (const key of ["checkin_enabled", "checkout_enabled"]) {
      if (key in req.body && typeof req.body[key] !== "boolean") {
        return res.status(422).json({ detail: `${key} must be true or false` });
      }
    }
    return res.json(
      await saveRecipientEvents(req.app.locals.db, req.body, req.currentUser.email)
    );
  })
);
