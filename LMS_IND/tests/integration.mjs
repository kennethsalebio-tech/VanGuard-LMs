/*
 * End-to-end integration test: LMS_IND <-> VanguardLMS billing API.
 *
 * Requires both applications to be running:
 *   VanguardLMS  PORT=4000 (BILLING_API_KEY / BILLING_API_SECRET set)
 *   LMS_IND      PORT=3000 (same BILLING_API_KEY / BILLING_API_SECRET,
 *                           LMS_WEBHOOK_SECRET matching VanguardLMS)
 *
 * Run with:  npm run test:integration
 */
import "dotenv/config";
import crypto from "crypto";
import sqlite3 from "sqlite3";

const LMS = process.env.LMS_URL || "http://localhost:3000";
const BILLING = process.env.BILLING_URL || "http://localhost:4000";
const API_KEY = process.env.BILLING_API_KEY || "test-key";
const API_SECRET = process.env.BILLING_API_SECRET || "test-secret";
const WEBHOOK_SECRET = process.env.LMS_WEBHOOK_SECRET || "test-lms-secret";

const results = [];
let failures = 0;

function check(name, condition, detail = "") {
  const passed = Boolean(condition);
  if (!passed) failures += 1;
  results.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function sign(method, path, rawBody, timestamp) {
  const canonical = `${timestamp}\n${method}\n${path}\n${crypto
    .createHash("sha256")
    .update(rawBody || "")
    .digest("hex")}`;
  return crypto.createHmac("sha256", API_SECRET).update(canonical).digest("hex");
}

async function billingApi(method, path, body) {
  const raw = body == null ? "" : JSON.stringify(body);
  const timestamp = Date.now();
  const response = await fetch(`${BILLING}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-billing-key": API_KEY,
      "x-billing-timestamp": String(timestamp),
      "x-billing-signature": sign(method, path, raw, timestamp),
    },
    body: raw || undefined,
    redirect: "manual",
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, text };
}

function query(dbPath, sql, params = []) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath);
    db.all(sql, params, (error, rows) => {
      db.close();
      if (error) reject(error);
      else resolve(rows);
    });
  });
}

function execute(dbPath, sql, params = []) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath);
    db.run(sql, params, function (error) {
      db.close();
      if (error) reject(error);
      else resolve(this.changes);
    });
  });
}

const LMS_DB = process.env.LMS_DB || "data/lms.sqlite";
const BILLING_DB = process.env.BILLING_DB || "../VanguardLMS/VanguardLMS/data/billing.sqlite";

async function resetDemoAccess(userId, courseId) {
  await execute(LMS_DB, "delete from LessonProgresses where userId = ? and courseId = ?", [userId, courseId]);
  await execute(LMS_DB, "delete from CourseProgresses where userId = ? and courseId = ?", [userId, courseId]);
  await execute(LMS_DB, "delete from CourseEnrollments where userId = ? and courseId = ?", [userId, courseId]);
  await execute(
    LMS_DB,
    "delete from CoursePurchases where userId = ? and courseId = ? and provider = 'demo'",
    [userId, courseId]
  );
}

/* ------------------------------------------------------------- browser jar */

function makeSession() {
  const cookies = new Map();
  return {
    cookies,
    header() {
      return Array.from(cookies.entries())
        .map(([name, value]) => `${name}=${value}`)
        .join("; ");
    },
    absorb(response) {
      const raw = response.headers.getSetCookie?.() || [];
      for (const line of raw) {
        const [pair] = line.split(";");
        const index = pair.indexOf("=");
        if (index > 0) cookies.set(pair.slice(0, index), pair.slice(index + 1));
      }
    },
    async fetch(path, options = {}) {
      const response = await fetch(`${LMS}${path}`, {
        ...options,
        redirect: "manual",
        headers: {
          ...(options.headers || {}),
          ...(cookies.size ? { cookie: this.header() } : {}),
        },
      });
      this.absorb(response);
      const text = await response.text();
      return { status: response.status, location: response.headers.get("location"), text };
    },
  };
}

function csrf(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  return match ? match[1] : null;
}

function formBody(fields) {
  return new URLSearchParams(fields).toString();
}

async function login(session, email, password) {
  const page = await session.fetch("/login");
  const token = csrf(page.text);
  const response = await session.fetch("/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: formBody({ email, password, _csrf: token }),
  });
  return response;
}

async function pricedCourseId(session) {
  // Admin page renders one price form per course; ids come from the action URL.
  const page = await session.fetch("/admin/courses");
  const ids = [...page.text.matchAll(/action="\/admin\/courses\/(\d+)\/price"/g)].map((m) =>
    Number(m[1])
  );
  return { page, ids };
}

/* --------------------------------------------------------------- the suite */

const admin = makeSession();
const existingLearner = makeSession();
const learner = makeSession();
const secondLearner = makeSession();

console.log("\n=== 1. Existing authentication ===");
const stamp = Date.now();
const existingLearnerEmail = `qa.existing.${stamp}@example.test`;
const adminLogin = await login(admin, "admin@lms.test", "Admin@123");
check("Admin can sign in", adminLogin.status === 302 && adminLogin.location === "/admin",
  `${adminLogin.status} → ${adminLogin.location}`);

const seedUsersPage = await admin.fetch("/admin/users");
const seedToken = csrf(seedUsersPage.text);
const existingCreated = await admin.fetch("/admin/users", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: formBody({
    name: "QA Existing Learner",
    email: existingLearnerEmail,
    password: "Learn@123",
    role: "learner",
    _csrf: seedToken,
  }),
});
check("Disposable existing learner created", existingCreated.status === 302, `HTTP ${existingCreated.status}`);
const learnerLogin = await login(existingLearner, existingLearnerEmail, "Learn@123");
check("Learner can sign in", learnerLogin.status === 302 && learnerLogin.location === "/dashboard",
  `${learnerLogin.status} → ${learnerLogin.location}`);

console.log("\n=== 2. Existing LMS pages still work ===");
const adminHome = await admin.fetch("/admin");
check("Admin dashboard renders", adminHome.status === 200 && adminHome.text.includes("Dashboard"));
const adminUsers = await admin.fetch("/admin/users");
check("User management renders", adminUsers.status === 200);
const adminReports = await admin.fetch("/admin/reports");
check("Reports page renders", adminReports.status === 200);
const learnerHome = await existingLearner.fetch("/dashboard");
check("Learner dashboard renders", learnerHome.status === 200);
const learnerCourses = await existingLearner.fetch("/courses");
check("Course catalog renders", learnerCourses.status === 200);
const certificates = await existingLearner.fetch("/certificates");
check("Certificates page renders", certificates.status === 200);

console.log("\n=== 2b. Provision disposable learners for the purchase flow ===");
const buyerEmail = `buyer.${stamp}@example.test`;
const failedBuyerEmail = `failed.${stamp}@example.test`;
const usersPage = await admin.fetch("/admin/users");
const usersToken = csrf(usersPage.text);
for (const [name, email] of [
  ["Integration Buyer", buyerEmail],
  ["Integration Failed Buyer", failedBuyerEmail],
]) {
  const created = await admin.fetch("/admin/users", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: formBody({ name, email, password: "Learn@123", role: "learner", _csrf: usersToken }),
  });
  check(`Test learner ${email} created`, created.status === 302, `HTTP ${created.status}`);
}
const buyerLogin = await login(learner, buyerEmail, "Learn@123");
check("Disposable buyer can sign in", buyerLogin.status === 302, `HTTP ${buyerLogin.status}`);
const failedBuyerLogin = await login(secondLearner, failedBuyerEmail, "Learn@123");
check("Disposable failed-payment learner can sign in", failedBuyerLogin.status === 302);
const buyerId = (await query(LMS_DB, "select id from Users where email = ?", [buyerEmail]))[0].id;
const failedBuyerId = (await query(LMS_DB, "select id from Users where email = ?", [failedBuyerEmail]))[0].id;

console.log("\n=== 3. Finance navigation & authorization ===");
check(
  "Finance & Billing appears in the admin sidebar",
  adminHome.text.includes("Finance &amp; Billing") || adminHome.text.includes("Finance & Billing")
);
const denied = await existingLearner.fetch("/admin/finance");
check("Learner is denied admin finance", denied.status === 403, `HTTP ${denied.status}`);

console.log("\n=== 4. Billing API connectivity ===");
const health = await billingApi("GET", "/api/billing/health");
check("Billing API answers signed requests", health.status === 200 && health.body?.ok === true,
  `${health.status} mode=${health.body?.mode}`);
const unsigned = await fetch(`${BILLING}/api/billing/dashboard`);
check("Unsigned billing request is rejected", unsigned.status === 401, `HTTP ${unsigned.status}`);

console.log("\n=== 5. Configure paid courses through the LMS ===");
const { page: coursesAdminPage, ids } = await pricedCourseId(admin);
check("Admin course management renders", coursesAdminPage.status === 200 && ids.length > 0,
  `course ids: ${ids.join(", ")}`);
const adminToken = csrf(coursesAdminPage.text);

const paidCourseId = ids.find((id) => id === 3) || ids[0];
const secondCourseId = ids.find((id) => id === 4) || ids[1];
const priceA = await admin.fetch(`/admin/courses/${paidCourseId}/price`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: formBody({ price: "2250", _csrf: adminToken }),
});
check("Administrator can set a course price", priceA.status === 302, `HTTP ${priceA.status}`);
await admin.fetch(`/admin/courses/${secondCourseId}/price`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: formBody({ price: "1499", _csrf: adminToken }),
});

const registry = await billingApi("GET", "/api/billing/courses");
const mirrored = registry.body?.items?.find((row) => row.courseId === paidCourseId);
check("Price is mirrored to the billing catalogue", Number(mirrored?.price) === 2250,
  `mirrored price: ${mirrored?.price}`);

console.log("\n=== 6. Paid labels in the existing catalog ===");
const catalog = await learner.fetch("/courses");
check("Paid course shows its price without a false PAID status",
  catalog.text.includes("PHP 2,250.00") && !catalog.text.includes("Payment pending"));
check("Free courses still show FREE label", catalog.text.includes("Free"));

const detail = await learner.fetch(`/courses/${paidCourseId}`);
check("Paid course detail labels the price and offers Purchase",
  detail.status === 200 && detail.text.includes("Paid course") && detail.text.includes("Purchase course"));

const freeRows = await query(
  LMS_DB,
  `select c.id from Courses c
   where c.status = 'published' and c.price = 0 and c.id not in (?, ?)
     and not exists (select 1 from CourseEnrollments e where e.courseId = c.id and e.userId = ?)
   order by c.id asc limit 1`,
  [paidCourseId, secondCourseId, buyerId]
);
const freeId = freeRows[0]?.id;
const freeDetail = await learner.fetch(`/courses/${freeId}`);
check("Free course detail still offers Enroll",
  freeDetail.status === 200 && freeDetail.text.includes("Enroll in this course"));

const directEnroll = await learner.fetch(`/courses/${paidCourseId}/enroll`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: formBody({ _csrf: csrf(detail.text) }),
});
const afterDirectEnroll = await learner.fetch(`/courses/${paidCourseId}`);
check(
  "Enroll cannot unlock a paid course without payment",
  afterDirectEnroll.text.includes("Purchase course") || afterDirectEnroll.text.includes("Complete the purchase"),
  `enroll HTTP ${directEnroll.status}`
);

console.log("\n=== 7. Purchase opens the demo method chooser directly ===");
const purchase = await learner.fetch(`/courses/${paidCourseId}/purchase`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: formBody({ _csrf: csrf(detail.text) }),
});
const directInvoiceRef = purchase.location?.split("/").pop();
check("Purchase redirects directly to the demo method chooser",
  purchase.status === 302 &&
    /^\/billing\/invoices\/DEMO-INV-\d{8}-[A-F0-9]{8}$/.test(purchase.location || ""),
  `${purchase.status} → ${purchase.location}`);
check("Purchase bypasses the intermediate sandbox checkout",
  !String(purchase.location || "").includes("/checkout/"));

const methodSelection = await learner.fetch(purchase.location);
const paidCourseRow = (await query(LMS_DB, "select title from Courses where id = ?", [paidCourseId]))[0];
const directInvoiceRow = (await query(
  LMS_DB,
  "select * from SimulatedInvoices where reference = ?",
  [directInvoiceRef]
))[0];
check("Demo method chooser opens without another click",
  methodSelection.status === 200 && methodSelection.text.includes("Choose how to simulate payment"));
check("Method chooser shows the correct course, learner, and amount",
  methodSelection.text.includes(paidCourseRow.title.replace(/&/g, "&amp;")) &&
    methodSelection.text.includes("Integration Buyer") &&
    methodSelection.text.includes("PHP 2,250.00"));
check("All three demo methods are offered",
  ["GCash-inspired", "Maya-inspired", "MariBank-inspired"].every((name) =>
    methodSelection.text.includes(name)));
check("Pending demo invoice is valid and server-priced",
  directInvoiceRow?.userId === buyerId &&
    directInvoiceRow?.courseId === paidCourseId &&
    Number(directInvoiceRow?.amount) === 2250 &&
    directInvoiceRow?.status === "open",
  `${directInvoiceRow?.userId}/${directInvoiceRow?.courseId} · ${directInvoiceRow?.amount} · ${directInvoiceRow?.status}`);
const demoBillingLookup = await billingApi("GET", `/api/billing/payments/${directInvoiceRef}`);
check("Demo invoice is not a real billing transaction", demoBillingLookup.status === 404);

const beforePay = await learner.fetch(`/courses/${paidCourseId}`);
check("Creating a pending demo invoice does not unlock the course",
  !beforePay.text.includes("Continue learning") && beforePay.text.includes("Purchase course"));

console.log("\n=== 8. Repeat clicks reuse the invoice; simulation unlocks the course ===");
const repeatToken = csrf((await learner.fetch("/profile")).text);
const repeatPurchase = await learner.fetch(`/courses/${paidCourseId}/purchase`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: formBody({ _csrf: repeatToken }),
});
const openInvoices = await query(
  LMS_DB,
  "select count(*) as total from SimulatedInvoices where userId = ? and courseId = ? and status = 'open'",
  [buyerId, paidCourseId]
);
check("Repeated Purchase reuses the existing pending demo invoice",
  repeatPurchase.location === purchase.location && Number(openInvoices[0].total) === 1,
  `redirect: ${repeatPurchase.location}, open invoices: ${openInvoices[0].total}`);

const directGcash = await learner.fetch(`/billing/invoices/${directInvoiceRef}/pay/gcash`);
const directPay = await learner.fetch(`/billing/invoices/${directInvoiceRef}/pay/gcash`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: formBody({ _csrf: csrf(directGcash.text), amount: "1" }),
});
const directDemoRow = (await query(
  LMS_DB,
  "select * from SimulatedTransactions where invoiceId = ?",
  [directInvoiceRow.id]
))[0];
check("Demo payment from the Purchase flow completes",
  directPay.status === 302 && directPay.location?.includes("/billing/transactions/DEMO-TXN-"));
check("Simulation stores the invoice amount and demo status",
  Number(directDemoRow?.amount) === 2250 && directDemoRow?.status === "simulated" &&
    directDemoRow?.paymentMode === "demo");
const directDemoPurchase = (await query(
  LMS_DB,
  "select * from CoursePurchases where reference = ?",
  [directDemoRow.reference]
))[0];
const afterDirectDemo = await learner.fetch(`/courses/${paidCourseId}`);
check("Simulated payment records a paid demo purchase",
  directDemoPurchase?.status === "paid" && directDemoPurchase?.provider === "demo",
  `${directDemoPurchase?.status} / ${directDemoPurchase?.provider}`);
check("Simulated payment unlocks the course",
  afterDirectDemo.text.includes("Continue learning") &&
    afterDirectDemo.text.includes(">Paid</span>"));
// Isolate the real-billing scenario below from the demo access just granted.
await resetDemoAccess(buyerId, paidCourseId);

console.log("\n=== 9. Existing verified billing still unlocks access ===");
const realCheckout = await billingApi("POST", "/api/billing/checkout", {
  learnerId: buyerId,
  learnerName: "Integration Buyer",
  learnerEmail: buyerEmail,
  courseId: paidCourseId,
  courseTitle: paidCourseRow.title,
  amount: 2250,
  currency: "PHP",
});
check("Existing billing checkout backend still starts",
  [200, 201].includes(realCheckout.status) && Boolean(realCheckout.body?.payment?.reference),
  `HTTP ${realCheckout.status}`);
const reference = realCheckout.body?.payment?.reference;
const checkoutPage = await fetch(`${BILLING}/checkout/${reference}`);
const checkoutHtml = await checkoutPage.text();
check("Existing sandbox checkout remains marked TEST MODE",
  checkoutPage.status === 200 && checkoutHtml.includes("SANDBOX TEST MODE"));
const pendingPayment = await billingApi("GET", `/api/billing/payments/${reference}`);
check("Existing billing records the payment as pending",
  pendingPayment.body?.payment?.status === "pending");

const now = new Date().toISOString();
await execute(
  LMS_DB,
  `insert into CoursePurchases
     (userId, courseId, reference, amount, currency, status, provider, createdAt, updatedAt)
   values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [buyerId, paidCourseId, reference, 2250, "PHP", "pending", "sandbox", now, now]
);

const pendingCatalog = await learner.fetch("/courses");
check("Pending payment shows PAYMENT PENDING on the course card",
  pendingCatalog.text.includes(">Payment pending</span>") &&
    !pendingCatalog.text.includes(">Paid</span>"),
  "no simultaneous PAID badge");
const pendingDetail = await learner.fetch(`/courses/${paidCourseId}`);
check("Pending payment detail shows ONLY PAYMENT PENDING",
  pendingDetail.text.includes("Payment pending") &&
    !pendingDetail.text.includes(">Paid</span>"));

const pay = await fetch(`${BILLING}/checkout/${reference}/pay`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: formBody({ outcome: "paid" }),
  redirect: "manual",
});
check("Existing simulated provider payment completes", pay.status === 302, `HTTP ${pay.status}`);
const paidPayment = await billingApi("GET", `/api/billing/payments/${reference}`);
check("Existing billing marks the payment paid with a receipt",
  paidPayment.body?.payment?.status === "paid" && Boolean(paidPayment.body?.payment?.receiptNumber),
  paidPayment.body?.payment?.receiptNumber);

// Do not visit the status page first. The catalog reconciliation must read the
// verified billing result and replace the stale pending state by itself.
const reconciledCatalog = await learner.fetch("/courses");
check("Verified payment clears PAYMENT PENDING on the catalog",
  reconciledCatalog.text.includes(">Paid</span>") &&
    !reconciledCatalog.text.includes("Payment pending"));
check("Verified payment unlocks the course from the catalog",
  reconciledCatalog.text.includes("Continue course"));

const statusPage = await learner.fetch(`/courses/${paidCourseId}/purchase/${reference}`);
check("Verified payment still unlocks through the existing status page",
  statusPage.status === 200 && statusPage.text.includes("Payment verified"));
const unlocked = await learner.fetch(`/courses/${paidCourseId}`);
check("Verified paid course is unlocked", unlocked.text.includes("Continue learning"));
const unlockedDetailBadge = unlocked.text.includes(">Paid</span>");
check("Verified course detail shows PAID only",
  unlockedDetailBadge && !unlocked.text.includes("Payment pending"));

const buyerAgain = makeSession();
await login(buyerAgain, buyerEmail, "Learn@123");
const afterLogin = await buyerAgain.fetch("/courses");
check("Paid status persists after logging out and back in",
  afterLogin.text.includes(">Paid</span>") &&
    !afterLogin.text.includes("Payment pending"));

const eventBody = JSON.stringify({
  eventId: `payment.paid:${reference}:paid`,
  type: "payment.paid",
  data: { reference, status: "paid", learnerId: buyerId, courseId: paidCourseId, amount: 2250 },
});
for (let attempt = 0; attempt < 2; attempt += 1) {
  const timestamp = Date.now();
  const signature = crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(`${timestamp}.${eventBody}`)
    .digest("hex");
  const response = await fetch(`${LMS}/api/billing/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-lms-timestamp": String(timestamp),
      "x-lms-signature": signature,
    },
    body: eventBody,
    redirect: "manual",
  });
  check(`Existing webhook delivery ${attempt + 1} accepted`, response.status === 200, `HTTP ${response.status}`);
}

const enrollments = await query(
  LMS_DB,
  "select count(*) as total from CourseEnrollments where userId = ? and courseId = ?",
  [buyerId, paidCourseId]
);
check("Duplicate webhooks did not create a second enrollment", Number(enrollments[0].total) === 1,
  `enrollments: ${enrollments[0].total}`);
const paidTransactions = await query(
  BILLING_DB,
  "select count(*) as total from BillingTransactions where learnerId = ? and courseId = ? and status = 'paid'",
  [buyerId, paidCourseId]
);
check("Only one paid transaction exists for the verified purchase",
  Number(paidTransactions[0].total) === 1, `paid transactions: ${paidTransactions[0].total}`);
const forged = await fetch(`${LMS}/api/billing/webhook`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-lms-timestamp": String(Date.now()), "x-lms-signature": "00" },
  body: eventBody,
});
check("Unsigned webhook is rejected", forged.status === 401, `HTTP ${forged.status}`);

console.log("\n=== 10. Failed demo payment grants no access ===");
const secondDetail = await secondLearner.fetch(`/courses/${secondCourseId}`);
const secondPurchase = await secondLearner.fetch(`/courses/${secondCourseId}/purchase`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: formBody({ _csrf: csrf(secondDetail.text) }),
});
const failedRef = secondPurchase.location?.split("/").pop();
check("Second learner also lands on the demo method chooser",
  secondPurchase.status === 302 &&
    /^\/billing\/invoices\/DEMO-INV-/.test(secondPurchase.location || ""),
  `${secondPurchase.status} → ${secondPurchase.location}`);
const failedScreen = await secondLearner.fetch(`/billing/invoices/${failedRef}/pay/gcash`);
const failedSimulation = await secondLearner.fetch(`/billing/invoices/${failedRef}/fail`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: formBody({ _csrf: csrf(failedScreen.text), method: "gcash" }),
});
check("Failed simulation is reported to the learner",
  failedSimulation.status === 302 &&
    (await secondLearner.fetch(failedSimulation.location)).text.includes("Demo payment failed"));
const failedDemo = (await query(
  LMS_DB,
  "select t.status, i.status as invoiceStatus from SimulatedTransactions t join SimulatedInvoices i on i.id = t.invoiceId where i.reference = ?",
  [failedRef]
))[0];
check("Failed demo transaction is recorded without access",
  failedDemo?.status === "failed" && failedDemo?.invoiceStatus === "failed");
const failedCourse = await secondLearner.fetch(`/courses/${secondCourseId}`);
check("Failed demo payment does not unlock the course",
  !failedCourse.text.includes("Continue learning") && failedCourse.text.includes("Purchase course"));
const failedRealPayment = await billingApi("GET", `/api/billing/payments/${failedRef}`);
check("Failed demo transaction never reaches real billing", failedRealPayment.status === 404);

const failedRefLocal = `failed-${Date.now()}`;
await execute(
  LMS_DB,
  `insert into CoursePurchases
     (userId, courseId, reference, amount, currency, status, provider, createdAt, updatedAt)
   values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [buyerId, secondCourseId, failedRefLocal, 1499, "PHP", "failed", "sandbox", now, now]
);
const failedCard = await learner.fetch("/courses");
check("Failed payment shows PAYMENT FAILED only",
  failedCard.text.includes(">Payment failed</span>") &&
    !failedCard.text.includes("Payment pending"));
await execute(
  LMS_DB,
  "update CoursePurchases set status = 'cancelled' where reference = ?",
  [failedRefLocal]
);
const cancelledCard = await learner.fetch("/courses");
check("Cancelled payment shows PAYMENT CANCELLED only",
  cancelledCard.text.includes(">Payment cancelled</span>") &&
    !cancelledCard.text.includes("Payment failed"));
await execute(LMS_DB, "delete from CoursePurchases where reference = ?", [failedRefLocal]);

console.log("\n=== 11. Finance dashboard shows real API data ===");
const finance = await admin.fetch("/admin/finance");
check("Finance dashboard renders", finance.status === 200 && finance.text.includes("Finance &amp; billing"));
const dashboardApi = await billingApi("GET", "/api/billing/dashboard");
const revenue = Number(dashboardApi.body?.totals?.revenue || 0);
check("Revenue figure matches the billing API", finance.text.includes(
  revenue.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
), `API revenue: ${revenue}`);
check("Dashboard lists recent transactions", finance.text.includes(reference));
check("Test mode is disclosed", finance.text.includes("Test payment environment"));

const transactions = await admin.fetch("/admin/finance/transactions?status=paid");
check("Transaction page filters paid rows", transactions.status === 200 && transactions.text.includes(reference));
const receipt = await admin.fetch(`/admin/finance/receipts/${reference}`);
check("Receipt renders from the billing API",
  receipt.status === 200 && receipt.text.includes(paidPayment.body.payment.receiptNumber));

const reports = await billingApi("GET", "/api/billing/reports");
check("Financial report totals are consistent",
  Number(reports.body?.totals?.revenue) >= 2250, `report revenue: ${reports.body?.totals?.revenue}`);

console.log("\n=== 12. Existing LMS functionality after integration ===");
const learnList = await existingLearner.fetch("/courses");
check("Catalog still lists free and priced courses",
  learnList.text.includes("Free") && learnList.text.includes("PHP 2,250.00"));
const profile = await existingLearner.fetch("/profile");
check("Profile page renders", profile.status === 200);
// Enroll the disposable existing learner in a free course so the lesson
// player still has a real enrolled learner to test.
const freeForExisting = await existingLearner.fetch(`/courses/${freeId}`);
await existingLearner.fetch(`/courses/${freeId}/enroll`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: formBody({ _csrf: csrf(freeForExisting.text) }),
});
const lessonRow = await query(
  LMS_DB,
  `select l.id from Lessons l
   join CourseEnrollments e on e.courseId = l.courseId
   join Users u on u.id = e.userId
   where l.status = 'published' and u.email = ?
   order by l.courseId asc, l.orderIndex asc limit 1`,
  [existingLearnerEmail]
);
if (lessonRow[0]) {
  const lesson = await existingLearner.fetch(`/learn/${lessonRow[0].id}`);
  check("Existing free-course lesson player still works",
    lesson.status === 200 && lesson.text.includes("Knowledge check") ||
      lesson.text.includes("Lesson") || lesson.text.includes("Curriculum"));
} else {
  check("Existing free-course lesson player still works", false, "no enrolled lesson found");
}
const instructor = makeSession();
const instructorLogin = await login(instructor, "instructor@lms.test", "Teach@123");
check("Instructor authentication still works",
  instructorLogin.status === 302 && instructorLogin.location === "/instructor");
const instructorHome = await instructor.fetch("/instructor");
check("Instructor dashboard renders", instructorHome.status === 200);

console.log("\n=== 13. Simulated payment module ===");
const demoBilling = await existingLearner.fetch("/billing");
check("Learner billing dashboard renders", demoBilling.status === 200);
check("Billing is clearly marked as a demo", demoBilling.text.includes("DEMO / SIMULATION ONLY"));
check("All three demo methods are named",
  demoBilling.text.includes("GCash-inspired") &&
  demoBilling.text.includes("Maya-inspired") &&
  demoBilling.text.includes("MariBank-inspired"));

async function createDemoInvoice(session, courseId) {
  const page = await session.fetch("/billing");
  return session.fetch("/billing/invoices", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: formBody({ courseId, _csrf: csrf(page.text) }),
  });
}

