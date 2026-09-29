# MongoDB → DynamoDB migration plan

Status: **Phase 0 (planning).** No application code has changed.
Region: **ap-south-1 (Mumbai)**, next to the Lightsail API server.

The rule for the whole migration: **MongoDB stays the source of truth until
DynamoDB has proven itself on real traffic.** Every phase before the last can
be undone by flipping a setting back.

---

## 1. Before we start: what we gain and what it costs

| Claim | Reality for this app |
|---|---|
| "25 GB free" | True. Storage up to 25 GB is free. Throughput is not: the free *provisioned* mode allows ~25 writes/s and ~50 reads/s across **all** tables and indexes, which the 9 AM rush exceeds. We plan for **on-demand** mode (pay per request, no limit). |
| "Faster than MongoDB" | A single DynamoDB read/write takes ~2–10 ms in the same region. But the database is not what users wait for: a check-in spends 1.5–3 s in photo handling and Gemini. Users will not notice a speed difference. |
| Cost | Estimated **$4–12 / month** on-demand at ~1,000 instructors (section 9). That is similar to Atlas Flex ($8–30). The saving is small; the real gains are no M0 limits, no Atlas account, and everything in one AWS account. |
| Effort | **5–8 weeks** for one developer. The code makes ~265 database calls in ~25 files, uses 10 transactions, 13 collections, ~35 indexes, and 58 test files that fake MongoDB. |

What DynamoDB does **not** do that we use today:

- **Ask any question at any time.** MongoDB can filter and sort on any field.
  DynamoDB can only look up by a table key or by an index planned in advance.
  Every list screen needs a planned index (section 5).
- **Unique rules on a field** (one email per user, one attendance per
  instructor per day). DynamoDB only guarantees the table key is unique.
  We add small "reservation" items written in the same transaction (section 6.2).
- **`countDocuments`, `distinct`, `aggregate`, `skip`.** Replaced by counters,
  queries per key, work in Node, and cursor paging (section 6).

**Decision point:** after reading this document, the team confirms "go" or
"stay on MongoDB (upgrade M0 → Flex)". Everything below assumes "go".

---

## 2. What the code does today (inventory)

### 2.1 Collections

| Collection | What it holds | Size of one record | Grows |
|---|---|---|---|
| `attendance` | One check-in/check-out session | ~3–8 KB | ~1,000/day |
| `evaluations` | Gemini result for check-in and check-out | ~5–20 KB | ~2,000/day |
| `instructors` | Roster, face ids, report token | ~1–2 KB | slowly |
| `users` | Admin / BOA logins | <1 KB | slowly |
| `boas` | BOA staff records | <1 KB | slowly |
| `colleges` | Campuses | <1 KB | slowly |
| `password_resets` | Reset / invite tokens (TTL) | <1 KB | small |
| `app_settings` | 7 single settings documents by `_id` | <5 KB | fixed |
| `report_delivery_runs` | Weekly report / reminder run counters | <5 KB | ~10/week |
| `evaluation_jobs` | Gemini job queue | ~1–2 KB | short-lived |
| `notification_jobs` | Report email queue | ~2–5 KB | short-lived (7-day TTL) |
| `mail_jobs` | Other emails (reset, reminders, alerts) | ~1–5 KB | short-lived (7-day TTL) |
| `storage_cleanup_jobs` | R2 photo deletions | <1 KB | short-lived |

### 2.2 Features we rely on

| Feature | Where | Count |
|---|---|---|
| Transactions (`withMongoTransaction`) | create/update/delete BOA, college, instructor; guarded check-in; password reset | **10 call sites** |
| Unique indexes | user email (case-insensitive), BOA and instructor employee id, instructor `instructor_user_id` and `report_token`, college name+location (case-insensitive), one attendance per instructor per day, one evaluation per attendance+kind, reset token hash | 11 |
| TTL indexes | `password_resets`, `evaluation_jobs`, `notification_jobs`, `mail_jobs` | 4 |
| `findOneAndUpdate` (job claims, conditional checkout, counters) | workers and routes | 17 |
| `aggregate` | latest 100 feedbacks per instructor (`instructorRoutes.js:106`); face enrolment count per college (`identificationSettings.js:205`) | 2 |
| `countDocuments` | unidentified queue total, synced instructor count, close-open dry run, `/health/ready` queue depth | 5 kinds |
| `distinct` | weekly report: instructors who attended (`reportRoutes.js:364`) | 1 |
| `skip` paging | unidentified queue, daily records list, instructor roster | 3 |
| `bulkWrite` | BigQuery roster and institute sync (batches of 500) | 3 |
| `$push`, `$addToSet`, `$pull`, `$inc` | alert deliveries, report recipients, counters, guard versions | several |
| Mixed id types (`idMatch` = string **or** ObjectId) | nearly every `_id` lookup | 56 |
| Change streams, server-side time | not used | 0 |

