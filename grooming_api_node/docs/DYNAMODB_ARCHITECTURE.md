# DynamoDB Architecture & Migration Design

**Project:** nxtGroom-v2 / `grooming_api_node`
**Date:** 2026-10-05
**Status:** Design — approved scope is consolidation onto one branch, MongoDB stays live throughout.

---

## 1. Goal and hard constraints

**Goal:** one branch holding all DynamoDB work, with MongoDB fully working until the DynamoDB setup is complete.

Three constraints shape every decision below:

1. **MongoDB must keep working.** Nothing is removed. Every collection can be switched back to MongoDB with an environment variable and a restart.
2. **One branch, no conflicts.** All DynamoDB work lands on a single branch cut from today's `main`.
3. **Routes and workers keep their MongoDB-shaped code.** Rewriting 84 `attendance` call sites by hand is where migrations go wrong. Instead, DynamoDB hides behind an object that answers the same calls as `db.collection(...)`.

---

## 2. What already exists (verified, not assumed)

Before designing anything new I checked all four DynamoDB branches by running the code.

| Branch | Ahead of `main` | Verdict |
|---|---|---|
| `feat/dynamodb-foundation` | 0 | Already merged into `main` |
| `feat/dynamodb-evaluations-runs` | 0 | Already merged into `main` |
| `docs/dynamodb-migration-plan` | 3 | Docs only |
| **`feat/dynamodb-job-queues`** | **7** | **Holds the entire unmerged engine** |

`main` already has, merged and live: the DynamoDB client and per-store routing (`src/config/dynamo.js`), dual-write routing (`src/stores/routing.js`), the item converter (`dynamoItems.js`), table setup (`dynamoTables.js`), copy/compare tooling (`dynamoSync.js`), and 3 stores — `app_settings`, `report_delivery_runs`, `evaluations`.

`feat/dynamodb-job-queues` adds **7 engine files that do not exist on `main` at all**:

| File | Lines | Job |
|---|---|---|
| `dynamoFilter.js` | 181 | Reads MongoDB filters — `$or`, `$in`, `$gte`, `$type`, `$exists` |
| `dynamoUpdate.js` | 130 | Applies `$set`, `$inc`, `$addToSet`, `$pull`, `$setOnInsert` in JS |
| `dynamoCollection.js` | 311 | Makes a DynamoDB table answer `db.collection()` calls |
| `dynamoDocuments.js` | 547 | Transactions, optimistic locking, unique-key reservations |
| `dynamoTransaction.js` | 127 | `withDynamoTransaction`, mirroring `withMongoTransaction` |
| `jobStore.js` | 177 | The 4 job queues |
| `coreStore.js` | 456 | The 6 transactional collections + their index plans |

### Verification I ran

| Check | Result |
|---|---|
| Syntax of all 7 files on `main` | Pass |
| All 8 modules import on `main` | Pass — every dependency already exists |
| `dynamo-core-plans.test.js` on `main` | **12/12 pass** |
| `dynamo-documents.test.js` with DynamoDB Local | **17/17 pass** |
| `dynamo-job-queues.test.js` | 0/11 — needs the table definitions |
| `dynamo-core-store.test.js` | 0/10 — needs the route registration |

The last two failures are **expected and benign**: `ResourceNotFoundException` because `main`'s `dynamoTables.js` has no job-queue or core tables yet, and `coreCollection` returns `withMongoTransaction` because `main`'s `dynamo.js` does not list those stores. Both are config edits, not engine bugs.

**Conclusion: do not redesign.** The engine is sound and already solves every hard problem — and the 17 passing transaction tests prove the riskiest part works against real DynamoDB. The work is consolidation and hardening, not reinvention.

---

## 3. Why a plain cherry-pick does not work

`feat/dynamodb-job-queues` branched from `main` on 29 Sep. `main` has moved **84 commits** since. I tested cherry-picking all 6 DynamoDB commits onto today's `main`:

| Commit | Result |
|---|---|
| Add a DynamoDB table that answers MongoDB collection calls | CLEAN |
| Put the four job queues behind stores | **CONFLICT** — 5 files |
| Add DynamoDB documents with transactions and unique indexes | **CONFLICT** — 2 files |
| Plan a DynamoDB index for every core collection query | CLEAN |
| Put the six transactional collections behind stores | **CONFLICT** — 16 files |
| Document switching the job queues | CLEAN |

