import bcrypt from "bcrypt";
import crypto from "crypto";
import { Op } from "sequelize";
import { User, PasswordReset, Session } from "../models/index.js";
import { landingFor, logActivity } from "../middleware/auth.js";
import { autoAssignTraining } from "../services/hrService.js";
import { notify } from "../services/progressService.js";
import {
  buildAuthorizationUrl,
  createPkcePair,
  exchangeAuthorizationCode,
  fetchGoogleProfile,
  googleConfigured,
  isVerifiedGoogleProfile,
} from "../services/googleOAuth.js";
import { mailConfigured, sendPasswordReset } from "../services/mailer.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OAUTH_TTL_MS = 10 * 60 * 1000;

function safeDestination(value) {
  const next = String(value || "");
  return next.startsWith("/") && !next.startsWith("//") ? next : "";
}

function stateMatches(expected, received) {
  const left = Buffer.from(String(expected || ""));
  const right = Buffer.from(String(received || ""));
  if (!left.length || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

async function establishSession(req, user, destination, message) {
  await new Promise((resolve, reject) =>
    req.session.regenerate((error) => (error ? reject(error) : resolve()))
  );
  req.session.userId = user.id;
  await user.update({ lastLoginAt: new Date() });
  req.user = user;
  await logActivity(req, "Signed in", { entityType: "user", entityId: user.id });
  req.flash("success_msg", message);
  return destination || landingFor(user);
}

export const loginPage = (req, res) =>
  res.render("login", {
    title: "Sign in",
    next: req.query.next || "",
    googleEnabled: googleConfigured(),
  });

export const registerPage = (req, res) =>
  res.render("register", { title: "Create account" });

export const forgotPasswordPage = (req, res) =>
  res.render("forgotpassword", { title: "Reset password" });

export async function loginUser(req, res) {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");

  if (!EMAIL_RE.test(email) || !password) {
    req.flash("error_msg", "Enter a valid email address and password.");
    return res.redirect("/login");
  }

  const user = await User.findOne({ where: { email } });
  const valid = user ? await bcrypt.compare(password, user.password) : false;
  if (!user || !valid) {
    req.recordLoginFailure?.();
    req.flash("error_msg", "Incorrect email or password.");
    return res.redirect("/login");
  }
  if (!user.isActive) {
    req.flash("error_msg", "This account is deactivated. Contact your administrator.");
    return res.redirect("/login");
  }

  req.clearLoginFailures?.();
  const destination = await establishSession(
    req,
    user,
    safeDestination(req.body.next),
    `Welcome back, ${user.name.split(" ")[0]}.`
  );
  return res.redirect(destination);
}

export function startGoogleAuth(req, res) {
  if (!googleConfigured()) {
    req.flash("error_msg", "Google sign-in is not configured. Use your email and password.");
    return res.redirect("/login");
  }

  const { verifier, challenge } = createPkcePair();
  const state = crypto.randomBytes(32).toString("base64url");
  req.session.googleOAuth = {
    state,
    verifier,
    next: safeDestination(req.query.next),
    createdAt: Date.now(),
  };

  return req.session.save((error) => {
    if (error) {
      console.error("Google sign-in session failed:", error.message);
      req.flash("error_msg", "Google sign-in could not be started. Please try again.");
      return res.redirect("/login");
    }
    return res.redirect(buildAuthorizationUrl({ state, codeChallenge: challenge }));
  });
}

export async function googleCallback(req, res) {
  const pending = req.session.googleOAuth;
  delete req.session.googleOAuth;

  const fail = (message) => {
    req.flash("error_msg", message);
    return req.session.save(() => res.redirect("/login"));
  };

  if (!googleConfigured()) {
    return fail("Google sign-in is not configured. Use your email and password.");
  }
  if (!pending || Date.now() - Number(pending.createdAt || 0) > OAUTH_TTL_MS) {
    return fail("Your Google sign-in session expired. Please try again.");
  }
  if (req.query.error) {
    return fail("Google sign-in was cancelled or denied.");
  }
  if (!stateMatches(pending.state, req.query.state) || !req.query.code) {
    console.warn("Rejected Google callback with an invalid state or missing code.");
    return fail("Google sign-in could not be verified. Please try again.");
  }

  try {
    const tokens = await exchangeAuthorizationCode({
      code: req.query.code,
      codeVerifier: pending.verifier,
    });
    const profile = await fetchGoogleProfile(tokens.access_token);

    if (!isVerifiedGoogleProfile(profile)) {
      return fail("Google did not confirm a verified email address for this account.");
    }

    const email = String(profile.email || "").trim().toLowerCase();
    const googleId = String(profile.sub);
    if (!EMAIL_RE.test(email) || !googleId) {
      return fail("Google did not return a usable account profile.");
    }

    let user = await User.findOne({ where: { googleId } });
    if (user && !user.isActive) {
      return fail("This account is deactivated. Contact your administrator.");
    }

    if (!user) {
      const existing = await User.findOne({ where: { email } });
      if (existing) {
        // Privileged accounts stay password-only. A matching Google email must
        // never become a route into HR, instructor, or administrator access.
        if (existing.role !== "learner") {
          console.warn(
            `[oauth] Refused Google auto-link for privileged account ${existing.id} (${existing.role}).`
          );
          return fail("Staff accounts must sign in with their existing credentials.");
        }
        if (existing.googleId && existing.googleId !== googleId) {
          return fail("That email is already linked to a different Google account.");
        }
        if (!existing.isActive) {
          return fail("This account is deactivated. Contact your administrator.");
        }
        await existing.update({ googleId, emailVerified: true });
        user = existing;
      }
    }

    if (!user) {
      const hashed = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 10);
      try {
        user = await User.create({
          name: String(profile.name || email.split("@")[0]).trim().slice(0, 120),
          email,
          password: hashed,
          googleId,
          emailVerified: true,
          authProvider: "google",
          role: "learner",
          employmentStatus: "active",
        });
        await autoAssignTraining(user);
        await notify(user.id, {
          title: "Welcome to Vanguard Learning",
          message:
            "Your Google account is connected. Browse the catalog and start your onboarding training.",
          type: "info",
          link: "/courses",
        });
      } catch (error) {
        // Concurrent callbacks can race on the unique email. Reuse that account
        // only when it is still an unlinked learner.
        if (error?.name === "SequelizeUniqueConstraintError") {
          const raced = await User.findOne({ where: { email } });
          if (!raced || raced.role !== "learner" || (raced.googleId && raced.googleId !== googleId)) {
            return fail("That email is already linked to another account.");
          }
          if (!raced.isActive) {
            return fail("This account is deactivated. Contact your administrator.");
          }
          await raced.update({ googleId, emailVerified: true });
          user = raced;
        } else {
          throw error;
        }
      }
    }

    await user.update({ emailVerified: true, lastLoginAt: new Date() });
    const destination = safeDestination(pending.next);
    await new Promise((resolve, reject) =>
      req.session.regenerate((error) => (error ? reject(error) : resolve()))
    );
    req.session.userId = user.id;
    req.user = user;
    await logActivity(req, "Signed in with Google", {
      entityType: "user",
      entityId: user.id,
    });
    req.flash("success_msg", `Welcome, ${user.name.split(" ")[0]}.`);
    return req.session.save(() =>
      res.redirect(destination || landingFor(user))
    );
  } catch (error) {
    console.error("Google sign-in failed:", error.code || error.message);
    return fail("Google sign-in could not be completed. Please try again.");
  }
}

export async function registerUser(req, res) {
  const name = String(req.body.name || "").trim();
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const confirm = String(req.body.confirm_password || "");

  if (name.length < 2) {
    req.flash("error_msg", "Enter your full name.");
    return res.redirect("/register");
  }
  if (!EMAIL_RE.test(email)) {
    req.flash("error_msg", "Enter a valid email address.");
    return res.redirect("/register");
  }
  if (password.length < 8) {
    req.flash("error_msg", "Password must be at least 8 characters.");
    return res.redirect("/register");
  }
  if (password !== confirm) {
    req.flash("error_msg", "Passwords do not match.");
    return res.redirect("/register");
  }
  if (await User.findOne({ where: { email } })) {
    req.flash("error_msg", "An account with that email already exists.");
    return res.redirect("/register");
  }

  const hashed = await bcrypt.hash(password, 10);
  const user = await User.create({
    name,
    email,
    password: hashed,
    role: "learner",
    employmentStatus: "active",
  });

  await new Promise((resolve, reject) =>
    req.session.regenerate((error) => (error ? reject(error) : resolve()))
  );
  req.session.userId = user.id;
  await autoAssignTraining(user);
  await notify(user.id, {
    title: "Welcome to Vanguard Learning",
    message:
      "Your learning account is ready. Browse the catalog and start your onboarding training.",
    type: "info",
    link: "/courses",
  });
  await logActivity(req, "Registered account", { entityType: "user", entityId: user.id });

  req.flash("success_msg", "Account created. Welcome to Vanguard Learning!");
  return res.redirect("/dashboard");
}

const RESET_TTL_MS = 30 * 60 * 1000;

function hashResetToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

async function revokeUserSessions(userId) {
  await Session.destroy({
    where: {
      [Op.or]: [
        { data: { [Op.like]: `%"userId":${userId},%` } },
        { data: { [Op.like]: `%"userId":${userId}}%` } },
      ],
    },
  });
}

export async function requestPasswordReset(req, res) {
  const email = String(req.body.email || "").trim().toLowerCase();
  const generic =
    "If that email is registered, a password reset link has been sent.";

  try {
    if (EMAIL_RE.test(email)) {
      const user = await User.findOne({ where: { email } });
      if (user && user.isActive) {
        if (!mailConfigured()) {
          console.warn(
            "[auth] Password reset requested but MAIL_HOST/MAIL_FROM_ADDRESS are not configured."
          );
        } else {
          const token = crypto.randomBytes(32).toString("base64url");
          await PasswordReset.create({
            userId: user.id,
            tokenHash: hashResetToken(token),
            expiresAt: new Date(Date.now() + RESET_TTL_MS),
          });
          await sendPasswordReset({ to: user.email, name: user.name, token });
        }
      }
    }
  } catch (error) {
    // Never expose whether the account exists or whether delivery succeeded.
    console.error("[auth] Password reset request failed:", error.message);
  }

  req.flash("success_msg", generic);
  return res.redirect("/login");
}

export async function resetPasswordPage(req, res) {
  const token = String(req.query.token || "");
  const record = token
    ? await PasswordReset.findOne({ where: { tokenHash: hashResetToken(token) } })
    : null;
  const valid =
    record && !record.usedAt && new Date(record.expiresAt).getTime() > Date.now();

  return res.render("reset-password", {
    title: "Choose a new password",
    token: valid ? token : "",
    invalid: !valid,
  });
}

export async function resetPassword(req, res) {
  const token = String(req.body.token || "");
  const password = String(req.body.password || "");
  const confirm = String(req.body.confirm_password || "");
  const invalidMessage =
    "That reset link is invalid or has expired. Request a new one from the sign-in page.";

  if (password.length < 8) {
    req.flash("error_msg", "Password must be at least 8 characters.");
    return res.redirect(`/reset-password?token=${encodeURIComponent(token)}`);
  }
  if (password !== confirm) {
    req.flash("error_msg", "Passwords do not match.");
    return res.redirect(`/reset-password?token=${encodeURIComponent(token)}`);
  }

  const record = token
    ? await PasswordReset.findOne({ where: { tokenHash: hashResetToken(token) } })
    : null;
  if (!record || record.usedAt || new Date(record.expiresAt).getTime() <= Date.now()) {
    req.flash("error_msg", invalidMessage);
    return res.redirect("/forgot-password");
  }

  const [claimed] = await PasswordReset.update(
    { usedAt: new Date() },
    { where: { id: record.id, usedAt: null } }
  );
  if (!claimed) {
    req.flash("error_msg", invalidMessage);
    return res.redirect("/forgot-password");
  }

  const user = await User.findByPk(record.userId);
  if (!user || !user.isActive) {
    req.flash("error_msg", invalidMessage);
    return res.redirect("/forgot-password");
  }

  await user.update({
    password: await bcrypt.hash(password, 10),
    emailVerified: true,
  });
  await PasswordReset.update(
    { usedAt: new Date() },
    { where: { userId: user.id, usedAt: null } }
  );
  await revokeUserSessions(user.id);

  await new Promise((resolve, reject) =>
    req.session.regenerate((error) => (error ? reject(error) : resolve()))
  );
  req.flash("success_msg", "Password updated. Sign in with your new password.");
  return req.session.save(() => res.redirect("/login"));
}

export function logoutUser(req, res) {
  req.session.destroy(() => {
    res.clearCookie("vanguard.sid");
    res.redirect("/login");
  });
}

export function dashboardPage(req, res) {
  return res.redirect(landingFor(req.user));
}
