/*
 * Minimal, dependency-free Google OpenID Connect authorization-code flow with
 * PKCE and state validation. All token exchange and profile requests happen
 * server-side; the browser only receives the Google authorization URL.
 */
import crypto from "crypto";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";

export function googleConfigured() {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID &&
      process.env.GOOGLE_CLIENT_SECRET &&
      process.env.GOOGLE_CALLBACK_URL
  );
}

export function createPkcePair() {
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  return { verifier, challenge };
}

export function buildAuthorizationUrl({ state, codeChallenge }) {
  if (!googleConfigured()) throw new Error("Google OAuth is not configured.");
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set("client_id", process.env.GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", process.env.GOOGLE_CALLBACK_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("access_type", "online");
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { error: "invalid_response", error_description: text };
  }
}

export async function exchangeAuthorizationCode({ code, codeVerifier }) {
  if (!googleConfigured()) throw new Error("Google OAuth is not configured.");
  const response = await fetchWithTimeout(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: String(code || ""),
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: process.env.GOOGLE_CALLBACK_URL,
      grant_type: "authorization_code",
      code_verifier: codeVerifier,
    }),
  });
  const payload = await readJson(response);
  if (!response.ok || !payload.access_token) {
    const error = new Error(
      payload.error_description || payload.error || "Google token exchange failed."
    );
    error.code = payload.error || "google_token_exchange_failed";
    throw error;
  }
  return payload;
}

export async function fetchGoogleProfile(accessToken) {
  const response = await fetchWithTimeout(USERINFO_ENDPOINT, {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  });
  const profile = await readJson(response);
  if (!response.ok || !profile.sub) {
    const error = new Error("Google profile request failed.");
    error.code = profile.error || "google_profile_failed";
    throw error;
  }
  return profile;
}

export function isVerifiedGoogleProfile(profile) {
  return (
    Boolean(profile?.email) &&
    (profile.email_verified === true || profile.email_verified === "true")
  );
}
