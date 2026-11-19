/*
 * Billing & finance HTTP layer.
 *
 * All /api/billing/* routes require a signed server-to-server request. The
 * sandbox checkout pages are the only browser-facing surface and only exist in
 * test mode, where no real money moves.
 */
import {
  listCourses,
  upsertCourse,
  archiveCourse,
  createCheckout,
  getPayment,
  verifyPayment,
  applyProviderResult,
  refundPayment,
  dashboard,
  revenueReport,
  report,
  listTransactions,
  listReceipts,
  getReceipt,
  findPayment,
  applyHitpayWebhook,
  providerMode,
  billingConfig,
  money,
} from "../services/billingService.js";
import { verifyProviderWebhook } from "../middleware/apiAuth.js";
import {
  verifyWebhookSignature as verifyHitpaySignature,
  webhookEventId,
} from "../services/hitpayProvider.js";

function failure(res, error, fallbackMessage = "Billing request failed.") {
  const status = error?.status || 500;
  if (status >= 500) console.error("[billing]", error);
  return res.status(status).json({
    error: error?.code || (status >= 500 ? "billing_error" : "invalid_request"),
    message: status >= 500 ? fallbackMessage : error.message,
  });
}

/* ---------------------------------------------------------------- system */

export const health = (req, res) =>
  res.json({
    ok: true,
    service: "VanguardLMS Billing",
    mode: providerMode(),
    provider: billingConfig.PROVIDER,
    currency: billingConfig.CURRENCY,
    time: new Date().toISOString(),
  });

/* ------------------------------------------------------------- dashboard */

export const dashboardHandler = async (req, res) => {
  try {
    res.json(await dashboard());
  } catch (error) {
    failure(res, error, "Could not build the billing dashboard.");
  }
};

export const transactionsHandler = async (req, res) => {
  try {
    res.json(await listTransactions(req.query));
  } catch (error) {
    failure(res, error, "Could not load transactions.");
  }
};

export const revenueHandler = async (req, res) => {
  try {
    res.json(await revenueReport({ months: req.query.months }));
  } catch (error) {
    failure(res, error, "Could not load revenue analytics.");
  }
};

export const reportsHandler = async (req, res) => {
  try {
    res.json(await report({ from: req.query.from, to: req.query.to }));
  } catch (error) {
    failure(res, error, "Could not build the financial report.");
  }
};

/* ----------------------------------------------------------- paid courses */

export const coursesHandler = async (req, res) => {
  try {
    res.json({ items: await listCourses(), currency: billingConfig.CURRENCY });
  } catch (error) {
    failure(res, error, "Could not load the paid course registry.");
  }
};

export const createCourseHandler = async (req, res) => {
  try {
    const record = await upsertCourse(req.body || {});
    res.status(201).json({
      course: {
        courseId: record.courseId,
        title: record.title,
        price: money(record.price),
        currency: record.currency,
        status: record.status,
      },
    });
  } catch (error) {
    failure(res, error, "Could not sync the course price.");
  }
};

export const updateCourseHandler = async (req, res) => {
  try {
    const record = await upsertCourse({
      ...req.body,
      courseId: Number(req.params.courseId),
    });
    res.json({
      course: {
        courseId: record.courseId,
        title: record.title,
        price: money(record.price),
        currency: record.currency,
        status: record.status,
      },
    });
  } catch (error) {
    failure(res, error, "Could not update the course price.");
  }
};

export const deleteCourseHandler = async (req, res) => {
  try {
    const record = await archiveCourse(req.params.courseId);
    if (!record) return res.status(404).json({ error: "course_not_found" });
    // Financial history is never deleted; the catalogue entry is archived.
    res.json({ courseId: record.courseId, status: record.status });
  } catch (error) {
    failure(res, error, "Could not archive the course.");
  }
};

/* --------------------------------------------------------------- payments */

export const checkoutHandler = async (req, res) => {
  try {
    const idempotencyKey = req.get("idempotency-key") || req.body?.idempotencyKey;
    const result = await createCheckout(req.body || {}, idempotencyKey);
    res.status(result.duplicate ? 200 : 201).json(result);
  } catch (error) {
    failure(res, error, "Could not start checkout.");
  }
};

export const paymentHandler = async (req, res) => {
  try {
    const result = await getPayment(req.params.reference);
    if (!result) return res.status(404).json({ error: "payment_not_found" });
    res.json(result);
  } catch (error) {
    failure(res, error, "Could not load the payment.");
  }
};

export const verifyPaymentHandler = async (req, res) => {
  try {
    const reference = req.params.reference || req.body?.reference;
    const result = await verifyPayment(reference);
    if (!result) return res.status(404).json({ error: "payment_not_found" });
    res.json(result);
  } catch (error) {
    failure(res, error, "Could not verify the payment.");
  }
};

