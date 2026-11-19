/*
 * Runtime configuration checks.
 *
 * Development can run with safe local defaults, but production must never boot
 * with missing secrets, localhost URLs, or an unconfigured Google login.
 */
export const isProduction = () => process.env.NODE_ENV === "production";

export function googleOAuthConfigured() {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID &&
      process.env.GOOGLE_CLIENT_SECRET &&
      process.env.GOOGLE_CALLBACK_URL
  );
}

export function validateRuntimeConfig() {
  const errors = [];
  const production = isProduction();

  if (production) {
    const secret = String(process.env.SESSION_SECRET || "");
    if (secret.length < 32 || /dev-secret|replace|change/i.test(secret)) {
      errors.push("SESSION_SECRET must be a random value of at least 32 characters.");
    }

    const appUrl = String(process.env.APP_URL || "");
    if (!/^https:\/\//i.test(appUrl)) {
      errors.push("APP_URL must be the public HTTPS URL in production.");
    }

    if (!googleOAuthConfigured()) {
      errors.push("GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_CALLBACK_URL are required.");
    } else if (!/^https:\/\//i.test(process.env.GOOGLE_CALLBACK_URL)) {
      errors.push("GOOGLE_CALLBACK_URL must use HTTPS in production.");
    }

    if (!process.env.BILLING_API_KEY || !process.env.BILLING_API_SECRET) {
      errors.push("BILLING_API_KEY and BILLING_API_SECRET are required.");
    }
    if (!/^https:\/\//i.test(String(process.env.BILLING_API_URL || ""))) {
      errors.push("BILLING_API_URL must use HTTPS in production.");
    }
    if (!process.env.LMS_WEBHOOK_SECRET) {
      errors.push("LMS_WEBHOOK_SECRET is required.");
    }

    if (!process.env.MAIL_HOST || !process.env.MAIL_PORT || !process.env.MAIL_FROM_ADDRESS) {
      errors.push("MAIL_HOST, MAIL_PORT and MAIL_FROM_ADDRESS are required for password reset email.");
    }

    if ((process.env.DB_DIALECT || "sqlite").toLowerCase() === "sqlite") {
      console.warn(
        "[config] SQLite is active in production. Use a managed MySQL database for multi-instance deployments."
      );
    }
  } else {
    if (!googleOAuthConfigured()) {
      console.warn("[config] Google sign-in is disabled until its three environment variables are set.");
    }
    if (!process.env.BILLING_API_KEY || !process.env.BILLING_API_SECRET) {
      console.warn("[config] Billing integration is disabled until BILLING_API_KEY/SECRET are set.");
    }
  }

  if (errors.length) {
    throw new Error(`Invalid production configuration:\n- ${errors.join("\n- ")}`);
  }
}
