/*
 * Billing domain service.
 *
 * Responsibilities:
 *  - mirror the LMS price catalogue (LMS remains the source of truth)
 *  - create idempotent checkout transactions
 *  - apply provider results exactly once
 *  - produce dashboard, revenue and report aggregates from stored records
 *
 * No card numbers, CVVs or wallet credentials are ever accepted or stored.
 */
import crypto from "crypto";
import { Op, fn, col, literal } from "sequelize";
import {
  BillingCourse,
  BillingTransaction,
  BillingEvent,
  sequelize,
} from "../models/index.js";
import { notifyLms } from "./lmsNotifier.js";
import {
  createPaymentRequest,
  createRefund,
  getPaymentRequest,
  hitpayConfigured,
} from "./hitpayProvider.js";

const CURRENCY = (process.env.BILLING_CURRENCY || "PHP").toUpperCase();
const PROVIDER = ["sandbox", "hitpay"].includes(
  String(process.env.PAYMENT_PROVIDER || "sandbox").toLowerCase()
)
  ? String(process.env.PAYMENT_PROVIDER || "sandbox").toLowerCase()
  : "sandbox";

export const providerMode = () => (PROVIDER === "sandbox" ? "sandbox" : "live");
export const publicBaseUrl = () =>
  (process.env.BILLING_PUBLIC_URL || `http://localhost:${process.env.PORT || 4000}`).replace(
    /\/$/,
    ""
  );

export function money(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(number * 100) / 100;
}

function lmsReturnUrl(payment) {
  const base = (process.env.LMS_PUBLIC_URL || "http://localhost:3000").replace(/\/$/, "");
  return `${base}/courses/${payment.courseId}/purchase/${payment.reference}`;
}

function receiptNumberFor(transaction) {
  const year = new Date().getFullYear();
  return `VGL-${year}-${String(transaction.id).padStart(6, "0")}`;
}

