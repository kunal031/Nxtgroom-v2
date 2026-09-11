import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { app } from "../server.js";
import { createAccessToken, getPasswordHash } from "../src/middleware/auth.js";
import {
  buildCheckoutEmail,
  buildEvaluationEmail,
  buildGroomingAlertEmail,
} from "../src/services/emailService.js";
import { todayBounds } from "../src/utils.js";

let server;
let baseUrl;

before(async () => {
  app.locals.db = null;
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

test("root endpoint identifies the API without exposing implementation details", async () => {
  const response = await fetch(`${baseUrl}/`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    message: "NxtWave Grooming Standards API",
    version: "2",
  });
  assert.equal(response.headers.get("x-powered-by"), null);
});

test("CORS rejects origins outside the configured allow-list", async () => {
  const response = await fetch(`${baseUrl}/`, {
    headers: { origin: "https://untrusted.example" },
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { detail: "Origin is not allowed by CORS" });
});

test("liveness stays healthy while readiness and database routes report unavailable DB", async () => {
  const live = await fetch(`${baseUrl}/health/live`);
  assert.equal(live.status, 200);
  assert.deepEqual(await live.json(), { status: "ok" });

  const ready = await fetch(`${baseUrl}/health/ready`);
  assert.equal(ready.status, 503);
  assert.deepEqual(await ready.json(), {
    ready: false,
    status: "degraded",
    reasons: ["DATABASE_UNAVAILABLE"],
    workers: [],
    queues: [],
  });

  const login = await fetch(`${baseUrl}/api/v2/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "username=admin%40nxtwave.com&password=admin%40123",
  });
  assert.equal(login.status, 503);
  assert.deepEqual(await login.json(), { detail: "Database not configured" });
});

test("login preserves the frontend authentication contract", async () => {
  const passwordHash = await getPasswordHash("admin@123");
  app.locals.db = {
    collection(name) {
      // /me also reads the workspace permission defaults, so it can tell the
      // browser which actions to offer.
      if (name === "app_settings") return { findOne: async () => null };
      assert.equal(name, "users");
      return {
        findOne: async ({ email }) => email === "admin@nxtwave.com"
          ? { email, password_hash: passwordHash, role: "SUPER_ADMIN" }
          : null,
      };
    },
  };

  const response = await fetch(`${baseUrl}/api/v2/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", connection: "close" },
    body: "username=admin%40nxtwave.com&password=admin%40123",
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.token_type, "bearer");
  assert.equal(body.role, "SUPER_ADMIN");
  assert.equal(body.access_token.split(".").length, 3);

  const me = await fetch(`${baseUrl}/api/v2/auth/me`, {
    headers: { authorization: `Bearer ${body.access_token}`, connection: "close" },
  });
  assert.equal(me.status, 200);
  assert.deepEqual(await me.json(), {
    email: "admin@nxtwave.com",
    role: "SUPER_ADMIN",
    college_id: null,
    // Sent so the interface only offers actions the server would allow. An
    // admin always may; a BOA depends on the workspace and per-user settings.
    can_delete_records: true,
    can_delete_checkout: true,
    // Workspace-wide, and off unless an administrator turns it on, so the
    // record view knows whether to offer re-analysis without needing the
    // super-admin-only settings endpoint.
    reanalyse_enabled: false,
    // Whether this account may name an unidentified check-in. Always true for
    // an administrator; a BOA depends on the workspace and per-user settings.
    can_identify: true,
  });
});

test("a per-user session version revokes an otherwise valid JWT", async () => {
  app.locals.db = {
    collection(name) {
      assert.equal(name, "users");
      return {
        findOne: async ({ email }) => ({
          email,
          role: "SUPER_ADMIN",
          session_version: 3,
        }),
      };
    },
  };
  const staleToken = createAccessToken({
    sub: "admin@example.com",
    role: "SUPER_ADMIN",
    sessionVersion: 2,
  });
  const response = await fetch(`${baseUrl}/api/v2/auth/me`, {
    headers: { authorization: `Bearer ${staleToken}`, connection: "close" },
  });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { detail: "Could not validate credentials" });
});

test("today bounds use the configured UTC offset", () => {
  const { start, end } = todayBounds(330, new Date("2026-08-14T20:00:00.000Z"));
  assert.equal(start.toISOString(), "2026-08-14T18:30:00.000Z");
  assert.equal(end.toISOString(), "2026-08-15T18:30:00.000Z");
});

test("BOA access is reloaded from the database and scoped to its college", async () => {
  const ownInstructor = {
    _id: "instructor-a",
    employee_id: "EMP-A",
    name: "Scoped Instructor",
    role: "Trainee",
    gender: "MALE",
    college_id: "college-a",
    email: "private@example.com",
    phone_no: "9999999999",
    deleted_at: null,
    _private_attendance_guard_version: 4,
  };
  let instructorFilter;
  const cursor = (rows) => ({
    sort() { return this; },
    skip() { return this; },
    limit() { return this; },
    async toArray() { return rows; },
  });
  app.locals.db = {
    collection(name) {
      if (name === "users") return {
        findOne: async ({ email }) => email === "boa@example.com"
          ? { email, role: "BOA", reference_id: "boa-a" }
          : null,
      };
      if (name === "boas") return {
        findOne: async () => ({ _id: "boa-a", college_id: "college-a" }),
      };
      if (name === "instructors") return {
        find(filter) {
          instructorFilter = filter;
          return cursor([ownInstructor]);
        },
      };
      if (name === "attendance") return {
        aggregate: () => ({ toArray: async () => [] }),
      };
      throw new Error(`Unexpected collection ${name}`);
    },
  };
  const token = createAccessToken({ sub: "boa@example.com", role: "BOA" });
  const response = await fetch(`${baseUrl}/api/v2/instructors`, {
    headers: { authorization: `Bearer ${token}`, connection: "close" },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.length, 1);
  assert.equal(body[0].email, undefined);
  assert.equal(body[0].phone_no, undefined);
  assert.equal(body[0]._private_attendance_guard_version, undefined);
  assert.match(JSON.stringify(instructorFilter), /college-a/);

  const forbidden = await fetch(`${baseUrl}/api/v2/boas`, {
    headers: { authorization: `Bearer ${token}`, connection: "close" },
  });
  assert.equal(forbidden.status, 403);
});

test("SES check-in report is concise and escapes instructor data", () => {
  const email = buildEvaluationEmail({
    instructorName: "A <Instructor>",
    overallStatus: "NON_COMPLIANT",
    aiSummary: "ID card is missing.",
    checkInTime: "2026-08-14T03:30:00.000Z",
    reportUrl: "https://facultytrack.example/reports/check-in",
  });
  assert.equal(email.subject, "Your check-in appearance report");
  assert.match(email.text, /Appearance status: NON-COMPLIANT/);
  assert.match(email.text, /ID card is missing\./);
  assert.match(email.html, /A &lt;Instructor&gt;/);
  assert.doesNotMatch(email.html, /A <Instructor>/);
  assert.match(email.text, /https:\/\/facultytrack\.example\/reports\/check-in/);
  assert.match(email.html, /View check-in report/);
});

test("SES checkout report includes attendance times and latest appearance status", () => {
  const email = buildCheckoutEmail({
    instructorName: "Test Instructor",
    checkInTime: "2026-08-14T03:30:00.000Z",
    checkOutTime: "2026-08-14T11:30:00.000Z",
    status: "done",
    remarks: "All checks passed.",
    reportUrl: "https://facultytrack.example/reports/check-out",
  });
  assert.match(email.subject, /Checkout confirmation/);
  assert.match(email.text, /Appearance status: COMPLIANT/);
  assert.match(email.text, /All checks passed\./);
  assert.match(email.text, /https:\/\/facultytrack\.example\/reports\/check-out/);
  assert.match(email.html, /View checkout report/);
});

test("checkout grooming alerts identify the correct event", () => {
  const email = buildGroomingAlertEmail({
    name: "Test Instructor",
    status: "non_compliant",
    summary: "ID card missing.",
    dateLabel: "2026-08-20",
    reportUrl: "https://facultytrack.example/reports/check-out",
    kind: "checkout",
  });
  assert.match(email.subject, /Your check-out on 2026-08-20/);
  assert.match(email.text, /Your check-out on 2026-08-20/);
  assert.doesNotMatch(email.text, /Your check-in/);
});

test("SES report asks for a retake when the photo could not be assessed", () => {
  const email = buildEvaluationEmail({
    instructorName: "Test Instructor",
    overallStatus: "COMPLIANT",
    aiSummary: "Footwear was not visible.",
    imageQuality: "RETAKE_RECOMMENDED",
  });
  // Nothing failed, so the result stands. The photo is still the problem, and
  // saying so is what gets a usable one next time.
  assert.match(email.text, /Appearance status: COMPLIANT/);
  assert.match(email.text, /clearer full-body photo/);
});