const demoCreate = await createDemoInvoice(existingLearner, paidCourseId);
check("Demo invoice can be created", demoCreate.status === 302 &&
  demoCreate.location?.includes("/billing/invoices/DEMO-INV-"), `${demoCreate.status} → ${demoCreate.location}`);
const demoInvoiceRef = demoCreate.location?.split("/").pop();
const demoInvoiceRow = (await query(LMS_DB, "select * from SimulatedInvoices where reference = ?", [demoInvoiceRef]))[0];
check("Demo invoice reads its amount from the course server-side",
  Number(demoInvoiceRow?.amount) === 2250 && demoInvoiceRow?.status === "open",
  `${demoInvoiceRow?.amount} / ${demoInvoiceRow?.status}`);

const methodPage = await existingLearner.fetch(`/billing/invoices/${demoInvoiceRef}`);
check("Demo method selection renders", methodPage.status === 200 &&
  methodPage.text.includes("Choose how to simulate payment") &&
  methodPage.text.includes("Continue to payment"));

const gcashPage = await existingLearner.fetch(`/billing/invoices/${demoInvoiceRef}/pay/gcash`);
check("GCash-inspired demo screen renders", gcashPage.status === 200 &&
  gcashPage.text.includes("GCash-inspired") && gcashPage.text.includes("DEMO PAYMENT"));
