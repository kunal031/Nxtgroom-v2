# Production deployment: AWS Lightsail + Vercel

`PROCESS_ROLE=all` runs the API and all four background workers in one
container, which is the intended setup on a single Lightsail instance. To scale
independently later, run the public service with `PROCESS_ROLE=api` and
`npm start`, then run a private worker service with `PROCESS_ROLE=worker` and
`npm run start:worker`; the image contains both entry points.

Check-in and check-out photographs are both analysed by the evaluation worker,
not inside the HTTP request. The tablet gets its answer once the photograph is
identified and stored; the Gemini report and its email follow from the queue.
Only two administrative recovery actions still run Gemini inside the request:
attaching a missing check-out photo and re-analysing a check-out.

This guide deploys the Express API as a Docker container behind Nginx on an
AWS Lightsail instance (Mumbai, $12 plan: 2 GB RAM, 2 vCPU) and the Vite
frontend as a Vercel project. It assumes the repository has been committed and
pushed to a Git provider that the instance and Vercel can both read. The sizing
and cost reasoning is in [docs/COST_ESTIMATION.md](../docs/COST_ESTIMATION.md).

## 1. Rotate credentials before deploying

Treat any credential previously pasted into chat, source code, screenshots,
issue trackers, or build logs as compromised. Before the first production
deployment, revoke and replace the MongoDB password, Gemini API key, AWS access
key, JWT secret, and administrator password. Do not reuse development values.

Store runtime secrets only in `grooming_api_node/.env` on the instance, owned by
the deploy user with mode `600` (`deploy.sh` enforces this). Do not put them in Git,
the Dockerfile, build arguments, Vercel frontend variables, or container image
layers. Only `VITE_API_BASE` belongs in Vercel; Vite variables are embedded in
the browser bundle and are public.

Generate a JWT secret locally if needed:

```powershell
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

### Release blocker: purge committed check-in photos

Uploaded check-in photos are present in the public Git history under
`grooming_api_v2/temp_uploads/`; `grooming_api_v2/fake_photo.jpg` must be
purged with them. A normal deletion commit removes these files only from the
latest checkout, not from earlier commits. Do not deploy until the repository
has been made private, pushes have been paused, and this history cleanup has
been completed.

Do not rewrite the current working copy: it contains uncommitted release work
and its local `main` is behind the remote. Preserve that work separately, then
perform the purge in a fresh mirror. The backup bundle below also contains the
photos, so keep it encrypted and access-restricted and destroy it after the
incident is closed.

```powershell
git clone --mirror https://github.com/kunal031/Nxtgroom.git Nxtgroom-rewrite.git
Set-Location Nxtgroom-rewrite.git
$oldMain = git rev-parse refs/heads/main
git bundle create ../Nxtgroom-pre-rewrite.bundle --all
git bundle verify ../Nxtgroom-pre-rewrite.bundle

# Requires git-filter-repo 2.47 or newer.
git filter-repo --sensitive-data-removal --invert-paths `
  --path grooming_api_v2/temp_uploads/ `
  --path grooming_api_v2/fake_photo.jpg

# Both commands must produce no matching paths.
git log --all --name-status -- grooming_api_v2/temp_uploads/ grooming_api_v2/fake_photo.jpg
git rev-list --objects --all | Select-String 'grooming_api_v2/(temp_uploads/|fake_photo\.jpg)'

# git-filter-repo removes origin as a safety measure.
git remote add origin https://github.com/kunal031/Nxtgroom.git
git push --force-with-lease="refs/heads/main:$oldMain" origin refs/heads/main:refs/heads/main
```

The explicit lease prevents silently overwriting a concurrent update. At the
time of this audit the remote had only `main`; if branches or tags are added,
stop and clean every affected ref instead of pushing only `main`. Temporarily
disable branch protection only if it blocks the reviewed force-push, then
restore it immediately. All collaborators must discard/reclone or carefully
rebase their old clones; merging an old branch can restore the purged blobs.

After the push, contact GitHub Support with the `git-filter-repo` first-changed
commit report so cached views can be removed. Delete earlier Vercel deployments
created from affected commits and rebuild without the old cache. On the API
server, delete any image built from an affected commit and rebuild only from
the cleaned commit.

## 2. Prepare external services

### MongoDB Atlas

1. Create a dedicated production database user with `readWrite` access only to
   the `grooming_standards` database.
2. Use a TLS `mongodb+srv://` connection string with retryable writes enabled.
3. Add the Lightsail instance's static IP address to Atlas as a single `/32`
   network entry. Do not leave `0.0.0.0/0` enabled. Without this entry the API
   cannot connect and refuses to start.
