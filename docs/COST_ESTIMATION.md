# FacultyTrack — Monthly Cost Estimation

**Setup:** AWS Lightsail $12 plan (backend) + Amazon DynamoDB (database) +
Gemini 2.5 Flash-Lite (grooming check) + AWS Rekognition (face identification) +
Cloudflare R2 (photos)
**Load:** 1,000 instructors, 1 check-in + 1 check-out photo per working day
**Assumptions given:** 50% male / 50% female · every photo is 1 MB · photos kept for 5 months
**Region:** AWS Asia Pacific (Mumbai, `ap-south-1`)
**Prices checked:** 29 September 2026 · **Exchange rate:** ₹96 = $1 (mid-market ₹95.97–₹96.04 on that day)

Every cost is given twice:

- **Expected** — what a normal month should cost.
- **Max cap** — the most the month can cost at this load. It assumes the
  longest possible month (27 working days) and that every variable is at its
  ceiling at once: every Gemini call uses its full token limit, prompt caching
  fails, and 10% of calls are billed twice. A real month will not reach it.
  If a bill does, something is wrong and should be investigated.

> Items marked *(est.)* are estimates the application can measure after
> go-live. The API exposes live token and request counters at `/health/metrics`
> (see Section 9).

---

## 1. Summary

| Service | What it does | Monthly cost (USD) | Monthly cost (INR) |
|---|---|---|---|
| AWS Lightsail ($12 plan + snapshots) | Runs the backend API and its background workers | **$13** · max $17 | **₹1,248** · max ₹1,632 |
| Amazon DynamoDB | Stores attendance, AI reports, users and job queues | **$7** · max $20 | **₹672** · max ₹1,920 |
| Google Gemini 2.5 Flash-Lite | Checks every check-in and check-out photo against the grooming standards | **$106** · max $355 | **₹10,176** · max ₹34,080 |
| AWS Rekognition | Identifies the instructor from their face in every photo | **$80** · max $108 | **₹7,680** · max ₹10,368 |
| Cloudflare R2 | Stores the photos for 5 months | **$4** · max $5 | **₹384** · max ₹480 |
| **Total** | | **$210** · max **$505** | **₹20,160** · max **₹48,480** |

**Where the money goes:** Gemini and Rekognition are **89%** of the expected
bill. The server, database and storage together are about **$24 (11%)**.

**Per instructor:** $0.21/month (₹20). **Per photo:** $0.004 (₹0.39).