check("Demo screen does not collect real credentials",
  !gcashPage.text.includes('type="password"') && !/\bOTP\b.*<input/i.test(gcashPage.text));
const invalidMethod = await existingLearner.fetch(`/billing/invoices/${demoInvoiceRef}/pay/card`);
check("Unknown demo method is rejected", invalidMethod.status === 302 && invalidMethod.location === "/billing");

const otherInvoiceAccess = await secondLearner.fetch(`/billing/invoices/${demoInvoiceRef}`);
check("Learner cannot open another learner's demo invoice",
  otherInvoiceAccess.status === 302 && otherInvoiceAccess.location === "/billing");
const secondBilling = await secondLearner.fetch("/billing");
const otherPayAttempt = await secondLearner.fetch(`/billing/invoices/${demoInvoiceRef}/pay/gcash`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: formBody({ _csrf: csrf(secondBilling.text), amount: "1" }),
});
check("Learner cannot pay another learner's demo invoice",
  otherPayAttempt.status === 302 &&
  (await query(LMS_DB, "select count(*) as total from SimulatedTransactions where invoiceId = ?", [demoInvoiceRow.id]))[0].total === 0);

const beforeDemoEnrollments = (await query(
  LMS_DB,
  "select count(*) as total from CourseEnrollments where userId = ? and courseId = ?",
  [demoInvoiceRow.userId, paidCourseId]
))[0].total;
const beforeDemoPurchases = (await query(
  LMS_DB,
  "select count(*) as total from CoursePurchases where userId = ? and courseId = ?",
  [demoInvoiceRow.userId, paidCourseId]
))[0].total;