The conflicts are **not** in the engine. They are in call-site files (`attendanceRoutes.js`, `evaluationWorker.js`, `notificationWorker.js`, `mailWorker.js`, `storageCleanupWorker.js`, `server.js`) that `main` rewrote heavily — plus the branch carries ~300 unrelated frontend file changes caused by its stale merge base.

### The strategy: layer, don't merge

Because the 7 engine files **do not exist on `main`**, they cannot conflict. So:

1. Copy the 7 engine files verbatim — zero conflict risk, already proven to import and pass tests.
2. Re-apply the small config edits **by hand** onto `main`'s current code.
3. Re-point the call sites **by hand**, against `main`'s versions rather than September's.

This takes the proven engine and discards the stale merge noise.

---

## 4. The architecture

### 4.1 Core idea — a MongoDB-shaped facade

```
   Routes and workers  (unchanged MongoDB-shaped code)
            │
            │  db.collection("attendance").findOne({ ... })
            ▼
   ┌──────────────────────────────────────────┐
   │  coreCollection / jobCollection          │   ← reads DB_WRITE_TO_*
   └──────────────────────────────────────────┘
            │                        │
     mongo  │                        │  dynamo
            ▼                        ▼
   db.collection(name)        dynamoCollection(name)
   (real MongoDB)             findOne/find/updateOne/
                              deleteMany/countDocuments/
                              aggregate/distinct/bulkWrite
```

One switch per group decides which side runs. The calling code never changes.

### 4.2 Store groups and their switches

Grouping is driven by **transactions**: a transaction cannot span two databases, so collections that share one must migrate together.

| Group | Collections | Switch |
|---|---|---|
| Settings | `app_settings` | `DB_WRITE_TO_APP_SETTINGS` |
| Delivery runs | `report_delivery_runs` | `DB_WRITE_TO_REPORT_DELIVERY_RUNS` |
| Evaluations | `evaluations` | `DB_WRITE_TO_EVALUATIONS` |
| Job queues | `evaluation_jobs`, `notification_jobs`, `mail_jobs`, `storage_cleanup_jobs` | one switch each |
| **Core** | `colleges`, `boas`, `users`, `password_resets`, `instructors`, `attendance` | **`DB_WRITE_TO_CORE`** (all six together) |

The six core collections share transactions — creating a BOA writes college + BOA + login together; a check-in writes the instructor guard + attendance record together. They must move as one unit.

### 4.3 Each switch has four safe states

```
mongo/mongo  →  both/mongo  →  both/dynamo  →  dynamo/dynamo
 (today)        (shadow)        (verify)        (done)
```

`dataRoute()` already **rejects** the two incoherent combinations (read Dynamo but write only Mongo, and the reverse), so a half-configured store fails loudly at startup rather than silently losing writes.

### 4.4 How the hard MongoDB features are replaced

| MongoDB feature | DynamoDB design |
|---|---|
| **Transactions** | `withDynamoTransaction` collects writes, commits one `TransactWriteItems`, and checks every document the transaction read is unchanged — matching snapshot isolation. **Verified by 17 passing tests.** |
| **Unique indexes** (9) | Reservation items in a `unique_keys` table, written in the *same* transaction as the document. A clash raises `code: 11000`, so **every existing duplicate handler keeps working unchanged**. |
| **Case-insensitive unique** | The reservation key is lowercased (`lower(user.email)`). |
| **Partial indexes** | The derived key is `undefined` when the document is outside the filter, so it simply is not in the index. |
| **TTL** | `ttlAttribute: "ttl"` on the job tables, set via `UpdateTimeToLiveCommand`. |
| **Range queries + sorting** | GSIs with a partition key and a sort key, e.g. `by_instructor` keyed `instructor_key` / `checkin_at_key`. |
| **Aggregation** | Computed in JS after an indexed read. |
| **Optimistic concurrency** | A `rev` attribute per document; writes are conditional on it and retried on a lost race. |

### 4.5 Index plans — the heart of the design

Each collection declares `derive()` (the index keys a document carries), `indexes`, `plan()` (which filters an index answers), and `scanOk`.

`scanOk: false` on `attendance` means **an unplanned filter is refused rather than silently scanning millions of rows**. This is the single most important safety property: a careless query fails fast in testing instead of melting the table in production.

The plans fix exactly the problems my earlier report found:

