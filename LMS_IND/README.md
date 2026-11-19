# Vanguard Learning — Integrated LMS

A working Learning Management System built on the existing XianFire scaffold
(Express + Sequelize + Handlebars `.xian` templates). It implements the complete
core journey:

**Instructor uploads a module → it becomes a webpage lesson → learners study it →
a randomized 5-question knowledge check is graded on the server → a pass unlocks
the next lesson → course completion issues a certificate.**

All assessment randomization, grading, and unlock enforcement happen on the
server. The approved question bank and answer key are never sent to the browser.

---

## Quick start

```bash
npm install
npm start
```

Open <http://localhost:3000>. On first run the app creates `data/lms.sqlite`,
syncs all tables, and seeds only the initial staff accounts and the course
catalogue. No demo learner accounts are created.

Requirements: Node.js 18+ (tested on Node 24). SQLite is embedded; no database
server is required for local development. Both apps load `.env` automatically.

### Initial staff accounts

| Role | Email | Development password |
| --- | --- | --- |
| Super administrator | `admin@lms.test` | `Admin@123` |
| HR administrator | `hr@lms.test` | `Hr@123` |
| Instructor | `instructor@lms.test` | `Teach@123` |

These existing staff accounts are preserved. Change their passwords after the
first production sign-in. On a fresh production database, set
`BOOTSTRAP_ADMIN_PASSWORD`, `BOOTSTRAP_HR_PASSWORD`, and
`BOOTSTRAP_INSTRUCTOR_PASSWORD` before the first `npm run migrate`; the seed
refuses to run in production without them. Learners create their own accounts
at `/register` or sign in with Google.

### Reset a local database

Stop the server and remove the SQLite file, then start again:

```bash
rm data/lms.sqlite
npm start
```

`npm run migrate` (alias `npm run seed`) initializes without starting the HTTP
server. It is idempotent: existing users mean the seed is skipped. Demo/test
learners can be removed with `node scripts/remove-demo-learners.mjs` (dry run)
and `node scripts/remove-demo-learners.mjs --apply`.

---

## Finance & Billing (VanguardLMS integration)

Paid courses and finance reporting are served by the existing **VanguardLMS**
project, which runs beside this app as a Billing & Finance API. Start it first
using its own `.env`, set the matching `BILLING_API_*` and `LMS_WEBHOOK_SECRET`
variables here, then open **Admin → Finance & Billing**.

Super administrators can price any course in **Course management**; learners buy
paid courses from the normal catalog. Course access is granted only after the
billing service verifies the payment — never from the purchase click or a
redirect. If the billing service is down, finance pages show a connection error
with a retry and the rest of the LMS keeps working.

`PAYMENT_PROVIDER=hitpay` enables the real HitPay hosted checkout. The sandbox
mode exists only for local tests and is refused in production. HitPay webhooks
must be registered in the HitPay dashboard at
`https://<billing-host>/api/billing/webhooks/hitpay`; the endpoint verifies the
raw-body `Hitpay-Signature` before changing any payment state.

Full architecture, endpoints, environment variables, migration steps and test
results: [`docs/FINANCE_INTEGRATION.md`](docs/FINANCE_INTEGRATION.md).

---

## Roles

- **Super administrator** — platform dashboard, user/role management, course
  overview, HRMS, reports and CSV exports, audit logs. Can manage any course.
- **HR administrator** — employee records, departments, positions, required
  training rules, compliance reporting and CSV exports.
- **Instructor** — create and manage own courses, modules, lesson conversion,
  question banks, publishing, and learner monitoring. Cannot manage courses
  owned by another instructor.
- **Learner** — catalog, enrollment, lesson study, knowledge checks, progress,
  certificates, notifications, profile.

Route guards and ownership checks are enforced in middleware and controllers,
not just hidden in the UI. Locked lessons and locked assessment endpoints
return 403/redirects when accessed directly.

---

## The lesson workflow

1. **Create a course** (instructor) with an assessment policy: questions per
   attempt (default 5), pass score (default 4), retake rules, certificate
   toggle, explanations toggle.
