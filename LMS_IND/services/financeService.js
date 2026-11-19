/*
 * Finance integration service for LMS_IND.
 *
 * VanguardLMS owns billing records; this service is the only place the LMS
 * talks to it. It also owns the access decision: a paid course is unlocked only
 * after the *billing server* reports a verified paid transaction whose learner,
 * course and amount match the local purchase record.
 */
import crypto from "crypto";
import { Op } from "sequelize";
import {
  Course,
  CoursePurchase,
  CourseEnrollment,
  ActivityLog,
  sequelize,
} from "../models/index.js";
import { billing, BillingError, billingConfigured } from "./billingClient.js";
import {
  ensureProgressRows,
  recalcCourseProgress,
  notify,
} from "./progressService.js";

export { BillingError, billingConfigured };

export function courseIsPaid(course) {
  return Boolean(course) && Number(course.price || 0) > 0;
}

export function formatPeso(value, currency = "PHP") {
  const amount = Number(value || 0);
  return `${currency} ${amount.toLocaleString("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function money(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : 0;
}

export function serializePurchase(purchase) {
  if (!purchase) return null;
  const row = purchase.toJSON ? purchase.toJSON() : purchase;
  return {
    reference: row.reference,
    courseId: row.courseId,
    userId: row.userId,
    amount: money(row.amount),
    currency: row.currency,
    status: row.status,
    provider: row.provider,
    receiptNumber: row.receiptNumber || null,
    paidAt: row.paidAt || null,
    createdAt: row.createdAt,
  };
}

function idempotencyKeyFor(userId, courseId) {
  return crypto
    .createHash("sha256")
    .update(`lms-purchase:${userId}:${courseId}`)
    .digest("hex");
}

export async function purchasesFor(userId) {
  return CoursePurchase.findAll({
    where: { userId },
    order: [["createdAt", "DESC"]],
  });
}

export async function findPurchase(reference) {
  return CoursePurchase.findOne({ where: { reference: String(reference || "") } });
}

export async function findPaidPurchase(userId, courseId) {
  return CoursePurchase.findOne({
    where: { userId, courseId, status: "paid" },
    order: [["paidAt", "DESC"]],
  });
}

/**
 * Pick the purchase that represents the learner's current payment state.
 * A verified paid row wins over a stale pending row, while a newer refund is
 * allowed to supersede the earlier paid state.
 */
export function selectPaymentPurchase(purchases = []) {
  const rows = [...purchases].sort((left, right) => {
    const leftTime = new Date(left.createdAt || left.paidAt || 0).getTime();
    const rightTime = new Date(right.createdAt || right.paidAt || 0).getTime();
    return rightTime - leftTime || Number(right.id || 0) - Number(left.id || 0);
  });
  const latest = rows[0] || null;
  if (latest?.status === "refunded") return latest;
  return rows.find((row) => row.status === "paid") || latest;
}

const PAYMENT_BADGES = {
  paid: { label: "Paid", tone: "paid" },
  pending: { label: "Payment pending", tone: "pending" },
  failed: { label: "Payment failed", tone: "failed" },
  cancelled: { label: "Payment cancelled", tone: "cancelled" },
  refunded: { label: "Payment refunded", tone: "refunded" },
};

export function paymentBadgeFor(purchase) {
  if (!purchase) return null;
  const badge = PAYMENT_BADGES[purchase.status];
  return badge ? { ...badge, status: purchase.status } : null;
}

/**
 * Re-read pending payments from the billing service and apply only a verified
 * result, then repair a verified purchase whose enrollment is missing. This
 * covers a missed webhook or a page loaded before the provider confirmed.
 * Demo invoices are deliberately excluded.
 */
export async function reconcileLearnerPayments(userId, { courseId } = {}) {
  const scope = { userId };
  if (courseId) scope.courseId = courseId;
  const purchases = await CoursePurchase.findAll({ where: scope });
  const pending = purchases.filter((purchase) => purchase.status === "pending");

  let updated = 0;
  for (const purchase of pending) {
    try {
      const result = await refreshPurchase(purchase.reference);
      if (result.fulfilled) updated += 1;
    } catch (error) {
      console.warn(
        `[finance] Could not reconcile ${purchase.reference}:`,
        error.code || error.message
      );
      // A billing outage should not block the catalog; try again next visit.
      break;
    }
  }

  const enrollments = await CourseEnrollment.findAll({ where: scope });
  const enrolled = new Set(enrollments.map((row) => row.courseId));
  const paid = purchases.filter(
    (purchase) => purchase.status === "paid" && !enrolled.has(purchase.courseId)
  );
  for (const purchase of paid) {
    await CourseEnrollment.findOrCreate({
      where: { userId, courseId: purchase.courseId },
      defaults: { source: "purchase", status: "active" },
    });
    try {
      await ensureProgressRows(userId, purchase.courseId);
      await recalcCourseProgress(userId, purchase.courseId);
    } catch (error) {
      console.warn(
        `[finance] Access repaired but progress setup failed for course ${purchase.courseId}:`,
        error.message
      );
    }
    updated += 1;
  }

  return { checked: pending.length, paidRepaired: paid.length, updated };
}

/**
 * Push the LMS course price to the billing catalogue. LMS is the source of
 * truth; the billing service keeps only a mirror for reporting and receipts.
 * A failure here must never block saving the course, so it is logged only.
 */
export async function syncCourseToBilling(course) {
  if (!billingConfigured()) return { synced: false, reason: "not_configured" };
  try {
    await billing.syncCourse({
      courseId: course.id,
      title: course.title,
      instructorName: course.instructor?.name || null,
      price: money(course.price),
      currency: course.currency || "PHP",
    });
    return { synced: true };
  } catch (error) {
    console.warn(
      `[finance] Could not sync course ${course.id} to the billing service:`,
      error.message
    );
    return { synced: false, reason: error.code || "billing_unavailable" };
  }
}

/**
 * Start (or resume) a purchase. Nothing is unlocked here — the learner is sent
 * to the billing service's checkout, and access is only granted later by
 * `fulfillPurchase` after server-side verification.
 */
export async function startPurchase(user, course) {
  if (!courseIsPaid(course)) {
    const error = new BillingError("This course is free — no purchase is required.", {
      status: 400,
      code: "course_is_free",
    });
    throw error;
  }

  const enrolled = await CourseEnrollment.findOne({
    where: { userId: user.id, courseId: course.id },
  });
  if (enrolled) {
    return { alreadyEnrolled: true, purchase: null, checkoutUrl: null };
  }

  const paid = await findPaidPurchase(user.id, course.id);
  if (paid) {
    // Billing was paid but the local enrollment is missing (e.g. restored DB):
    // recover access from the verified record instead of charging again.
    await fulfillPurchase(paid, {
      reference: paid.reference,
      learnerId: user.id,
      courseId: course.id,
      amount: paid.amount,
      status: "paid",
      receiptNumber: paid.receiptNumber,
      paidAt: paid.paidAt,
    });
    return { alreadyEnrolled: true, purchase: serializePurchase(paid), checkoutUrl: null };
  }

  const result = await billing.checkout(
    {
      learnerId: user.id,
      learnerName: user.name,
      learnerEmail: user.email,
      courseId: course.id,
      courseTitle: course.title,
      instructorName: course.instructor?.name || null,
      amount: money(course.price),
      currency: course.currency || "PHP",
    },
    idempotencyKeyFor(user.id, course.id)
  );

  const payment = result.payment;
  if (!payment?.reference) {
    throw new BillingError("The billing service did not return a payment reference.", {
      code: "invalid_billing_response",
    });
  }

  const [purchase] = await CoursePurchase.findOrCreate({
    where: { reference: payment.reference },
    defaults: {
      userId: user.id,
      courseId: course.id,
      amount: money(payment.amount ?? course.price),
      currency: payment.currency || course.currency || "PHP",
      // Always start pending locally: only fulfillPurchase() may mark it paid,
      // and only after it has re-checked the billing response.
      status: "pending",
      provider: payment.provider || "sandbox",
    },
  });

  if (payment.status === "paid") {
    await fulfillPurchase(purchase, {
      ...payment,
      learnerId: user.id,
      courseId: course.id,
    });
  }

  return {
    alreadyEnrolled: payment.status === "paid",
    purchase: serializePurchase(purchase),
    checkoutUrl: result.checkoutUrl,
    duplicate: Boolean(result.duplicate),
  };
}

/**
 * Mark a verified payment as paid and unlock the course. Idempotent: the status
 * transition only happens once, and CourseEnrollment has a unique
 * (courseId, userId) index, so repeated webhooks cannot duplicate enrollments.
 */
export async function fulfillPurchase(purchase, payment) {
  if (!purchase) return { fulfilled: false, reason: "purchase_missing" };

  const amountMatches = money(payment.amount) === money(purchase.amount);
  const identityMatches =
    Number(payment.learnerId) === Number(purchase.userId) &&
    Number(payment.courseId) === Number(purchase.courseId);
  const currencyMatches =
    !payment.currency ||
    String(payment.currency).toUpperCase() ===
      String(purchase.currency || "PHP").toUpperCase();
  const verified = payment.status === "paid";

  if (!verified || !amountMatches || !identityMatches || !currencyMatches) {
    console.warn(
      `[finance] Refusing to unlock ${purchase.reference}: verified=${verified} amount=${amountMatches} identity=${identityMatches} currency=${currencyMatches}`
    );
    return { fulfilled: false, reason: "verification_failed" };
  }

  // Mark the purchase paid and create enrollment in one transaction. A failure
  // in either write rolls both back, so a card can never show PAID without the
  // access record (or vice versa).
  const fulfilled = await sequelize.transaction(async (transaction) => {
    const [updated] = await CoursePurchase.update(
      {
        status: "paid",
        paidAt: payment.paidAt ? new Date(payment.paidAt) : new Date(),
        verifiedAt: new Date(),
        receiptNumber: payment.receiptNumber || purchase.receiptNumber,
        provider: payment.provider || purchase.provider,
      },
      {
        where: { id: purchase.id, status: { [Op.ne]: "paid" } },
        transaction,
      }
    );

    // Idempotent repair: a paid row whose enrollment was missing still gets it.
    await CourseEnrollment.findOrCreate({
      where: { userId: purchase.userId, courseId: purchase.courseId },
      defaults: { source: "purchase", status: "active" },
      transaction,
    });
    return Boolean(updated);
  });

  // Progress rows are derivative data and can safely be repaired after commit.
  // A failure here must not hide the already-committed payment or access.
  try {
    await ensureProgressRows(purchase.userId, purchase.courseId);
    await recalcCourseProgress(purchase.userId, purchase.courseId);
  } catch (error) {
    console.warn(
      `[finance] Payment ${purchase.reference} verified but progress setup failed:`,
      error.message
    );
  }

  if (!fulfilled) {
    return { fulfilled: false, reason: "already_fulfilled" };
  }

  const course = await Course.findByPk(purchase.courseId);
  await notify(purchase.userId, {
    title: "Payment verified — course unlocked",
    message: `Your payment for ${course?.title || "your course"} was verified. You can start learning now.`,
    type: "payment",
    link: `/courses/${purchase.courseId}`,
  });
  await ActivityLog.create({
    userId: purchase.userId,
    action: "Purchase verified",
    entityType: "course",
    entityId: purchase.courseId,
    detail: `Reference ${purchase.reference} · ${formatPeso(purchase.amount, purchase.currency)}`,
    ip: null,
  }).catch((error) => console.warn("[finance] Activity log failed:", error.message));

  return { fulfilled: true };
}

async function applyLocalStatus(purchase, payment) {
  const status = ["paid", "failed", "cancelled", "refunded"].includes(payment.status)
    ? payment.status
    : "pending";
  const changes = { status, provider: payment.provider || purchase.provider };
  if (payment.receiptNumber) changes.receiptNumber = payment.receiptNumber;
  if (payment.refundedAt) changes.refundedAt = new Date(payment.refundedAt);
  await purchase.update(changes);
}

/**
 * Re-read a payment from the billing service and reconcile the local record.
 * This is the only path triggered by loading a page — a browser redirect alone
 * never reaches `fulfillPurchase` without a verified server-side response.
 */
export async function refreshPurchase(reference, { user } = {}) {
  const purchase = await findPurchase(reference);
  if (!purchase) return { purchase: null, payment: null, fulfilled: false };

  if (user && user.role !== "superadmin" && purchase.userId !== user.id) {
    return { purchase: null, payment: null, fulfilled: false, forbidden: true };
  }

  // `verifyPayment` asks the billing service to re-query HitPay for pending
  // transactions; the browser's redirect parameters are never trusted.
  const result = await billing.verifyPayment(purchase.reference);
  const payment = result?.payment;
  if (!payment) return { purchase, payment: null, fulfilled: false };

  if (Number(payment.learnerId) !== Number(purchase.userId)) {
    console.warn(`[finance] Payment ${purchase.reference} learner mismatch.`);
    return { purchase, payment, fulfilled: false, forbidden: true };
  }

  let fulfilled = false;
  if (payment.status === "paid") {
    const outcome = await fulfillPurchase(purchase, payment);
    fulfilled = outcome.fulfilled;
    await purchase.reload();
  } else {
    // Pending, failed, cancelled or refunded — never grants access.
    await applyLocalStatus(purchase, payment);
  }

  return { purchase, payment, fulfilled };
}

/* --------------------------------------------------------------- webhooks */

export function verifyWebhookSignature({ rawBody, timestamp, signature }) {
  const secret = process.env.LMS_WEBHOOK_SECRET;
  if (!secret) return false;

  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt) || Math.abs(Date.now() - sentAt) > 5 * 60 * 1000) {
    return false;
  }

  const body = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody || "");
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${sentAt}.${body}`)
    .digest("hex");
  const left = Buffer.from(signature || "");
  const right = Buffer.from(expected);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * Handle a signed billing notification. The event is treated only as a hint:
 * the payment is fetched again over the authenticated API before unlocking, so
 * a forged or replayed body cannot grant course access.
 */
export async function handleBillingWebhook(body) {
  const reference = body?.data?.reference || body?.reference;
  if (!reference) return { handled: false, reason: "missing_reference" };

  const purchase = await findPurchase(reference);
  if (!purchase) {
    console.warn(`[finance] Webhook for unknown purchase ${reference}.`);
    return { handled: false, reason: "unknown_reference" };
  }

  const result = await refreshPurchase(reference);
  return { handled: true, purchase: serializePurchase(result.purchase), fulfilled: result.fulfilled };
}