| Report finding | Fix |
|---|---|
| Orphan photo scan: 2 unindexed scans per S3 object | `by_checkin_photo` / `by_checkout_photo` GSIs |
| `attendance_id` unindexed on 3 job queues | `by_attendance` GSI on each |
| `attendance.updated_at` unindexed | Served by `by_day` / `by_instructor` |
| Unidentified queue | Dedicated `unidentified` GSI, holding *only* unidentified rows |
| `storage_cleanup_jobs` missing `{status, lease_until}` + TTL | `active` GSI + `ttl` |
| Outbox reconcilers | 3 dedicated outbox GSIs |

Job queues use one `active` GSI holding only jobs a worker may still claim, so the thousands of finished jobs kept for a week are never read.

### 4.6 Dual-write, and one subtlety worth stating

For most stores `both` runs the write against each database. **Job queues are different**: they copy the *result*. Running "claim the oldest eligible job" twice could pick different jobs in each database and drift apart, so the queue writes once and copies the outcome. This is a genuinely good decision already in the code.

---

## 5. Known gaps this design must still close

From my earlier database report, these are **not** fixed by the existing engine:

| # | Gap | Fix |
|---|---|---|
| 1 | DynamoDB absent from `/health/ready` — a dead Dynamo still reports healthy | Probe each store that routes to Dynamo |
| 2 | Table existence never verified at startup | Call `ensureDynamoTables({ apply: false })` at boot |
| 3 | Failed shadow writes vanish — no retry, silent drift | Alert on the metric; persist failures for retry |
| 4 | `saveEvaluation` missing the null guard its siblings have | Add `if (input)` |
| 5 | `BatchGetCommand` sits exactly at the 100-key limit | Derive the chunk size from `KINDS.length` |
| 6 | `compare` loads both sides into memory | Stream it before the `evaluations` cutover |
| 7 | DynamoDB client never closed on shutdown | Destroy it alongside `closeMongoConnection()` |

---

## 6. Plan of work

Each numbered item is one commit, sequenced so the tree stays working and reviewable.

**Phase A — branch**
1. Create `feat/dynamodb-migration` from today's `main`.

**Phase B — engine (no behaviour change; nothing imports these yet)**
2. `dynamoFilter.js` — MongoDB filter reading
3. `dynamoUpdate.js` — MongoDB update operators
4. `dynamoCollection.js` — the collection facade
5. `dynamoTransaction.js` — transaction sessions
6. `dynamoDocuments.js` — transactions, locking, unique keys
7. `jobStore.js` — the 4 job queues
8. `coreStore.js` — the 6 core collections and their plans
9. Test helper for DynamoDB Local + dynalite

**Phase C — wire it up (behaviour still MongoDB by default)**
10. Register the new stores in `dynamo.js`
11. Add the job-queue tables, GSIs and TTL
12. Add the core tables, GSIs and the `unique_keys` table
13. Teach copy/compare about the new tables

**Phase D — call sites, one group at a time**
14. Job queues: workers call `jobCollection(db, name)`
15. Core: routes call `coreCollection(db, name)` and `coreTransaction(db)`

**Phase E — close the gaps from §5**
16. Verify tables at startup
17. Add DynamoDB to `/health/ready`
18. Alert and retry failed shadow writes
19. Fix the null guard and the batch limit
20. Close the DynamoDB client on shutdown

**Phase F — tests and docs**
21. Port the 4 DynamoDB test suites
22. Update `.env.example` and `DEPLOYMENT.md` with the switch-over runbook

### Default behaviour after all of this

Every switch defaults to `mongo`. With no environment changes, **the application behaves exactly as it does today** — all DynamoDB code is present, tested and dormant. That is what satisfies "keep MongoDB until the DynamoDB setup is complete".

---

## 7. Cutover order, when you choose to start

Smallest and least risky first, verifying with `npm run dynamo:compare` at each step:

1. `app_settings` — already at `both`; a handful of singleton config documents
2. `report_delivery_runs` — one document per report run
3. Job queues — self-healing by nature; a lost job is retried
4. `evaluations` — needs a retention decision and a streaming `compare` first
5. Core six — last, together, after everything above has held in production

---

## 8. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| An unplanned query on `attendance` | High | `scanOk: false` refuses it at test time |
| Silent dual-write drift | High | Gap #3 — alert and retry (Phase E) |
| Lossy type conversion (ISO-shaped strings become Dates) | Medium | Low impact for the current 3 stores; must be re-checked before the core six, which hold user-entered text |
| `compare` cannot scale to `evaluations` | Medium | Gap #6 — stream before that cutover |
| DynamoDB Local is needed for transaction tests | Low | Tests skip rather than fail without it; CI sets the variable |
| 84 commits of call-site drift | Medium | Re-apply by hand against `main` (§3), never cherry-pick |
