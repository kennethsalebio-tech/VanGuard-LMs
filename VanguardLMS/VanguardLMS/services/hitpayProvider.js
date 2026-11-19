/*
 * HitPay hosted-checkout adapter.
 *
 * Only server-to-server calls are made here; the browser receives the hosted
 * checkout URL returned by HitPay. The API key never reaches the LMS or the
 * browser.
 */
import crypto from "crypto";

const DEFAULT_TIMEOUT_MS = 10000;

export function hitpayConfigured() {
  return Boolean(process.env.HITPAY_API_KEY);
}

export function hitpayEnvironment() {
  return String(process.env.HITPAY_ENVIRONMENT || "sandbox").toLowerCase() === "production"
    ? "production"
    : "sandbox";
}

export function hitpayApiBase() {
  const configured = String(process.env.HITPAY_API_URL || "").trim();
  if (configured) {
    return /^https?:\/\//i.test(configured)
      ? configured.replace(/\/$/, "")
      : `https://${configured.replace(/\/$/, "")}`;
  }
  return hitpayEnvironment() === "production"
    ? "https://api.hit-pay.com/v1"
    : "https://api.sandbox.hit-pay.com/v1";
}

async function callHitPay(path, options = {}) {
  if (!hitpayConfigured()) {
    const error = new Error("HitPay is not configured.");
    error.status = 503;
    error.code = "hitpay_unconfigured";
    throw error;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${hitpayApiBase()}${path}`, {
      ...options,
      headers: {
        accept: "application/json",
        "X-BUSINESS-API-KEY": process.env.HITPAY_API_KEY,
        "X-Requested-With": "XMLHttpRequest",
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...(options.headers || {}),
      },
      signal: controller.signal,
    });
  } catch (error) {
    const timedOut = error.name === "AbortError";
    const wrapped = new Error(
      timedOut ? "HitPay did not respond in time." : "HitPay is unreachable."
    );
    wrapped.status = 502;
    wrapped.code = timedOut ? "hitpay_timeout" : "hitpay_unavailable";
    throw wrapped;
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { message: text };
  }

  if (!response.ok) {
    console.error(
      `[hitpay] ${options.method || "GET"} ${path} returned ${response.status}:`,
      payload?.message || payload?.error || "unknown error"
    );
    const error = new Error(
      payload?.message || payload?.error || "HitPay rejected the request."
    );
    error.status = response.status >= 500 ? 502 : 422;
    error.code = "hitpay_request_failed";
    throw error;
  }

  return payload;
}

export async function createPaymentRequest({
  reference,
  amount,
  currency,
  email,
  name,
  purpose,
  redirectUrl,
}) {
  // `webhook` is intentionally omitted: HitPay requires webhook registration in
  // the dashboard, where the per-endpoint signing salt is issued.
  const payload = await callHitPay("/payment-requests", {
    method: "POST",
    body: JSON.stringify({
      currency: String(currency || "PHP").toUpperCase(),
      amount: Math.round(Number(amount) * 100) / 100,
      email,
      name,
      purpose: String(purpose || "Course purchase").slice(0, 255),
      reference_number: String(reference).slice(0, 255),
      redirect_url: redirectUrl,
      allow_repeated_payments: false,
      send_email: false,
      send_sms: false,
      expires_after: "30 minutes",
      metadata: { lms_reference: String(reference) },
    }),
  });

  if (!payload.id || !payload.url) {
    const error = new Error("HitPay did not return a checkout URL.");
    error.status = 502;
    error.code = "invalid_hitpay_response";
    throw error;
  }
  return {
    id: String(payload.id),
    url: String(payload.url),
    status: String(payload.status || "pending"),
    expiresAt: payload.expiry_date ? new Date(payload.expiry_date) : null,
    raw: payload,
  };
}

export async function getPaymentRequest(paymentRequestId) {
  return callHitPay(`/payment-requests/${encodeURIComponent(paymentRequestId)}`);
}

export async function createRefund({ paymentId, amount }) {
  const payload = await callHitPay("/refund", {
    method: "POST",
    body: JSON.stringify({
      payment_id: paymentId,
      amount: Math.round(Number(amount) * 100) / 100,
      send_email: false,
    }),
  });
  if (String(payload.status || "").toLowerCase() !== "succeeded") {
    const error = new Error("HitPay did not accept the refund.");
    error.status = 409;
    error.code = "hitpay_refund_failed";
    throw error;
  }
  return payload;
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || "").trim().toLowerCase());
  const right = Buffer.from(String(b || "").trim().toLowerCase());
  if (!left.length || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function verifyWebhookSignature(rawBody, signature) {
  const salt = process.env.HITPAY_WEBHOOK_SALT;
  if (!salt || !signature) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ""));
  const expected = crypto.createHmac("sha256", salt).update(body).digest("hex");
  return safeEqual(signature, expected);
}

export function webhookEventId(eventObject, eventType, body) {
  const refunded = body?.refunded_amount ?? body?.payments?.[0]?.refunded_amount ?? "";
  return [
    "hitpay",
    eventObject || "payment_request",
    body?.id || body?.payment_request_id || "unknown",
    eventType || "",
    body?.status || "",
    refunded,
    body?.updated_at || "",
  ].join(":");
}