### 2.3 Background load (why idle traffic matters)

Each of the 4 workers wakes every **2 seconds** and runs 2–8 queries even when
there is no work: evaluation 6, notification 8, mail 2, storage cleanup 2.
That is **~9 operations/second per server, all day**, plus ~3/s from
`/health/ready` (7 `findOne` + 7 `countDocuments`, cached 5 s). Atlas showed
~30 ops/s while both Northflank and Lightsail were running.

Copied to DynamoDB unchanged, the idle polling alone would be ~25 million
requests a month. Section 7 changes this **before** the move.

---

## 3. Clean-up to do first, while still on MongoDB

These make the migration simpler and are worth doing even if we stay on
MongoDB. Each is a small, separate change.

| # | Change | Why |
|---|---|---|
| C1 | Give every document a **string `_id`**. Convert existing ObjectId ids (BigQuery-synced instructors, password resets) to their hex string, and make `instructorSync.js` and `passwordResetService.js` write string ids. Then `idMatch` becomes plain equality. | DynamoDB keys are plain strings. Removes 56 two-value lookups. |
| C2 | **Backfill `attendance_day`** on old attendance rows, then drop the `check_in_time` fallback in `attendanceOnLocalDay` and `openCheckInFilter`. | Every "today" query becomes a simple key lookup. |
| C3 | **Backfill `evaluations.kind = "checkin"`** where missing, then drop `kind: {$ne: "checkout"}`. | Evaluation key becomes `attendance_id + kind`. |
| C4 | **Drain old `_private_evaluation_outbox.image` bytes** (pre-R2 legacy). | Could exceed DynamoDB's 400 KB item limit. |
| C5 | **Reduce idle polling** (section 7). | Cuts idle load by ~90% on MongoDB today and on DynamoDB later. |
| C6 | Fix **`mail_jobs` stuck in `processing`**: a job that runs out of attempts while leased is never claimed again and never expires. | Bug found during the inventory. |
| C7 | Add an index for the **orphan photo scan** (`storageCleanupWorker.js:69` looks up attendance by photo key with no index, i.e. a full scan per R2 object every 6 h). | Bug found during the inventory. |
| C8 | Store dates we will range-query as **ISO-8601 UTC strings** in the new stores (keep `Date` in MongoDB). TTL needs a separate epoch-seconds number. | DynamoDB sorts strings, has no Date type. |

---

## 4. Table design

**One DynamoDB table per MongoDB collection** (plus one table for unique
reservations). It maps one-to-one, is easy to read in the AWS console, and
lets us move one collection at a time.

All tables: on-demand capacity, point-in-time recovery on, deletion protection
on, names prefixed `facultytrack-` (e.g. `facultytrack-attendance`).

Notation: **PK** = partition key, **SK** = sort key, **GSI** = global secondary
index (a second way to look up the same table).

### 4.1 `attendance`

Table key: **PK `id`**.

| Index | PK | SK | Answers |
|---|---|---|---|
| `by_instructor` | `instructor_id` | `check_in_time` | Public weekly/day reports, escalation week count, "latest 100 feedbacks" |
| `by_day` | `attendance_day` | `check_in_time` | Admin daily records (all colleges), 8 PM reminder cron, weekly cron (who attended), midnight close-open, photo purge (walk old days) |
| `by_college_day` | `college_id` | `check_in_time` | BOA daily records (own college only) |
| `unidentified` (sparse) | `unidentified_scope` = `college_id` or `"ALL"`, set only while unidentified | `check_in_time` | Unidentified queue |
| `outbox_evaluation` (sparse) | `outbox_evaluation_pk` = `"PENDING"` | `created_at` | Evaluation outbox reconciler and health check |
| `outbox_checkin` (sparse) | same pattern | `created_at` | Check-in email outbox |
| `outbox_checkout` (sparse) | same pattern | `created_at` | Check-out email outbox |
| `by_checkin_photo` (sparse) | `check_in_photo_key` | – | Orphan photo scan |
| `by_checkout_photo` (sparse) | `check_out_photo_key` | – | Orphan photo scan |

