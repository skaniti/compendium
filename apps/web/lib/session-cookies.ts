// Shared cookie-setting logic for the login/refresh/logout routes (D2,
// batch 04 auth/session parity). Kept in one place so the three routes'
// cookie shape never drifts from each other -- login issues the initial
// pair, refresh rotates both (backend rotation contract), logout clears
// all five (access, refresh, expires-at, policy, last-active).

import type { cookies } from "next/headers";

export const ACCESS_TOKEN_COOKIE = "access_token";
export const REFRESH_TOKEN_COOKIE = "refresh_token";
// Non-HttpOnly: the whole point is that SessionKeeper (client component)
// can read it. Holds the access token's `exp` claim as epoch millis.
export const SESSION_EXPIRES_AT_COOKIE = "session_expires_at";
// D1/D2 (session-expiry-tuning): non-HttpOnly, informational cookies read
// by lib/session-policy-client.ts (client-side) and this module (server
// route handlers). session_policy carries the backend's per-role decision
// of how idle-tolerant and resume-capable this session is; session_last_active
// is a plain epoch-ms timestamp SessionKeeper writes on real user activity
// (never here -- see applySessionCookies' own note below). Neither cookie
// enforces anything: the backend's token lifetimes remain the sole
// enforcement, exactly like session_expires_at above.
export const SESSION_POLICY_COOKIE = "session_policy";
export const SESSION_LAST_ACTIVE_COOKIE = "session_last_active";

// Policy + last-active cookies are informational and outlive a single
// access/refresh token pair (a remembered session's refresh token alone
// lives 90 days) -- give them a matching 90-day maxAge instead of the
// session-cookie (no maxAge) lifetime the other three get.
const POLICY_COOKIE_MAX_AGE_SECONDS = 90 * 24 * 60 * 60;

// Item 1 (session-expiry-tuning review fixes): refresh_token was
// unconditionally browser-session-scoped (no maxAge), so a "remembered"
// session -- whose backend refresh token is genuinely good for 90 days --
// still died the moment the browser closed. These mirror apps/api's
// Settings defaults (`jwt_refresh_token_expire_days` /
// `jwt_refresh_token_expire_days_remembered`, config/settings.py) and are
// COOKIE RETENTION ONLY: they control how long the browser holds onto the
// cookie, nothing more. The backend's stored refresh-token expiry remains
// the sole enforcement point, exactly like every other cookie in this
// module -- a longer/shorter cookie maxAge can at most make the client
// forget a token sooner than the backend would, never extend it.
export const REFRESH_COOKIE_MAX_AGE_SECONDS_DEFAULT = 7 * 24 * 3600;
export const REFRESH_COOKIE_MAX_AGE_SECONDS_REMEMBERED = 90 * 24 * 3600;

// Backend's per-(role, remembered) session policy (spec D1). idleMinutes
// === 0 means "never idle out" (the remembered-device row). Camel-cased
// once here at the boundary -- everything downstream (the cookie's own
// JSON contents, SessionKeeper, session-policy-client.ts) uses this shape,
// never the backend's raw snake_case.
export interface SessionPolicy {
  idleMinutes: number;
  resume: boolean;
  remembered: boolean;
}

// Exported for lib/session-policy-client.ts, which reads the ALREADY
// camelCase JSON this module writes into the session_policy cookie
// (applySessionCookies below) -- it validates the parsed cookie value with
// this same shape guard rather than duplicating the field checks.
export function isSessionPolicyShape(value: unknown): value is SessionPolicy {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.idleMinutes === "number" &&
    Number.isFinite(v.idleMinutes) &&
    v.idleMinutes >= 0 &&
    typeof v.resume === "boolean" &&
    typeof v.remembered === "boolean"
  );
}

// Accepts the backend's raw `session_policy` response body (snake_case:
// `{ idle_minutes, resume, remembered }`, per spec D1) and normalizes +
// validates it into the camelCase SessionPolicy shape. Returns null for
// anything malformed OR absent (a route handler passing `undefined` here --
// e.g. an older backend build mid-rollout that doesn't send session_policy
// yet -- gets null back, which callers treat as "leave the policy cookie
// untouched", not "clear it"; see applySessionCookies).
export function parseSessionPolicy(raw: unknown): SessionPolicy | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const candidate = {
    idleMinutes: r.idle_minutes,
    resume: r.resume,
    remembered: r.remembered,
  };
  return isSessionPolicyShape(candidate) ? candidate : null;
}

// Duck-typed against the subset of next/headers' cookie store API these
// routes actually use (.set/.get/.delete) -- Next doesn't export a stable
// public type for the resolved value, and this form lets tests pass a
// minimal fake jar instead of standing up real Next internals.
type CookieStore = Pick<Awaited<ReturnType<typeof cookies>>, "set" | "get" | "delete">;

