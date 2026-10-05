import crypto from "node:crypto";
import { BigQuery } from "@google-cloud/bigquery";
import { getSetting, saveSetting } from "../stores/settingsStore.js";
import { coreCollection } from "../stores/coreStore.js";

const DATASET = "niat_instructor_automation_data";
const TABLE = "niat_instructor_managers_and_instructors_details";
const EMAIL_TABLE = "niat_instructor_unit_wise_completion_and_best_attempt_details";
const INSTITUTE_TABLE = "niat_institute_details";
export const SYNC_STATE_ID = "instructor_sync";

const MAX_ROWS = 50_000;

let client = null;
let clientFingerprint = "";

function credentials() {
  const raw = process.env.BIGQUERY_CREDENTIALS_JSON;
  if (!raw) return null;
  try {
    const decoded = raw.trim().startsWith("{")
      ? raw
      : Buffer.from(raw, "base64").toString("utf8");
    return JSON.parse(decoded);
  } catch {
    console.error("BIGQUERY_CREDENTIALS_JSON is not valid JSON or base64 JSON");
    return null;
  }
}

export function isSyncConfigured() {
  return Boolean(credentials());
}

function getClient() {
  const creds = credentials();
  if (!creds) throw new Error("BigQuery credentials are not configured");
  const fingerprint = `${creds.project_id}|${creds.client_email}`;
  if (!client || clientFingerprint !== fingerprint) {
    client = new BigQuery({
      projectId: process.env.BIGQUERY_PROJECT_ID || creds.project_id,
      credentials: {
        client_email: creds.client_email,
        private_key: creds.private_key,
      },
    });
    clientFingerprint = fingerprint;
  }
  return client;
}

function clean(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().replace(/\s+/g, " ");
  return text.length ? text : null;
}

export function mapInstructorRow(row) {
  const lookup = new Map(
    Object.entries(row || {}).map(([key, value]) => [key.toLowerCase(), value])
  );
  const pick = (...names) => {
    for (const name of names) {
      const value = clean(lookup.get(name));
      if (value) return value;
    }
    return null;
  };

  const userId = pick("instructor_user_id", "instructoruserid", "user_id");
  const name = pick("instructor_name", "instructorname");
  if (!userId || !name) return null;

  return {
    instructor_user_id: userId,
    name,
    instructor_role: pick("instructor_role", "instructorrole"),
    institute_name: pick("institute_name", "institutename"),
    instructor_category: pick("instructor_category", "instructorcategory"),
    email: (pick("instructor_mail", "instructor_email", "email") || "").toLowerCase() || null,
  };
}

export async function fetchInstructorRoster() {
  const projectId = process.env.BIGQUERY_PROJECT_ID || credentials()?.project_id;
  const query = `
    WITH roster AS (
      SELECT
        instructor_user_id,
        ANY_VALUE(instructor_name)     AS instructor_name,
        ANY_VALUE(instructor_role)     AS instructor_role,
        ANY_VALUE(institute_name)      AS institute_name,
        ANY_VALUE(instructor_category) AS instructor_category
      FROM \`${projectId}.${DATASET}.${TABLE}\`
      WHERE instructor_user_id IS NOT NULL
        AND TRIM(instructor_user_id) != ''
      GROUP BY instructor_user_id
    ),
    mails AS (
      SELECT
        instructor_user_id,
        ANY_VALUE(instructor_mail) AS instructor_mail
      FROM \`${projectId}.${DATASET}.${EMAIL_TABLE}\`
      WHERE instructor_user_id IS NOT NULL
        AND instructor_mail IS NOT NULL
        AND TRIM(instructor_mail) != ''
      GROUP BY instructor_user_id
    )
    SELECT roster.*, mails.instructor_mail
    FROM roster
    LEFT JOIN mails USING (instructor_user_id)
    LIMIT ${MAX_ROWS}
  `;
  const [rows] = await getClient().query({ query, location: process.env.BIGQUERY_LOCATION || undefined });

  const mapped = [];
  let skipped = 0;
  for (const row of rows) {
    const record = mapInstructorRow(row);
    if (!record) {
      skipped += 1;
      continue;
    }
    mapped.push(record);
  }
  return {
    records: mapped,
    fetched: rows.length,
    skipped,
    withEmail: mapped.filter((record) => record.email).length,
  };
}