4. Use a paid tier (Flex or above). The free M0 tier holds 512 MB, which this
   workload fills in about 5–7 weeks, caps throughput at 100 operations per
   second, and has no backups.
5. Run the database preflight before starting a production revision. Its
   default mode is read-only and reports document IDs without printing email
   addresses:

```powershell
cd grooming_api_node
npm run db:preflight
```

The audit blocks on non-canonical, duplicate, or case-colliding user emails;
invalid or duplicate BOA/instructor employee IDs; duplicate case-insensitive
college name/location keys; active BOAs or instructors assigned to a missing or
archived college; missing or invalid active-instructor emails; invalid or
duplicate active attendances; duplicate or invalid evaluation attendance IDs;
and conflicting index definitions. Resolve those records manually using the
listed document IDs. In particular, preserve attendance history: choose the
authoritative active record and give the other records an accurate
`check_out_time`; do not delete them blindly.

After the read-only report says `safe_to_apply_indexes`, run the index step in a
one-off container on the instance or a trusted administrative environment using the same
database settings:

```powershell
$env:DATABASE_PREFLIGHT_APPLY="CREATE_INDEXES"
npm run db:preflight:apply
Remove-Item Env:DATABASE_PREFLIGHT_APPLY
npm run db:preflight
```

The apply command is deliberately narrow and idempotent: it creates only
missing indexes. It never edits, merges, closes, or deletes application
documents, and it refuses to replace a conflicting index. Index construction
can consume database CPU, memory, I/O, and storage, so schedule the one-off job
for an appropriate maintenance window and monitor Atlas while it runs.

Production API startup is verify-only. It repeats the read-only data audit and
index verification, then fails closed with an actionable preflight error if
data blockers, missing indexes, or conflicting indexes remain. Development
startup may create missing indexes automatically after the same audit passes.

### Amazon DynamoDB (migration in progress)

Data moves from MongoDB to DynamoDB one store at a time; see
`docs/DYNAMODB_ARCHITECTURE.md`. **With the switches unset, everything stays
on MongoDB and none of this is needed.**

Every collection now has a DynamoDB implementation, in the order they should
move:

| Order | Switch | Collections |
|---|---|---|
| 1 | `DB_WRITE_TO_APP_SETTINGS` | `app_settings` |
| 2 | `DB_WRITE_TO_REPORT_DELIVERY_RUNS` | `report_delivery_runs` |
| 3 | `DB_WRITE_TO_EVALUATION_JOBS` and the three other `*_JOBS` switches | the four job queues |
| 4 | `DB_WRITE_TO_EVALUATIONS` | `evaluations` |
| 5 | `DB_WRITE_TO_CORE` | `colleges`, `boas`, `users`, `password_resets`, `instructors`, `attendance` |

The core six move as one group because they share transactions and a
transaction cannot span two databases. Move them last, after everything
above has held in production.

