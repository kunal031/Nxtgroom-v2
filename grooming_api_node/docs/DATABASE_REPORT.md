# Database Report — MongoDB vs DynamoDB

**Project:** nxtGroom-v2 / `grooming_api_node`
**Date:** 2026-10-05
**Method:** Read from source code only. Every claim below has a `file:line` reference. Docs and `.md` files were not used as evidence.

---

## 1. Short summary

The app runs on **MongoDB**. A **DynamoDB** migration has been started, but it is small and early.

|                                    | MongoDB              | DynamoDB                          |
| ---------------------------------- | -------------------- | --------------------------------- |
| Collections / tables in code       | **13**               | **3**                             |
| Indexes defined in code            | **36**               | **0** extra (only primary kes)    |
| Checked when the app starts        | Yes, strictly        | No                                |
| Part of the `/health` check        | Yes                  | No                                |
| Supports transactions              | Yes, used in 6 files | Not used anywhere                 |
| Turned on right now (local `.env`) | Everything           | Only `app_settings`, shadow-write |

In plain words: **MongoDB does 100% of the real work. DynamoDB currently holds a copy of one small settings table.** 3 of 13 collections have been given a DynamoDB path, and those 3 are the smallest and simplest ones.

---

## 2. MongoDB connection

All in [src/config/db.js](src/config/db.js).

### How it connects

```js
client = new MongoClient(config.mongoUri, {
  appName: "facultytrack-api",
  maxPoolSize: 20,
  minPoolSize: 1,
  serverSelectionTimeoutMS: 10000,
  connectTimeoutMS: 10000,
  socketTimeoutMS: 120000,
  retryWrites: true,
});
```