const wrongAmountPay = await existingLearner.fetch(`/billing/invoices/${demoInvoiceRef}/pay/gcash`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: formBody({ _csrf: csrf(gcashPage.text), amount: "1" }),
});
check("Simulated payment completes", wrongAmountPay.status === 302 &&
  wrongAmountPay.location?.includes("/billing/transactions/DEMO-TXN-"), `${wrongAmountPay.status} → ${wrongAmountPay.location}`);
const demoTxnRef = wrongAmountPay.location?.split("/").pop();
const demoPaymentRow = (await query(LMS_DB, "select * from SimulatedTransactions where reference = ?", [demoTxnRef]))[0];
check("Frontend amount is ignored in favor of the invoice amount",
  Number(demoPaymentRow?.amount) === 2250, `stored: ${demoPaymentRow?.amount}`);
check("Demo transaction is stored as SIMULATED / DEMO",
  demoPaymentRow?.status === "simulated" && demoPaymentRow?.paymentMode === "demo");
const invoiceAfter = (await query(LMS_DB, "select * from SimulatedInvoices where id = ?", [demoInvoiceRow.id]))[0];
check("Demo invoice is marked simulated, never paid", invoiceAfter?.status === "simulated");
const afterDemoEnrollments = (await query(
  LMS_DB,
  "select count(*) as total from CourseEnrollments where userId = ? and courseId = ?",
  [demoInvoiceRow.userId, paidCourseId]
))[0].total;
const afterDemoPurchases = (await query(
  LMS_DB,
  "select count(*) as total from CoursePurchases where userId = ? and courseId = ?",
  [demoInvoiceRow.userId, paidCourseId]
))[0].total;
const demoPurchase = (await query(
  LMS_DB,
  "select * from CoursePurchases where reference = ?",
  [demoTxnRef]
))[0];
check("Simulation creates a paid demo purchase and enrollment",
  Number(afterDemoEnrollments) === Number(beforeDemoEnrollments) + 1 &&
  Number(afterDemoPurchases) === Number(beforeDemoPurchases) + 1 &&
  demoPurchase?.status === "paid" && demoPurchase?.provider === "demo",
  `enrollments ${beforeDemoEnrollments}→${afterDemoEnrollments}, purchases ${beforeDemoPurchases}→${afterDemoPurchases}`);
