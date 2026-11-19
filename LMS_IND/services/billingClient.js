/*
 * Signed server-to-server client for the VanguardLMS Billing & Finance API.
 *
 * The browser never talks to the billing service and never sees its
 * credentials. Every call is made here, server-side, using HMAC-SHA256 over:
 *
 *   <timestamp>\n<METHOD>\n<path>\n<sha256(raw body)>
 *
 * Failures are surfaced as BillingError so pages can show a friendly message
 * instead of crashing or inventing finance figures.
 */
import crypto from "crypto";

const DEFAULT_TIMEOUT = Number(process.env.BILLING_TIMEOUT_MS || 8000);

export class BillingError extends Error {
  constructor(message, { status = 0, code = "billing_error", unavailable = false } = {}) {
    super(message);
    this.name = "BillingError";
    this.status = status;
    this.code = code;
    this.unavailable = unavailable;
  }
}

function config() {
  return {
    baseUrl: (process.env.BILLING_API_URL || "http://localhost:4000").replace(/\/$/, ""),
    key: process.env.BILLING_API_KEY || "",
    secret: process.env.BILLING_API_SECRET || "",
  };
}

export function billingConfigured() {
  const { key, secret } = config();
  return Boolean(key && secret);
}

function sign(secret, method, path, rawBody, timestamp) {
  const canonical = `${timestamp}\n${method.toUpperCase()}\n${path}\n${crypto
    .createHash("sha256")
    .update(rawBody)
    .digest("hex")}`;
  return crypto.createHmac("sha256", secret).update(canonical).digest("hex");
}

async function request(method, path, { query, body, idempotencyKey, timeoutMs } = {}) {
  const { baseUrl, key, secret } = config();
  if (!key || !secret) {
    throw new BillingError(
      "The billing service credentials are not configured on this LMS.",
      { code: "billing_unconfigured", unavailable: true }
    );
  }

  const search = query
    ? `?${new URLSearchParams(
        Object.entries(query).filter(([, value]) => value !== undefined && value !== null && value !== "")
      ).toString()}`
    : "";
  // Signed path must match what the billing service receives verbatim.
  const signedPath = `/api/billing${path}${search}`;
  const rawBody = body == null ? "" : JSON.stringify(body);
  const timestamp = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || DEFAULT_TIMEOUT);

  let response;
  try {
    response = await fetch(`${baseUrl}${signedPath}`, {
      method,
      headers: {
        accept: "application/json",
        ...(rawBody ? { "content-type": "application/json" } : {}),
        "x-billing-key": key,
        "x-billing-timestamp": String(timestamp),
        "x-billing-signature": sign(secret, method, signedPath, rawBody, timestamp),
        ...(idempotencyKey ? { "idempotency-key": String(idempotencyKey) } : {}),
      },
      body: rawBody || undefined,
      signal: controller.signal,
    });
  } catch (error) {
    const timedOut = error.name === "AbortError";
    console.error(
      `[finance] Billing API ${method} ${signedPath} failed:`,
      timedOut ? "request timed out" : error.message
    );
    throw new BillingError(
      timedOut
        ? "The billing service did not respond in time."
        : "The billing service is unreachable.",
      { code: timedOut ? "billing_timeout" : "billing_unavailable", unavailable: true }
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { message: text };
  }

  if (!response.ok) {
    console.error(
      `[finance] Billing API ${method} ${signedPath} returned ${response.status}:`,
      payload?.message || payload?.error || "unknown error"
    );
    throw new BillingError(payload?.message || "The billing service rejected the request.", {
      status: response.status,
      code: payload?.error || `billing_http_${response.status}`,
      unavailable: response.status >= 500,
    });
  }

  return payload;
}

export const billing = {
  health: () => request("GET", "/health"),
  dashboard: () => request("GET", "/dashboard"),
  revenue: (months = 6) => request("GET", "/revenue", { query: { months } }),
  reports: ({ from, to } = {}) => request("GET", "/reports", { query: { from, to } }),
  transactions: (query) => request("GET", "/transactions", { query }),
  courses: () => request("GET", "/courses"),
  syncCourse: (course) => request("POST", "/courses", { body: course }),
  updateCourse: (courseId, course) =>
    request("PUT", `/courses/${courseId}`, { body: course }),
  archiveCourse: (courseId) => request("DELETE", `/courses/${courseId}`),
  checkout: (payload, idempotencyKey) =>
    request("POST", "/checkout", { body: payload, idempotencyKey }),
  payment: (reference) => request("GET", `/payments/${encodeURIComponent(reference)}`),
  verifyPayment: (reference) =>
    request("POST", "/payments/verify", { body: { reference } }),
  refund: (reference, payload = {}) =>
    request("POST", `/refunds`, { body: { reference, ...payload } }),
  receipts: (query) => request("GET", "/receipts", { query }),
  receipt: (reference) => request("GET", `/receipts/${encodeURIComponent(reference)}`),
};
