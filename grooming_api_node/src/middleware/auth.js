import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { ObjectId } from "mongodb";
import { runtimeConfig } from "../config/env.js";
import { coreCollection } from "../stores/coreStore.js";

const ALGORITHM = "HS256";
export const SESSION_COOKIE = "facultytrack_session";
const DUMMY_PASSWORD_HASH = "$2a$12$bghTrM835YAcVNiZAKbf1epxJ8GXHIZsplcAo.3RCPzxQ2W7x.hYa";

export const ROLES = {
  SUPER_ADMIN: "SUPER_ADMIN",
  ADMIN: "ADMIN",
  BOA: "BOA",
};

/** Roles with organisation-wide reach (not scoped to a single college). */
export const ELEVATED_ROLES = [ROLES.SUPER_ADMIN, ROLES.ADMIN];

export function isElevated(role) {
  return ELEVATED_ROLES.includes(role);
}

export function userSessionVersion(user) {
  return Number.isSafeInteger(user?.session_version) && user.session_version >= 0
    ? user.session_version
    : 0;
}

export async function getPasswordHash(password) {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(plainPassword, hashedPassword) {
  const candidate = hashedPassword || DUMMY_PASSWORD_HASH;
  const matched = await bcrypt.compare(plainPassword, candidate);
  return Boolean(hashedPassword) && matched;
}

export function createAccessToken(data, expiresMinutes = runtimeConfig().jwtExpiresMinutes) {
  const config = runtimeConfig();
  const {
    sessionVersion = 0,
    // Never allow a caller-provided JWT claim to bypass the normalized value.
    sv: _ignoredSessionVersion,
    ...claims
  } = data;
  if (!Number.isSafeInteger(sessionVersion) || sessionVersion < 0) {
    throw new Error("sessionVersion must be a non-negative safe integer");
  }
  return jwt.sign({ ...claims, sv: sessionVersion }, config.jwtSecret, {
    algorithm: ALGORITHM,
    expiresIn: `${expiresMinutes}m`,
    issuer: config.jwtIssuer,
    audience: config.jwtAudience,
  });
}

/**
 * Populates req.currentUser = { email, role } or replies 401 with a {detail} body.
 */
export async function getCurrentUser(req, res, next) {
  const header = req.headers.authorization || "";
  const [scheme, bearerToken] = header.split(" ");
  const cookies = Object.fromEntries(
    String(req.headers.cookie || "").split(";").map((part) => {
      const index = part.indexOf("=");
      if (index < 0) return ["", ""];
      return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1))];
    }).filter(([name]) => name)
  );
  const token = scheme === "Bearer" && bearerToken
    ? bearerToken
    : cookies[SESSION_COOKIE];

  if (!token) {
    res.set("WWW-Authenticate", "Bearer");
    return res.status(401).json({ detail: "Could not validate credentials" });
  }

  try {
    const config = runtimeConfig();
    const payload = jwt.verify(token, config.jwtSecret, {
      algorithms: [ALGORITHM],
      issuer: config.jwtIssuer,
      audience: config.jwtAudience,
    });
    if (
      !payload.sub
      || !Object.values(ROLES).includes(payload.role)
      || !Number.isSafeInteger(payload.sv)
      || payload.sv < 0
    ) {
      res.set("WWW-Authenticate", "Bearer");
      return res.status(401).json({ detail: "Could not validate credentials" });
    }
    const db = req.app.locals.db;
    const user = await coreCollection(db, "users").findOne({ email: payload.sub });
    if (
      !user
      || user.disabled_at
      || user.role !== payload.role
      || userSessionVersion(user) !== payload.sv
    ) {
      res.set("WWW-Authenticate", "Bearer");
      return res.status(401).json({ detail: "Could not validate credentials" });
    }
    let collegeId = null;
    if (user.role === ROLES.BOA) {
      const boa = await coreCollection(db, "boas").findOne({
        $and: [
          { _id: idMatch(String(user.reference_id)) },
          { $or: [{ deleted_at: null }, { deleted_at: { $exists: false } }] },
        ],
      });
      if (!boa) {
        res.set("WWW-Authenticate", "Bearer");
        return res.status(401).json({ detail: "Could not validate credentials" });
      }
      collegeId = String(boa.college_id);
    }
    req.currentUser = {
      email: user.email,
      role: user.role,
      referenceId: user.reference_id,
      collegeId,
      // Absent unless someone set it for this person, which is deliberately
      // distinct from false: absent follows the workspace default.
      ...(typeof user.can_delete_records === "boolean"
        ? { can_delete_records: user.can_delete_records }
        : {}),
      // Carried for the same reason. canDeleteCheckout() reads this field, but
      // it was never copied off the user document, so a per-person check-out
      // override could be stored and would then be ignored: everyone silently
      // fell back to the workspace default instead.
      ...(typeof user.can_delete_checkout === "boolean"
        ? { can_delete_checkout: user.can_delete_checkout }
        : {}),
    };
    return next();
  } catch (error) {
    if (!["JsonWebTokenError", "TokenExpiredError", "NotBeforeError"].includes(error?.name)) {
      return next(error);
    }
    res.set("WWW-Authenticate", "Bearer");
    return res.status(401).json({ detail: "Could not validate credentials" });
  }
}

/** Guard for administrative routes: SUPER_ADMIN and ADMIN both qualify. */
export function requireSuperAdmin(req, res, next) {
  if (!isElevated(req.currentUser?.role)) {
    return res.status(403).json({ detail: "Not authorized" });
  }
  return next();
}

/**
 * Guard for actions only the primary administrator may take. Restricting
 * ADMIN-account management to SUPER_ADMIN keeps that account un-removable, so
 * an admin cannot lock the owner out of their own system.
 */
export function requireRootAdmin(req, res, next) {
  if (req.currentUser?.role !== ROLES.SUPER_ADMIN) {
    return res.status(403).json({ detail: "Only the super admin can manage administrator accounts" });
  }
  return next();
}

/**
 * Compatibility helper for legacy records that may use MongoDB ObjectIds.
 * Documents are written with string UUID `_id`s, but older rows may use real
 * ObjectIds - so we match on both forms, exactly like the `$or` queries did.
 */
export function idMatch(idStr) {
  const variants = [idStr];
  if (ObjectId.isValid(idStr) && String(new ObjectId(idStr)) === idStr) {
    variants.push(new ObjectId(idStr));
  }
  return { $in: variants };
}

/**
 * Guard for endpoints an operator or scheduler calls without a session.
 *
 * cron-jobs.org cannot hold one, and neither can an uptime probe, so they
 * present a shared secret instead. Compared in constant time so the check
 * cannot leak the secret one byte at a time.
 */
export function requireCronSecret(req, res, next) {
  const expected = process.env.CRON_SECRET || "";
  if (!expected) {
    return res.status(503).json({ detail: "CRON_SECRET is not configured on the server" });
  }
  const supplied = String(req.get("x-cron-secret") || "");
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  const matches = expectedBuffer.length === suppliedBuffer.length
    && crypto.timingSafeEqual(expectedBuffer, suppliedBuffer);
  if (!matches) return res.status(401).json({ detail: "Invalid cron secret" });
  return next();
}

export function requireDatabase(req, res, next) {
  if (!req.app.locals.db) {
    return res.status(503).json({ detail: "Database not configured" });
  }
  return next();
}

export function instructorScope(currentUser) {
  if (isElevated(currentUser?.role)) return {};
  return { college_id: idMatch(String(currentUser?.collegeId)) };
}