check("Simulated purchase unlocks the course page",
  (await existingLearner.fetch(`/courses/${paidCourseId}`)).text.includes("Continue learning"));
check("Simulation is excluded from billing service revenue",
  (await query(BILLING_DB, "select count(*) as total from BillingTransactions where learnerId = ?", [demoInvoiceRow.userId]))[0].total === 0);

const demoResult = await existingLearner.fetch(`/billing/transactions/${demoTxnRef}`);
check("Demo result page reports simulated success", demoResult.status === 200 &&
  demoResult.text.includes("Simulated payment successful") &&
  demoResult.text.includes("DEMO RECEIPT") && demoResult.text.includes(demoTxnRef));

const duplicateToken = csrf((await existingLearner.fetch("/billing")).text);
const duplicateDemo = await existingLearner.fetch(`/billing/invoices/${demoInvoiceRef}/pay/maya`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: formBody({ _csrf: duplicateToken }),
});
const demoCount = (await query(LMS_DB, "select count(*) as total from SimulatedTransactions where invoiceId = ?", [demoInvoiceRow.id]))[0].total;
check("Duplicate demo submission returns the existing transaction",
  duplicateDemo.status === 302 && duplicateDemo.location === `/billing/transactions/${demoTxnRef}` && Number(demoCount) === 1,
  `count: ${demoCount}`);

