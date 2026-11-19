# Finance & Billing integration — LMS_IND ⇄ VanguardLMS

LMS_IND remains the learning application and the source of truth for learners
and courses. VanguardLMS runs beside it as the **Billing & Finance API** and is
the source of truth for transactions, receipts, and refunds.

```
combinesystem/
├── LMS_IND/          LMS, auth, users, courses (port 3000)
└── VanguardLMS/
    └── VanguardLMS/  Billing API, HitPay adapter (port 4000)
```

## Architecture

```
Browser ──HTTPS/session──► LMS_IND
                              │  signed server-to-server call
                              ▼
                        VanguardLMS Billing API
                              │  create payment request
                              ▼
                         HitPay hosted checkout
                              │
                              │ signed webhook (raw-body HMAC)
                              ▼
                        VanguardLMS marks the payment
                              │  signed notification
                              ▼
                        LMS_IND re-reads the payment
                              │
                              ▼
                    enrollment / course access
```

A browser redirect back from HitPay is never sufficient. The LMS asks the
billing API for the payment over the authenticated channel. For a pending HitPay
transaction the billing API re-queries HitPay before answering.

## Data ownership

| Data | Owner |
| --- | --- |
| Learners, staff, roles, enrollments | LMS_IND |
| Courses, lessons, prices | LMS_IND |
| Transactions, receipts, refunds, revenue | VanguardLMS |
| Paid-access ledger | LMS_IND `CoursePurchases`, verified against billing |

Stable identifiers are LMS `Users.id`, LMS `Courses.id`, and the billing
transaction UUID reference. VanguardLMS never creates learner accounts and does
not own a separate catalogue; it keeps a price mirror for reporting.

## Security model

* **Service authentication** — every `/api/billing/*` request except provider
  webhooks carries:
  `X-Billing-Key`, `X-Billing-Timestamp`, and `X-Billing-Signature`, where the
  signature is HMAC-SHA256 over
  `<timestamp>\n<METHOD>\n<path>\n<sha256(raw body)>`. Requests outside the
  five-minute window, wrong keys, and bad signatures are rejected.
* **HitPay webhooks** — `POST /api/billing/webhooks/hitpay` verifies
  `Hitpay-Signature = HMAC-SHA256(rawBody, HITPAY_WEBHOOK_SALT)`. The signature
  is checked before parsing financial state. Amount, currency, transaction
  reference, and provider reference must match the stored record before it can
  become paid.
* **LMS notifications** — the billing service signs
  `<timestamp>.<rawBody>` with `LMS_WEBHOOK_SECRET`. The LMS treats the body as a
  hint and re-reads the payment from billing before unlocking.
* **Idempotency** — checkout uses a learner+course idempotency key. Provider
  events are stored with a unique event id, the paid transition is conditional,
  and `CourseEnrollments` has a unique `(courseId, userId)` index.
* **No card data** — HitPay's hosted checkout collects payment details. The LMS
  and billing service never accept or store PAN, CVV, or wallet credentials.
* **Access control** — finance pages and refunds are superadmin-only. Learners
  can only view their own purchase reference.
* **Failure isolation** — billing calls have an 8-second timeout. Finance pages
  show an explicit connection error rather than invented figures.

## Payment lifecycle

1. Learner chooses **Purchase course**.
2. LMS verifies the course price and calls billing `/checkout`.
3. Billing stores a `pending` transaction, creates a HitPay payment request with
   our reference as `reference_number`, and returns the hosted checkout URL.
4. Learner pays on HitPay.
5. HitPay posts a signed event to the registered webhook. Billing verifies the
   signature, checks amount/currency/reference, marks the transaction paid,
   issues a receipt number, and notifies the LMS.
6. LMS re-reads the payment. Only matching learner, course, amount, and a
   verified `paid` status create the enrollment and unlock the course.
7. Pending, failed, cancelled, and expired payments grant nothing.

Refunds call HitPay's `/v1/refund` with the stored HitPay charge id. Local state
only changes after HitPay accepts the refund. Partial refunds are recorded with
their refunded amount.

## Environment

Generate secrets with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Both projects load `.env` automatically. Never commit either file.

### VanguardLMS

