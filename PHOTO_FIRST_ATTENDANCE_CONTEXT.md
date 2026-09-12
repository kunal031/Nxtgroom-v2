# Photo-first attendance — project context

Working notes for continuing this work in a new conversation. Written 2026-09-12.

Paste this whole file into a new chat and say "continue from here".

---

## What the project is

**FacultyTrack** (this repo) records instructor attendance at NxtWave colleges.
A photo is taken at check-in and check-out, Google Gemini evaluates it against
written grooming standards, and the verdict is emailed and published to a
tokenised report link.

- `grooming_api_node/` — Node 24 + Express, ESM, no build step → Northflank
- `grooming-frontend/` — React 19 + Vite + Tailwind v4 + Capacitor → Vercel

## What I am changing, and why

Attendance used to work like this: a BOA picked an instructor from a dropdown,
took their photo, pressed Check-In. The dropdown choice decided everything —
whose record it was, which dress code applied, which session to close.

**The goal is photo-first attendance.** A tablet sits in each college with the
camera open. An instructor walks up, the camera photographs them by itself, AWS
Rekognition identifies who they are, and the system decides whether this is
their arrival or their departure. No dropdown, no button.

The end state I asked for: *"when a person in front of camera comes, camera
automatically captures image, fetches his record from database and saves its
checkout record"*, with a popup like *"Instructor1 checked in"*, and the
check-in/check-out buttons removed entirely.

---

## Decisions I made during this work

These were discussed and settled. Do not silently revisit them.

**Identification**
- Face recognition via **AWS Rekognition**, in a **separate AWS account** from
  the SES/email one. Its own credentials, never falling back to the mail key.
- Accept a match at **95% similarity or above**. Below that is "not recognised".
- Identity resolves from Rekognition's `ExternalImageId` (the instructor's own
  id), never from a `FaceId` — one instructor accumulates several faces.
- **Look-alike handling is deliberately deferred.** The runner-up match is
  recorded so those cases can be found later.

**Per-college rollout**
- Each college is either `FACE_ONLY` or `SELECTOR`, over a global default.
  Reference photos are enrolled a campus at a time, so one college can be
  recognising faces while another still uses the dropdown.
- Default is `FACE_ONLY`.
- Low enrolment is **advisory only** — it warns, it never switches a college
  back. The administrator decides.
- The college comes from the **tablet's login**, not from the instructor: the
  mode must be known before anybody has been identified.

**When recognition fails**
- **Check-in**: save the record anyway as `unidentified`, stamped with the
  tablet's college. Skip Gemini (no gender ⇒ no dress code) and skip the email.
  An administrator names it later in a queue.
- **Check-out**: **refuse**. There is nothing to create — a check-out closes one
  specific open session and guessing which would attach one person's departure
  to another's day. The refusal says: *"Not recognised. Try again, or ask an
  administrator to update your reference photo."* I accepted that an instructor
  may complain if this recurs; that complaint is the signal to fix their
  reference photo.

**The unidentified queue**
- Administrators name unidentified check-ins. A setting (`boa_can_identify`,
  off by default) lets BOAs do it too — often they are the only people who can
  recognise a face from their own campus.
- Naming enrols that photograph as an additional face for the instructor, so
  recognition improves with each correction.
- A later recognised check-in at the same college within 30 minutes is offered
  as *"possibly already resolved"* — a **suggestion the admin confirms**, never
  applied automatically.
- Assigning to somebody who already checked in that day **warns** rather than
  refuses; the admin can force it.
- Discarding a queue item is its own permission, not inherited from the delete
  permissions.

**Timing rules** (Asia/Kolkata)
- Checked in **before noon** ⇒ check-out opens **at noon**. So an 11:55 check-in
  can check out at 12:00, five minutes later. That is intended.
- Checked in **at or after noon** ⇒ check-out opens **10 minutes** later.
- Too early ⇒ show *"already checked in"*, record nothing.
- At **midnight**, any day still open is marked `not_checked_out`. Everything
  gets marked, including an 11 PM session still running — accepted. The mark is
  **descriptive, not a lock**: such a session can still be checked out.
- An 11 PM check-in appearing at 1 AM starts a **new day's** record.

**Auto-capture**
- Fires after ~600 ms of a steady whole-body frame. Blocks on multiple people.
- Deliberately **stricter than the manual shutter**: `FULL_BODY` only. The
  manual gate stays permissive because a person pressing a button has already
  judged the frame; nobody judges an automatic one.
- After ~5 seconds of unusable frames, a manual button appears with a
  *"stand straight, whole body in frame"* instruction.
- **Liveness is deferred.** A finished, tested hand-raise challenge exists at
  `grooming-frontend/src/lib/livenessChallenge.ts` and is wired to nothing.

**Symmetry (settled late, after I objected to the difference)**
- Check-in and check-out must behave the same way: both queue their analysis to
  the worker, and the **worker** stores the report and then queues the email.
- Check-out previously ran Gemini inline. That was reversed. `evaluateCheckoutNow`
  survives only for the admin Re-analyse and photo-retry paths, where a human is
  waiting.

---

## What is built (six commits on `update-attendance-flow`)

`main` is untouched at `8194487`. Nothing has been merged or pushed.

```
4b17216  Identify check-out by face, and analyse it like a check-in
6279933  Take the check-in photograph without a button press
054d520  Gate check-out on when the instructor arrived, and close abandoned days
02282af  Resolve check-ins whose face was not recognised
b801eeb  Identify instructors by face at check-in, per college
2a72871  Enroll instructor reference faces for photo-first attendance
```