export interface SessionTokens {
  accessToken: string;
  // Optional: view-as/return-to-admin (D5, batch 04) deliberately don't get
  // a refresh_token back from the backend (rotation would resurrect the
  // acting-as-demo identity past its 60-min TTL cap -- see those two
  // routes). When omitted, applySessionCookies leaves whatever
  // refresh_token cookie is already in the jar untouched instead of
  // clobbering it with undefined.
  refreshToken?: string;
  // Optional: the backend's session_policy, already parsed (parseSessionPolicy)
  // by the caller. Omitted -- not merely falsy -- when the backend response
  // didn't carry a session_policy at all (rollout backward-compat, D1): the
  // policy cookie is left exactly as it already is, never cleared just
  // because this particular response didn't include one.
  policy?: SessionPolicy;
}

const baseCookieOptions = {
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
};

// Decodes -- does NOT verify -- a JWT payload to read its `exp` claim
// (seconds since epoch). No signature check is performed or needed: this is
// purely informational, letting SessionKeeper know when to attempt a
// refresh. The backend (verify_api_key) remains the sole enforcement point
// regardless of what this reads; a tampered value here can at most make the
// client refresh at the wrong time, never bypass auth.
export function decodeJwtExpiryMs(token: string): number | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    const payload: unknown = JSON.parse(json);
    if (typeof payload !== "object" || payload === null) return null;
    const exp = (payload as { exp?: unknown }).exp;
    if (typeof exp !== "number" || !Number.isFinite(exp)) return null;
    return exp * 1000;
  } catch {
    return null;
  }
}

// Sets both auth cookies plus the readable expiry cookie SessionKeeper
// polls. Used by both the login route (initial issue) and the refresh
// route (rotation).
export function applySessionCookies(cookieStore: CookieStore, tokens: SessionTokens): void {
  cookieStore.set(ACCESS_TOKEN_COOKIE, tokens.accessToken, { ...baseCookieOptions, httpOnly: true });
  if (tokens.refreshToken !== undefined) {
    // Item 1 (session-expiry-tuning review fixes): only set a maxAge when a
    // policy is present -- an older backend build mid-rollout (or
    // view-as/return, which omit refreshToken outright and never reach
    // this branch) leaves today's behaviour byte-identical (no maxAge,
    // browser-session-scoped).
    const refreshCookieOptions =
      tokens.policy !== undefined
        ? {
            ...baseCookieOptions,
            httpOnly: true,
            maxAge: tokens.policy.remembered
              ? REFRESH_COOKIE_MAX_AGE_SECONDS_REMEMBERED
              : REFRESH_COOKIE_MAX_AGE_SECONDS_DEFAULT,
          }
        : { ...baseCookieOptions, httpOnly: true };
    cookieStore.set(REFRESH_TOKEN_COOKIE, tokens.refreshToken, refreshCookieOptions);
  }
  // else: no-op -- see the SessionTokens.refreshToken doc comment above.

  const expiresAtMs = decodeJwtExpiryMs(tokens.accessToken);
  if (expiresAtMs !== null) {
    cookieStore.set(SESSION_EXPIRES_AT_COOKIE, String(expiresAtMs), {
      ...baseCookieOptions,
      httpOnly: false,
    });
  } else {
    // No readable exp (unexpected token shape) -- don't leave a stale
    // expiry cookie around; SessionKeeper treats its absence as inert.
    cookieStore.delete(SESSION_EXPIRES_AT_COOKIE);
  }

  if (tokens.policy !== undefined) {
    cookieStore.set(SESSION_POLICY_COOKIE, JSON.stringify(tokens.policy), {
      ...baseCookieOptions,
      httpOnly: false,
      maxAge: POLICY_COOKIE_MAX_AGE_SECONDS,
    });
  }
  // else: no-op -- see the SessionTokens.policy doc comment above.
}

// Item 3 (session-expiry-tuning review fixes): used by the login route to
// record login itself as activity, instead of deleting session_last_active
// as it did before -- a session with zero recorded activity must not read
// as "always active" against the permissive no-last-active fallbacks in
// lib/session-policy-client.ts's sessionMayResume/sessionLapsed. Same
// cookie shape as the other readable, non-httpOnly cookies (httpOnly:
// false, 90-day maxAge, matching session_policy above) -- centralized here
// so the login route doesn't hand-roll its own cookie options.
export function stampLastActive(cookieStore: CookieStore, nowMs: number): void {
  cookieStore.set(SESSION_LAST_ACTIVE_COOKIE, String(nowMs), {
    ...baseCookieOptions,
    httpOnly: false,
    maxAge: POLICY_COOKIE_MAX_AGE_SECONDS,
  });
}

export function clearSessionCookies(cookieStore: CookieStore): void {
  cookieStore.delete(ACCESS_TOKEN_COOKIE);
  cookieStore.delete(REFRESH_TOKEN_COOKIE);
  cookieStore.delete(SESSION_EXPIRES_AT_COOKIE);
  cookieStore.delete(SESSION_POLICY_COOKIE);
  cookieStore.delete(SESSION_LAST_ACTIVE_COOKIE);
}