2. **Add a module**, then upload a PDF, DOCX, PPTX, TXT, Markdown, or HTML file
   (25 MB limit). The original upload is kept as a downloadable resource.
3. **Automatic conversion** extracts text and produces sanitized, sectioned
   lesson HTML. Conversion notes are shown in the lesson editor.
4. **Generate a question bank** — 20–50 questions per lesson. With no LLM key,
   a deterministic local generator creates cloze and true/false questions from
   the lesson text. With an OpenAI-compatible key configured, the LLM is used.
   Every generated question is saved as `pending`.
5. **Instructor review** — edit prompts/options/explanations, approve, reject,
   delete, or add questions manually. Only `approved` questions are eligible.
6. **Publish the lesson** — blocked until at least the course's question count
   is approved. Publishing notifies enrolled learners.
7. **Learner studies** the webpage lesson, opens the knowledge check, and gets
   a server-selected random subset with shuffled option order. Exactly one
   answer per question; grading is server-side.
8. **Pass** (default 4/5) completes the lesson, unlocks the next one, updates
   progress, and eventually issues a certificate. Failure records the attempt
   and leaves the lesson in progress.
9. **Certificate** — printable HTML (use the browser's Save as PDF) with a
   public verification page at `/verify` using the certificate ID or code.

Every attempt receives a unique random set and option order. Retakes are
governed by `allowRetakes` and `maxAttempts`.

---

## AI-assisted question generation

- Generated questions are **drafts**. They can never enter an assessment until
  an instructor approves them individually or via "Approve all pending".
- The instructor can edit every prompt, option, correct answer, explanation,
  and difficulty before or after approval.
- Without an API key the local generator runs entirely offline and
  deterministically. It is extractive (cloze/true-false) rather than a general
  LLM, so question quality is bounded by the source document's sentences.
- `generatedBy` records `ai` vs `instructor`, and bank status is derived from
  the number of approved questions.

Optional configuration (OpenAI-compatible `/chat/completions` endpoint):

```bash
export LLM_API_KEY=...
export LLM_BASE_URL=https://api.openai.com/v1
export LLM_MODEL=gpt-4o-mini
```

---

## Vanguard Live Classroom

Instructors can start an instant live class or schedule one from
`/instructor/live` (also linked from the dashboard and the course builder).
Every learner enrolled in the selected course is invited, notified, and given a
participant record; nobody else can open the room.

- **Conferencing:** native WebRTC video with one direct peer connection per
  participant, inside the existing room shell. Camera, microphone, screen
  sharing, participant tiles and chat are all rendered by the LMS; there is no
  third-party iframe or external video service to load.
- **Authorization:** the room checks the signed-in user on every request — host
  ownership or course enrollment. Meeting access tokens are HMAC-signed on the
  server (6-hour expiry) and bound to the meeting id and user id. Signaling
  messages are CSRF-protected and only relayed between joined participants.
- **Media:** the browser captures camera/microphone with `getUserMedia`, sends
  tracks over pre-created audio/video transceivers, and renders remote tracks in
  participant tiles. Camera toggles stop/unpublish the video track and restore
  it without leaving the room; the button reflects the real track state.
- **Camera device selection:** the meeting details page offers a camera check
  (permission test, live preview, device picker), and the room toolbar can switch
  cameras mid-call. The choice is remembered on the device.
- **Rooms:** each session gets a unique, unguessable room name stored in the
  database. Rooms are never listed publicly.
- **Chat:** stored server-side per meeting and polled by the room page.
- **Attendance:** a participant row records invitation state, and an attendance
  row is written for every actual join/leave with a duration. Receiving a
  notification never counts as attendance. Hosts can review attendance on the
  meeting page and remove a participant from the room.
- **Notifications:** scheduled, started, cancelled and ended events are sent
  through the existing notification system; Open resolves to the meeting page.
- **Recording:** never enabled by default. Use OS/browser capture with
  participants' consent if a recording is needed.

Browsers require explicit camera/microphone permission (media APIs also require
HTTPS or `localhost`). If permission is denied, no camera exists, or the device
is busy, the room shows that state, keeps chat and attendance working, and
offers a retry — it never reports “Camera on” without a live video track.

Media works on `localhost` and any HTTPS deployment. Configure ICE servers with
`WEBRTC_ICE_SERVERS` (JSON or comma-separated STUN URLs) and, for restrictive
networks, `TURN_URL` / `TURN_USERNAME` / `TURN_CREDENTIAL`. Only the resulting
browser-required ICE list is sent to the room page; no other secret is exposed.

## Production deployment

1. Create independent `.env` files in `LMS_IND/` and `VanguardLMS/VanguardLMS/`.
   Never reuse the development secrets. Both files are git-ignored.
2. Put both services behind HTTPS (reverse proxy or managed platform) and set
   `NODE_ENV=production`. The LMS sets secure session cookies and requires
   public HTTPS URLs; VanguardLMS requires HTTPS billing and webhook URLs.
3. Point `DB_DIALECT=mysql` at a managed database for multi-instance
   deployments. SQLite remains supported for a single small instance.
4. Run `npm run migrate` in each project once, then start the billing service
   before the LMS.
5. Google Cloud Console → OAuth web client: add the exact production callback
   `https://<lms-host>/auth/google/callback`. The app requests `openid email
   profile`, validates state/PKCE, and refuses unverified Google emails.
6. HitPay dashboard → Developers → Webhook Endpoints: register
   `https://<billing-host>/api/billing/webhooks/hitpay` and subscribe to
   `payment_request.completed`, `payment_request.failed`, and
   `charge.updated`. Copy that endpoint's **webhook salt** into
   `HITPAY_WEBHOOK_SALT` (not the API-key salt). Set `PAYMENT_PROVIDER=hitpay`
   and the production `HITPAY_API_KEY` / `HITPAY_API_URL`.
7. Configure SMTP (`MAIL_*`) so password reset links can be delivered.
8. After the first sign-in, change the three staff passwords from User
   Management. Keep the supervisor, HR, and instructor accounts password-only.

The integration suite can be run against the deployed services with
`LMS_URL`/`BILLING_URL` and the same secrets in the environment. Its disposable
accounts use reserved `@example.test` addresses and are removed by the cleanup
scripts.

## Configuration

The project loads `.env` automatically through `dotenv`. Never commit `.env`.
Production startup validates every required secret and refuses localhost URLs.

| Variable | Default | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `development` | Set to `production` in production |
| `APP_URL` | `http://localhost:3000` | Public HTTPS URL |
| `PORT` | `3000` | HTTP port |
| `SESSION_SECRET` | dev fallback | Session signing secret; 32+ random characters in production |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL` | — | Google OAuth web client; callback must be `/auth/google/callback` |
| `BILLING_API_URL`, `BILLING_API_KEY`, `BILLING_API_SECRET` | — | Server-to-server billing credentials (must match VanguardLMS) |
| `LMS_WEBHOOK_SECRET` | — | Verifies signed payment notifications from the billing service |
| `MAIL_HOST`, `MAIL_PORT`, `MAIL_USERNAME`, `MAIL_PASSWORD`, `MAIL_FROM_ADDRESS` | — | SMTP delivery for password reset links |
| `BOOTSTRAP_ADMIN_PASSWORD`, `BOOTSTRAP_HR_PASSWORD`, `BOOTSTRAP_INSTRUCTOR_PASSWORD` | dev fallbacks | Required only when seeding a fresh production database |
| `WEBRTC_ICE_SERVERS` | Google STUN | ICE server JSON or comma-separated STUN URLs |
| `TURN_URL` / `TURN_USERNAME` / `TURN_CREDENTIAL` | — | TURN relay for restrictive networks |
| `DB_DIALECT` | `sqlite` | `sqlite` or `mysql` |
| `DB_STORAGE` | `data/lms.sqlite` | SQLite file path |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | — | MySQL connection |
| `LLM_API_KEY` / `OPENAI_API_KEY` | — | Enables LLM question generation |
| `LLM_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible base URL |
| `LLM_MODEL` | `gpt-4o-mini` | Model name |

The default SQLite database means the app runs without Laragon/MySQL. To point
at MySQL, create the database, set `DB_DIALECT=mysql` and the `DB_*` variables,
then run `npm run migrate`.

---

## Security and integrity notes

- Passwords hashed with bcrypt (cost 10); session ID regenerated on login and
  after password reset. Sessions are stored in the database, not process memory.
- Google sign-in uses authorization code + PKCE + state, verifies Google's
  `email_verified` claim, and links only existing learner accounts. Staff
  accounts remain password-only.
- Password reset tokens are random, stored only as SHA-256 hashes, expire after
  30 minutes, are single-use, and revoke existing sessions.
- Custom CSRF tokens on all state-changing forms, including a post-multipart
  verification path for uploads.
- Login rate limiting: 8 attempts per IP+email per 15 minutes; reset requests
  are limited to 5 per IP per hour (in-memory).
- Security headers, `httpOnly`/`sameSite=lax`/secure-in-production session
  cookie, upload type and size validation, sanitized lesson HTML.
- Billing amounts, currencies, and provider references are checked server-side;
  duplicated provider events are idempotent.
- Server-side question selection, option shuffling, grading, pass/fail, and
  unlock checks. The full bank is never serialized to the client.
- RBAC middleware plus per-course ownership checks on every instructor action.
- Audit log for sign-in, enrollment, lesson publication, question generation,
  assessment outcomes, and administrative changes.

---

## Known limitations (reported honestly)

- **No proctoring.** Cameras/microphones are never activated. There are no
  lockdown browsers, identity checks, or exam scheduling.
- **PDF export is browser-based.** Certificates are printable HTML; the app
  does not generate a server-side PDF. There is no QR code image — the
  verification code and `/verify` URL are provided instead.
- **No OCR.** Scanned/image-only PDFs convert with little or no text. Text-based
  PDF, DOCX, PPTX, TXT, MD, and HTML are supported.
- **SCORM/xAPI are not implemented.** There is no LMS-to-LRS integration or
  package import/export. This is documented rather than faked.
- **SMTP credentials are required for password reset email.** Without
  `MAIL_HOST`/`MAIL_FROM_ADDRESS`, the endpoint still returns a generic success
  message but no reset link is sent; an administrator must reset the password
  from User Management.
- **Rate limiting is in-process**, while sessions are database-backed. For
  multi-instance deployments, use a shared limiter such as Redis.
- **Live video is a peer-to-peer mesh**, so it is intended for normal class
  sizes (each participant sends one stream per peer). Very large sessions need
  an SFU. Participants behind symmetric NATs or corporate firewalls require a
  TURN server, and signaling is in-process (single-instance deployment).
- **Local generator quality is limited.** It is deterministic and extractive,
  not a semantic LLM. LLM generation is optional and requires a key.
- The integration suite (`npm run test:integration`) runs 55 checks against both
  running services. Real Google OAuth completion and live HitPay charges require
  valid Google and HitPay credentials and cannot be exercised with placeholders.

---

## Project structure

```
index.js                     App bootstrap, helpers, partials, middleware, errors
routes/                      auth, learner, instructor, admin routers
controllers/                 auth, learner, instructor, admin
models/                      Sequelize models, associations, seed data
services/                    document conversion, question generation,
                             progress/unlocking/certificates, HR assignment,
                             scoring, notification routing, live classroom
middleware/                  auth/RBAC, CSRF/security, upload, async wrapper
routes/live.js               Live Classroom meeting room and room APIs
views/                       .xian Handlebars pages and partials
public/lms.css               Lesson typography, inputs, certificate print styles
uploads/                     Uploaded module files (created at runtime)
data/lms.sqlite              Default SQLite database (created at runtime)
```