export async function saveInstructorRoster(db, records) {
  if (!records.length) return { upserted: 0, modified: 0 };
  const now = new Date();
  const operations = records.map((record) => {
    const owned = { ...record };
    for (const key of ["email"]) {
      if (owned[key] === null) delete owned[key];
    }
    return {
      updateOne: {
        filter: { instructor_user_id: record.instructor_user_id },
        update: {
          $set: { ...owned, source: "bigquery", synced_at: now, updated_at: now },
          $setOnInsert: {
            created_at: now,
            deleted_at: null,
            college_id: null,
            gender: null,
            report_token: crypto.randomBytes(24).toString("base64url"),
          },
        },
        upsert: true,
      },
    };
  });

  let upserted = 0;
  let modified = 0;
  const BATCH = 500;
  for (let index = 0; index < operations.length; index += BATCH) {
    const result = await coreCollection(db, "instructors").bulkWrite(
      operations.slice(index, index + BATCH),
      { ordered: false }
    );
    upserted += result.upsertedCount || 0;
    modified += result.modifiedCount || 0;
  }
  return { upserted, modified };
}

export async function readSyncState(db) {
  return getSetting(db, SYNC_STATE_ID);
}

export async function writeSyncState(db, state) {
  await saveSetting(db, SYNC_STATE_ID, { set: { ...state, _id: SYNC_STATE_ID } });
}

export async function runInstructorSync(db, { triggeredBy } = {}) {
  const startedAt = new Date();
  try {
    const { records, fetched, skipped } = await fetchInstructorRoster();
    const { upserted, modified } = await saveInstructorRoster(db, records);
    const state = {
      last_sync_at: new Date(),
      last_sync_status: "success",
      last_sync_error: null,
      last_sync_by: triggeredBy || null,
      record_count: records.length,
      rows_fetched: fetched,
      rows_skipped: skipped,
      upserted,
      modified,
      duration_ms: Date.now() - startedAt.getTime(),
    };
    await writeSyncState(db, state);
    return { ok: true, ...state };
  } catch (error) {
    const state = {
      last_sync_at: new Date(),
      last_sync_status: "failed",
      last_sync_error: error?.message?.slice(0, 300) || "Sync failed",
      last_sync_by: triggeredBy || null,
      duration_ms: Date.now() - startedAt.getTime(),
    };
    await writeSyncState(db, state);
    return { ok: false, ...state };
  }
}


export async function fetchInstitutes() {
  const projectId = process.env.BIGQUERY_PROJECT_ID || credentials()?.project_id;
  const query = `
    SELECT
      institute_id,
      ANY_VALUE(institute_name)     AS institute_name,
      ANY_VALUE(institue_location)  AS institute_location
    FROM \`${projectId}.${DATASET}.${INSTITUTE_TABLE}\`
    WHERE institute_id IS NOT NULL AND TRIM(institute_id) != ''
    GROUP BY institute_id
    LIMIT 5000
  `;
  const [rows] = await getClient().query({ query, location: process.env.BIGQUERY_LOCATION || undefined });

  const records = [];
  let skipped = 0;
  for (const row of rows) {
    const id = clean(row.institute_id);
    const name = clean(row.institute_name);
    if (!id || !name) {
      skipped += 1;
      continue;
    }
    records.push({
      institute_id: id,
      name,
      location: clean(row.institute_location) || "",
    });
  }
  return { records, fetched: rows.length, skipped };
}