function serialize(transaction) {
  const row = transaction.toJSON ? transaction.toJSON() : transaction;
  return {
    reference: row.reference,
    learnerId: row.learnerId,
    learnerName: row.learnerName,
    learnerEmail: row.learnerEmail,
    courseId: row.courseId,
    courseTitle: row.courseTitle,
    amount: money(row.amount),
    currency: row.currency,
    status: row.status,
    provider: row.provider,
    providerStatus: row.providerStatus || null,
    paymentMethod: row.paymentMethod,
    receiptNumber: row.receiptNumber || null,
    paidAt: row.paidAt || null,
    verifiedAt: row.verifiedAt || null,
    refundedAt: row.refundedAt || null,
    refundAmount: row.refundAmount != null ? money(row.refundAmount) : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/* ------------------------------------------------------------ catalogue */

export async function upsertCourse(input = {}) {
  const courseId = Number(input.courseId);
  if (!Number.isInteger(courseId) || courseId <= 0) {
    const error = new Error("courseId must be a positive integer.");
    error.status = 422;
    throw error;
  }
  const price = money(input.price);
  if (price < 0) {
    const error = new Error("price cannot be negative.");
    error.status = 422;
    throw error;
  }
  if (!String(input.title || "").trim()) {
    const error = new Error("title is required.");
    error.status = 422;
    throw error;
  }

  const values = {
    courseId,
    title: String(input.title).trim(),
    instructorName: input.instructorName ? String(input.instructorName).trim() : null,
    price,
    currency: String(input.currency || CURRENCY).toUpperCase(),
    status: price > 0 ? "paid" : "free",
    syncedAt: new Date(),
  };

  const [record, created] = await BillingCourse.findOrCreate({
    where: { courseId },
    defaults: values,
  });
  if (!created) await record.update(values);
  return record;
}

export async function listCourses() {
  const rows = await BillingCourse.findAll({ order: [["courseId", "ASC"]] });
  return rows.map((row) => ({
    courseId: row.courseId,
    title: row.title,
    instructorName: row.instructorName,
    price: money(row.price),
    currency: row.currency,
    status: row.status,
    syncedAt: row.syncedAt,
  }));
}

export async function archiveCourse(courseId) {
  const record = await BillingCourse.findOne({ where: { courseId: Number(courseId) } });
  if (!record) return null;
  await record.update({ status: "archived", syncedAt: new Date() });
  return record;
}

/* ------------------------------------------------------------- checkout */

export async function createCheckout(input = {}, idempotencyKey) {
  const learnerId = Number(input.learnerId);
  const courseId = Number(input.courseId);
  const learnerName = String(input.learnerName || "").trim();
  const learnerEmail = String(input.learnerEmail || "").trim().toLowerCase();
  const courseTitle = String(input.courseTitle || "").trim();

  const invalid = [];
  if (!Number.isInteger(learnerId) || learnerId <= 0) invalid.push("learnerId");
  if (!Number.isInteger(courseId) || courseId <= 0) invalid.push("courseId");
  if (learnerName.length < 2) invalid.push("learnerName");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(learnerEmail)) invalid.push("learnerEmail");
  if (!courseTitle) invalid.push("courseTitle");
  if (money(input.amount) <= 0) invalid.push("amount");
  if (invalid.length) {
    const error = new Error(`Invalid checkout payload: ${invalid.join(", ")}.`);
    error.status = 422;
    error.code = "invalid_checkout";
    throw error;
  }

  // LMS is authoritative for price; the catalogue mirror is refreshed here so
  // the stored amount always matches what the LMS course record says.
  const course = await upsertCourse({
    courseId,
    title: courseTitle,
    instructorName: input.instructorName,
    price: input.amount,
    currency: input.currency || CURRENCY,
  });

  if (money(course.price) < 0.3) {
    const error = new Error("The payment provider requires an amount of at least 0.30.");
    error.status = 422;
    error.code = "amount_too_small";
    throw error;
  }

  const existingPaid = await BillingTransaction.findOne({
    where: { learnerId, courseId, status: "paid" },
    order: [["paidAt", "DESC"]],
  });
  if (existingPaid) {
    return { duplicate: true, payment: serialize(existingPaid) };
  }

  const key = idempotencyKey ? String(idempotencyKey).slice(0, 128) : null;
  let transaction;
  if (key) {
    const existing = await BillingTransaction.findOne({ where: { idempotencyKey: key } });
    if (existing) {
      if (existing.status === "paid" || existing.status === "refunded") {
        return { duplicate: true, payment: serialize(existing) };
      }
      if (
        existing.status === "pending" &&
        existing.provider === PROVIDER &&
        existing.providerCheckoutUrl &&
        (!existing.providerExpiresAt || new Date(existing.providerExpiresAt) > new Date())
      ) {
        return {
          duplicate: false,
          reused: true,
          payment: serialize(existing),
          checkoutUrl: existing.providerCheckoutUrl,
        };
      }
      // A previous attempt failed or expired before any money moved. Reuse the
      // same reference so the idempotency key stays unique, then obtain a fresh
      // provider checkout URL.
      await existing.update({
        status: "pending",
        provider: PROVIDER,
        providerReference: null,
        providerPaymentId: null,
        providerCheckoutUrl: null,
        providerStatus: null,
        providerExpiresAt: null,
        failureReason: null,
        failedAt: null,
        amount: money(course.price),
        currency: course.currency,
      });
      transaction = existing;
    }
  }

  if (!transaction) {
    transaction = await BillingTransaction.create({
      reference: crypto.randomUUID(),
      idempotencyKey: key,
      learnerId,
      learnerName,
      learnerEmail,
      courseId,
      courseTitle: course.title,
      amount: money(course.price),
      currency: course.currency,
      status: "pending",
      provider: PROVIDER,
      paymentMethod:
        PROVIDER === "sandbox" ? "Sandbox test checkout" : "HitPay checkout",
    });
  }

  let checkoutUrl;
  try {
    if (PROVIDER === "hitpay") {
      if (!hitpayConfigured()) {
        const error = new Error("HitPay is not configured on the billing service.");
        error.status = 503;
        error.code = "hitpay_unconfigured";
        throw error;
      }
      const remote = await createPaymentRequest({
        reference: transaction.reference,
        amount: transaction.amount,
        currency: transaction.currency,
        email: transaction.learnerEmail,
        name: transaction.learnerName,
        purpose: transaction.courseTitle,
        redirectUrl: lmsReturnUrl(transaction),
      });
      checkoutUrl = remote.url;
      await transaction.update({
        providerReference: remote.id,
        providerCheckoutUrl: remote.url,
        providerStatus: remote.status,
        providerExpiresAt: remote.expiresAt,
        paymentMethod: "HitPay checkout",
      });
    } else {
      checkoutUrl = `${publicBaseUrl()}/checkout/${transaction.reference}`;
      await transaction.update({
        providerStatus: "pending",
        providerCheckoutUrl: checkoutUrl,
      });
    }
  } catch (error) {
    await transaction
      .update({
        status: "failed",
        failedAt: new Date(),
        failureReason: String(error.message || "Provider checkout failed").slice(0, 250),
        providerStatus: "failed",
      })
      .catch(() => {});
    console.error("[billing] Provider checkout failed:", error.message);
    throw error;
  }

  return {
    duplicate: false,
    reused: false,
    payment: serialize(transaction),
    checkoutUrl,
  };
}

export async function findPayment(reference, { learnerId } = {}) {
  const where = { reference: String(reference || "") };
  if (learnerId) where.learnerId = Number(learnerId);
  const transaction = await BillingTransaction.findOne({ where });
  return transaction ? serialize(transaction) : null;
}

export async function getPayment(reference) {
  const transaction = await BillingTransaction.findOne({
    where: { reference: String(reference || "") },
  });
  return transaction ? { payment: serialize(transaction) } : null;
}

/*
 * Server-side verification. The signed webhook is authoritative, but when a
 * learner returns from checkout before the webhook lands we re-query HitPay
 * directly instead of trusting the browser's redirect parameters.
 */
export async function verifyPayment(reference) {
  let transaction = await BillingTransaction.findOne({
    where: { reference: String(reference || "") },
  });
  if (!transaction) return null;

  if (
    transaction.provider === "hitpay" &&
    transaction.status === "pending" &&
    transaction.providerReference &&
    hitpayConfigured()
  ) {
    try {
      const remote = await getPaymentRequest(transaction.providerReference);
      const status = String(remote.status || "").toLowerCase();
      await transaction.update({ providerStatus: status || transaction.providerStatus });

      if (["completed", "succeeded", "paid"].includes(status)) {
        const charge = Array.isArray(remote.payments) ? remote.payments[0] : null;
        await applyProviderResult({
          reference: transaction.reference,
          outcome: "paid",
          provider: "hitpay",
          eventId: `hitpay:verify:${transaction.providerReference}:${remote.updated_at || status}`,
          source: "verify",
          payload: {
            amount: remote.amount,
            currency: remote.currency,
            providerPaymentId: charge?.id || remote.payment_id || null,
            paymentMethod: charge?.payment_type || "HitPay checkout",
            providerReference: remote.id || transaction.providerReference,
          },
        });
      } else if (["failed", "expired", "canceled", "cancelled"].includes(status)) {
        await applyProviderResult({
          reference: transaction.reference,
          outcome: status === "failed" ? "failed" : "cancelled",
          provider: "hitpay",
          eventId: `hitpay:verify:${transaction.providerReference}:${remote.updated_at || status}`,
          source: "verify",
          payload: { status, failureReason: remote.failed_reason || null },
        });
      }
      transaction = await BillingTransaction.findByPk(transaction.id);
    } catch (error) {
      // A verification outage must not change the stored state or unlock access.
      console.warn(
        `[billing] HitPay verification failed for ${reference}:`,
        error.code || error.message
      );
    }
  }

  const payment = serialize(transaction);
  return {
    payment,
    verified: payment.status === "paid" || payment.status === "refunded",
    actionable: payment.status === "pending",
  };
}

/* -------------------------------------------------------- provider events */

export async function applyProviderResult({
  reference,
  outcome,
  provider = PROVIDER,
  eventId,
  source = "provider",
  payload = {},
}) {
  const transaction = await BillingTransaction.findOne({
    where: { reference: String(reference || "") },
  });
  if (!transaction) return null;

  if (payload?.currency && String(payload.currency).toUpperCase() !== transaction.currency.toUpperCase()) {
    const error = new Error("Provider currency does not match the stored transaction.");
    error.status = 422;
    error.code = "currency_mismatch";
    throw error;
  }
  if (
    outcome === "paid" &&
    payload?.amount != null &&
    money(payload.amount) !== money(transaction.amount)
  ) {
    const error = new Error("Provider amount does not match the stored transaction.");
    error.status = 422;
    error.code = "amount_mismatch";
    throw error;
  }
  if (
    payload?.providerReference &&
    transaction.providerReference &&
    String(payload.providerReference) !== String(transaction.providerReference)
  ) {
    const error = new Error("Provider reference does not match the stored transaction.");
    error.status = 409;
    error.code = "provider_reference_mismatch";
    throw error;
  }

  if (!["paid", "failed", "cancelled", "refunded"].includes(outcome)) {
    const error = new Error(`Unsupported payment outcome: ${outcome}`);
    error.status = 422;
    throw error;
  }

  const resolvedEventId =
    eventId || `${provider}:${transaction.reference}:${outcome}:${Date.now()}`;

  let applied;
  try {
    applied = await sequelize.transaction(async (dbTransaction) => {
      const current = await BillingTransaction.findByPk(transaction.id, {
        transaction: dbTransaction,
        lock: dbTransaction.LOCK.UPDATE,
      });

      await BillingEvent.create(
        {
          eventId: resolvedEventId,
          reference: current.reference,
          type: outcome,
          source,
          payload: JSON.stringify(payload).slice(0, 60000),
        },
        { transaction: dbTransaction }
      );

      if (current.status === "paid" && outcome !== "refunded") {
        return { payment: serialize(current), changed: false };
      }
      if (current.status === "refunded" && outcome === "refunded") {
        return { payment: serialize(current), changed: false, ignored: true };
      }
      if (outcome === "refunded" && current.status !== "paid") {
        return { payment: serialize(current), changed: false, ignored: true };
      }

      const now = new Date();
      const changes = { lastEventAt: now, provider, providerStatus: outcome };
      if (payload?.providerPaymentId) {
        changes.providerPaymentId = String(payload.providerPaymentId);
      }

      if (outcome === "paid") {
        changes.status = "paid";
        changes.paidAt = now;
        changes.verifiedAt = now;
        changes.receiptNumber = current.receiptNumber || receiptNumberFor(current);
        changes.paymentMethod =
          provider === "sandbox"
            ? "Sandbox test checkout"
            : payload?.paymentMethod || current.paymentMethod;
      } else if (outcome === "failed") {
        changes.status = "failed";
        changes.failedAt = now;
        changes.failureReason = String(payload?.failureReason || "Payment failed")
          .slice(0, 250);
      } else if (outcome === "cancelled") {
        changes.status = "cancelled";
        changes.failedAt = now;
        changes.failureReason = String(payload?.failureReason || "Payment cancelled")
          .slice(0, 250);
      } else {
        changes.status = "refunded";
        changes.refundedAt = now;
        changes.refundAmount = money(
          payload.refunded_amount ?? payload.amount ?? current.amount
        );
        changes.refundReason = payload.reason ? String(payload.reason).slice(0, 250) : "Refund";
      }

      await current.update(changes, { transaction: dbTransaction });
      return { payment: serialize(current), changed: true };
    });
  } catch (error) {
    // Unique violation means this provider event was already applied.
    if (error?.name === "SequelizeUniqueConstraintError") {
      const fresh = await BillingTransaction.findByPk(transaction.id);
      return { payment: serialize(fresh), duplicateEvent: true };
    }
    throw error;
  }

  if (!applied.changed) {
    return { ...applied, duplicateEvent: false };
  }

  const fresh = await BillingTransaction.findByPk(transaction.id);
  const eventType =
    outcome === "paid"
      ? "payment.paid"
      : outcome === "refunded"
        ? "payment.refunded"
        : "payment.failed";
  const delivery = await notifyLms(eventType, fresh);

  return { payment: serialize(fresh), duplicateEvent: false, notifiedLms: delivery };
}

/*
 * Resolve a verified HitPay event to one stored transaction. Matching is by our
 * own reference first, then by the HitPay payment-request id, then by charge id.
 */
export async function applyHitpayWebhook({ body, eventObject, eventType, eventId }) {
  const reference = String(body?.reference_number || body?.metadata?.lms_reference || "").trim();
  let transaction = null;

  if (reference) {
    transaction = await BillingTransaction.findOne({ where: { reference } });
  }
  if (!transaction && body?.payment_request_id) {
    transaction = await BillingTransaction.findOne({
      where: { providerReference: String(body.payment_request_id) },
    });
  }
  if (!transaction && body?.id) {
    transaction = await BillingTransaction.findOne({
      where: { providerReference: String(body.id) },
    });
  }
  if (!transaction && body?.id) {
    transaction = await BillingTransaction.findOne({
      where: { providerPaymentId: String(body.id) },
    });
  }
  if (!transaction) return { handled: false, reason: "unknown_reference" };

  const charge = Array.isArray(body?.payments) ? body.payments[0] : null;
  const refundedAmount = money(
    body?.refunded_amount ?? charge?.refunded_amount ?? 0
  );
  const status = String(body?.status || "").toLowerCase();
  const type = String(eventType || "").toLowerCase();

  let outcome = null;
  if (refundedAmount > 0 || ["refunded", "partially_refunded"].includes(status)) {
    outcome = "refunded";
  } else if (["completed", "succeeded", "paid"].includes(status)) {
    outcome = "paid";
  } else if (status === "failed" || type.includes("failed")) {
    outcome = "failed";
  } else if (["expired", "canceled", "cancelled"].includes(status)) {
    outcome = "cancelled";
  }

  if (!outcome) {
    return { handled: true, ignored: true, reason: "no_financial_change" };
  }

  const result = await applyProviderResult({
    reference: transaction.reference,
    outcome,
    provider: "hitpay",
    eventId,
    source: "hitpay_webhook",
    payload: {
      amount: body?.amount,
      currency: body?.currency,
      refunded_amount: refundedAmount || undefined,
      providerReference: body?.payment_request_id || body?.id,
      providerPaymentId: charge?.id || body?.payment_id || body?.id || null,
      paymentMethod: charge?.payment_type || body?.payment_method || null,
      failureReason: body?.failed_reason || null,
    },
  });

  return { handled: true, ...result };
}

export async function refundPayment(reference, { amount, reason } = {}) {
  const transaction = await BillingTransaction.findOne({
    where: { reference: String(reference || "") },
  });
  if (!transaction) return null;
  if (transaction.status !== "paid") {
    const error = new Error("Only a paid transaction can be refunded.");
    error.status = 409;
    throw error;
  }
  const refundAmount = amount == null ? money(transaction.amount) : money(amount);
  if (refundAmount <= 0 || refundAmount > money(transaction.amount)) {
    const error = new Error("Refund amount must be between 0 and the paid amount.");
    error.status = 422;
    throw error;
  }

  let providerRefund = null;
  if (transaction.provider === "hitpay") {
    if (!hitpayConfigured()) {
      const error = new Error("HitPay is not configured, so no refund was issued.");
      error.status = 503;
      error.code = "hitpay_unconfigured";
      throw error;
    }
    if (!transaction.providerPaymentId) {
      const error = new Error(
        "HitPay has not yet reported the charge id for this payment. Wait for the verified webhook and try again."
      );
      error.status = 409;
      error.code = "missing_provider_payment_id";
      throw error;
    }
    providerRefund = await createRefund({
      paymentId: transaction.providerPaymentId,
      amount: refundAmount,
    });
  }

  return applyProviderResult({
    reference: transaction.reference,
    outcome: "refunded",
    provider: transaction.provider,
    eventId: providerRefund?.id
      ? `hitpay:refund:${providerRefund.id}`
      : `refund:${transaction.reference}:${Date.now()}`,
    source: "refund",
    payload: {
      amount: providerRefund?.amount_refunded ?? refundAmount,
      reason: reason || "Refund requested by administrator",
    },
  });
}

/* ------------------------------------------------------------ reporting */

function startOfMonth(offsetFromNow = 0) {
  const date = new Date();
  date.setDate(1);
  date.setHours(0, 0, 0, 0);
  date.setMonth(date.getMonth() + offsetFromNow);
  return date;
}

export async function revenueSeries(months = 6) {
  const span = Math.max(1, Math.min(24, Number(months) || 6));
  const from = startOfMonth(-(span - 1));

  // MySQL and SQLite format dates differently; pick the right expression.
  const bucketExpression =
    sequelize.getDialect() === "sqlite"
      ? fn("strftime", literal("'%Y-%m'"), col("paidAt"))
      : fn("DATE_FORMAT", col("paidAt"), "%Y-%m");

  const rows = await BillingTransaction.findAll({
    where: { status: "paid", paidAt: { [Op.gte]: from } },
    attributes: [
      [bucketExpression, "bucket"],
      [fn("SUM", col("amount")), "revenue"],
      [fn("COUNT", col("id")), "sales"],
    ],
    group: ["bucket"],
    raw: true,
  });

  const byBucket = new Map(
    rows.map((row) => [row.bucket, { revenue: money(row.revenue), sales: Number(row.sales) }])
  );

  const series = [];
  for (let index = 0; index < span; index += 1) {
    const date = startOfMonth(-(span - 1) + index);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    const bucket = byBucket.get(key) || { revenue: 0, sales: 0 };
    series.push({
      month: key,
      label: date.toLocaleDateString("en-US", { month: "short", year: "2-digit" }),
      revenue: bucket.revenue,
      sales: bucket.sales,
    });
  }
  return series;
}

async function courseSales(limit = 6) {
  const rows = await BillingTransaction.findAll({
    where: { status: { [Op.in]: ["paid", "refunded"] } },
    attributes: [
      "courseId",
      "courseTitle",
      [fn("SUM", literal("CASE WHEN status = 'paid' THEN amount ELSE 0 END")), "revenue"],
      [fn("COUNT", col("id")), "sales"],
    ],
    group: ["courseId", "courseTitle"],
    order: [[literal("revenue"), "DESC"]],
    limit,
    raw: true,
  });
  return rows.map((row) => ({
    courseId: row.courseId,
    courseTitle: row.courseTitle,
    revenue: money(row.revenue),
    sales: Number(row.sales),
  }));
}

export async function dashboard() {
  const [totals, refunds, pending, failed, recent, series, sales, paidCourses] =
    await Promise.all([
      BillingTransaction.findOne({
        where: { status: "paid" },
        attributes: [
          [fn("SUM", col("amount")), "revenue"],
          [fn("COUNT", col("id")), "count"],
        ],
        raw: true,
      }),
      BillingTransaction.findOne({
        where: { status: "refunded" },
        attributes: [
          [fn("SUM", col("amount")), "amount"],
          [fn("COUNT", col("id")), "count"],
        ],
        raw: true,
      }),
      BillingTransaction.count({ where: { status: "pending" } }),
      BillingTransaction.count({ where: { status: { [Op.in]: ["failed", "cancelled"] } } }),
      BillingTransaction.findAll({ order: [["createdAt", "DESC"]], limit: 8 }),
      revenueSeries(6),
      courseSales(6),
      BillingCourse.count({ where: { status: "paid" } }),
    ]);

  return {
    environment: {
      mode: providerMode(),
      provider: PROVIDER,
      currency: CURRENCY,
      checkoutNotice:
        providerMode() === "sandbox"
          ? "SANDBOX TEST MODE — no real money is collected. Payments are simulated on the billing service test page."
          : "Live payments are processed by HitPay. Access is granted only after a signature-verified payment event.",
    },
    totals: {
      revenue: money(totals?.revenue),
      successfulPayments: Number(totals?.count || 0),
      pendingPayments: pending,
      failedPayments: failed,
      paidCourseSales: Number(totals?.count || 0),
      refundedAmount: money(refunds?.amount),
      refunds: Number(refunds?.count || 0),
      paidCourses,
    },
    monthlyRevenue: series,
    courseSales: sales,
    recentTransactions: recent.map(serialize),
  };
}

export async function revenueReport({ months = 6 } = {}) {
  const series = await revenueSeries(months);
  return {
    currency: CURRENCY,
    series,
    total: money(series.reduce((sum, row) => sum + row.revenue, 0)),
  };
}

function rangeWhere(from, to) {
  const where = {};
  if (from) {
    const start = new Date(from);
    if (!Number.isNaN(start.getTime())) where.createdAt = { [Op.gte]: start };
  }
  if (to) {
    const end = new Date(to);
    if (!Number.isNaN(end.getTime())) {
      end.setHours(23, 59, 59, 999);
      where.createdAt = { ...(where.createdAt || {}), [Op.lte]: end };
    }
  }
  return where;
}

export async function report({ from, to } = {}) {
  const where = rangeWhere(from, to);

  const [totals, byCourse, byStatus] = await Promise.all([
    BillingTransaction.findOne({
      where: { ...where, status: "paid" },
      attributes: [
        [fn("SUM", col("amount")), "revenue"],
        [fn("COUNT", col("id")), "count"],
      ],
      raw: true,
    }),
    BillingTransaction.findAll({
      where: { ...where, status: { [Op.in]: ["paid", "refunded"] } },
      attributes: [
        "courseId",
        "courseTitle",
        [fn("SUM", col("amount")), "revenue"],
        [fn("COUNT", col("id")), "sales"],
      ],
      group: ["courseId", "courseTitle"],
      order: [[literal("revenue"), "DESC"]],
      raw: true,
    }),
    BillingTransaction.findAll({
      where,
      attributes: ["status", [fn("COUNT", col("id")), "count"]],
      group: ["status"],
      raw: true,
    }),
  ]);

  return {
    currency: CURRENCY,
    range: { from: from || null, to: to || null },
    totals: {
      revenue: money(totals?.revenue),
      successfulPayments: Number(totals?.count || 0),
    },
    byStatus: byStatus.map((row) => ({ status: row.status, count: Number(row.count) })),
    byCourse: byCourse.map((row) => ({
      courseId: row.courseId,
      courseTitle: row.courseTitle,
      revenue: money(row.revenue),
      sales: Number(row.sales),
    })),
  };
}

const SORTABLE = {
  createdAt: "createdAt",
  amount: "amount",
  learnerName: "learnerName",
  courseTitle: "courseTitle",
  status: "status",
  paidAt: "paidAt",
};

export async function listTransactions(query = {}) {
  const page = Math.max(1, Number(query.page) || 1);
  const perPage = Math.max(1, Math.min(100, Number(query.perPage) || 15));
  const where = { ...rangeWhere(query.from, query.to) };

  const status = String(query.status || "").trim();
  if (status && ["pending", "paid", "failed", "cancelled", "refunded"].includes(status)) {
    where.status = status;
  }
  if (query.courseId) where.courseId = Number(query.courseId);

  const search = String(query.search || "").trim();
  if (search) {
    where[Op.or] = [
      { reference: { [Op.like]: `%${search}%` } },
      { learnerName: { [Op.like]: `%${search}%` } },
      { learnerEmail: { [Op.like]: `%${search}%` } },
      { courseTitle: { [Op.like]: `%${search}%` } },
      { receiptNumber: { [Op.like]: `%${search}%` } },
    ];
  }

  const sortColumn = SORTABLE[query.sort] || "createdAt";
  const direction = String(query.dir || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";

  const { rows, count } = await BillingTransaction.findAndCountAll({
    where,
    order: [[sortColumn, direction]],
    offset: (page - 1) * perPage,
    limit: perPage,
  });

  return {
    items: rows.map(serialize),
    pagination: {
      page,
      perPage,
      total: count,
      pages: Math.max(1, Math.ceil(count / perPage)),
    },
    filters: { search, status, courseId: query.courseId || null, from: query.from || null, to: query.to || null },
    sort: { column: query.sort || "createdAt", dir: direction.toLowerCase() },
  };
}

export async function listReceipts(query = {}) {
  const page = Math.max(1, Number(query.page) || 1);
  const perPage = Math.max(1, Math.min(100, Number(query.perPage) || 15));
  const where = { status: { [Op.in]: ["paid", "refunded"] }, receiptNumber: { [Op.ne]: null } };

  const search = String(query.search || "").trim();
  if (search) {
    where[Op.or] = [
      { reference: { [Op.like]: `%${search}%` } },
      { learnerName: { [Op.like]: `%${search}%` } },
      { receiptNumber: { [Op.like]: `%${search}%` } },
      { courseTitle: { [Op.like]: `%${search}%` } },
    ];
  }

  const { rows, count } = await BillingTransaction.findAndCountAll({
    where,
    order: [["paidAt", "DESC"]],
    offset: (page - 1) * perPage,
    limit: perPage,
  });

  return {
    items: rows.map(serialize),
    pagination: { page, perPage, total: count, pages: Math.max(1, Math.ceil(count / perPage)) },
  };
}

export async function getReceipt(reference) {
  const payment = await findPayment(reference);
  if (!payment || !payment.receiptNumber) return null;
  return {
    receiptNumber: payment.receiptNumber,
    issuedAt: payment.paidAt,
    status: payment.status,
    amount: payment.amount,
    currency: payment.currency,
    learnerName: payment.learnerName,
    learnerEmail: payment.learnerEmail,
    courseId: payment.courseId,
    courseTitle: payment.courseTitle,
    reference: payment.reference,
    provider: payment.provider,
    paymentMethod: payment.paymentMethod,
    refundedAt: payment.refundedAt,
    refundAmount: payment.refundAmount,
    environment: providerMode(),
  };
}

export const billingConfig = { CURRENCY, PROVIDER };
