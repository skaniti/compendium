// D2/D3 (session-expiry-tuning): client-side reads/writes for the two
// non-HttpOnly, informational cookies lib/session-cookies.ts's
// applySessionCookies/clearSessionCookies own server-side --
// `session_policy` (the backend's per-role decision, JSON, camelCase --
// see that module's SessionPolicy type) and `session_last_active` (epoch
// ms, written here on real user activity; the login route also stamps it
// to "now" on successful login, since login is itself activity -- see
// session-cookies.ts's stampLastActive -- and the server clears it on
// logout/refresh-failure via clearSessionCookies).
//
// Nothing here enforces anything: these are read by SessionKeeper (to
// decide WHEN to attempt a refresh) and lib/api.ts's apiFetch (to decide
// whether a 401 is worth a silent recovery attempt before bouncing to
// /login). The backend's token lifetimes remain the sole enforcement,
// exactly like session_expires_at.

import {
  isSessionPolicyShape,
  SESSION_EXPIRES_AT_COOKIE,
  SESSION_LAST_ACTIVE_COOKIE,
  SESSION_POLICY_COOKIE,
  type SessionPolicy,
} from "./session-cookies";

// Throttle for writeLastActiveMs: activity fires on every pointermove/
// keydown/wheel/scroll, which would otherwise write a cookie on nearly
// every event. 30s matches spec D2's own throttle figure.
const LAST_ACTIVE_WRITE_THROTTLE_MS = 30_000;
const COOKIE_MAX_AGE_SECONDS = 90 * 24 * 60 * 60; // 90 days, matches applySessionCookies' policy cookie

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const pattern = new RegExp(`(?:^|; )${name}=([^;]*)`);
  const match = document.cookie.match(pattern);
  return match ? decodeURIComponent(match[1]) : null;
}

// Reads + validates the session_policy cookie. Unlike
// session-cookies.ts's parseSessionPolicy (which normalizes the backend's
// RAW snake_case response body), this cookie already holds the camelCase
// SessionPolicy shape applySessionCookies wrote -- isSessionPolicyShape is
// the same field-level guard, just applied directly instead of after a
// snake_case->camelCase remap.
export function readSessionPolicy(): SessionPolicy | null {
  const raw = readCookie(SESSION_POLICY_COOKIE);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isSessionPolicyShape(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function readLastActiveMs(): number | null {
  const raw = readCookie(SESSION_LAST_ACTIVE_COOKIE);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

// Shared reader for session_expires_at -- SessionKeeper.tsx used to keep its
// own copy of this parsing; hoisted here (session-expiry-tuning review
// fixes, item 1) so sessionLapsed below (and SessionKeeper's own
// near-expiry check, which now imports this) read the exact same cookie
// the exact same way instead of two independently-maintained regexes.
export function readSessionExpiresAtMs(): number | null {
  const raw = readCookie(SESSION_EXPIRES_AT_COOKIE);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

// Module-scope, not per-call -- the throttle is meant to survive across
// the many activity events a single page session generates, not reset
// every call.
let lastWriteAtMs = 0;

// Test-only escape hatch: the throttle above is deliberately module-scope
// state (see the note on it), which means it also survives across test
// cases within one file unless reset. Exported so
// session-policy-client.test.ts can reset it in a beforeEach instead of
// relying on synthetically spaced timestamps to dodge the throttle window.
export function __resetThrottleForTests(): void {
  lastWriteAtMs = 0;
}

// Idle lapse must be FINAL (D2): once a session has genuinely lapsed --
// its access token has expired AND the PERSISTED session_last_active
// cookie is already outside the policy's idle window -- no further
// activity may revive it by silently refreshing that timestamp. Without
// this check, writeLastActiveMs would happily overwrite the stale
// last-active cookie on the very next pointerdown/keydown after a user
// returns from being idle, making the session look freshly active again
// and letting SessionKeeper's own idle check resurrect it via the
// still-live refresh token -- the batch-04 resurrection bug, one step
// later (this time surviving even a persisted, cross-reload cookie).
//
// Deliberately permissive (never lapsed) when: there is no policy cookie
// (pre-upgrade / dev no-auth mode -- unrelated to this policy-driven
// check), idleMinutes is 0 (remembered device, never idles out), there is
// no readable expiresAt cookie, the token has not actually expired yet, or
// there is no PRIOR stored last-active to compare against (first write
// this session -- e.g. right after login/refresh, before this cookie has
// ever been set).
export function sessionLapsed(nowMs: number): boolean {
  const policy = readSessionPolicy();
  if (!policy || policy.idleMinutes <= 0) return false;
  const expiresAt = readSessionExpiresAtMs();
  if (expiresAt === null || expiresAt > nowMs) return false;
  const storedLastActive = readLastActiveMs();
  if (storedLastActive === null) return false;
  return nowMs - storedLastActive >= policy.idleMinutes * 60_000;
}

// Writes session_last_active directly via document.cookie (no server
// round-trip -- this is purely a client-side "when did the user last do
// something" marker read back by sessionMayResume/SessionKeeper).
// Throttled to once per LAST_ACTIVE_WRITE_THROTTLE_MS unless `force` is
// set (used after a successful refresh triggered by real activity -- see
// SessionKeeper). Every writer funnels through here, so gating on
// sessionLapsed at this single choke point (rather than at each call site)
// covers SessionKeeper's markActive today and any future writer for free.
export function writeLastActiveMs(nowMs: number, options?: { force?: boolean }): void {
  if (typeof document === "undefined") return;
  if (!options?.force && nowMs - lastWriteAtMs < LAST_ACTIVE_WRITE_THROTTLE_MS) return;
  if (sessionLapsed(nowMs)) return;
  lastWriteAtMs = nowMs;
  const secure = typeof location !== "undefined" && location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${SESSION_LAST_ACTIVE_COOKIE}=${nowMs}; path=/; max-age=${COOKIE_MAX_AGE_SECONDS}; SameSite=Lax${secure}`;
}

// D3: the single gate lib/api.ts's apiFetch and app/login/LoginPageClient.tsx
// use to decide whether a 401 (or a /login mount) is worth attempting a
// silent recoverSession() at all, before ever calling the backend. A
// missing last-active cookie is treated as "active" (first visit after
// upgrade, or a policy cookie freshly set by login/refresh with no
// activity recorded yet) -- deliberately permissive, matching spec D3's
// formula verbatim.
export function sessionMayResume(nowMs: number): boolean {
  const policy = readSessionPolicy();
  if (!policy || !policy.resume) return false;
  if (policy.idleMinutes === 0) return true;
  const lastActive = readLastActiveMs();
  if (lastActive === null) return true;
  return nowMs - lastActive < policy.idleMinutes * 60_000;
}

// The idle window SessionKeeper actually checks against: the policy's own
// idleMinutes (0 = never idle out) when a policy cookie exists, else the
// pre-policy NEXT_PUBLIC_IDLE_MINUTES/60-fallback -- unchanged from
// SessionKeeper's own former readIdleMinutes so behaviour with NO policy
// cookie stays byte-identical to pre-D1. Written as a literal
// `process.env.NEXT_PUBLIC_IDLE_MINUTES` reference (not an indirected
// lookup) so Next's client build can still statically inline it per the
// NEXT_PUBLIC_* convention.
export function effectiveIdleMinutes(policy: SessionPolicy | null): number {
  if (policy) return policy.idleMinutes;
  const raw = process.env.NEXT_PUBLIC_IDLE_MINUTES;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60;
}
