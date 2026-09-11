import { Router } from "express";
import { appUrl, runtimeConfig } from "../config/env.js";
import {
  createAccessToken,
  getCurrentUser,
  getPasswordHash,
  ROLES,
  SESSION_COOKIE,
  userSessionVersion,
  verifyPassword,
} from "../middleware/auth.js";
import { asyncRoute } from "../utils.js";
import {
  canDeleteAttendance,
  canDeleteCheckout,
  canIdentifyAttendance,
  getAccessSettings,
} from "../services/accessSettings.js";
import { getNotificationSettings } from "../services/notificationSettings.js";
import {
  googleClientId,
  isGoogleLoginEnabled,
  verifyGoogleIdToken,
} from "../services/googleAuth.js";
import {
  consumeResetToken,
  issueResetToken,
  hashResetToken,
  peekResetToken,
  RESET_TTL_MS,
} from "../services/passwordResetService.js";
import { enqueueMailJob } from "../services/mailWorker.js";
import { sealSecret } from "../services/secretBox.js";
import { withMongoTransaction } from "../config/db.js";
import rateLimit from "express-rate-limit";

// Credential verification is a network call to Google; rate limit it so a
// flood of forged tokens cannot exhaust the request budget.
const googleLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { detail: "Too many sign-in attempts. Please try again later." },
});

// Anonymous endpoints that send mail or test tokens. Tighter than the Google
// limiter because each accepted request costs an outbound email.
const passwordResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { detail: "Too many password reset attempts. Please try again later." },
});

/**
 * Greeting name for an account. Admin records carry their own name; a BOA's
 * lives on the linked boas document, so fall back to the email local part
 * rather than address the person as "there".
 */
async function displayNameForUser(db, user) {
  if (user.name) return user.name;
  if (user.role === ROLES.BOA && user.reference_id) {
    const boa = await db.collection("boas").findOne(
      { _id: user.reference_id },
      { projection: { name: 1 } }
    );
    if (boa?.name) return boa.name;
  }
  return String(user.email || "").split("@")[0] || "there";
}

export const authRouter = Router();

function setSessionCookie(res, token) {
  const production = runtimeConfig().nodeEnv === "production";
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: production,
    sameSite: production ? "none" : "lax",
    path: "/",
    maxAge: runtimeConfig().jwtExpiresMinutes * 60_000,
  });
}

function clearSessionCookie(res) {
  const production = runtimeConfig().nodeEnv === "production";
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    secure: production,
    sameSite: production ? "none" : "lax",
    path: "/",
  });
}

authRouter.post("/logout", (_req, res) => {
  clearSessionCookie(res);
  return res.status(204).end();
});

authRouter.get("/me", getCurrentUser, asyncRoute(async (req, res) => {
  const settings = await getAccessSettings(req.app.locals.db);
  // Read here rather than from the settings endpoint, which is super-admin
  // only: a BOA opens the same record view and must see the same control.
  const notifications = await getNotificationSettings(req.app.locals.db);
  res.json({
    email: req.currentUser.email,
    role: req.currentUser.role,
    college_id: req.currentUser.collegeId,
    reanalyse_enabled: notifications.reanalyse_enabled,
    // Sent so the interface can hide an action the server would refuse. The
    // server still checks on every delete; this only keeps the UI honest.
    can_delete_records: canDeleteAttendance(req.currentUser, settings),
    can_delete_checkout: canDeleteCheckout(req.currentUser, settings),
    // Whether this account may name an unidentified check-in. Sent for the same
    // reason as the delete flags: the queue is hidden rather than offered and
    // then refused. The server still checks on every assignment.
    can_identify: canIdentifyAttendance(req.currentUser, settings),
  });
}));