1. In IAM, create a user `facultytrack-dynamodb` with an access key and only
   this policy (replace the account id). Lightsail cannot use IAM roles, and
   the SES key must not be reused.

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": [
           "dynamodb:DescribeTable", "dynamodb:CreateTable", "dynamodb:TagResource",
           "dynamodb:UpdateContinuousBackups", "dynamodb:UpdateTimeToLive",
           "dynamodb:DescribeTimeToLive", "dynamodb:GetItem", "dynamodb:PutItem",
           "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query",
           "dynamodb:Scan", "dynamodb:BatchWriteItem", "dynamodb:BatchGetItem",
           "dynamodb:ConditionCheckItem", "dynamodb:TransactWriteItems",
           "dynamodb:TransactGetItems"
         ],
         "Resource": [
           "arn:aws:dynamodb:ap-south-1:ACCOUNT_ID:table/facultytrack-*",
           "arn:aws:dynamodb:ap-south-1:ACCOUNT_ID:table/facultytrack-*/index/*"
         ]
       }
     ]
   }
   ```

2. Add `DYNAMODB_REGION`, `DYNAMODB_ACCESS_KEY_ID` and
   `DYNAMODB_SECRET_ACCESS_KEY` to `.env`, then create the tables
   (on-demand billing, deletion protection and point-in-time recovery on):

   ```bash
   docker compose run --rm api npm run dynamo:tables          # report only
   docker compose run --rm api npm run dynamo:tables:apply    # create missing tables
   ```

3. Copy the existing data. MongoDB is only read.

   ```bash
   docker compose run --rm api npm run dynamo:copy -- --apply
   ```

4. Turn on dual writes for **one** store and redeploy, reads staying on
   MongoDB. Use the per-store switch rather than the global one, so a
   problem affects one collection:

   ```bash
   DB_WRITE_TO_APP_SETTINGS=both
   ```

   A DynamoDB write that fails is retried three times. One that still does
   not land is logged as `shadow_write_failed` and counted at
   `/health/metrics` under `divergence.unmirrored_writes`; it never fails
   the request. **Anything other than zero there means the databases have
   drifted** — find the rows with `dynamo:compare` and copy that store
   again.

5. Check daily that the databases agree; it exits 1 on any difference:

   ```bash
   docker compose run --rm api npm run dynamo:compare -- --store app_settings
   ```

6. After a clean week with no divergence, move that store's reads:
   `DB_READ_FROM_APP_SETTINGS=dynamo`. Then repeat steps 3-6 for the next
   store in the table above.

7. To undo any step, set the value back to `mongo` and redeploy. MongoDB
   keeps receiving every write until a store reaches `dynamo/dynamo`, so a
   rollback before then loses nothing.

The process refuses to start if a switch points at a table that does not
exist or is missing an index, so a skipped `dynamo:tables:apply` fails
immediately and visibly instead of serving empty results. `/health/ready`
answers 503 with `DYNAMODB_UNAVAILABLE` if DynamoDB stops answering once a
store is using it.

### Amazon SES

1. Verify `SES_FROM_EMAIL` or its domain in the same AWS region configured in
   `AWS_REGION`.
2. If the SES account is still in the sandbox, either verify every recipient or
   request production access before launch.
3. Create a dedicated IAM principal and grant only the SES send permission it
   needs. Create a new access key specifically for this service and rotate it
   regularly.
4. Optionally attach an SES configuration set for delivery, bounce, and
   complaint telemetry.

The API queues check-in mail after AI analysis completes. A photographed
checkout is analysed by the same evaluation worker, and its report mail is
queued only after that report is stored; a checkout without a photo queues a
plain confirmation. Sending is retried from MongoDB, so at least one process
with the workers must keep running (`PROCESS_ROLE=all` on the single instance
covers this).

SES `SendEmail` does not provide an idempotency key. The worker is durable and
records an explicit `delivery_unknown` state after an ambiguous final attempt,
but a container crash immediately after SES accepts a message can still cause a
rare duplicate on retry. Treat these notifications as at-least-once delivery;
the administrative attendance record remains the source of truth.

### Gemini

Create a Gemini API key with an appropriate spend limit. The configured model
is pinned to `gemini-2.5-flash-lite`. Validate that the model is available to
the Google AI project before launch.

## 3. Deploy the API on AWS Lightsail

Files used in this section:

| File | Purpose |
| --- | --- |
| `grooming_api_node/Dockerfile` | Builds the API image (API and worker entry points) |
| `grooming_api_node/docker-compose.yml` | Runs the container: auto-restart, `127.0.0.1:8000` only, `NODE_ENV=production`, 1.4 GB memory cap, rotated logs |
| `deploy/lightsail/nginx/facultytrack-api.conf` | HTTPS, 10 MB uploads, 90 s timeout, real client IP, token-free access log |
| `deploy/lightsail/setup-server.sh` | One-time instance setup: Docker, Nginx, Certbot, 2 GB swap, certificate |
| `deploy/lightsail/deploy.sh` | Every release: build, start, health check, automatic rollback |

### 3.1 Create the instance (Lightsail console)

| Setting | Value |
| --- | --- |
| Region | Asia Pacific (Mumbai) `ap-south-1`, the same region as SES and Rekognition |
| Platform / blueprint | Linux, OS only, **Ubuntu 24.04 LTS** |
| Plan | **$12/month, dual-stack (IPv4)**: 2 GB RAM, 2 vCPU, 60 GB SSD |
| Static IP | Create one and attach it (free while attached) |
| Automatic snapshots | Enable (daily) |

**Networking → IPv4 firewall:**

| Port | Source | Why |
| --- | --- | --- |
| 22 (SSH) | Your office/VPN IP only | Administration |
| 80 (HTTP) | Anywhere | Certificate issue/renewal and redirect to HTTPS |
| 443 (HTTPS) | Anywhere | The API |
| 8000 | **Do not open** | The API is reachable only through Nginx |

### 3.2 DNS

Create an `A` record for the API hostname (for example `api.example.com`)
pointing at the static IP. Let's Encrypt cannot issue a certificate for a bare
IP address, so a hostname is required. Wait until `nslookup <hostname>` returns
the static IP before continuing.

### 3.3 Prepare the instance (once)

SSH in as `ubuntu`, then:

```bash
sudo mkdir -p /opt/facultytrack && sudo chown ubuntu:ubuntu /opt/facultytrack
# Private repository: add a read-only deploy key to GitHub first.
git clone <repository-url> /opt/facultytrack
cd /opt/facultytrack
sudo deploy/lightsail/setup-server.sh api.example.com ops@example.com
exit   # log in again so the ubuntu user can run Docker
```

The script installs Docker, Nginx and Certbot, adds a 2 GB swap file, obtains
the certificate, installs the Nginx site with the real hostname, and sets up
automatic certificate renewal. It is safe to re-run.

### 3.4 Create the environment file (once)

```bash
cd /opt/facultytrack/grooming_api_node
cp .env.example .env
chmod 600 .env
nano .env   # fill in every Required row of the table below
```

Copy the production values from the current deployment and use the table in
"API environment contract" below. `docker-compose.yml` forces
`NODE_ENV=production` regardless of the file. Recommended values for the $12
plan:

```dotenv
PROCESS_ROLE=all
TRUST_PROXY_HOPS=1
EVALUATION_CONCURRENCY=4
CHECKIN_CONCURRENCY_LIMIT=10
```

### 3.5 Deploy and update

```bash
cd /opt/facultytrack
deploy/lightsail/deploy.sh               # latest origin/main
deploy/lightsail/deploy.sh <commit|tag>  # a specific revision
deploy/lightsail/deploy.sh --rollback    # the previous release
```

`deploy.sh` builds an image tagged with the commit, starts it, waits for
`/health/live`, prints `/health/ready`, and restarts the previous image
automatically if the new one does not come up within 90 seconds. It keeps the
three newest images for rollback. Deploy outside the 9 AM and 6 PM attendance
rushes: a restart drops requests that are in flight.

### 3.6 Health checks and monitoring

| Check | Path | Use |
| --- | --- | --- |
| Liveness | `/health/live` | Docker `HEALTHCHECK` in the image; `deploy.sh` |
| Readiness | `/health/ready` | External uptime monitor, every 1–5 minutes |

Docker restarts the container automatically when the process exits
(`restart: unless-stopped`), including after an instance reboot. Point an
uptime monitor at `https://<api-hostname>/health/ready` so someone is alerted
when it returns 503.