"One attendance per instructor per day" is enforced by a reservation item
`ATTENDANCE_DAY#<instructor_id>#<YYYY-MM-DD>` (section 6.2), not by an index.

The delta refresh (`updated_at > X`) becomes a filter on the `by_day` /
`by_college_day` query; the date range already limits it to a small set.

### 4.2 `evaluations`

Table key: **PK `attendance_id`, SK `kind`** (`checkin` | `checkout`). This
key *is* the old unique index. Purge = delete both kinds for one attendance.
The 90-day audit scan moves to an offline script.

### 4.3 `instructors`

Table key: **PK `id`**.

| Index | PK | SK | Answers |
|---|---|---|---|
| `by_college` | `college_id` | `name` | BOA roster, "any instructor in this college?" before delete |
| `by_report_token` | `report_token` | – | Public report pages |
| `by_instructor_user_id` | `instructor_user_id` | – | BigQuery sync upsert |

Admin roster (all colleges, sorted by name, ≤5,000 rows): scan and sort in
Node. Small table, acceptable. Unique employee id, report token and
`instructor_user_id` use reservations.

### 4.4 `users`, `boas`, `colleges`

| Table | Key | Indexes | Uniques via reservation |
|---|---|---|---|
| `users` | PK `email` (lower-case) | `by_reference_id` (BOA → login) | none needed: email is the key |
| `boas` | PK `id` | `by_college` (`college_id`) | `employee_id` |
| `colleges` | PK `id` | `by_institute_id` | lower-case `name + location` |

`users` keyed by email: login, "who is this token?" (every request) and
forgot-password are single `GetItem` calls. Admin screens that address a user
by id use a small `by_id` index.

### 4.5 Small tables

| Table | Key | Notes |
|---|---|---|
| `password_resets` | PK `email` | index `by_token_hash`; TTL attribute `ttl` |
| `app_settings` | PK `id` (`access_settings`, `notification_settings`, …) | `emails` list for report recipients becomes a String Set (`ADD` / `DELETE` replace `$addToSet` / `$pull`) |
| `report_delivery_runs` | PK `id` | `$inc` → `ADD`; the "complete when terminal ≥ queued" rule becomes `ConditionExpression: terminal >= queued` |
| `unique_keys` | PK `key` | reservation items (section 6.2) |

### 4.6 Job tables

`evaluation_jobs`, `notification_jobs`, `mail_jobs`, `storage_cleanup_jobs`:

- Table key **PK `id`**, using the same deterministic ids as today
  (`<attendanceId>:evaluation`, `password-reset:<email>:<hash>`, …). The
  "enqueue once" guarantee becomes `PutItem` with
  `attribute_not_exists(id)`.
- Index `ready`: PK `queue_state` (`queued` / `processing` / `recovering`),
  SK `due_at` (for `queued`: `available_at`; for `processing`: `lease_until`).
  One index answers "what can I claim?" and "which leases expired?".
- Index `deadline` (sparse): PK `queue_state`, SK `deadline_at`.
- Failed jobs awaiting sync: sparse index on `failure_unsynced = "1"`.
- TTL attribute `ttl` replaces `expires_at`.
- Queue depth and oldest age for `/health/ready`: a `Select: COUNT` query on
  `ready` per state, cached 30 s.

Claiming a job (replaces `findOneAndUpdate`):

1. `Query ready` for `queue_state = queued AND due_at <= now`, `Limit` 5.
   This is a read, and costs almost nothing when the queue is empty.
2. For the oldest candidate: `UpdateItem` with
   `ConditionExpression: queue_state = :queued AND due_at <= :now`, set
   `processing`, `worker_id`, `lease_until`, `ADD attempts 1`.
3. If the condition fails, another worker won; try the next candidate.

A failed conditional update is still billed as a write, so step 1 always runs
first. Never "try to claim" blindly on an empty queue.

---

## 5. Every screen and job → which lookup serves it