authRouter.post(
  "/login",
  asyncRoute(async (req, res) => {
    const email = String(req.body.username || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    if (!email || !password || email.length > 254 || password.length > 128) {
      return res.status(422).json({ detail: "Username and password are required" });
    }

    const user = await req.app.locals.db.collection("users").findOne({ email });
    const passwordMatches = await verifyPassword(password, user?.password_hash);
    if (!user || user.disabled_at || !Object.values(ROLES).includes(user.role) || !passwordMatches) {
      return res.status(401).json({ detail: "Incorrect email or password" });
    }

    const accessToken = createAccessToken({
        sub: user.email,
        role: user.role,
        sessionVersion: userSessionVersion(user),
      });
    setSessionCookie(res, accessToken);
    return res.json({
      access_token: accessToken,
      token_type: "bearer",
      role: user.role,
      expires_in: 60 * runtimeConfig().jwtExpiresMinutes,
    });
  })
);

authRouter.post(
  "/change-password",
  getCurrentUser,
  asyncRoute(async (req, res) => {
    const minimumResponse = new Promise((resolve) => setTimeout(resolve, 300));
    const currentPassword = String(req.body?.current_password || "");
    const newPassword = String(req.body?.new_password || "");

    if (!currentPassword || !newPassword) {
      return res.status(422).json({ detail: "Current and new passwords are required" });
    }
    if (newPassword.length < 12 || newPassword.length > 128) {
      return res.status(422).json({ detail: "New password must be between 12 and 128 characters" });
    }
    if (newPassword === currentPassword) {
      return res.status(422).json({ detail: "New password must differ from the current password" });
    }

    const db = req.app.locals.db;
    const user = await db.collection("users").findOne({ email: req.currentUser.email });
    if (!user || !(await verifyPassword(currentPassword, user.password_hash))) {
      return res.status(401).json({ detail: "Current password is incorrect" });
    }

    // Bumping session_version invalidates every existing token for this user,
    // including the one making this request, so a stolen token cannot survive
    // a password change.
    await db.collection("users").updateOne(
      { _id: user._id },
      {
        $set: {
          password_hash: await getPasswordHash(newPassword),
          password_changed_at: new Date(),
          updated_at: new Date(),
        },
        $inc: { session_version: 1 },
      }
    );

    return res.json({ message: "Password changed successfully. Please sign in again." });
  })
);

/**
 * Starts a self-service reset. Always answers 200 with the same body: a
 * different response for a known versus unknown address would let anyone
 * enumerate which emails hold accounts.
 */
authRouter.post(
  "/forgot-password",
  passwordResetLimiter,
  asyncRoute(async (req, res) => {
    // Started before any lookup so a known and an unknown address take the same
    // observable time. It lived in the change-password handler's scope, where
    // this one could not see it, so every request here threw a ReferenceError
    // and self-service reset answered 500 instead of the generic message.
    const minimumResponse = new Promise((resolve) => setTimeout(resolve, 300));
    const email = String(req.body?.email || "").trim().toLowerCase();
    const genericResponse = {
      message: "If that email has an account, a reset link is on its way.",
    };
    if (!email || email.length > 254) {
      await minimumResponse;
      return res.json(genericResponse);
    }

    const db = req.app.locals.db;
    const user = await db.collection("users").findOne({ email });

    // Disabled accounts get no link; re-enabling is an administrator action.
    if (user && !user.disabled_at && Object.values(ROLES).includes(user.role)) {
      const token = await issueResetToken(db, { email, kind: "reset", ttlMs: RESET_TTL_MS });
      const name = await displayNameForUser(db, user);
      await db.collection("mail_jobs").deleteMany({
        type: "password_reset",
        to_email: email,
        status: { $in: ["queued", "processing"] },
      });
      await enqueueMailJob(db, {
        id: `password-reset:${email}:${hashResetToken(token)}`,
        type: "password_reset",
        toEmail: email,
        payload: {
          name,
          appUrl: appUrl(),
          // Sealed, not raw. password_resets stores only a hash of this token
          // precisely so a database copy cannot be replayed; a queued job
          // holding the plaintext gave that back until the mail was sent.
          token_sealed: sealSecret(token),
          expiresInMinutes: Math.round(RESET_TTL_MS / 60000),
        },
      });
    }
    await minimumResponse;
    return res.json(genericResponse);
  })
);

/** Lets the reset page show "this link expired" before asking for a password. */
authRouter.get(
  "/reset-password/:token",
  passwordResetLimiter,
  asyncRoute(async (req, res) => {
    const outcome = await peekResetToken(req.app.locals.db, req.params.token);
    if (outcome.error) {
      return res.status(400).json({
        detail: outcome.error === "expired"
          ? "This link has expired. Request a new one."
          : "This link is not valid. Request a new one.",
        reason: outcome.error,
      });
    }
    return res.json({ valid: true, email: outcome.email, kind: outcome.kind });
  })
);

/** Redeems a token and sets the password. Used by both invites and resets. */
authRouter.post(
  "/reset-password",
  passwordResetLimiter,
  asyncRoute(async (req, res) => {
    const token = String(req.body?.token || "");
    const newPassword = String(req.body?.new_password || "");
    const confirmPassword = String(req.body?.confirm_password ?? newPassword);

    if (newPassword.length < 12 || newPassword.length > 128) {
      return res.status(422).json({ detail: "Password must be between 12 and 128 characters" });
    }
    if (newPassword !== confirmPassword) {
      return res.status(422).json({ detail: "Passwords do not match" });
    }

    const db = req.app.locals.db;
    const passwordHash = await getPasswordHash(newPassword);
    const outcome = await withMongoTransaction(async (session) => {
      const consumed = await consumeResetToken(db, token, { session });
      if (consumed.error) return consumed;
      const user = await db.collection("users").findOne(
        { email: consumed.email },
        { session }
      );
      if (!user || user.disabled_at || !Object.values(ROLES).includes(user.role)) {
        return { error: "account_unavailable" };
      }
      const changed = await db.collection("users").updateOne(
        { _id: user._id, disabled_at: { $exists: false } },
        {
          $set: {
            password_hash: passwordHash,
            password_changed_at: new Date(),
            updated_at: new Date(),
          },
          $inc: { session_version: 1 },
        },
        { session }
      );
      if (!changed.matchedCount) throw new Error("Password update lost its account target");
      return consumed;
    });
    if (outcome.error === "account_unavailable") {
      return res.status(400).json({ detail: "This account can no longer be activated." });
    }
    if (outcome.error) {
      return res.status(400).json({
        detail: outcome.error === "expired"
          ? "This link has expired. Request a new one."
          : "This link is not valid. Request a new one.",
      });
    }

    return res.json({ message: "Password set successfully. You can sign in now." });
  })
);

/** Advertises whether the Google button should render, so the UI never shows a dead control. */
authRouter.get("/google/config", (_req, res) => {
  res.json({ enabled: isGoogleLoginEnabled(), client_id: googleClientId() || null });
});

/**
 * Sign-in only. A verified Google address must already belong to an active
 * user; this route never provisions accounts, so administrators keep sole
 * control of who exists via BOA management.
 */
authRouter.post(
  "/google",
  googleLoginLimiter,
  asyncRoute(async (req, res) => {
    if (!isGoogleLoginEnabled()) {
      return res.status(503).json({ detail: "Google sign-in is not enabled" });
    }

    const verification = await verifyGoogleIdToken(req.body?.credential);
    if (verification.error) {
      return res.status(401).json({ detail: verification.error });
    }

    const user = await req.app.locals.db
      .collection("users")
      .findOne({ email: verification.email });

    // One message for "no such user", "disabled", and "bad role" so the
    // endpoint cannot be used to enumerate which emails hold accounts.
    if (!user || user.disabled_at || !Object.values(ROLES).includes(user.role)) {
      return res.status(403).json({
        detail: "This Google account is not authorised. Ask an administrator to add it first.",
      });
    }

    const accessToken = createAccessToken({
        sub: user.email,
        role: user.role,
        sessionVersion: userSessionVersion(user),
      });
    setSessionCookie(res, accessToken);
    return res.json({
      access_token: accessToken,
      token_type: "bearer",
      role: user.role,
      expires_in: 60 * runtimeConfig().jwtExpiresMinutes,
    });
  })
);