**Tests: 353 backend, 132 frontend, all passing.** Typecheck and lint clean.

### New backend files
| File | Purpose |
|---|---|
| `src/services/faceRecognition.js` | Rekognition wrapper: index, search, quality-check, delete |
| `src/services/identificationSettings.js` | Per-college FACE_ONLY / SELECTOR modes |
| `src/services/identifyQueue.js` | Resolving unidentified check-ins |
| `src/services/checkoutTiming.js` | The noon / 10-minute rules |
| `src/services/openCheckIns.js` | Midnight "not checked out" marking |

### New frontend files
| File | Purpose |
|---|---|
| `components/ReferencePhotoField.tsx` | Upload a reference photo on the instructor form |
| `components/IdentificationSettingsSection.tsx` | Settings → Identification |
| `components/CollegeEnrolmentList.tsx` | Per-college instructor list for bulk enrolment |
| `components/UnidentifiedQueue.tsx` | The admin queue |

---

## Uncommitted work in progress

```
 M grooming_api_node/src/routes/attendanceRoutes.js    (storeAttendancePhoto extraction)
 M grooming_api_node/test/checkout-flow.test.js        (its structural guards updated)
?? grooming_api_node/src/services/kioskAction.js       (the kiosk decision logic)
?? grooming_api_node/test/kiosk-action.test.js         (14 tests, all passing)
```

All green. Safe to commit as-is.

`kioskAction.js` decides what one photograph does:

| recognised | day state | action | records anything |
|---|---|---|---|
| yes | no record today | `CHECK_IN` | yes |
| yes | open record, past the timing rule | `CHECK_OUT` | yes |
| yes | open record, too early | `TOO_EARLY` | **no** |
| yes | already checked out | `ALREADY_DONE` | **no** |
| no | anything | `UNIDENTIFIED` | yes (a check-in) |

---

## The code is complete

`POST /api/v2/attendance/auto` and `KioskAttendance.tsx` are built, tested and
committed (`e7ddc4d`). A face-only college's Attendance screen is now a camera:
capture → identify → popup naming the person → reset, with no buttons and no
review step. A college still in SELECTOR mode keeps the old card.

The camera belongs to the screen, not the tablet — it opens when a BOA opens
Attendance and releases when they leave.

Nothing further is required in code to run photo-first attendance. What remains
is operational, and is listed below.

**Note:** I agreed to a "thin dispatcher" refactor, then narrowed it to
extracting only the photo-storage helper, because check-in and check-out differ
deliberately — check-in refuses when its photo cannot be stored (the photo *is*
the check-in), check-out proceeds without one (attendance matters more than its
picture). Do not flatten that difference.

---

## Blocked on me, not on code

**1. The database index migration.** `one_attendance_per_day` currently keys on
`{instructor_id, attendance_day}` with a partial filter requiring only
`attendance_day` to be a string. Unidentified records carry `instructor_id:
null`, so **every unidentified check-in on one day collides** and the second is
silently rejected.

The fix exists: `WIDENED_DAILY_ATTENDANCE_INDEX` and
`migrateLegacyDailyAttendanceIndex` in `src/config/databasePreflight.js`, with
7 tests including one asserting the replacement is created *before* the old one
is dropped.

It is **deliberately not applied**. Requiring the new index made the API refuse
to start against the existing cluster — and would have done the same to
production, whose running code expects the old shape. New code and new index
must land together in a maintenance window.

**`MONGODB_URI` points at a shared production Atlas cluster (`cluster0.obvnixm`)
that my whole team and the deployed Northflank API use.** I am consulting my
mentor before any index change. Do not run migrations against it.

Two tests record the gap so it cannot be forgotten, including one named
*"until the migration runs, a second unidentified check-in still collides"*.

**2. Reference photos for ~600 instructors.** Recognition does nothing without
them. Admins will upload them before deployment, via the instructor form or the
new per-college enrolment list. The Rekognition collection currently holds
**0 faces**.

**3. The midnight cron job is not scheduled.** Needs to be added at 00:00 IST:
```
POST https://<api>/api/v2/reports/cron/close-open-checkins
Header: x-cron-secret: <CRON_SECRET>
```
Test with `?dry=1` first — it reports what it would mark without writing.

---

## Environment facts worth knowing

- **AWS is configured and working.** Collection `facultytrack-faces` exists in
  `ap-south-1`, IAM policy `FacultyTrackRekognition` is attached, and the four
  `REKOGNITION_*` keys are in `.env`. Verified by a live call.
- **`.env` has `NODE_ENV="production"` on the laptop**, pointing at the shared
  production cluster. This nearly caused a live index change. A dev cluster or
  local MongoDB would be worth having.
- **`grooming-frontend/.env` does not exist.** `npm run build` fails locally
  without `VITE_API_BASE`; CI sets `https://api.example.com`.
- An unused `OPENAI_API_KEY` remains in `.env` from before the Gemini switch.

## How I want to work

- Everything on the `update-attendance-flow` branch. `main` stays untouched.
- Explain what will change **before** editing. One change at a time. Show me
  `git diff`. Nothing commits unless I say so.
- Commit messages: one commit per stage, with a per-file explanation in the body
  saying *why*, not just what.
- Run the tests after every change. `npm test` passing does not mean the app
  compiles — typecheck and build must run too.