| Where | Today (MongoDB) | DynamoDB |
|---|---|---|
| Every request: who is logged in | `users.findOne({email})` | `GetItem users` |
| BOA requests: which college | `boas.findOne(_id)` | `GetItem boas` |
| Kiosk check-in: today's record? | `attendanceOnLocalDay` | `GetItem unique_keys ATTENDANCE_DAY#…` → `GetItem attendance` |
| Check-in write | transaction: guard `$inc` + insert | `TransactWriteItems`: put reservation + put attendance + condition on instructor version |
| Check-out | conditional `findOneAndUpdate` | `UpdateItem` with `attribute_not_exists(check_out_time)` |
| Status poll | `findOne` + projection | `GetItem` + `ProjectionExpression` |
| Daily records, admin | `find({date range})` + sort + skip | `Query by_day` for each day in the range, merge in Node, cursor paging |
| Daily records, BOA | same + `college_id` | `Query by_college_day` with `check_in_time BETWEEN` |
| Unidentified queue | `find` + `countDocuments` + skip | `Query unidentified` + `Select: COUNT` |
| Instructor list + latest 100 feedbacks | `aggregate` with `$setWindowFields` | `Query by_instructor` with `Limit 100`, one per instructor on the page. **Too many calls for 1,000 instructors**, so we also keep a short `recent_feedback` list on each instructor, updated when an evaluation finishes. |
| Face enrolment count per college | `aggregate $group` | scan `instructors` (small), count in Node, cache 5 min |
| Public report page | `findOne({report_token})` then `find` by instructor + time | `Query by_report_token` → `Query by_instructor` |
| Weekly report cron | `distinct(instructor_id)` over the week | `Query by_day` × 7, collect ids in Node |
| 8 PM reminder cron | `find({check_in_time range, check_out_time: null})` | `Query by_day` for today, filter `check_out_time` missing |
| Midnight close-open | `updateMany(openCheckInFilter)` | `Query by_day`, then `UpdateItem` each (≤1,000) |
| Photo purge | `find({check_in_time < cutoff, has photo})` | walk `by_day` for days older than the cutoff that are not yet purged; keep a "purged up to" marker in `app_settings` |
| Orphan photo scan | `findOne({$or: photo keys})` (no index) | `Query by_checkin_photo` / `by_checkout_photo` |
| Admin lists (colleges, BOAs, admins) | `find` limit 1000 | `Scan` (tables are tiny) |
| BigQuery sync | `bulkWrite` upserts of 500 | `BatchWriteItem` (25 per call) or parallel `UpdateItem`; reservations checked per row |

---

## 6. The hard parts

### 6.1 Transactions (10 places)

DynamoDB has `TransactWriteItems`: up to 100 items, all or nothing, and each
item can carry a condition. MongoDB transactions **read then write**. DynamoDB
transactions **only write**, with conditions. Each of the 10 becomes:

1. Read what is needed (normal `GetItem`s).
2. One `TransactWriteItems` whose conditions re-check what was read (e.g.
   "college still not deleted", "instructor version is still 7").
3. If a condition fails, return the same error the code returns today (409 or
   "try again").

The `_private_*_guard_version` counters we `$inc` today to force conflicts
become a `version` attribute with `ConditionExpression: version = :seen`.
This is the same idea in DynamoDB form.

| Call site | Items in the transaction |
|---|---|
| Guarded check-in | reservation `ATTENDANCE_DAY#…` (must not exist) + attendance put + instructor version check |
| Create BOA | college check + BOA put + user put + `EMPLOYEE_ID#…` reservation |
| Update BOA | college check + BOA update + user update (+ reservation swap on email / employee id change) |
| Delete BOA | BOA update + user update |
| Update / delete college | college update + `COLLEGE#name|location` reservation swap; delete also needs "no BOA / instructor in this college", checked by query plus a college `version` condition |
| Create / update / delete instructor | college check + instructor put/update + reservations; "no open check-in today" checked on the reservation item |
| Password reset | delete reset token (must exist, same hash) + user update |

Transactional writes cost 2× a normal write. At our volume that is cents.

### 6.2 Unique rules → reservation items

Table `unique_keys`, one item per claimed value:

| Rule | Reservation key |
|---|---|
| One attendance per instructor per day | `ATTENDANCE_DAY#<instructor_id>#<day>` |
| BOA employee id | `BOA_EMPLOYEE#<employee_id>` |
| Instructor employee id | `INSTRUCTOR_EMPLOYEE#<employee_id>` |
| Instructor report token | handled by the `by_report_token` index plus a random 24-byte token (a collision is practically impossible) |
| `instructor_user_id` | `INSTRUCTOR_USER#<id>` |
| College name + location (ignoring capitals) | `COLLEGE#<lower name>|<lower location>` |

