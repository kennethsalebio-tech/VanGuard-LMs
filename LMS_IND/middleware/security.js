import crypto from "crypto";

const loginAttempts = new Map();
const resetAttempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;
const RESET_WINDOW_MS = 60 * 60 * 1000;
const RESET_MAX_ATTEMPTS = 5;

export function securityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Permissions-Policy", "camera=(self), microphone=(self), geolocation=()");
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
}

export function csrfToken(req, res, next) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString("hex");
  }
  res.locals.csrfToken = req.session.csrfToken;
  next();
}

export function verifyCsrf(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  // Server-to-server billing callbacks carry an HMAC signature and have no
  // browser session; they are verified by the route handler instead.
  if (req.path === "/api/billing/webhook") return next();
  // Multipart bodies are parsed by multer on the route; those routes call
  // verifyCsrfNow immediately after the upload middleware.
  if ((req.headers["content-type"] || "").includes("multipart/form-data")) {
    return next();
  }
  return checkToken(req, res, next);
}

export function verifyCsrfNow(req, res, next) {
  return checkToken(req, res, next);
}

function checkToken(req, res, next) {
  const submitted = req.body?._csrf || req.get("x-csrf-token");
  if (submitted && submitted === req.session?.csrfToken) return next();

  // An expired or destroyed session has no CSRF token left. Send the user to
  // sign in again with their destination preserved instead of a dead-end 403.
  if (!req.session?.userId) {
    // The submitted URL is usually a POST-only action, so send the user back
    // to the page that hosted the form once they sign in again.
    const destination = `/login?next=${encodeURIComponent(safeReferer(req))}`;
    const redirect = () => res.redirect(destination);
    if (req.session) {
      req.flash("error_msg", "Your session expired. Please sign in again to continue.");
      return req.session.save(() => redirect());
    }
    return redirect();
  }

  // A signed-in session with a mismatched token usually means the page was
  // rendered before the session was replaced (for example by signing in again
  // in another tab). Nothing has been changed yet, so send the user back to
  // the page they came from instead of a dead-end 403. Genuine cross-site
  // submissions still never reach the handler.
  req.flash("error_msg", "Your form session expired. Please try that again.");
  return req.session.save(() => res.redirect(safeReferer(req)));
}

function safeReferer(req) {
  const referer = req.get("referer");
  if (referer) {
    try {
      const url = new URL(referer);
      if (url.host !== req.get("host")) return "/dashboard";
      if (["/login", "/register"].includes(url.pathname)) return "/dashboard";
      return url.pathname + url.search;
    } catch {
      // Fall through to the dashboard for malformed or off-site referers.
    }
  }
  return "/dashboard";
}

export function loginRateLimit(req, res, next) {
  const key = `${req.ip}|${String(req.body?.email || "").toLowerCase()}`;
  const now = Date.now();
  const attempts = (loginAttempts.get(key) || []).filter((t) => now - t < WINDOW_MS);
  if (attempts.length >= MAX_ATTEMPTS) {
    req.flash(
      "error_msg",
      "Too many sign-in attempts. Please wait 15 minutes before trying again."
    );
    return res.redirect("/login");
  }
  req.recordLoginFailure = () => {
    attempts.push(now);
    loginAttempts.set(key, attempts);
  };
  req.clearLoginFailures = () => loginAttempts.delete(key);
  next();
}

export function passwordResetRateLimit(req, res, next) {
  const key = String(req.ip || "unknown");
  const now = Date.now();
  const attempts = (resetAttempts.get(key) || []).filter(
    (time) => now - time < RESET_WINDOW_MS
  );
  if (attempts.length >= RESET_MAX_ATTEMPTS) {
    req.flash(
      "error_msg",
      "Too many reset attempts. Please wait before trying again."
    );
    return res.redirect("/forgot-password");
  }
  attempts.push(now);
  resetAttempts.set(key, attempts);
  next();
}

export function validateRequired(fields) {
  return (req, res, next) => {
    const missing = fields.filter((field) => {
      const value = req.body?.[field];
      return value === undefined || String(value).trim() === "";
    });
    if (missing.length) {
      req.flash("error_msg", `Please complete: ${missing.join(", ")}.`);
      return res.redirect(req.get("referer") || "/");
    }
    next();
  };
}