const closedInvoicePage = await existingLearner.fetch(`/billing/invoices/${demoInvoiceRef}`);
check("A simulated invoice redirects to its result instead of charging again",
  closedInvoicePage.status === 302 && closedInvoicePage.location === `/billing/transactions/${demoTxnRef}`);

const demoAdmin = await admin.fetch("/admin/finance/simulated");
check("Admin demo ledger renders", demoAdmin.status === 200 && demoAdmin.text.includes("Not real payments"));
check("Admin demo ledger lists the simulated transaction", demoAdmin.text.includes(demoTxnRef));
const demoSearch = await admin.fetch(`/admin/finance/simulated?q=${encodeURIComponent(demoTxnRef)}`);
check("Admin can search demo transactions by reference",
  demoSearch.status === 200 && demoSearch.text.includes(demoTxnRef));
const demoMethodFilter = await admin.fetch("/admin/finance/simulated?method=gcash");
check("Admin can filter demo transactions by method",
  demoMethodFilter.status === 200 && demoMethodFilter.text.includes(demoTxnRef));
const demoStatusFilter = await admin.fetch("/admin/finance/simulated?status=cancelled");
check("Admin demo status filter excludes simulated rows",
  demoStatusFilter.status === 200 && demoStatusFilter.text.includes("No simulated payments found"));