Each insert writes the reservation with `attribute_not_exists(key)` in the
same transaction. A failed condition is the new "duplicate key (11000)" and
maps to the same 409 the API returns today. Renames delete the old
reservation and put the new one in one transaction.

### 6.3 Counts, `distinct`, `skip`

- Counts: `Select: COUNT` on the relevant index, cached. Only
  `/health/ready` runs counts often, and its cache moves from 5 s to 30 s.
- `distinct`: collect ids in Node from a `by_day` query.
- `skip`/`offset` paging: replaced by a cursor (`LastEvaluatedKey`, sent to
  the browser as an opaque `next` token). **The frontend changes** for the
  unidentified queue, daily records and roster: "load more" instead of page
  numbers.

### 6.4 Eventual consistency

Index queries (GSIs) can be up to ~1 s behind. Anything that must be exact
(duplicate-day check, job claim, checkout) uses the table key or a condition,
never an index read alone. Everything designed above follows this.

### 6.5 Tests

The 58 test files build their own fake MongoDB inline, and many assert exact
Mongo filter shapes (e.g. `filter.$or[1].check_in_time.$gte`). They cannot
pass unchanged against DynamoDB. Plan:

- Phase 1 moves route tests to fake **stores** (the new layer), not fake
  MongoDB.
- Add one **contract test suite per store** that runs against both real
  MongoDB and **DynamoDB Local** (Docker). Both must pass the same tests.

---

## 7. Job polling change (do on MongoDB first, C5)

1. **Wake on enqueue.** The process that adds a job wakes the worker
   immediately. The evaluation worker already does this in-process
   (`evaluationWorker.js:33-48`); do the same for notification and mail.
2. **Idle back-off.** When a tick finds nothing, wait 2 s → 4 s → 8 s → up to
   **15 s**. Any found work resets it to 0. With `PROCESS_ROLE=all` (one
   server, workers in the same process as the API), wake-on-enqueue covers
   almost every job, and the 15 s sweep only catches retries and expired
   leases.
3. **Sweeps less often.** Deadline, expired-lease, outbox and failed-sync
   sweeps run every 60 s instead of every tick.
4. **Health counts cached 30 s** instead of 5 s.

Expected idle load: from ~9 ops/s to **<1 op/s** per server.

---

## 8. Phases

| Phase | What | Time | Undo |
|---|---|---|---|
| **0** | This document; team go / no-go | 3–4 days | – |
| **1** | Clean-up C1–C8 on MongoDB | 1 week | normal revert |
| **2** | **Store layer**: move every `db.collection(...)` call behind one module per collection (`src/stores/attendanceStore.js`, …). Behaviour unchanged. Tests move to fake stores. One collection per PR. | 1.5–2 weeks | normal revert |
| **3** | **AWS setup**: tables and indexes by script (`scripts/dynamodb-tables.js`), IAM user limited to `facultytrack-*` tables, PITR, deletion protection, DynamoDB Local in `docker-compose` for development. MongoDB untouched. | 2 days | delete tables |
| **4** | **DynamoDB stores**: a second implementation of each store. Contract tests pass on both. | 2–3 weeks | not used yet |
| **5** | **Copy data**: one-off script MongoDB → DynamoDB (read-only on MongoDB), with a count and sample check per table. | 1–2 days | re-run |
| **6** | **Dual write**: `DB_WRITE_TO=both`, `DB_READ_FROM=mongo`. A daily compare job reports differences. Run 1–2 weeks. | 1–2 weeks | set `DB_WRITE_TO=mongo` |
| **7** | **Move reads one group at a time**: settings/colleges/BOAs → users/instructors → job tables → attendance/evaluations. Watch logs for a few days after each. | 1–2 weeks | set back to `mongo` |
| **8** | **Remove MongoDB**: stop writing to it; keep it read-only 30 days with a final export; then remove the `mongodb` package, `MONGODB_URI`, `databasePreflight.js`, `idMatch`, and the MongoDB docs; close Atlas. | 2 days + 30-day wait | restore from export |

Per-collection switches (Phase 6–7), in `.env`:

```
DB_WRITE_TO=mongo|both|dynamo
DB_READ_FROM=mongo|dynamo
# optional per-store override, e.g.
DB_READ_FROM_ATTENDANCE=mongo
```

In dual-write, MongoDB is written first and is the answer the user sees. A
failed DynamoDB write is logged and fixed by the compare job; it never fails
the user's request.