Readiness covers MongoDB and Cloudflare R2 connectivity, the progress markers
of all four durable workers (evaluation, notification, storage cleanup, mail),
and the age of evaluation/email queues and private attendance outboxes. A queue
at least 15 minutes old is reported as a warning; readiness fails at 23 hours,
before the 24-hour terminal privacy deadline. Alert on warnings rather than
waiting for a failure.

In the Lightsail console, watch the **CPU** graph (stay out of the burstable
zone for long periods) and add a memory alarm if available. Move to the $24
plan (4 GB) when peak memory stays above ~75%, or at roughly 2,000 instructors.

Useful commands on the instance:

```bash
docker logs -f --tail 100 facultytrack-api              # application log
sudo tail -f /var/log/nginx/facultytrack-api.access.log  # request log (tokens redacted)
docker stats facultytrack-api                            # live CPU and memory
curl -s http://127.0.0.1:8000/health/ready               # readiness from inside
```

### 3.7 Cutover from the previous host

1. Set up and verify Lightsail while the old API keeps running. Both can share
   the same Atlas database safely: jobs are claimed with leases, so none is
   processed twice.
2. Verify section 5 against `https://<api-hostname>`.
3. Change `VITE_API_BASE` in Vercel to the new hostname and **redeploy** the
   frontend (the value is compiled into the bundle).