| Variable | Purpose |
| --- | --- |
| `NODE_ENV` | `production` in production |
| `PORT` | Billing port, default `4000` |
| `SESSION_SECRET` | 32+ random characters; database-backed sessions |
| `DB_DIALECT`, `DB_STORAGE` | SQLite local option |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | MySQL |
| `BILLING_API_KEY`, `BILLING_API_SECRET` | Shared LMS-to-billing credentials |
| `BILLING_PUBLIC_URL` | Public HTTPS billing URL |
| `BILLING_CURRENCY` | `PHP` |
| `LMS_PUBLIC_URL` | Public HTTPS LMS URL used for return links |
| `LMS_WEBHOOK_URL` | `https://<lms>/api/billing/webhook` |
| `LMS_WEBHOOK_SECRET` | Must match the LMS |
| `PAYMENT_PROVIDER` | `hitpay` in production; `sandbox` only for tests |
| `HITPAY_API_KEY` | HitPay business API key |
| `HITPAY_API_URL` | Optional full API base; defaults by environment |
| `HITPAY_ENVIRONMENT` | `production` or `sandbox` |
| `HITPAY_WEBHOOK_SALT` | **Per-webhook endpoint** salt from HitPay |
| `PAYMENT_WEBHOOK_SECRET` | Only for the legacy sandbox callback |

### LMS_IND

| Variable | Purpose |
| --- | --- |
| `NODE_ENV` | `production` in production |
| `APP_URL` | Public HTTPS LMS URL |
| `PORT` | Default `3000` |
| `SESSION_SECRET` | 32+ random characters |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google OAuth web client |
| `GOOGLE_CALLBACK_URL` | `https://<lms>/auth/google/callback` |
| `BILLING_API_URL` | Public HTTPS billing URL |
| `BILLING_API_KEY`, `BILLING_API_SECRET` | Match VanguardLMS |
| `BILLING_TIMEOUT_MS` | Default `8000` |
| `LMS_WEBHOOK_SECRET` | Match VanguardLMS |
| `MAIL_HOST`, `MAIL_PORT`, `MAIL_USERNAME`, `MAIL_PASSWORD`, `MAIL_FROM_ADDRESS` | Password reset SMTP |
| `BOOTSTRAP_*_PASSWORD` | Required only when seeding a fresh production DB |

Production startup rejects missing secrets, localhost public URLs, sandbox
payment mode, and weak session secrets.

## HitPay setup

1. Create separate sandbox and production HitPay accounts. They are independent.
2. Copy the API key from **Dashboard → Settings → API Keys**.
3. Register `https://<billing-host>/api/billing/webhooks/hitpay` under
   **Developers → Webhook Endpoints**.
4. Subscribe to `payment_request.completed`, `payment_request.failed`, and
   `charge.updated`.
5. Copy the **webhook endpoint salt** into `HITPAY_WEBHOOK_SALT`. Do not use the
   API-key salt, which signs legacy callbacks differently.
6. Set `PAYMENT_PROVIDER=hitpay`, `HITPAY_ENVIRONMENT=production`, and the
   production API key/base URL. Restart billing.

## Google setup

Create an OAuth **Web application** client in Google Cloud Console. Add the exact
authorized redirect URI `https://<lms-host>/auth/google/callback`. The app uses
authorization code + PKCE + state, verifies `email_verified`, links Google only
to existing learner accounts with the same verified email, and never grants a
staff role through OAuth.

## Migration and startup

Both migrations are additive and preserve existing rows.

```bash
cd VanguardLMS/VanguardLMS
npm install
npm run migrate
npm start

cd ../../LMS_IND
npm install
npm run migrate
npm start
```

The billing service must be reachable before the LMS starts taking purchases.
Use MySQL for multiple instances; SQLite is suitable for a single small node.

## Removing demo/test data

```bash
cd LMS_IND
node scripts/remove-demo-learners.mjs          # dry run
node scripts/remove-demo-learners.mjs --apply

cd ../VanguardLMS/VanguardLMS
node scripts/remove-test-billing.mjs           # dry run
node scripts/remove-test-billing.mjs --apply
```

Only learners on the reserved test domains (`@lms.test`, `@example.test`) are
removed. Staff accounts and real external learner accounts are preserved. The
current local database retains only the three staff accounts and the real
learner account.

## Tests

`cd LMS_IND && npm run test:integration` runs 55 checks against both running
services: authentication, RBAC, catalog, free enrollment, finance navigation,
signed/unsigned API access, price mirroring, pending checkout, paid fulfillment,
receipts, duplicate webhooks, failed payments, reports, and existing LMS pages.

Latest local run: **55 checks, 55 passed, 0 failed** (sandbox provider).
Real Google OAuth and live HitPay charges require valid Google/HitPay credentials
and cannot be validated with placeholders.

## Operational notes

* Finance data is never deleted; course catalogue entries are archived.
* A refund does not automatically revoke an existing enrollment; that is an
  administrative policy decision.
* HitPay webhooks are acknowledged with `202` when the event does not belong to
  a stored transaction, preventing unrelated retries.
* Provider amount or currency mismatches are rejected (`422`) and never unlock
  a course.