[src/config/db.js:43-51](src/config/db.js#L43-L51)

| Setting                    | Value  | What it means                           |
| -------------------------- | ------ | --------------------------------------- |
| `maxPoolSize`              | 20     | At most 20 connections at once          |
| `minPoolSize`              | 1      | Keeps 1 connection warm                 |
| `serverSelectionTimeoutMS` | 10000  | Waits 10s to find a server              |
| `socketTimeoutMS`          | 120000 | A single query may take up to 2 minutes |
| `retryWrites`              | true   | Retries a failed write once             |

One shared client and one shared `db` object are kept in module variables and reused everywhere ([src/config/db.js:13-18](src/config/db.js#L13-L18)).

### What happens at startup

This is the important part. On every connect, the app **changes the database**, it does not just read it:

1. Connects and runs `ping` ([db.js:53-55](src/config/db.js#L53-L55))
2. Runs 3 index migrations that **create and drop indexes**, and one that **rewrites documents**:
   - `migrateLegacyEvaluationIdentityIndex` ([db.js:57](src/config/db.js#L57)) — this one runs `updateMany({kind: {$exists: false}}, {$set: {kind: "checkin"}})` ([databasePreflight.js:300-303](src/config/databasePreflight.js#L300-L303))
   - `migrateLegacyActiveAttendanceIndex` ([db.js:63](src/config/db.js#L63))
   - `migrateLegacyDailyAttendanceIndex` ([db.js:67](src/config/db.js#L67))
3. Verifies all 36 required indexes ([db.js:71](src/config/db.js#L71))
4. Then it splits by environment:
   - **production** — if any index is missing, **startup fails** ([db.js:72-78](src/config/db.js#L72-L78))
   - **not production** — it **silently creates the missing indexes** ([db.js:79-81](src/config/db.js#L79-L81))

> ⚠️ **Risk:** Step 4's non-production branch means starting the app in development against a shared or production cluster will **write index and document changes to that cluster**. The local `.env` points `MONGODB_URI` at a `mongodb+srv://` Atlas cluster while `NODE_ENV="development"` ([.env:1](.env#L1)), which is exactly the combination that triggers auto-apply.

### Safety features that are good

- TLS is enforced in production. A plain `mongodb://` URI must set `tls=true`, and `mongodb+srv://` must not set `tls=false` ([env.js:210-230](src/config/env.js#L210-L230))
- Failure during connect closes the client and resets state, so no half-open connection is left behind ([db.js:82-87](src/config/db.js#L82-L87))
- `checkMongoConnection()` pings with a 1.5s timeout for health checks ([db.js:92-100](src/config/db.js#L92-L100))
- Clean shutdown on SIGTERM/SIGINT ([server.js:326-349](server.js#L326-L349))

### Transactions

```js
session.withTransaction(() => work(session), {
  readConcern: { level: "snapshot" },
  writeConcern: { w: "majority" },
  readPreference: "primary",
});
```

[src/config/db.js:20-35](src/config/db.js#L20-L35)

This is a strong, correct setting (snapshot reads + majority writes). It is used in **6 files, 12 places** — `instructorRoutes.js` (5), `adminRoutes.js` (5), `authRoutes.js` (1), `attendanceRoutes.js` (1).

**This is the single biggest migration blocker.** DynamoDB has no equivalent in this codebase — `TransactWriteCommand` appears nowhere in `src/` or `scripts/`.

---

## 3. MongoDB collections and indexes

**13 collections** are used. 36 indexes are declared in `REQUIRED_DATABASE_INDEXES` ([databasePreflight.js:48-209](src/config/databasePreflight.js#L48-L209)), covering **11** of the 13.

A plain grep for `.collection("name")` finds only 10 — three more are reached through module constants, which is easy to miss:

- `evaluations` → `STORE` in [evaluationStore.js:8](src/stores/evaluationStore.js#L8)
- `app_settings` → `STORE` in [settingsStore.js:6](src/stores/settingsStore.js#L6)
- `report_delivery_runs` → `STORE` in [deliveryRunStore.js:6](src/stores/deliveryRunStore.js#L6)
- `password_resets` → `RESET_COLLECTION` in [passwordResetService.js:4](src/services/passwordResetService.js#L4)

Usage counts below are from direct `.collection("name")` calls:

| Collection             | Uses         | Indexes | Notes                                                                |
| ---------------------- | ------------ | ------- | -------------------------------------------------------------------- |
| `attendance`           | 84           | 7       | Busiest collection                                                   |
| `instructors`          | 50           | 4       |                                                                      |
| `users`                | 39           | 2       |                                                                      |
| `colleges`             | 26           | 2       |                                                                      |
| `evaluation_jobs`      | 22           | 5       | Job queue                                                            |
| `notification_jobs`    | 18           | 5       | Job queue                                                            |
| `boas`                 | 13           | 2       |                                                                      |
| `mail_jobs`            | 8            | 3       | Job queue                                                            |
| `storage_cleanup_jobs` | 6            | 1       | Job queue                                                            |
| `evaluations`          | 2 (+ store)  | 2       | **Migrating**                                                        |
| `password_resets`      | via constant | 3       | [passwordResetService.js:4](src/services/passwordResetService.js#L4) |
| `app_settings`         | via store    | **0**   | **Migrating**                                                        |
| `report_delivery_runs` | via store    | **0**   | **Migrating**                                                        |

### Full index list

**users (2)** — `email_1` (unique), `unique_user_email_casefold` (unique + collation en/2)
**password_resets (3)** — `email_1` (unique), `token_hash_1` (unique), `expires_at_1` (**TTL**)
**boas (2)** — `employee_id_1` (unique), `college_id_1`
**instructors (4)** — `employee_id_string_unique` (unique, partial), `report_token_unique` (unique, partial), `instructor_user_id_unique` (unique, partial), `college_id_1_deleted_at_1_name_1`
**colleges (2)** — `name_1_location_1` (unique), `unique_college_name_location_casefold` (unique + collation)
**attendance (7)** — `instructor_id_1_check_in_time_-1`, `one_attendance_per_day` (unique, partial), `date_-1`, `college_id_1_date_-1`, and 3 sparse outbox indexes (`pending_evaluation_outbox`, `pending_checkin_outbox`, `pending_checkout_outbox`)
**evaluations (2)** — `attendance_id_1_kind_1` (unique), `processed_at_-1`
**evaluation_jobs (5)** — 4 status-combo indexes + `expires_at_1` (**TTL**)
**notification_jobs (5)** — 4 status-combo indexes + `expires_at_1` (**TTL**)
**mail_jobs (3)** — 2 status-combo indexes + `expires_at_1` (**TTL**)
**storage_cleanup_jobs (1)** — `status_1_available_at_1_created_at_1`

### Queries that run with no index to help them

The 36 indexes are well chosen for the queries they cover, but several hot paths query fields that **no index starts with**. These are full collection scans. Ranked by impact:

**1. Orphan photo scan — two scans per S3 object.** [storageCleanupWorker.js:72-75](src/services/storageCleanupWorker.js#L72-L75) runs, inside a loop over every S3 object:

```js
db.collection("attendance").findOne(
  {
    $or: [
      { check_in_photo_key: object.key },
      { check_out_photo_key: object.key },
    ],
  },
  { projection: { _id: 1 } },
);
```

Neither photo-key field is indexed, and the `$or` means both branches scan. This runs against the **84-use `attendance` collection**, once per object in the bucket.
_Fix:_ index `check_in_photo_key` and `check_out_photo_key` (sparse).

**2. Job cleanup on attendance delete — three scans.** [attendanceRoutes.js:212-216](src/routes/attendanceRoutes.js#L212-L216) deletes by `attendance_id` from all three job queues in parallel. **`attendance_id` is not indexed on any of them** — every queue index starts with `status`.
_Fix:_ add `{attendance_id: 1}` to `evaluation_jobs`, `notification_jobs`, `mail_jobs`.

**3. `distinct` on an unindexed range.** [reportRoutes.js:349-351](src/routes/reportRoutes.js#L349-L351) — `distinct("instructor_id", { check_in_time: {$gte, $lte} })`. `check_in_time` is only the _second_ key of `{instructor_id, check_in_time}`, so it cannot lead. This also returns an unbounded array, which risks the 16 MB BSON limit as data grows.

**4. Incremental client sync.** [attendanceRoutes.js:1604](src/routes/attendanceRoutes.js#L1604) filters `{ updated_at: {$gt: updatedSince} }` and sorts by `{check_in_time: -1, _id: -1}`. **`updated_at` has no index at all**, and the sort doesn't match `{date:-1}` either, so this needs an in-memory sort.

**5. Open check-in filter.** [openCheckIns.js:6-21](src/services/openCheckIns.js#L6-L21) leads with `check_out_time` and `checkout_status`, neither indexed. This filter also drives a `countDocuments` at [reportRoutes.js:540](src/routes/reportRoutes.js#L540).

**6. `storage_cleanup_jobs` is under-indexed vs. its siblings.** Its claim query ([storageCleanupWorker.js:17-23](src/services/storageCleanupWorker.js#L17-L23)) needs `{status, lease_until}` for the stuck-job recovery branch, but only `{status, available_at, created_at}` is declared. It is also the **only one of the four queues without an `expires_at` TTL index**, so completed jobs are never auto-removed.

**7. `report_delivery_runs` grows forever.** No TTL index and no cleanup code anywhere — one document per report run, kept indefinitely.

Other unindexed fields: `attendance.attendance_day` standalone (used without `instructor_id` at [escalationReport.js:81](src/services/escalationReport.js#L81)), `attendance.deleting_at` (filtered on nearly every read), `users.reference_id` + `users.role` ([adminRoutes.js:162](src/routes/adminRoutes.js#L162), [:759](src/routes/adminRoutes.js#L759)), `instructors.email` and `instructors.source` ([instructorImport.js:257](src/services/instructorImport.js#L257), [instructorSync.js:299](src/services/instructorSync.js#L299)).

> **Why this matters for the migration:** these gaps are _survivable_ in MongoDB because it can always fall back to a scan. **DynamoDB cannot.** Every one of these query shapes would need a GSI before its collection could move — and no GSIs exist yet.

### Advanced MongoDB features in use

These all need redesign for DynamoDB:

| Feature                                     | Where                                                                  | DynamoDB equivalent                         |
| ------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------- |
| **TTL indexes (4)**                         | `password_resets`, `evaluation_jobs`, `notification_jobs`, `mail_jobs` | TTL attribute — **not configured**          |
| **Partial indexes (4)**                     | `instructors` ×3, `attendance` ×1                                      | Sparse GSI — none exist                     |
| **Collation / case-insensitive unique (2)** | `users`, `colleges`                                                    | No equivalent; must store a lowercase field |
| **Sparse indexes (3)**                      | `attendance` outboxes                                                  | Sparse GSI — none exist                     |
| **Unique constraints (9)**                  | across 5 collections                                                   | Only enforceable via the primary key        |
| **Aggregation pipelines (6)**               | `evaluations`, `attendance` ×4, `instructors`                          | Hand-written JS (one already done, see §5)  |
| **`countDocuments`**                        | [workerHealth.js:157-161](src/services/workerHealth.js#L157-L161)      | No cheap count in DynamoDB                  |
| **Sorted `findOne`**                        | [workerHealth.js:146-155](src/services/workerHealth.js#L146-L155)      | Needs a GSI with a sort key                 |
| **Transactions**                            | 6 files                                                                | Not used                                    |

**One piece of genuinely good news for the migration:** there are **zero `$lookup`, `$graphLookup` or `$unionWith` stages** anywhere in the codebase. Every join is already done in application code using `idMatch` plus an in-memory `Map` (for example [attendanceRoutes.js:1620-1637](src/routes/attendanceRoutes.js#L1620-L1637), [dailyReport.js:336-352](src/services/dailyReport.js#L336-L352)). Since DynamoDB has no joins at all, this removes what is normally one of the hardest parts of such a migration.

> **Note on unique indexes:** DynamoDB can only guarantee uniqueness on the primary key. The 9 unique indexes in MongoDB (emails, employee IDs, report tokens, college name+location) have **no clean DynamoDB equivalent** and need either separate lookup tables or a conditional-write pattern.

### Data integrity tooling (MongoDB only)

`auditDatabasePreflight` ([databasePreflight.js:497-771](src/config/databasePreflight.js#L497-L771)) is a genuinely good safety net. It runs 14 checks for bad data **before** creating unique indexes — invalid emails, duplicate employee IDs, orphaned references, attendance collisions. Index creation is blocked unless the data is clean, and requires an explicit `DATABASE_PREFLIGHT_APPLY=CREATE_INDEXES` confirmation ([databasePreflight.js:790-794](src/config/databasePreflight.js#L790-L794)).

**There is no DynamoDB equivalent of this audit.**

---

## 4. DynamoDB connection

All in [src/config/dynamo.js](src/config/dynamo.js).

### Scope — only 3 stores

```js
export const DYNAMO_STORES = Object.freeze([
  "app_settings",
  "report_delivery_runs",
  "evaluations",
]);
```

[src/config/dynamo.js:4](src/config/dynamo.js#L4)

Any other collection skips DynamoDB entirely and goes straight to Mongo ([dynamo.js:21](src/config/dynamo.js#L21)). So `attendance`, `instructors`, `users` and the rest are **not touched** by the migration yet.

### How it connects

```js
return new DynamoDBClient({
  region: config.region || "ap-south-1",
  ...(config.endpoint ? { endpoint: config.endpoint } : {}),
  credentials,
  maxAttempts: 3,
});
```

[src/config/dynamo.js:88-93](src/config/dynamo.js#L88-L93)

- Singleton document client, created on first use ([dynamo.js:96-103](src/config/dynamo.js#L96-L103))
- `marshallOptions: { removeUndefinedValues: true }` ([dynamo.js:99](src/config/dynamo.js#L99))
- `setDynamoDocumentClient()` exists so tests can inject a fake ([dynamo.js:105-107](src/config/dynamo.js#L105-L107))

**Good security decision:** it refuses to fall back to ambient or SES credentials. It throws unless dedicated DynamoDB keys (or a local endpoint) are present ([dynamo.js:83-86](src/config/dynamo.js#L83-L86)):

```
"DYNAMODB_ACCESS_KEY_ID and DYNAMODB_SECRET_ACCESS_KEY must both be set
 (the SES key is never used for DynamoDB)"
```

### Table schemas — primary keys only

[src/stores/dynamoTables.js:9-35](src/stores/dynamoTables.js#L9-L35)

| Table                               | Partition key       | Sort key   |
| ----------------------------------- | ------------------- | ---------- |
| `facultytrack-app_settings`         | `_id` (S)           | —          |
| `facultytrack-report_delivery_runs` | `_id` (S)           | —          |
| `facultytrack-evaluations`          | `attendance_id` (S) | `kind` (S) |

Table creation settings ([dynamoTables.js:104-111](src/stores/dynamoTables.js#L104-L111)):

- `BillingMode: "PAY_PER_REQUEST"` — on-demand, no capacity planning
- `DeletionProtectionEnabled: true` when protecting
- Tag `app=facultytrack`
- Point-in-time recovery enabled afterwards, with retry backoff ([dynamoTables.js:52-66](src/stores/dynamoTables.js#L52-L66))

> ⚠️ **No secondary indexes and no TTL.** A grep for `GlobalSecondaryIndex`, `LocalSecondaryIndex`, `TimeToLiveSpecification` and `StreamSpecification` across all non-`node_modules` JS returns **zero hits**. The only match in that family is `BillingMode` at [dynamoTables.js:106](src/stores/dynamoTables.js#L106).
>
> This is consistent — `QueryCommand` is also used nowhere, because there is nothing to query. Every DynamoDB access is a key lookup.

**`evaluations` cannot fully cut over because of this.** MongoDB has `processed_at_-1` ([databasePreflight.js:16-20](src/config/databasePreflight.js#L16-L20)), used for the 90-day audit query ([databasePreflight.js:483-486](src/config/databasePreflight.js#L483-L486)). DynamoDB has no index on `processed_at`, so that query is MongoDB-only.

### Routing — how reads and writes are directed

`dataRoute()` ([dynamo.js:20-31](src/config/dynamo.js#L20-L31)) reads env vars, per store or globally:

- `DB_WRITE_TO` / `DB_WRITE_TO_<STORE>` → `mongo` | `both` | `dynamo`
- `DB_READ_FROM` / `DB_READ_FROM_<STORE>` → `mongo` | `dynamo`
- Default for both is `"mongo"` ([dynamo.js:12](src/config/dynamo.js#L12))

It correctly rejects two nonsense combinations ([dynamo.js:24-29](src/config/dynamo.js#L24-L29)): reading from Dynamo while writing only to Mongo, and the reverse. This gives a safe 4-step path: `mongo/mongo` → `both/mongo` → `both/dynamo` → `dynamo/dynamo`.

### Dual-write — and its weak spot

```js
const result = await primary();
try {
  await shadow();
} catch (error) {
  incrementMetric(`shadow_write_failed_${shadowName}`);
  console.error(JSON.stringify({ event: "shadow_write_failed", ... }));
}
return result;
```

[src/stores/routing.js:9-26](src/stores/routing.js#L9-L26)

The read source becomes the primary; the other database is the shadow.

> ⚠️ **Shadow failures are swallowed.** There is no retry, no queue, and no error raised. If DynamoDB is down for an hour while on `both`, every write succeeds in Mongo and is **lost** in Dynamo, and the two databases drift apart permanently. The only way to find out is to run `npm run dynamo:compare` by hand. The counter is exposed at `/health/metrics`, but that route is behind `requireCronSecret` ([server.js:112](server.js#L112)), so nothing alerts automatically.

---

## 5. Side-by-side comparison

### Connection handling

| Aspect              | MongoDB                                                    | DynamoDB                                                    |
| ------------------- | ---------------------------------------------------------- | ----------------------------------------------------------- |
| Client              | Pooled, 20 max ([db.js:45](src/config/db.js#L45))          | HTTPS singleton, no pool setting                            |
| Connect step        | Explicit `connect()` + `ping`                              | None; lazy on first call                                    |
| Retries             | `retryWrites: true`                                        | `maxAttempts: 3` ([dynamo.js:92](src/config/dynamo.js#L92)) |
| Timeouts            | 4 settings tuned                                           | SDK defaults only                                           |
| Credentials         | In the URI                                                 | Separate dedicated keys                                     |
| Verified at startup | **Yes** — ping + 36 indexes                                | **No** — config strings only                                |
| In `/health/ready`  | **Yes** ([server.js:115](server.js#L115))                  | **No**                                                      |
| Clean shutdown      | `closeMongoConnection()` ([server.js:340](server.js#L340)) | Never closed                                                |

### Startup checks — the clearest gap

MongoDB is checked hard; DynamoDB is barely checked.

What runs at startup ([server.js:303-308](server.js#L303-L308), [worker.js:10-14](worker.js#L10-L14)):

1. `validateEnvironment()` → `dynamoConfigurationErrors()` ([env.js:127-128](src/config/env.js#L127-L128)) — this **does** validate DynamoDB region, credentials and prefix, and throws on bad values ([dynamo.js:48-68](src/config/dynamo.js#L48-L68))
2. `connectToMongo()` — full connect, ping, index verification
3. `if (!db) throw new Error("MongoDB is required to start the API")` ([server.js:306](server.js#L306))

What does **not** run: `ensureDynamoTables` is only ever called from [scripts/dynamodb-tables.js:15](scripts/dynamodb-tables.js#L15) and from tests. **Neither `server.js` nor `worker.js` imports anything from `dynamoTables.js`.**

So DynamoDB config _shape_ is validated, but there is **no network call, no credential check, and no table probe**. A missing or misnamed table only shows up as a runtime `ResourceNotFoundException` — and on `both` with Mongo primary, `routing.js` swallows it into a log line and the request still returns success.

### Health check

`readinessStatus()` ([server.js:114-140](server.js#L114-L140)) checks exactly three things: Mongo ping, photo storage, worker liveness. DynamoDB is absent.

> ⚠️ With `DB_READ_FROM=dynamo`, a completely broken DynamoDB still returns `200 {"ready": true}`.

### Query patterns

| MongoDB                         | DynamoDB                                      | Where                                                                 |
| ------------------------------- | --------------------------------------------- | --------------------------------------------------------------------- |
| `findOne({_id})`                | `GetCommand` + `ConsistentRead: true`         | [settingsStore.js:15-21](src/stores/settingsStore.js#L15-L21)         |
| `updateOne(..., {upsert:true})` | `UpdateCommand` with `if_not_exists()`        | [dynamoItems.js:49-53](src/stores/dynamoItems.js#L49-L53)             |
| `$set`                          | `SET #f = :v`                                 | [dynamoItems.js:45-48](src/stores/dynamoItems.js#L45-L48)             |
| `$setOnInsert`                  | `SET #f = if_not_exists(#f, :v)`              | [dynamoItems.js:52](src/stores/dynamoItems.js#L52)                    |
| `$inc`                          | `ADD #f :one` + `attribute_exists` guard      | [deliveryRunStore.js:76-85](src/stores/deliveryRunStore.js#L76-L85)   |
| `$addToSet`                     | `list_append` + condition, with fallback      | [settingsStore.js:54-73](src/stores/settingsStore.js#L54-L73)         |
| `$pull`                         | read → `REMOVE list[i]`, retry up to 5×       | [settingsStore.js:83-117](src/stores/settingsStore.js#L83-L117)       |
| `$expr: {$gte:[...]}`           | `ConditionExpression: "#terminal >= #queued"` | [deliveryRunStore.js:43-52](src/stores/deliveryRunStore.js#L43-L52)   |
| `find({_id: {$in: [...]}})`     | `BatchGetCommand`, 100 keys/call              | [evaluationStore.js:99](src/stores/evaluationStore.js#L99)            |
| 5-stage aggregation             | Hand-written JS flatMap                       | [evaluationStore.js:144-153](src/stores/evaluationStore.js#L144-L153) |

All DynamoDB reads use `ConsistentRead: true`, which matches MongoDB's read-your-own-write behaviour. Good choice.

### Semantic differences worth knowing

**1. `$addToSet` / `$pull` are sets in Mongo, ordered lists in Dynamo.** The Dynamo version emulates them with `list_append` plus a read-modify-write loop that retries 5 times and then throws ([settingsStore.js:116](src/stores/settingsStore.js#L116)). Element order can differ between the two databases, so `dynamo:compare` could report a difference even when the logical content matches.

**2. Legacy `kind` handling differs.** Mongo's check-in filter is `kind: {$ne: "checkout"}` ([evaluationStore.js:25-29](src/stores/evaluationStore.js#L25-L29)) — so a missing or null `kind` counts as a check-in. DynamoDB requires a literal `"checkin"` sort-key value. The startup migration backfills old documents ([databasePreflight.js:300-303](src/config/databasePreflight.js#L300-L303)), which closes the gap, but only after that migration has run.

**3. Timestamps are stored as different types.** Mongo keeps real `Date` objects; Dynamo keeps ISO strings ([dynamoItems.js:4](src/stores/dynamoItems.js#L4)).

### Data conversion is lossy — verified by running it

[src/stores/dynamoItems.js](src/stores/dynamoItems.js) converts both ways. `toItem` turns `Date` → ISO string and `ObjectId` → hex string ([dynamoItems.js:3-15](src/stores/dynamoItems.js#L3-L15)). `fromItem` turns a string back into a `Date` **only if it matches a regex** ([dynamoItems.js:1](src/stores/dynamoItems.js#L1), [:18](src/stores/dynamoItems.js#L18)):

```js
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
```

I tested the actual round-trip:

```
input : { note: "2024-01-02T03:04:05.123Z"  (a plain string),
          real: new Date("2024-01-02T03:04:05.123Z") }
stored: { note: "2024-01-02T03:04:05.123Z", real: "2024-01-02T03:04:05.123Z" }
output: note → Date   ← CHANGED TYPE
        real → Date   ← correct
```

Two real consequences:

1. **Any user-supplied string shaped like an ISO-millis timestamp becomes a `Date`.** The two types are indistinguishable once stored, so the conversion has to guess, and it guesses `Date`.
2. **`ObjectId` never comes back as an `ObjectId`** — it returns as a string. This is why the Mongo path needs `idVariants()` ([evaluationStore.js:157-169](src/stores/evaluationStore.js#L157-L169)) to match both forms, while the Dynamo path just stringifies everything.

For the 3 migrated stores this is low risk today (settings and run records don't hold free-text ISO strings). It becomes a real hazard if `attendance` or `instructors` ever migrate, since those hold user-entered text.

### Migration tooling

Both halves exist and are reasonable ([src/stores/dynamoSync.js](src/stores/dynamoSync.js)):

| Command                       | What it does                                                           |
| ----------------------------- | ---------------------------------------------------------------------- |
| `npm run dynamo:tables`       | Dry run — reports missing tables and key-schema conflicts              |
| `npm run dynamo:tables:apply` | Creates tables, enables PITR + deletion protection                     |
| `npm run dynamo:copy`         | Streams Mongo → Dynamo in batches of 25, retries unprocessed items 8×  |
| `npm run dynamo:compare`      | Loads both sides, reports `onlyInMongo` / `onlyInDynamo` / `different` |

Both scripts default to **read-only** and need `--apply` to change anything — a good default.

> ⚠️ **`compare` will not scale to `evaluations`.** It loads the entire Mongo collection _and_ does a full-table `ScanCommand` ([dynamoSync.js:36-45](src/stores/dynamoSync.js#L36-L45)), holding both in memory as `Map`s ([dynamoSync.js:55-78](src/stores/dynamoSync.js#L55-L78)). `evaluations` grows by one item per attendance per kind, forever. The verification tool is likely to be the first thing that breaks during the `evaluations` cutover. Results are also capped at 50 examples ([dynamoSync.js:6](src/stores/dynamoSync.js#L6)).

This `ScanCommand` is the **only** Scan in the codebase, and it is CLI-only — never on a request path. That is correct design.

---

## 6. Current live state

From the local `.env`:

```
NODE_ENV="development"
MONGODB_URI=mongodb+srv://...        (a shared Atlas cluster)
DYNAMODB_REGION=ap-south-1
DYNAMODB_ACCESS_KEY_ID=AKIA...
DYNAMODB_SECRET_ACCESS_KEY=...
DB_WRITE_TO_APP_SETTINGS=both
```

| Store                   | Write   | Read    | Status                                 |
| ----------------------- | ------- | ------- | -------------------------------------- |
| `app_settings`          | `both`  | `mongo` | Dual-writing, Mongo is source of truth |
| `report_delivery_runs`  | `mongo` | `mongo` | Not started                            |
| `evaluations`           | `mongo` | `mongo` | Not started                            |
| the other 8 collections | `mongo` | `mongo` | No DynamoDB path exists                |

`DB_READ_FROM` is unset, so it defaults to `mongo` ([dynamo.js:12](src/config/dynamo.js#L12)). This is **step 2 of 4** on the safe migration path, for **1 of 3** prepared stores.

In `.env.example` all DynamoDB lines are commented out ([.env.example:22-33](.env.example#L22-L33)), so a fresh checkout is Mongo-only. There is no `deploy/` or `.github/` directory inside `grooming_api_node`, and `docker-compose.yml` sets no DB routing vars — so **nothing configures DynamoDB in any committed deployment config.**

### Why `app_settings` was a smart first choice

`app_settings` holds only a handful of singleton config documents — `config_settings`, `access_settings`, `notification_settings`, `rp_recipients`, `instructor_sync`, `institute_sync`, and the daily-report settings id. It has **zero declared Mongo indexes**, so a plain `_id` partition key is a perfect match. `report_delivery_runs` is the same shape. Both are tiny, low-traffic, and need no secondary indexes — the easiest possible starting point.

---

## 7. Issues found, by priority

### High

**1. DynamoDB is invisible to health checks.**
`readinessStatus()` ([server.js:114-140](server.js#L114-L140)) never touches DynamoDB. With `DB_READ_FROM=dynamo`, a dead DynamoDB still reports `ready: true` and the load balancer keeps sending traffic.
_Fix:_ add a cheap `GetCommand` on a known key to the readiness check, but only for stores whose route actually uses DynamoDB.

**2. Nothing verifies tables exist at startup.**
`ensureDynamoTables` is never called by `server.js` or `worker.js`. A typo in `DYNAMODB_TABLE_PREFIX` passes env validation and fails silently at runtime.
_Fix:_ call `ensureDynamoTables(..., { apply: false })` at boot when any store uses DynamoDB, and fail fast on missing tables.

**3. Lost shadow writes are silent and unrecoverable.**
[routing.js:14-25](src/stores/routing.js#L14-L25) logs and moves on. No retry, no dead-letter queue. The databases can drift apart indefinitely during any DynamoDB outage.
_Fix:_ at minimum, alert on the `shadow_write_failed_*` metric. Better: persist failed shadow writes to a retry queue — the codebase already has 4 job-queue collections to copy the pattern from.

**4. Local development writes to a shared cluster.**
`NODE_ENV=development` + an Atlas URI means the non-production branch at [db.js:79-81](src/config/db.js#L79-L81) **auto-creates indexes**, and [databasePreflight.js:300-303](src/config/databasePreflight.js#L300-L303) **rewrites documents**, on that shared cluster.
_Fix:_ point local development at a local MongoDB, or gate auto-apply on the host being localhost rather than on `NODE_ENV`.

**5. Rotate the credentials in `.env`.**
`.env` holds a live AWS access key ([.env:36-37](.env#L36-L37)) and an Atlas username/password in the URI ([.env:3](.env#L3)). `.gitignore` does exclude `.env` and `.env.*` while keeping `.env.example` ([.gitignore:3-5](.gitignore#L3-L5)), and this directory is **not** a git repository — so these are almost certainly **not committed**. Still, plaintext long-lived keys on a developer machine are worth rotating and moving to a secrets manager.

### Medium

**6. MongoDB index gaps on hot paths.** (full detail in §3)

- `attendance.check_in_photo_key` / `check_out_photo_key` — two unindexed scans **per S3 object** in the orphan scan ([storageCleanupWorker.js:72](src/services/storageCleanupWorker.js#L72))
- `attendance_id` unindexed on all three job queues — three scans per attendance delete ([attendanceRoutes.js:212-216](src/routes/attendanceRoutes.js#L212-L216))
- `attendance.updated_at` — no index, used by the client incremental-sync endpoint ([attendanceRoutes.js:1604](src/routes/attendanceRoutes.js#L1604))
- `storage_cleanup_jobs` missing `{status, lease_until}` and an `expires_at` TTL that its three sibling queues all have
- `report_delivery_runs` has no TTL and no cleanup code — grows forever

These are worth fixing on MongoDB regardless of the migration, and each one also marks a GSI that DynamoDB will need later.

**7. No TTL on any DynamoDB table.**
MongoDB has 4 TTL indexes that auto-delete expired rows (`password_resets`, `evaluation_jobs`, `notification_jobs`, `mail_jobs`). None of those 4 collections is migrated yet, so **nothing is being lost today** — but `evaluations` and `report_delivery_runs` both grow without bound and have no retention story on the DynamoDB side.

**8. `evaluations` cannot cut over without a GSI.**
The `processed_at_-1` audit query ([databasePreflight.js:483-486](src/config/databasePreflight.js#L483-L486)) has no DynamoDB equivalent. A GSI on `processed_at` is required first.

**9. `BatchGetCommand` is exactly at the hard limit.**
[evaluationStore.js:95-96](src/stores/evaluationStore.js#L95-L96) uses 50 ids × 2 kinds = **100 keys**, and DynamoDB's `BatchGetItem` limit is 100. There is zero headroom — adding a third `kind` would break it immediately.
_Fix:_ lower `BATCH_SESSIONS` to 40, or derive it as `100 / KINDS.length`.

**10. Missing null guard in `saveEvaluation`.**
[evaluationStore.js:53-55](src/stores/evaluationStore.js#L53-L55) passes `upsertCommandInput(...)` straight into `new UpdateCommand(...)`. That function returns `null` when there are no fields to set ([dynamoItems.js:63](src/stores/dynamoItems.js#L63)). Both sibling stores guard it — [settingsStore.js:29](src/stores/settingsStore.js#L29) and [deliveryRunStore.js:35](src/stores/deliveryRunStore.js#L35) use `if (input)`. This one does not.

**11. Lossy type conversion.**
See §5. ISO-millis-shaped strings become `Date`s; `ObjectId`s become strings. Low risk for the current 3 stores, high risk for `attendance` / `instructors`.

### Low

**12. DynamoDB client is never closed on shutdown.** `closeMongoConnection()` is called ([server.js:340](server.js#L340)); there is no DynamoDB equivalent. Harmless for HTTPS, but inconsistent.
**13. No data-integrity audit for DynamoDB.** The 14-check `auditDatabasePreflight` has no counterpart.
**14. Region silently defaults to `ap-south-1`** at [dynamo.js:89](src/config/dynamo.js#L89), even though `dynamoConfigurationErrors()` requires the var — a confusing double default.
**15. `compare` reports only 50 examples** ([dynamoSync.js:6](src/stores/dynamoSync.js#L6)), which may hide the scale of a drift.

---

## 8. What the migration still needs

Only the **3 easiest** of 13 collections have a DynamoDB path, and those 3 need no secondary indexes. The hard work is untouched. Before the big collections (`attendance`, `instructors`, `users`) can move, these need designs that do not exist yet:

| Capability                  | Used in MongoDB                            | DynamoDB plan                |
| --------------------------- | ------------------------------------------ | ---------------------------- |
| Multi-document transactions | 12 places, 6 files                         | **None** — biggest blocker   |
| Unique constraints          | 9 indexes                                  | **None** beyond primary keys |
| Case-insensitive uniqueness | `users`, `colleges`                        | **None**                     |
| Partial / sparse indexes    | 7 indexes                                  | **None**                     |
| TTL auto-expiry             | 4 collections                              | **None**                     |
| Range queries + sorting     | `attendance` by date, job queues by status | **None** — no GSIs exist     |
| Aggregation                 | dashboard stats, reports                   | Partly hand-written          |
| `countDocuments`            | worker health                              | **None**                     |

### Suggested order

1. Add DynamoDB to readiness checks and startup table verification _(fixes #1, #2)_
2. Alert on, and retry, failed shadow writes _(fixes #3)_
3. Fix the small code issues: batch limit, null guard _(fixes #9, #10)_
4. Finish `app_settings`: `both/dynamo` → `dynamo/dynamo`, verifying with `dynamo:compare` at each step
5. Migrate `report_delivery_runs` the same way
6. Before `evaluations`: add a `processed_at` GSI, decide TTL/retention, and replace `compare`'s in-memory diff with a streaming one _(fixes #7, #8)_
7. Only then design the hard problems above for the remaining 8 collections

---

## 9. Verdict

**The MongoDB setup is solid and carefully built.** Connection pooling is tuned, TLS is enforced in production, 36 indexes are declared in code and verified at startup, production refuses to start with missing indexes, and the 14-check preflight audit before creating unique indexes is better than most codebases have.

**The DynamoDB setup is a well-designed but early skeleton.** The parts that exist are good: per-store routing with safe step-by-step states, incoherent-config rejection, dedicated credentials that refuse to reuse the SES key, consistent reads, on-demand billing, PITR and deletion protection, and working copy/compare tooling that defaults to read-only.

**The three real gaps are operational, not structural:** DynamoDB is absent from health checks, table existence is never verified at boot, and failed shadow writes vanish silently. All three share one shape — _when DynamoDB breaks, nobody finds out_. They are worth closing before the next store cuts over, because they are cheap now and get expensive once DynamoDB becomes a read source.

The migration is roughly **under 25% prepared by collection count** (3 of 13 have a code path, and only 1 of those 3 is actually switched on). The remaining collections carry every MongoDB feature DynamoDB does not natively provide — transactions, unique constraints, TTL, and range queries.
