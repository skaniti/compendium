import { cookies } from "next/headers";
import { applySessionCookies, clearSessionCookies, REFRESH_TOKEN_COOKIE } from "@/lib/session-cookies";

export const runtime = "nodejs";

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:8001";

// Polled by components/SessionKeeper.tsx (D2: activity-scoped sliding
// refresh). Rotation contract mirrors the backend: every successful refresh
// returns a new access_token AND a new refresh_token, both of which replace
// the old cookies here.
export async function POST(): Promise<Response> {
  const cookieStore = await cookies();
  const refreshToken = cookieStore.get(REFRESH_TOKEN_COOKIE)?.value;
  if (!refreshToken) {
    return Response.json({ error: "No refresh token." }, { status: 401 });
  }

  let res: Response;
  try {
    res = await fetch(`${BACKEND}/api/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
  } catch (err) {
    // Backend unreachable -- a network/transient problem, not proof the
    // refresh token itself is dead. Leave cookies intact (the access token
    // may still be valid for a while yet) and surface a retryable error
    // instead of hard-logging the user out over a connectivity blip.
    console.error("refresh: backend request failed:", err);
    return Response.json({ error: "Refresh temporarily unavailable." }, { status: 502 });
  }

  if (res.status === 401 || res.status === 403) {
    // The refresh token itself is invalid/expired/revoked -- there is no
    // session left to salvage. Clear all three cookies so the client-side
    // 401 interceptor (lib/api.ts apiFetch) bounces to /login on the very
    // next request instead of retrying against a dead session forever.
    clearSessionCookies(cookieStore);
    return Response.json({ error: "Refresh failed." }, { status: 401 });
  }

  if (!res.ok) {
    // Any other backend failure (500/502/503/...) is presumed transient.
    // Do NOT clear cookies here -- that would hard-log-out an active user
    // over a backend blip -- and do NOT return 401, since apiFetch's
    // interceptor treats any 401 as an auth failure and redirects to
    // /login. SessionKeeper just retries on its next check interval.
    console.error(`refresh: backend returned ${res.status}`);
    return Response.json({ error: "Refresh temporarily unavailable." }, { status: 502 });
  }

  const data = (await res.json()) as { access_token: string; refresh_token: string; token_type: string };
  applySessionCookies(cookieStore, { accessToken: data.access_token, refreshToken: data.refresh_token });
  return Response.json({ ok: true });
}