check("Admin finance revenue page does not show demo transactions",
  !(await admin.fetch("/admin/finance")).text.includes(demoTxnRef));
const demoDenied = await existingLearner.fetch("/admin/finance/simulated");
check("Learner cannot access the admin demo ledger", demoDenied.status === 403);
const demoExport = await admin.fetch("/admin/finance/simulated/export");
check("Admin can export the demo ledger as CSV", demoExport.status === 200 &&
  demoExport.text.includes("transaction_reference") && demoExport.text.includes(demoTxnRef));
const demoDetail = await admin.fetch(`/admin/finance/simulated/${demoTxnRef}`);
check("Admin can open demo transaction details", demoDetail.status === 200 &&
  demoDetail.text.includes("Not a real payment") && demoDetail.text.includes(demoInvoiceRef));

async function createAndPay(session, courseId, method) {
  const created = await createDemoInvoice(session, courseId);
  const reference = created.location?.split("/").pop();
  const screen = await session.fetch(`/billing/invoices/${reference}/pay/${method}`);
  const paid = await session.fetch(`/billing/invoices/${reference}/pay/${method}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: formBody({ _csrf: csrf(screen.text) }),
  });
  return { created, paid, reference, txn: paid.location?.split("/").pop() };
}
await resetDemoAccess(demoInvoiceRow.userId, paidCourseId);
const mayaFlow = await createAndPay(existingLearner, paidCourseId, "maya");
check("Maya-inspired demo payment completes", mayaFlow.paid.status === 302 &&
  (await existingLearner.fetch(mayaFlow.paid.location)).text.includes("Simulated payment successful"));
await resetDemoAccess(demoInvoiceRow.userId, paidCourseId);
const mariFlow = await createAndPay(existingLearner, paidCourseId, "maribank");
check("MariBank-inspired demo payment completes", mariFlow.paid.status === 302 &&
  (await existingLearner.fetch(mariFlow.paid.location)).text.includes("Simulated payment successful"));

await resetDemoAccess(demoInvoiceRow.userId, paidCourseId);
const cancelCreated = await createDemoInvoice(existingLearner, paidCourseId);
const cancelRef = cancelCreated.location?.split("/").pop();
const cancelScreen = await existingLearner.fetch(`/billing/invoices/${cancelRef}/pay/gcash`);
const cancelResponse = await existingLearner.fetch(`/billing/invoices/${cancelRef}/cancel`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: formBody({ _csrf: csrf(cancelScreen.text), method: "gcash" }),
});
check("Demo payment can be cancelled", cancelResponse.status === 302 &&
  (await existingLearner.fetch(cancelResponse.location)).text.includes("Demo payment cancelled"));

const failCreated = await createDemoInvoice(existingLearner, paidCourseId);
const failRef = failCreated.location?.split("/").pop();
const failScreen = await existingLearner.fetch(`/billing/invoices/${failRef}/pay/gcash`);
const failResponse = await existingLearner.fetch(`/billing/invoices/${failRef}/fail`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: formBody({ _csrf: csrf(failScreen.text), method: "gcash" }),
});
check("Demo failure can be simulated", failResponse.status === 302 &&
  (await existingLearner.fetch(failResponse.location)).text.includes("Demo payment failed"));
const failedDemoRow = (await query(
  LMS_DB,
  "select t.status, i.status as invoiceStatus from SimulatedTransactions t join SimulatedInvoices i on i.id = t.invoiceId where i.reference = ?",
  [failRef]
))[0];
check("Failed demo transaction is recorded without money movement",
  failedDemoRow?.status === "failed" && failedDemoRow?.invoiceStatus === "failed");

const invalidInvoice = await existingLearner.fetch("/billing/invoices/DEMO-INV-DOES-NOT-EXIST");
check("Invalid demo invoice redirects safely", invalidInvoice.status === 302 && invalidInvoice.location === "/billing");

const demoMethodNames = await query(LMS_DB, "select distinct paymentMethod from SimulatedTransactions where userId = ?", [demoInvoiceRow.userId]);
check("All three demo methods were exercised",
  ["gcash", "maya", "maribank"].every((method) => demoMethodNames.some((row) => row.paymentMethod === method)),
  demoMethodNames.map((row) => row.paymentMethod).join(", "));
const demoTotal = (await query(LMS_DB, "select count(*) as total from SimulatedTransactions where userId = ?", [demoInvoiceRow.userId]))[0].total;
check("Demo ledger is separated by invoice", Number(demoTotal) === 5, `demo rows: ${demoTotal}`);

// Keep the local database clean after the demo checks.
await resetDemoAccess(demoInvoiceRow.userId, paidCourseId);
await execute(
  LMS_DB,
  "delete from SimulatedTransactions where userId = ?",
  [demoInvoiceRow.userId]
);
await execute(
  LMS_DB,
  "delete from SimulatedInvoices where userId = ?",
  [demoInvoiceRow.userId]
);

/* ----------------------------------------------------------------- summary */

console.log("\n================ SUMMARY ================");
console.log(`Checks: ${results.length}  Passed: ${results.length - failures}  Failed: ${failures}`);
for (const row of results.filter((r) => !r.passed)) {
  console.log(`FAILED: ${row.name}${row.detail ? ` — ${row.detail}` : ""}`);
}
process.exitCode = failures ? 1 : 0;