4. Change every cron-job.org job URL to the new hostname (the `x-cron-secret`
   header is unchanged).
5. Do this outside the attendance rushes. After one or two quiet days, stop the
   old API and remove its IP address from the Atlas access list.

### API environment contract

Set these in `grooming_api_node/.env` on the instance. Set every row marked
required. The API refuses to start when `NODE_ENV` is unset, and once
`NODE_ENV=production` it also validates the
security-sensitive required values at startup and exits instead of starting
with an insecure fallback.

| Variable | Requirement | Production value or purpose |
| --- | --- | --- |
| `NODE_ENV` | Required | `production` |
| `PORT` | Optional | `8000` (container default) |
| `TRUST_PROXY_HOPS` | Optional | Defaults to `1` (Nginx only). Add one per extra proxy layer, such as a Lightsail load balancer or Cloudflare; permitted range is 0–5 |
| `PROCESS_ROLE` | Optional | Defaults to `all`; set only when API and worker run separately |
| `MONGODB_URI` | Required, secret | Rotated Atlas connection URI |
| `DB_NAME` | Optional | Defaults to `grooming_standards` |
| `DATABASE_PREFLIGHT_APPLY` | One-off only | Leave unset on the API service. Set to `CREATE_INDEXES` only for the confirmed migration job, then remove it. |
| `DB_WRITE_TO` | Optional | `mongo` (default), `both` or `dynamo`: where migrated stores write. Per-store override, e.g. `DB_WRITE_TO_APP_SETTINGS` |
| `DB_READ_FROM` | Optional | `mongo` (default) or `dynamo`: where migrated stores read. Must be a database that is written |
| `DYNAMODB_REGION` | Required once a store uses DynamoDB | `ap-south-1` |
| `DYNAMODB_ACCESS_KEY_ID` / `DYNAMODB_SECRET_ACCESS_KEY` | Required once a store uses DynamoDB, secret | Keys of the `facultytrack-dynamodb` IAM user; never the SES key |
| `DYNAMODB_TABLE_PREFIX` | Optional | Defaults to `facultytrack-` |
| `DYNAMODB_ENDPOINT` | Development only | DynamoDB Local, e.g. `http://localhost:8001`; unset on a server |
| `SECRET_KEY` | Required, secret | Unique random value, at least 32 characters |
| `JWT_EXPIRE_MINUTES` | Optional | Defaults to `525600` (one year); permitted range is 5–525600. Leave unset for one-year sign-ins; a password change or reset still signs every device out |
| `JWT_ISSUER` | Optional | Defaults to `facultytrack-api` |
| `JWT_AUDIENCE` | Optional | Defaults to `facultytrack-web` |
| `ADMIN_EMAIL` | Required | Production superadmin email |
| `ADMIN_PASSWORD` | Required, secret | Unique password of at least 12 characters |
| `ADMIN_PASSWORD_VERSION` | Required | Start at `1`; change whenever the password rotates |
| `CORS_ORIGINS` | Required | Exact comma-separated HTTPS Vercel origins, no `*` |
| `APP_URL` | Required | Canonical public Vercel HTTPS origin used in emailed links; must appear in `CORS_ORIGINS` |
| `CRON_SECRET` | Required, secret | Random secret sent only in the scheduler request header |
| `GEMINI_API_KEY` | Required, secret | Gemini API key |
| `GEMINI_MODEL` | Optional | Defaults to pinned `gemini-2.5-flash-lite` |
| `GEMINI_TIMEOUT_MS` | Optional | Defaults to `120000`; permitted range is 10000–600000 |
| `GEMINI_MAX_RETRIES` | Optional | Defaults to `2`; permitted range is 0–2 |
| `GEMINI_INTERACTIVE_TIMEOUT_MS` | Optional | Defaults to `20000`; used only by the administrative check-out photo recovery and re-analysis actions, which run inside the HTTP request. Timeout times attempts must stay under the 60000ms request timeout or startup fails |
| `GEMINI_INTERACTIVE_MAX_RETRIES` | Optional | Defaults to `1`; permitted range is 0–2 |
| `GEMINI_EXPLICIT_CACHE` | Optional | Defaults to `true`; set to `false` to disable explicit male/female prompt caching. Cache failures automatically use the normal request path. |
| `GEMINI_CACHE_TTL_SECONDS` | Optional | Defaults to `3600`; permitted range is 600–86400. Prompt changes automatically create a new cache identity. |
| `EVALUATION_POLL_MS` | Optional | Defaults to `2000`; permitted range is 250–60000 |
| `EVALUATION_LEASE_MS` | Optional | Defaults to `600000`; must cover all Gemini attempts plus 60000 |
| `EVALUATION_MAX_ATTEMPTS` | Optional | Defaults to `3`; permitted range is 1–10 |
| `EVALUATION_CONCURRENCY` | Optional | Defaults to `2`; `4` recommended on the $12 plan for ~1,000 instructors; permitted range is 1–20. Gemini jobs one worker runs at once, shared by check-in and check-out |
| `CHECKIN_CONCURRENCY_LIMIT` | Optional | Defaults to `10` per API replica; permitted range is 1–50. Photographs decoded at once across check-in, check-out and the kiosk; extra requests get HTTP 503 with `Retry-After: 5`. Raise only with more memory |
| `GROUP_ATTENDANCE_MAX_PEOPLE` | Optional | Defaults to `6`; permitted range is 2–12 |
| `GROUP_CONCURRENCY_LIMIT` | Optional | Defaults to `2`; group photographs processed at once |
| `GROUP_CROP_CONCURRENCY` | Optional | Defaults to `3`; faces cropped at once within one group photograph |
| `GROUP_MIN_FACE_PIXELS` | Optional | Defaults to `72` |
| `R2_ENDPOINT` | Required | Cloudflare R2 HTTPS S3 endpoint without a path |
| `R2_BUCKET` | Required | Private attendance-photo bucket name |
| `R2_ACCESS_KEY_ID` | Required, secret | R2 object read/write/delete credential |
| `R2_SECRET_ACCESS_KEY` | Required, secret | Matching R2 secret credential |
| `R2_TIMEOUT_MS` | Optional | Defaults to `15000`; permitted range is 2000–60000 |
| `AWS_REGION` | Required | SES region, for example `ap-south-1` |
| `AWS_ACCESS_KEY_ID` | Required, secret | Rotated dedicated IAM access key |
| `AWS_SECRET_ACCESS_KEY` | Required, secret | Matching IAM secret key |
| `AWS_SESSION_TOKEN` | Conditional, secret | Required only when using temporary AWS credentials |
| `SES_FROM_EMAIL` | Required | Verified sender address |
| `SES_CONFIGURATION_SET` | Optional | SES configuration set name |
| `SES_TIMEOUT_MS` | Optional | Defaults to `30000`; aborts a hung SES request |
| `SES_MAX_ATTEMPTS` | Optional | Defaults to `2`; SDK attempts per delivery try |
| `NOTIFICATION_LEASE_MS` | Optional | Defaults to `300000`; must exceed the SES timeout by at least 60000 |
| `NOTIFICATION_MAX_ATTEMPTS` | Optional | Defaults to `5`; durable worker delivery attempts |
| `NOTIFICATION_CONCURRENCY` | Optional | Defaults to `2` |
| `APP_TIME_ZONE` | Optional | Defaults to `Asia/Kolkata` |
| `ADMIN_PASSWORD_RESET` | Break-glass only | `true` overwrites the stored administrator password from `ADMIN_PASSWORD` on every start. Unset it immediately after use |
| `GOOGLE_CLIENT_ID` | Optional | Enables Google sign-in for existing active users; leave blank to hide it |
| `REKOGNITION_COLLECTION_ID` | Optional | Face-identification collection. While blank, face identification reports `NOT_CONFIGURED` |
| `AWS_REKOGNITION_REGION` | With Rekognition | Region of the collection, for example `ap-south-1` |
| `REKOGNITION_ACCESS_KEY_ID` | With Rekognition, secret | Rekognition lives in its own AWS account; the SES key is never reused |
| `REKOGNITION_SECRET_ACCESS_KEY` | With Rekognition, secret | Matching Rekognition secret key |
| `REKOGNITION_MATCH_THRESHOLD` | Optional | Defaults to `95`; below this a check-in is saved unidentified |
| `REKOGNITION_MAX_FACES_PER_INSTRUCTOR` | Optional | Defaults to `6` |
| `REKOGNITION_TIMEOUT_MS` | Optional | Defaults to `10000`; runs inside the check-in request |
| `REKOGNITION_MAX_ATTEMPTS` | Optional | Defaults to `2` |
| `BIGQUERY_CREDENTIALS_JSON` | Optional, secret | Service-account JSON (plain or base64) for instructor sync |
| `BIGQUERY_PROJECT_ID` | Optional | Defaults to the credential's `project_id` |
| `BIGQUERY_LOCATION` | Optional | BigQuery dataset location |