export const webhookHandler = async (req, res) => {
  const provider = String(req.params.provider || "").toLowerCase();
  if (!["sandbox", "hitpay"].includes(provider)) {
    return res.status(404).json({ error: "unknown_provider" });
  }

  if (provider === "hitpay") {
    if (providerMode() !== "live" || billingConfig.PROVIDER !== "hitpay") {
      return res.status(404).json({ error: "provider_disabled" });
    }
    if (!verifyHitpaySignature(req.rawBody || "", req.get("hitpay-signature"))) {
      console.warn("[billing] Rejected HitPay webhook with an invalid signature.");
      return res.status(401).json({ error: "invalid_signature" });
    }

    try {
      const body = req.body || {};
      const eventObject = req.get("hitpay-event-object") || "";
      const eventType = req.get("hitpay-event-type") || "";
      const result = await applyHitpayWebhook({
        body,
        eventObject,
        eventType,
        eventId: webhookEventId(eventObject, eventType, body),
      });
      if (!result.handled) {
        // Acknowledge unknown traffic so HitPay does not retry unrelated events.
        return res.status(202).json({ ok: true, ignored: result.reason });
      }
      return res.json({
        ok: true,
        ignored: Boolean(result.ignored),
        duplicateEvent: Boolean(result.duplicateEvent),
        payment: result.payment || null,
      });
    } catch (error) {
      return failure(res, error, "Could not process the HitPay webhook.");
    }
  }

  const check = verifyProviderWebhook({
    provider,
    rawBody: req.rawBody || "",
    timestamp: req.get("x-webhook-timestamp"),
    signature: req.get("x-webhook-signature"),
  });
  if (!check.ok) {
    console.warn(`[billing] Rejected ${provider} webhook: ${check.reason}`);
    return res.status(401).json({ error: check.reason });
  }

  try {
    const body = req.body || {};
    const outcome = String(body.outcome || body.status || "").toLowerCase();
    if (!["paid", "failed", "cancelled", "refunded"].includes(outcome)) {
      return res.status(422).json({ error: "unsupported_outcome" });
    }
    const result = await applyProviderResult({
      reference: body.reference,
      outcome,
      provider,
      eventId: body.eventId,
      source: "webhook",
      payload: body,
    });
    if (!result) return res.status(404).json({ error: "payment_not_found" });
    return res.json({ ok: true, duplicateEvent: result.duplicateEvent, payment: result.payment });
  } catch (error) {
    return failure(res, error, "Could not process the webhook.");
  }
};

export const refundHandler = async (req, res) => {
  try {
    const reference = req.params.reference || req.body?.reference;
    const result = await refundPayment(reference, {
      amount: req.body?.amount,
      reason: req.body?.reason,
    });
    if (!result) return res.status(404).json({ error: "payment_not_found" });
    res.json(result);
  } catch (error) {
    failure(res, error, "Could not process the refund.");
  }
};

/* --------------------------------------------------------------- receipts */

export const receiptsHandler = async (req, res) => {
  try {
    res.json(await listReceipts(req.query));
  } catch (error) {
    failure(res, error, "Could not load receipts.");
  }
};

export const receiptHandler = async (req, res) => {
  try {
    const receipt = await getReceipt(req.params.reference);
    if (!receipt) return res.status(404).json({ error: "receipt_not_found" });
    res.json(receipt);
  } catch (error) {
    failure(res, error, "Could not load the receipt.");
  }
};

/* ------------------------------------------------------- sandbox provider */

function lmsReturnUrl(payment) {
  const base = (process.env.LMS_PUBLIC_URL || "http://localhost:3000").replace(/\/$/, "");
  return `${base}/courses/${payment.courseId}/purchase/${payment.reference}`;
}

export const sandboxCheckoutPage = async (req, res) => {
  const payment = await findPayment(req.params.reference);
  if (!payment) {
    return res.status(404).render("sandbox-result", {
      title: "Payment not found",
      payment: null,
      outcome: "missing",
      returnUrl: process.env.LMS_PUBLIC_URL || "http://localhost:3000",
      mode: providerMode(),
    });
  }
  if (providerMode() !== "sandbox") {
    return res.status(404).render("sandbox-result", {
      title: "Test checkout disabled",
      payment,
      outcome: "disabled",
      returnUrl: lmsReturnUrl(payment),
      mode: providerMode(),
    });
  }
  return res.render("sandbox-checkout", {
    title: "Sandbox checkout",
    payment,
    canPay: payment.status === "pending",
    mode: providerMode(),
  });
};

export const sandboxPayAction = async (req, res) => {
  if (providerMode() !== "sandbox") {
    return res.status(403).send("The sandbox checkout is disabled in live mode.");
  }
  const payment = await findPayment(req.params.reference);
  if (!payment) return res.status(404).send("Unknown payment reference.");

  const outcome = ["paid", "failed", "cancelled"].includes(req.body.outcome)
    ? req.body.outcome
    : "failed";

  await applyProviderResult({
    reference: payment.reference,
    outcome,
    provider: "sandbox",
    eventId: `sandbox-ui:${payment.reference}:${outcome}`,
    source: "sandbox",
    payload: { simulated: true, outcome },
  });

  return res.redirect(`/checkout/${payment.reference}/done`);
};

export const sandboxResultPage = async (req, res) => {
  const payment = await findPayment(req.params.reference);
  if (!payment) {
    return res.status(404).render("sandbox-result", {
      title: "Payment not found",
      payment: null,
      outcome: "missing",
      returnUrl: process.env.LMS_PUBLIC_URL || "http://localhost:3000",
      mode: providerMode(),
    });
  }
  return res.render("sandbox-result", {
    title: "Sandbox result",
    payment,
    outcome: payment.status,
    returnUrl: lmsReturnUrl(payment),
    mode: providerMode(),
  });
};
