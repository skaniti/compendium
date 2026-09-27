import { cookies } from "next/headers";
import { applySessionCookies, clearSessionCookies, parseSessionPolicy, REFRESH_TOKEN_COOKIE } from "@/lib/session-cookies";
import { ingressHeaders } from "@/lib/ingress";
import { proxyAttestHeaders } from "@/lib/proxy-attest";

export const runtime = "nodejs";

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:8001";

// D3 (session-expiry-tuning): the outcome of ONE backend refresh call,
// shared by every concurrent POST() awaiting the same refresh_token value
// (see inFlightRefreshes below). Deliberately NOT a shared Response -- a
// Response body can only be read once, and every awaiting caller needs its
// OWN cookie store written to (each POST() call runs in its own Next
// request context, via next/headers' cookies()) -- so the shared promise
// resolves to this plain-data result instead, and each caller applies
// cookies to its own jar from it.
type RefreshResult =
  | { kind: "ok"; accessToken: string; refreshToken: string; policy: ReturnType<typeof parseSessionPolicy> }
  | { kind: "auth-failed" }
  | { kind: "transient" };

// Module-level, per refresh-token value (not global) -- two DIFFERENT
// refresh tokens (e.g. two different users, or a token that already
// rotated) must never share an in-flight call. Deleted in `finally` so a
// later, independent refresh with the same token value (after this one
// settles) starts its own backend call rather than replaying a stale
// result.
const inFlightRefreshes = new Map<string, Promise<RefreshResult>>();

async function performBackendRefresh(
  refreshToken: string,
  extraHdrs: Record<string, string>
): Promise<RefreshResult> {
  let res: Response;
  try {
    res = await fetch(`${BACKEND}/api/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...extraHdrs },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
  } catch (err) {
    // Backend unreachable -- a network/transient problem, not proof the
    // refresh token itself is dead. Leave cookies intact (the access token
    // may still be valid for a while yet) and surface a retryable error
    // instead of hard-logging the user out over a connectivity blip.
    console.error("refresh: backend request failed:", err);
    return { kind: "transient" };
  }

  if (res.status === 401 || res.status === 403) {
    // The refresh token itself is invalid/expired/revoked -- there is no
    // session left to salvage.
    return { kind: "auth-failed" };
  }

  if (!res.ok) {
    // Any other backend failure (500/502/503/...) is presumed transient.
    console.error(`refresh: backend returned ${res.status}`);
    return { kind: "transient" };
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    token_type: string;
    session_policy?: unknown;
  };
  return {
    kind: "ok",
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    policy: parseSessionPolicy(data.session_policy),
  };
}

// Polled by components/SessionKeeper.tsx (D2: activity-scoped sliding
// refresh). Rotation contract mirrors the backend: every successful refresh
// returns a new access_token AND a new refresh_token, both of which replace
// the old cookies here.
//
// D3: single-flighted per refresh-token VALUE. Two tabs restored together
// (or apiFetch's silent recovery firing alongside SessionKeeper's own
// check) can both hit this route with the SAME refresh_token cookie before
// either backend call returns -- without sharing the call, both would
// rotate the token, and the backend's reuse-detection would treat the
// second rotation as a stolen-token replay and revoke every token for the
// user. Holds within one Node process (the current docker/local deploy
// shape); a multi-instance deploy would make this best-effort only (see
// spec D3).
export async function POST(req: Request): Promise<Response> {
  const cookieStore = await cookies();
  const refreshToken = cookieStore.get(REFRESH_TOKEN_COOKIE)?.value;
  if (!refreshToken) {
    // Item 4 (session-expiry-tuning review fixes): clear any stale
    // session_policy/session_last_active left over from a lost session
    // (e.g. a non-persistent refresh_token cookie that didn't survive a
    // browser restart) so they stop telling apiFetch/SessionKeeper this
    // session is resumable and triggering doomed refresh attempts.
    clearSessionCookies(cookieStore);
    return Response.json({ error: "No refresh token." }, { status: 401 });
  }

  let resultPromise = inFlightRefreshes.get(refreshToken);
  if (!resultPromise) {
    // D1/D4/D6 (session-expiry-tuning, 2026-09-10 amendment): the ingress
    // verdict forwarded to the backend is the FIRST caller's -- this map is
    // keyed by token value alone, so a second concurrent POST() presenting
    // the SAME refresh_token joins this in-flight call instead of starting
    // its own with its own ingress headers. Both callers are the same
    // browser/session (same refresh token), so in practice their ingress
    // verdicts match; documented here rather than silently assumed.
    // Task 7e (post-flip-closeout): proxyAttestHeaders(req) joins the same
    // in-flight call for the same reason -- it's inert ({}) until
    // BACKEND_PROXY_SECRET is configured, and once configured, concurrent
    // callers on the same refresh_token are the same browser/session.
    resultPromise = performBackendRefresh(refreshToken, {
      ...ingressHeaders(req),
      ...proxyAttestHeaders(req),
    }).finally(() => {
      inFlightRefreshes.delete(refreshToken);
    });
    inFlightRefreshes.set(refreshToken, resultPromise);
  }
  const result = await resultPromise;

  if (result.kind === "auth-failed") {
    // Clear all five cookies so the client-side 401 interceptor (lib/api.ts
    // apiFetch) bounces to /login on the very next request instead of
    // retrying against a dead session forever.
    clearSessionCookies(cookieStore);
    return Response.json({ error: "Refresh failed." }, { status: 401 });
  }

  if (result.kind === "transient") {
    // Do NOT clear cookies here -- that would hard-log-out an active user
    // over a backend blip -- and do NOT return 401, since apiFetch's
    // interceptor treats any 401 as an auth failure and redirects to
    // /login. SessionKeeper just retries on its next check interval.
    return Response.json({ error: "Refresh temporarily unavailable." }, { status: 502 });
  }

  applySessionCookies(cookieStore, {
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    policy: result.policy ?? undefined,
  });
  return Response.json({ ok: true });
}
