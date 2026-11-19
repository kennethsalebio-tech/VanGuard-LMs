/*
 * Server-to-server authentication for the billing API.
 *
 * LMS_IND signs every request with a shared secret using HMAC-SHA256. The
 * signed string is:
 *
 *   <timestamp>\n<METHOD>\n<path>\n<sha256(raw body)>
 *
 * Headers:
 *   X-Billing-Key        public key id (BILLING_API_KEY)
 *   X-Billing-Timestamp  unix milliseconds
 *   X-Billing-Signature  lowercase hex digest
 *
 * A request is rejected when the key is wrong, the timestamp is outside the
 * replay window, or the signature does not match the exact bytes received.
 */
import crypto from "crypto";

const REPLAY_WINDOW_MS = 5 * 60 * 1000;

function digestBody(rawBody) {
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody || "");
  return crypto.createHash("sha256").update(body).digest("hex");
}

export function signRequest({ secret, method, path, rawBody = "", timestamp = Date.now() }) {
  const canonical = `${timestamp}\n${String(method).toUpperCase()}\n${path}\n${digestBody(rawBody)}`;
  return crypto.createHmac("sha256", secret).update(canonical).digest("hex");
}

export function safeEqual(a = "", b = "") {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function requireApiAuth(req, res, next) {
  const apiKey = process.env.BILLING_API_KEY;
  const apiSecret = process.env.BILLING_API_SECRET;

  if (!apiKey || !apiSecret) {
    return res.status(503).json({
      error: "billing_api_unconfigured",
      message:
        "Set BILLING_API_KEY and BILLING_API_SECRET before using the billing API.",
    });
  }

  const providedKey = req.get("x-billing-key") || "";
  const timestamp = req.get("x-billing-timestamp") || "";
  const signature = req.get("x-billing-signature") || "";

  if (!safeEqual(providedKey, apiKey)) {
    return res.status(401).json({ error: "invalid_api_key" });
  }

  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt) || Math.abs(Date.now() - sentAt) > REPLAY_WINDOW_MS) {
    return res.status(401).json({
      error: "stale_request",
      message: "The signed request timestamp is missing or outside the 5 minute window.",
    });
  }

  const expected = signRequest({
    secret: apiSecret,
    method: req.method,
    path: req.originalUrl,
    rawBody: req.rawBody || "",
    timestamp: sentAt,
  });

  if (!safeEqual(signature, expected)) {
    return res.status(401).json({ error: "invalid_signature" });
  }

  return next();
}

/*
 * Payment-provider webhooks are validated with a different secret so provider
 * traffic can never be mistaken for LMS traffic.
 */
export function verifyProviderWebhook({ provider, rawBody, timestamp, signature }) {
  const secret = process.env.PAYMENT_WEBHOOK_SECRET;
  if (!secret) return { ok: false, reason: "webhook_secret_missing" };

  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt) || Math.abs(Date.now() - sentAt) > REPLAY_WINDOW_MS) {
    return { ok: false, reason: "stale_webhook" };
  }

  const canonical = `${sentAt}\n${String(provider || "")}\n${Buffer.from(
    rawBody || ""
  ).toString("utf8")}`;
  const expected = crypto.createHmac("sha256", secret).update(canonical).digest("hex");

  if (!safeEqual(signature, expected)) return { ok: false, reason: "invalid_signature" };
  return { ok: true };
}
