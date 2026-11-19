export const isProduction = () => process.env.NODE_ENV === "production";

export const paymentProvider = () =>
  String(process.env.PAYMENT_PROVIDER || "sandbox").toLowerCase();

export function hitpayConfigured() {
  return Boolean(process.env.HITPAY_API_KEY);
}

export function validateRuntimeConfig() {
  const errors = [];
  const production = isProduction();
  const provider = paymentProvider();

  if (!["sandbox", "hitpay"].includes(provider)) {
    errors.push("PAYMENT_PROVIDER must be either 'hitpay' or 'sandbox'.");
  }
  if (production && provider !== "hitpay") {
    errors.push("PAYMENT_PROVIDER must be 'hitpay' in production. Sandbox is test-only.");
  }

  if (!process.env.BILLING_API_KEY || !process.env.BILLING_API_SECRET) {
    errors.push("BILLING_API_KEY and BILLING_API_SECRET are required.");
  }
  if (!process.env.LMS_WEBHOOK_URL || !process.env.LMS_WEBHOOK_SECRET) {
    errors.push("LMS_WEBHOOK_URL and LMS_WEBHOOK_SECRET are required.");
  }

  if (production) {
    if (String(process.env.SESSION_SECRET || "").length < 32) {
      errors.push("SESSION_SECRET must be a random value of at least 32 characters.");
    }
    if (!/^https:\/\//i.test(String(process.env.BILLING_PUBLIC_URL || ""))) {
      errors.push("BILLING_PUBLIC_URL must use HTTPS in production.");
    }
    if (!/^https:\/\//i.test(String(process.env.LMS_PUBLIC_URL || ""))) {
      errors.push("LMS_PUBLIC_URL must use HTTPS in production.");
    }
    if (!/^https:\/\//i.test(String(process.env.LMS_WEBHOOK_URL || ""))) {
      errors.push("LMS_WEBHOOK_URL must use HTTPS in production.");
    }
  }

  if (provider === "hitpay") {
    if (!process.env.HITPAY_API_KEY) {
      errors.push("HITPAY_API_KEY is required when PAYMENT_PROVIDER=hitpay.");
    }
    if (!process.env.HITPAY_WEBHOOK_SALT) {
      errors.push("HITPAY_WEBHOOK_SALT is required when PAYMENT_PROVIDER=hitpay.");
    }
    if (production && process.env.HITPAY_ENVIRONMENT !== "production") {
      errors.push("HITPAY_ENVIRONMENT must be 'production' in production.");
    }
    const hitpayUrl = String(process.env.HITPAY_API_URL || "");
    if (hitpayUrl && !/^https:\/\//i.test(hitpayUrl)) {
      errors.push("HITPAY_API_URL must use HTTPS.");
    }
  }

  if (errors.length) {
    throw new Error(`Invalid billing configuration:\n- ${errors.join("\n- ")}`);
  }
}