Example non-secret values (replace both origins with real domains):

```dotenv
NODE_ENV=production
PORT=8000
# DATABASE_PREFLIGHT_APPLY is intentionally unset on the API service.
ADMIN_PASSWORD_VERSION=1
CORS_ORIGINS=https://facultytrack.example.com,https://facultytrack.vercel.app
APP_URL=https://facultytrack.example.com
AWS_REGION=ap-south-1
```

Do not copy placeholders or secrets from `.env.example` into source control.

## 4. Deploy the frontend on Vercel

Import the same repository as a separate Vercel project:

| Setting | Value |
| --- | --- |
| Root Directory | `grooming-frontend` |
| Framework Preset | Vite |
| Node.js version | 24.x |
| Install command | `npm ci` |
| Build command | `npm run build` |
| Output directory | `dist` |

Create one Vercel environment variable:

```dotenv
VITE_API_BASE=https://YOUR_API_HOSTNAME
```

Use the HTTPS origin only, with no trailing slash and no `/api/v2` suffix.
Apply it to Production. If Preview deployments must call the production API,
add each exact preview/custom-domain origin to `CORS_ORIGINS`; dynamic wildcard
origins are intentionally rejected. A stable preview domain or a separate
staging API is safer than broad production CORS.

Deploy the frontend, note its final production domain, update `CORS_ORIGINS`
in the API's `.env` to that exact origin, and run `deploy/lightsail/deploy.sh`
to restart the API. If the
Vercel domain later changes, repeat this step.