**Job tables during dual write:** jobs must be claimed from one database
only. Jobs stay on MongoDB until Phase 7 moves the whole job group at once,
during a quiet hour (after 9 PM) with empty queues (`/health/ready` depth 0).

---

## 9. Cost estimate (on-demand, Mumbai)

Approximate on-demand prices (check the AWS pricing page before deciding):
~$0.71 per million write units and ~$0.14 per million read units. A write
unit covers 1 KB; a read unit covers 4 KB (half for eventually consistent
reads). Every index an item appears in costs another write when the indexed
fields change. Transactions cost double.

| Item | Per month | Cost |
|---|---|---|
| Check-in + check-out writes (attendance, evaluations, jobs, indexes, reservations): ~1,000 instructors × 2 × ~60 write units × 26 days | ~3–5 M write units | $2–4 |
| Dashboard, reports, status polls, auth lookups | ~10–20 M read units | $1.5–3 |
| Worker polling after section 7 (<1 op/s) | ~2 M read units | $0.3 |
| Storage (well under 25 GB for years) | – | $0 (free tier) |
| Point-in-time recovery (~$0.2 per GB) | 1–3 GB | $0.2–0.6 |
| **Total** | | **≈ $4–8, allow up to $12** |

Without section 7 (polling unchanged), add ~$5–10 a month.

After Phase 6 we replace this estimate with real numbers from CloudWatch
(`ConsumedReadCapacityUnits`, `ConsumedWriteCapacityUnits`).

---

## 10. AWS setup details (Phase 3)

- **Access from Lightsail.** Lightsail instances cannot use IAM roles, so
  the API uses access keys of a dedicated IAM user `facultytrack-dynamodb`.
  Do not reuse the SES/Rekognition keys. Policy: DynamoDB actions on
  `arn:aws:dynamodb:ap-south-1:<account>:table/facultytrack-*` and their
  indexes only; no `DeleteTable`.
- **New env keys:** `DYNAMODB_REGION=ap-south-1`, `DYNAMODB_TABLE_PREFIX=facultytrack-`,
  `DYNAMODB_ACCESS_KEY_ID`, `DYNAMODB_SECRET_ACCESS_KEY`,
  `DYNAMODB_ENDPOINT` (only for DynamoDB Local), `DB_WRITE_TO`, `DB_READ_FROM`.
- **Library:** `@aws-sdk/client-dynamodb` + `@aws-sdk/lib-dynamodb` (same SDK
  family already used for SES and Rekognition).
- **Backups:** point-in-time recovery (35 days) on every table; export to S3
  for yearly archives (see `COST_ESTIMATION.md`).
- **Monitoring:** CloudWatch alarms on throttled requests and system errors
  per table; a monthly budget alert at $15.

---

## 11. Risks

| Risk | Effect | Guard |
|---|---|---|
| A screen needs a query nobody planned | That screen can't be built efficiently | Section 5 lists every current query; new features must add their index first |
| Duplicate check-in on the same day | Two records for one instructor | Reservation item in the same transaction (6.2) |
| Two workers take the same job | Double Gemini call or double email | Conditional claim (4.6); deterministic ids already prevent duplicate emails |
| Dual-write drift | Databases disagree | Daily compare job; MongoDB is the source of truth until Phase 7 |
| Item over 400 KB | Write fails | C4 drains legacy image outboxes; `alert_deliveries` capped at 20 |
| Frontend paging change | Page numbers stop working | Cursor-based "load more" shipped in Phase 2 with the store layer |
| Cost higher than estimated | Bill surprise | Budget alert; section 7 done first; real numbers checked after Phase 6 |
| Tests rewritten wrongly | Hidden behaviour change | Phase 2 changes structure only; contract tests run on both databases |

---

## 12. Found during the inventory (fix regardless of the decision)

1. **`mail_jobs` can get stuck forever** (C6). A job that uses its last
   attempt while leased stays `processing`: it is never claimed, never swept,
   never expired.
2. **Orphan photo scan runs a full collection scan** for each R2 object every
   6 hours (C7).
3. **A check-out evaluation has no durable outbox.** If enqueueing it fails
   (`attendanceRoutes.js:2358-2378`), the error is only logged and the
   check-out is never evaluated.
4. **BigQuery-synced instructors and password resets still get ObjectId ids**
   (C1), which is why every lookup needs `idMatch`.