**Not in this estimate:** the frontend host (Vercel Pro, $20/month), report
emails (AWS SES, $0.10 per 1,000; about $12–$32/month depending on how many
reporting partners get copies), and free items (cron-job.org, BigQuery
instructor sync, Let's Encrypt HTTPS).

---

## 2. Usage assumptions

| Item | Expected | Max cap | How it is derived |
|---|---|---|---|
| Instructors | 1,000 | 1,000 | Given |
| Working days per month | 26 | 27 | Monday–Saturday. A 31-day month with 4 Sundays has 27. |
| Photos per instructor per day | 2 | 2 | 1 check-in + 1 check-out |
| **Photos per month** | **52,000** | **54,000** | 1,000 × 2 × working days |
| Male / female | 50 / 50 | 50 / 50 | Given |
| Photo size | 1 MB | 1 MB | Given (the app sends at most 2048 px JPEG) |
| Photo retention in R2 | 5 months | 6 months | Given. The cap allows one extra month in case the purge job stops running for a while. |

Keeping photos for 5 months needs no code change. The scheduled purge job
(cron-job.org) is called with `?months=5`:

```
POST /api/v2/reports/cron/purge-photos?months=5
Header: x-cron-secret: <CRON_SECRET>
```

The default in the code is 2 months (`PHOTO_RETENTION_MONTHS` in
`grooming_api_node/src/routes/reportRoutes.js`).

---

## 3. AWS Lightsail — $12 plan + snapshots

### 3.1 Price

| Item | Price (Mumbai) | Source |
|---|---|---|
| 2 GB plan (2 vCPU, 60 GB SSD) | $0.01612/hour, capped at **$12/month** | AWS price list, published 15 Sep 2026 |
| Data transfer included | **1.5 TB/month** (Mumbai plans get half of the listed 3 TB; inbound and outbound both count) | aws.amazon.com/lightsail/pricing |
| Transfer above the allowance | $0.13/GB (outbound only) | AWS price list |
| Snapshot storage | $0.05 per GB-month | AWS price list |

### 3.2 Why the $12 plan is the right size

Memory is the deciding factor. The heaviest work is resizing photos in memory,
and the app processes at most 10 photos at once (`CHECKIN_CONCURRENCY_LIMIT=10`).
This was measured with the app's own `normalizeInstructorImage` function:

| Component | Peak RAM |
|---|---|
| Ubuntu + Docker + Nginx | ~350 MB |
| Node app with 10 photos processing at once (measured) | ~550 MB |
| Group photos, workers, database connections | ~100 – 150 MB |
| **Total at the busiest minute** | **~1.0 – 1.05 GB of 2 GB** |

CPU at the morning rush (about 2.5 photos a second at peak) is ~31% of the two
vCPUs, and the server earns roughly 25× more burst credit in quiet hours than
it spends at the rushes, so it never throttles at this load. Nothing is stored
on the server's disk: photos are in R2 and data is in DynamoDB, so ~8–12 GB of
the 60 GB SSD is used.

The $12 plan is comfortable up to about 1,500 instructors. At about 2,000,
move to the $24 plan (4 GB).

### 3.3 Data transfer — well inside the allowance

| Flow | Expected | Max cap |
|---|---|---|
| Photos uploaded by tablets | 52 GB | 54 GB |
| Photos saved to R2 | 52 GB | 54 GB |
| Photos read back from R2 for Gemini | 52 GB | 54 GB |
| Photos sent to Gemini (base64, +33%) | 107 GB | 119 GB |
| Photos sent to Rekognition | 62 GB | 81 GB |
| API responses and DynamoDB traffic | 10 GB | 10 GB |
| **Total** | **~336 GB of 1,500 GB (22%)** | **~372 GB (25%)** |

No overage is charged.

### 3.4 Lightsail cost

| Item | Expected | Max cap |
|---|---|---|
| Instance | $12.00 | $12.00 |
| Snapshots: 7 daily automatic snapshots. The first is the ~10 GB of used disk and each later one adds only what changed (~1 GB a day). | 16 GB × $0.05 = $0.80 | Full 60 GB disk + 7 × 5 GB changes = 95 GB × $0.05 = $4.75 |
| Data transfer overage | $0 | $0 |
| Static IP (free while attached) | $0 | $0 |
| **Total** | **$12.80 ≈ $13** | **$16.75 ≈ $17** |

---

## 4. Amazon DynamoDB

### 4.1 Price (on-demand, Mumbai)

| Item | Price | Source |
|---|---|---|
| Writes | $0.71 per million write request units (1 unit = a write of up to 1 KB) | AWS price list, published 11 Sep 2026 |
| Reads | $0.1425 per million read request units (1 unit = a strongly consistent read of up to 4 KB, or two eventually consistent ones) | AWS price list |
| Storage | First 25 GB free every month, then $0.285 per GB-month | AWS price list |
| Point-in-time recovery (continuous backup) | $0.228 per GB-month | AWS price list |

On-demand billing charges only for requests actually made, so a quiet night or
a Sunday costs almost nothing.

### 4.2 Cost maths

Request counts come from the table design in
[DYNAMODB_MIGRATION_PLAN.md](./DYNAMODB_MIGRATION_PLAN.md). Each photo costs
~60 write units: the attendance item, the AI report, job queue items, index
updates, uniqueness reservations, and transactions, which count double.

| Item | Expected | Max cap |
|---|---|---|
| Writes | 52,000 photos × 60 = 3.1 M units → **$2.22** | 54,000 × 100 = 5.4 M units → **$3.83** |
| Reads: tablets, Daily Records, reports, sign-in checks | 15 M units | 30 M units |
| Reads: background worker polling (after the polling change in the migration plan) | 2 M units | 5 M units |
| Reads: Dashboard and Institutes pages *(est.)* | 15 M units | 60 M units |
| Reads total | 32 M units → **$4.56** | 95 M units → **$13.54** |
| Storage: ~0.35 GB added per month, ~4 GB after a year, ~13 GB after 3 years | **$0** (under the free 25 GB) | **$0** |
| Point-in-time recovery | ~2 GB × $0.228 = **$0.46** | ~13 GB (year 3) × $0.228 = **$2.96** |
| **Total** | **$7.23 ≈ $7** | **$20.34 ≈ $20** |

> **Dashboard design matters.** The Dashboard shows a 30-day trend and the
> Institutes page can show "All time". Both refresh every 30 seconds while
> open. If they read every attendance record on each refresh, one open
> Dashboard would read ~15,000 units per refresh, or roughly **$50 a month per
> administrator who keeps it open all day**. The estimate above assumes the
> migration stores one small summary item per day and institute, so a refresh
> reads a few hundred units instead. Build it that way before moving the
> Dashboard to DynamoDB.

---

## 5. Google Gemini 2.5 Flash-Lite

### 5.1 Price (paid tier, standard)

| Item | Price per 1 million tokens | Source |
|---|---|---|
| Input (text and image) | $0.10 | ai.google.dev/gemini-api/docs/pricing |
| Cached input (the grooming rules, reused between calls) | $0.01 | same |
| Output, including "thinking" tokens | $0.40 | same |
| Cache storage | $1.00 per hour | same |

### 5.2 Calls per month

Men need one call per photo. Women need two: the first identifies the attire
(saree, kurti with dupatta or formal), the second checks the photo against
that attire's rules (`grooming_api_node/src/services/visionEngine.js`).

| | Expected | Max cap |
|---|---|---|
| Grading calls (every photo) | 52,000 | 54,000 |
| Attire calls (women's photos only, 50%) | 26,000 | 27,000 |
| **Total calls** | **78,000** | **81,000** |

### 5.3 Tokens per call

Rules and schema sizes were measured from the application's own prompt and
schema builders (characters ÷ 4). The image size uses Gemini's published
counting: 258 tokens per 768 × 768 tile.

| Part | Grading call | Attire call | Basis |
|---|---|---|---|
| Grooming rules (cached) | 5,968 (men) / 5,446 (women, average) | 3,198 | Measured: `buildSystemPrompt`, `buildFemaleAttirePrompt` |
| Photo | 1,548 (a portrait 2048 px photo is 6 tiles); 2,322 max (square, 9 tiles) | same | Gemini token documentation |
| Answer format (JSON schema) | ~1,610 | ~231 | Measured |
| Answer + thinking | ~3,200 expected *(est.)*; **10,096 hard limit** | ~560 expected *(est.)*; **1,536 hard limit** | Answer ≈ 20 checkpoints × ~80 tokens. The limits are `maxOutputTokens` in the code. |

### 5.4 Cost maths

**Expected:**
```
One grading call  = 5,707 cached × $0.01/M          = $0.000057
                  + 3,208 input (photo + schema)  × $0.10/M = $0.000321
                  + 3,200 output × $0.40/M               = $0.001280
                  = $0.00166 per call × 52,000               = $86.21

One attire call   = 3,198 cached × $0.01/M          = $0.000032
                  + 1,829 input × $0.10/M                = $0.000183
                  + 560 output × $0.40/M                 = $0.000224
                  = $0.00044 per call × 26,000               = $11.41

Retries (~3% of calls billed twice)                          = $2.93
Cache storage: 5 cached rule sets = 25,504 tokens,
  kept alive ~8 hours a working day (1-hour cache, renewed while in use)
  = 0.0255 M × $1.00 × 208 hours                            = $5.30
Cache creation (rules billed as input once an hour)          = $0.53
Total                                                        = $106.38
```

**Max cap:** every call uses its full token limit, prompt caching fails so the
rules are billed at the full input price, 10% of calls are billed twice, and
the caches are kept alive all 744 hours of the month.
```
One grading call  = (5,968 rules + 2,322 photo + 1,637 schema + 50) × $0.10/M
                  + 10,096 output × $0.40/M
                  = $0.00504 per call × 54,000                = $271.95
One attire call   = (3,198 + 2,322 + 231 + 50) × $0.10/M + 1,536 × $0.40/M
                  = $0.00119 per call × 27,000                = $32.25
Re-billed calls (10%)                                        = $30.42
Cache storage + creation, 744 hours                          = $20.87
Total                                                        = $355.49
```

| Gemini item | Expected | Max cap |
|---|---|---|
| Grading calls | $86.21 | $271.95 |
| Attire calls | $11.41 | $32.25 |
| Retries | $2.93 | $30.42 |
| Prompt cache | $5.83 | $20.87 |
| **Total** | **$106.38 ≈ $106** | **$355.49 ≈ $355** |

About **70% of the expected Gemini cost is output ("thinking") tokens**. The
real thinking length is the largest uncertainty in this whole estimate:
replace the ~3,200 above with the measured figure after the first week (Section 9).

---

## 6. AWS Rekognition

### 6.1 Price (Mumbai)

| Item | Price | Source |
|---|---|---|
| Face search (`SearchFacesByImage`) and enrolment (`IndexFaces`), first 1 M images/month | **$0.00125 per image** | AWS price list, published 11 Sep 2026 |
| Face check before enrolment (`DetectFaces`) | $0.00125 per image | same |
| Stored faces | $0.000012 per face per month | same |

Mumbai is 25% dearer than the US list price ($0.001).

### 6.2 Cost maths

Every photo is searched once. A person who stays in front of the tablet after
being recorded can be photographed again, and each extra frame is also
searched (it is answered "already checked in" and not stored). The estimate
allows 20% extra searches for this; the cap allows 50%.

| Item | Expected | Max cap |
|---|---|---|
| Face searches | 52,000 × 1.2 = 62,400 × $0.00125 = **$78.00** | 54,000 × 1.5 = 81,000 × $0.00125 = **$101.25** |
| Faces enrolled when an admin names an unidentified check-in | 3% of photos = 1,560 × $0.00125 = **$1.95** | 10% = 5,400 × $0.00125 = **$6.75** |
| Stored faces (up to 6 per instructor) | 6,000 × $0.000012 = **$0.07** | **$0.07** |
| **Total** | **$80.02 ≈ $80** | **$108.07 ≈ $108** |

**One-time:** enrolling the first reference photo for 1,000 instructors
(`DetectFaces` + `IndexFaces`) = 2,000 × $0.00125 = **$2.50**.

---

## 7. Cloudflare R2 (photos)

### 7.1 Price (Standard storage)

| Item | Price | Free every month | Source |
|---|---|---|---|
| Storage | $0.015 per GB-month | 10 GB-month | developers.cloudflare.com/r2/pricing |
| Uploads (Class A: `PutObject`, `ListObjects`) | $4.50 per million | 1 million | same |
| Reads (Class B: `GetObject`, `HeadObject`) | $0.36 per million | 10 million | same |
| Deletes | Free | — | same |
| Data out (egress) | Free | — | same |

### 7.2 Cost maths

```
New photos per month   = 52,000 × 1 MB                 = 52 GB
Stored after 5 months  = 5 × 52 GB + ~3 GB reference photos = 263 GB
Billable               = 263 − 10 free                 = 253 GB × $0.015 = $3.80
```

| Month | Photos stored | Cost |
|---|---|---|
| 1 | 55 GB | $0.67 |
| 2 | 107 GB | $1.45 |
| 3 | 159 GB | $2.23 |
| 4 | 211 GB | $3.01 |
| **5 onward** | **263 GB** | **$3.80** |

Storage stops growing after month 5, because the purge deletes a month of
photos for every month added.

**Operations are free at this volume:** ~52,000 uploads plus ~31,000 listings
from the orphan-photo check that runs every 6 hours (Class A, 1 million free), and ~52,000
reads for Gemini plus photo views and health checks (Class B, 10 million free).

| | Expected | Max cap (6 months kept, 27-day months) |
|---|---|---|
| Storage | $3.80 | 327 GB → $4.76 |
| Operations | $0 | $0 |
| **Total** | **$3.80 ≈ $4** | **$4.76 ≈ $5** |

---

## 8. Keeping spending under the cap

None of these services stops charging by itself, so set alerts at the
expected cost and a hard limit near the cap:

| Service | What to set up |
|---|---|
| AWS (Lightsail, DynamoDB, Rekognition) | AWS Budgets: alert at $110 (expected ~$100 for these three) and $150. Budget actions can stop Rekognition by removing the API user's permission. |
| Gemini | Google Cloud billing budget alert at $120. A daily request quota on the Gemini API (for example 4,000 requests a day, against ~3,000 needed on a working day) is a hard stop that caps a runaway month. |
| Cloudflare R2 | Billing notification in the Cloudflare dashboard. At under $5 a month, this is low risk. |

---

## 9. Items to verify after go-live

1. **Real Gemini tokens per call.** After one week, read `/health/metrics`
   (`gemini_input_tokens_total`, `gemini_cached_input_tokens_total`,
   `gemini_output_tokens_total`, `gemini_requests_total`) and divide by the
   number of calls. Replace the *(est.)* figures in Section 5.3. The thinking
   length alone can move the Gemini line between ~$60 and ~$170.
2. **Extra Rekognition searches from people lingering at the tablet.** Compare
   the image count on the first Rekognition bill with the check-ins and
   check-outs recorded that month, and replace the 20% allowance in
   Section 6.2.
3. **DynamoDB request units.** CloudWatch `ConsumedReadCapacityUnits` and
   `ConsumedWriteCapacityUnits` per table, a week after the migration.
4. **Average photo size in R2.** The bucket's total size ÷ number of photos;
   the estimate assumes 1 MB.
5. **The purge job runs with `?months=5`.** Otherwise photos are deleted after
   2 months, and R2 costs about 60% less than shown.
6. **Lightsail memory and CPU graphs.** Move to the $24 plan if peak memory
   stays above ~75% or burst credit runs low.