## 5. Release verification

Run these checks without sending a real instructor email or Gemini request:

```powershell
cd grooming_api_node
npm ci
npm run db:preflight
npm run check
npm audit --omit=dev

cd ..\grooming-frontend
npm ci
npm run lint
npm test
$env:VITE_API_BASE="https://YOUR_API_HOSTNAME"
npm run build
Remove-Item Env:VITE_API_BASE
npm audit
```

Then verify the deployed services:

1. `/health/live` and `/health/ready` both return HTTP 200.
2. An unauthenticated `/api/v2` protected request is rejected.
3. The production frontend can log in and the browser has no CORS or mixed
   content errors.
4. A test instructor with a verified/allowed SES address can check in, receive
   the completed AI report, check out, and receive the checkout report.
5. A BOA cannot read or modify instructors belonging to another college.
6. MongoDB contains one evaluation and the expected email delivery status for
   the test attendance record.
7. `/health/ready` reports all four workers as `ok`, no critical queue ages, and no
   `QUEUE_METRICS_UNAVAILABLE` reason.
8. `docker logs facultytrack-api` and the Nginx access log contain request/job
   identifiers but no credentials, report/reset tokens, or photo data.
9. A photo upload of about 5 MB succeeds (confirms the Nginx body-size limit).

After verification, remove test data according to the organization's retention
policy and monitor SES bounces/complaints, Gemini errors and spend, MongoDB
capacity, HTTP error rate, and worker queue age.

## 6. Rollback

`deploy/lightsail/deploy.sh --rollback` restarts the previous API image, and
Lightsail snapshots restore the whole instance. Keep the previous Vercel
deployment available too.
If a release fails, roll back both services as a pair when their API contract
changed. Do not roll back database data blindly. The confirmed preflight job
creates indexes but does not include destructive down-migrations; inspect the
database before any manual schema cleanup.
