// Shared cookie-setting logic for the login/refresh/logout routes (D2,
// batch 04 auth/session parity). Kept in one place so the three routes'
// cookie shape never drifts from each other -- login issues the initial
// pair, refresh rotates both (backend rotation contract), logout clears
// all three.

import type { cookies } from "next/headers";

export const ACCESS_TOKEN_COOKIE = "access_token";
export const REFRESH_TOKEN_COOKIE = "refresh_token";
// Non-HttpOnly: the whole point is that SessionKeeper (client component)
// can read it. Holds the access token's `exp` claim as epoch millis.
export const SESSION_EXPIRES_AT_COOKIE = "session_expires_at";

// Duck-typed against the subset of next/headers' cookie store API these
// routes actually use (.set/.get/.delete) -- Next doesn't export a stable
// public type for the resolved value, and this form lets tests pass a
// minimal fake jar instead of standing up real Next internals.
type CookieStore = Pick<Awaited<ReturnType<typeof cookies>>, "set" | "get" | "delete">;

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
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
  cookieStore.set(REFRESH_TOKEN_COOKIE, tokens.refreshToken, { ...baseCookieOptions, httpOnly: true });

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
}

export function clearSessionCookies(cookieStore: CookieStore): void {
  cookieStore.delete(ACCESS_TOKEN_COOKIE);
  cookieStore.delete(REFRESH_TOKEN_COOKIE);
  cookieStore.delete(SESSION_EXPIRES_AT_COOKIE);
}
