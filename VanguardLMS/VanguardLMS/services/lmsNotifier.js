/*
 * Signed notifications from the billing service to LMS_IND.
 *
 * The LMS treats this as a hint only: before unlocking a course it re-reads the
 * payment from this API over the authenticated server-to-server channel. A
 * dropped webhook therefore delays access but can never corrupt it.
 */
import crypto from "crypto";

function sign(secret, timestamp, body) {
  return crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
}

function publicPayload(eventType, payment) {
  return {
    reference: payment.reference,
    status: payment.status,
    learnerId: payment.learnerId,
    courseId: payment.courseId,
    courseTitle: payment.courseTitle,
    amount: Number(payment.amount),
    currency: payment.currency,
    receiptNumber: payment.receiptNumber,
    paidAt: payment.paidAt,
    refundedAt: payment.refundedAt,
  };
}

export async function notifyLms(eventType, payment) {
  const url = process.env.LMS_WEBHOOK_URL;
  const secret = process.env.LMS_WEBHOOK_SECRET;

  if (!url || !secret) {
    console.warn(
      "[billing] LMS_WEBHOOK_URL / LMS_WEBHOOK_SECRET not set — payment notification skipped."
    );
    return { delivered: false, skipped: true };
  }

  const event = {
    // Stable per payment state, so a retried delivery is idempotent at the LMS.
    eventId: `${eventType}:${payment.reference}:${payment.status}`,
    type: eventType,
    sentAt: new Date().toISOString(),
    data: publicPayload(eventType, payment),
  };
  const body = JSON.stringify(event);
  const timestamp = Date.now();
  const signature = sign(secret, timestamp, body);

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-lms-timestamp": String(timestamp),
          "x-lms-signature": signature,
        },
        body,
        signal: controller.signal,
      });
      if (response.ok) return { delivered: true };
      console.warn(
        `[billing] LMS notification rejected (${response.status}) for ${payment.reference}.`
      );
    } catch (error) {
      console.warn(
        `[billing] LMS notification attempt ${attempt} failed for ${payment.reference}:`,
        error.message
      );
    } finally {
      clearTimeout(timer);
    }
  }

  return { delivered: false };
}