export async function saveInstitutes(db, records) {
  if (!records.length) return { upserted: 0, modified: 0 };
  const now = new Date();
  const operations = records.map((record) => ({
    updateOne: {
      filter: { institute_id: record.institute_id },
      update: {
        $set: {
          name: record.name,
          location: record.location,
          institute_id: record.institute_id,
          source: "bigquery",
          synced_at: now,
          updated_at: now,
        },
        $setOnInsert: { _id: record.institute_id, created_at: now, deleted_at: null },
      },
      upsert: true,
    },
  }));

  let upserted = 0;
  let modified = 0;
  for (let index = 0; index < operations.length; index += 500) {
    const result = await coreCollection(db, "colleges").bulkWrite(
      operations.slice(index, index + 500),
      { ordered: false }
    );
    upserted += result.upsertedCount || 0;
    modified += result.modifiedCount || 0;
  }
  return { upserted, modified };
}

export async function linkInstructorsToInstitutes(db) {
  const colleges = await coreCollection(db, "colleges")
    .find(
      { $or: [{ deleted_at: null }, { deleted_at: { $exists: false } }] },
      { projection: { _id: 1, name: 1 } }
    )
    .toArray();

  const byName = new Map();
  const ambiguousNames = new Set();
  for (const college of colleges) {
    const key = String(college.name).trim().toLowerCase();
    if (byName.has(key)) {
      ambiguousNames.add(key);
      continue;
    }
    byName.set(key, college._id);
  }

  const unassigned = await coreCollection(db, "instructors")
    .find({
      source: "bigquery",
      institute_name: { $type: "string" },
      $or: [{ college_id: null }, { college_id: { $exists: false } }, { college_id: "" }],
    })
    .project({ _id: 1, institute_name: 1 })
    .toArray();

  const operations = [];
  let unmatched = 0;
  let ambiguous = 0;
  for (const instructor of unassigned) {
    const key = String(instructor.institute_name).trim().toLowerCase();
    if (ambiguousNames.has(key)) {
      ambiguous += 1;
      continue;
    }
    const collegeId = byName.get(key);
    if (!collegeId) {
      unmatched += 1;
      continue;
    }
    operations.push({
      updateOne: {
        filter: { _id: instructor._id },
        update: { $set: { college_id: String(collegeId), updated_at: new Date() } },
      },
    });
  }
  if (unmatched || ambiguous) {
    console.warn(
      `Institute linking left ${unmatched} instructor(s) with no matching college and `
      + `${ambiguous} with an ambiguous college name; they remain unassigned and are not `
      + "visible to any BOA until a college is set on them."
    );
  }
  if (!operations.length) return { linked: 0, unmatched, ambiguous };

  let linked = 0;
  for (let index = 0; index < operations.length; index += 500) {
    const result = await coreCollection(db, "instructors").bulkWrite(
      operations.slice(index, index + 500),
      { ordered: false }
    );
    linked += result.modifiedCount || 0;
  }
  return { linked, unmatched, ambiguous };
}

export async function runInstituteSync(db, { triggeredBy } = {}) {
  const startedAt = new Date();
  try {
    const { records, fetched, skipped } = await fetchInstitutes();
    const { upserted, modified } = await saveInstitutes(db, records);
    const { linked, unmatched, ambiguous } = await linkInstructorsToInstitutes(db);
    const state = {
      last_sync_at: new Date(),
      last_sync_status: "success",
      last_sync_error: null,
      last_sync_by: triggeredBy || null,
      record_count: records.length,
      rows_fetched: fetched,
      rows_skipped: skipped,
      upserted,
      modified,
      instructors_linked: linked,
      instructors_unmatched: unmatched,
      instructors_ambiguous: ambiguous,
      duration_ms: Date.now() - startedAt.getTime(),
    };
    await saveSetting(db, "institute_sync", { set: { ...state, _id: "institute_sync" } });
    return { ok: true, ...state };
  } catch (error) {
    const state = {
      last_sync_at: new Date(),
      last_sync_status: "failed",
      last_sync_error: error?.message?.slice(0, 300) || "Sync failed",
      duration_ms: Date.now() - startedAt.getTime(),
    };
    await saveSetting(db, "institute_sync", { set: { ...state, _id: "institute_sync" } });
    return { ok: false, ...state };
  }
}
