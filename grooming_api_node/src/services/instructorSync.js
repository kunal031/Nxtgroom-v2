import crypto from "node:crypto";
import { BigQuery } from "@google-cloud/bigquery";
import { getSetting, saveSetting } from "../stores/settingsStore.js";
import { coreCollection } from "../stores/coreStore.js";

/**
 * Pulls the instructor roster from BigQuery into MongoDB.
 *
 * The BigQuery table is the system of record for who exists; FacultyTrack owns
 * the attendance and grooming data keyed to those people. Syncing a local copy
 * means every screen reads from Mongo at Mongo speed, and the roster stays
 * usable if BigQuery is unreachable.
 */

const DATASET = "niat_instructor_automation_data";
const TABLE = "niat_instructor_managers_and_instructors_details";
/**
 * Carries instructor_mail; the roster table has no email column.
 *
 * Six tables in this dataset hold an address. This one covers 594 of the 600
 * rostered instructors, against 309 for the demo-sessions table used before —
 * that one only contains instructors who ran a demo, which is a subset.
 * Combining all six reaches 596, which is not worth six joins.
 */
const EMAIL_TABLE = "niat_instructor_unit_wise_completion_and_best_attempt_details";
/** Institutes, which FacultyTrack stores as colleges. */
const INSTITUTE_TABLE = "niat_institute_details";
export const SYNC_STATE_ID = "instructor_sync";

/** Guards against a runaway query; the roster is a few thousand rows. */
const MAX_ROWS = 50_000;

let client = null;
let clientFingerprint = "";

function credentials() {
  const raw = process.env.BIGQUERY_CREDENTIALS_JSON;
  if (!raw) return null;
  try {
    // Accept either the raw JSON or a base64 copy, because some hosts mangle
    // multi-line values in their environment editor.
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

/** Trims and collapses whitespace; returns null for anything empty. */
function clean(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().replace(/\s+/g, " ");
  return text.length ? text : null;
}

/**
 * Maps one BigQuery row onto the fields FacultyTrack stores. Column names are
 * matched case-insensitively because the warehouse is not consistent about
 * casing between tables.
 */
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
    // Joined from the demo table; the roster itself has no email column and
    // roughly half the instructors have no record there.
    email: (pick("instructor_mail", "instructor_email", "email") || "").toLowerCase() || null,
  };
}

/**
 * Fetches one row per instructor, with their email joined in.
 *
 * Deduplication happens in BigQuery rather than in JavaScript: the roster
 * repeats a person once per manager (4,606 rows for 599 people) and the demo
 * table once per week, so grouping at the source moves a fraction of the data
 * over the wire. Each instructor has exactly one institute, role and category,
 * verified against the warehouse, so ANY_VALUE is safe here.
 */
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
    // Rows are already one per instructor; anything rejected here is missing
    // a name and cannot be displayed.
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

/**
 * Writes the roster into the `instructors` collection, keyed on
 * instructor_user_id, so synced people appear on the Instructors page and can
 * be selected for attendance like any other record.
 *
 * The sync is strictly additive. It adds instructors that are new, updates
 * values that changed, and touches nothing else — there is no delete, drop or
 * replace anywhere in this path, and every write is addressed to an id present
 * in the current roster.
 *
 * That matters because an instructor who has left the BigQuery roster still
 * has attendance and grooming history here, and removing the row would orphan
 * it. Someone who disappears from the warehouse simply keeps their record with
 * an older synced_at. instructor-sync-additive.test.js asserts this by
 * inspecting the generated operations, so a destructive change fails there
 * before it could ever reach a database.
 *
 * Fields FacultyTrack owns — college assignment, gender, soft deletion — live
 * in $setOnInsert so a re-sync cannot reset them.
 */
export async function saveInstructorRoster(db, records) {
  if (!records.length) return { upserted: 0, modified: 0 };
  const now = new Date();
  const operations = records.map((record) => {
    // Only overwrite the columns BigQuery is authoritative for. About half the
    // instructors have no email in the warehouse, and writing that null would
    // erase an address an administrator entered so a check-in report could be
    // delivered.
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
            // Minted here rather than when the first alert is sent. Waiting
            // meant an instructor had no report link until an email had gone
            // out, and while alerts were broken that was almost everybody.
            report_token: crypto.randomBytes(24).toString("base64url"),
          },
        },
        upsert: true,
      },
    };
  });

  let upserted = 0;
  let modified = 0;
  // Batched so one oversized bulk write cannot exceed the 16MB command limit.
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

/** Runs one sync end to end and records the outcome for the Settings screen. */
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
      // Message only: a stack trace here would surface in the admin UI.
      last_sync_error: error?.message?.slice(0, 300) || "Sync failed",
      last_sync_by: triggeredBy || null,
      duration_ms: Date.now() - startedAt.getTime(),
    };
    await writeSyncState(db, state);
    return { ok: false, ...state };
  }
}


/**
 * Fetches the institute list. FacultyTrack calls these colleges internally;
 * the warehouse and the UI both call them institutes.
 *
 * Note institue_location: the column is misspelled in the warehouse, so both
 * spellings are read rather than assuming it will be corrected.
 */
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
    // A nameless institute cannot be displayed or chosen, so it is skipped
    // rather than stored as a blank option in every dropdown.
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

/**
 * Upserts institutes into the colleges collection, keyed on institute_id.
 * Additive like the instructor sync: an institute that leaves the warehouse
 * keeps its record, because instructors and attendance still reference it.
 */
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

/**
 * Assigns synced instructors to their institute by name.
 *
 * The roster names an instructor's institute but carries no id, so without
 * this every synced instructor stays unassigned — which leaves BOA scoping
 * with nothing to filter on and stores a college of "null" on their check-ins.
 */
export async function linkInstructorsToInstitutes(db) {
  const colleges = await coreCollection(db, "colleges")
    .find(
      // A soft-deleted college is not somewhere an instructor can be placed.
      { $or: [{ deleted_at: null }, { deleted_at: { $exists: false } }] },
      { projection: { _id: 1, name: 1 } }
    )
    .toArray();

  // Colleges are unique on (name, location), so one name can belong to more
  // than one campus. Keying the lookup on the name alone silently gave every
  // instructor of a repeated name to whichever college was read last, which
  // filed them under another campus and exposed them to that campus's BOA —
  // college_id is the only scope boundary a BOA has. An ambiguous name is left
  // unassigned instead, for someone to resolve deliberately.
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
  // An instructor with no college is invisible to every BOA, since the BOA
  // scope filters on college_id. That used to be reported only as a number
  // buried in the sync state, so nobody noticed people missing from a roster.
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

/** Runs the institute sync and the instructor linking together. */
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
