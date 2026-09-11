import { cookies } from "next/headers";
import { ACCESS_TOKEN_COOKIE, applySessionCookies, parseSessionPolicy } from "@/lib/session-cookies";
import { ingressHeaders } from "@/lib/ingress";

export const runtime = "nodejs";

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:8001";

// D5 (batch 04 auth/session parity): admin-only demo switch. JWT port of
// Dash's session-cookie /__view_as_demo (frontend/dash/app.py:1566-1624) --
// the backend re-checks admin role from the DB and mints a demo-scoped
// access token carrying acting_as_demo/admin_origin_* claims. This route's
// only job is to forward the caller's own access token as Bearer auth and,
// on success, swap the cookie the same way the login route does.
//
// Task V3 item 4 fix: no longer self-rejects with 401 when the access_token
// cookie is absent -- ONLY conditionally adds the Authorization header,
// mirroring app/api/[...path]/route.ts's own "inject if present" idiom
// (that catch-all proxy backs every other authenticated GET/PATCH, e.g.
// /api/auth/me, and never had this route's extra gate). The upfront 401
// this used to return unconditionally 401'd (no cookie -> instant 401,
// same status apiFetch's own interceptor -- lib/api.ts -- treats as "bounce
// to /login") an admin session that AUTH_REQUIRED=unset (proxy.ts's own
// documented "local dev keeps its existing no-auth loop" contract) never
// forces through /login in the first place, so it never acquires a cookie
// -- yet the SAME session's role was already correctly resolved as "admin"
// moments earlier by SessionProvider's /api/auth/me read, which goes
// through the lenient catch-all and never needed a cookie either. Live-
// reproduced via CDP (task-V3-report.md): clicking "view demo" as admin
// with no cookie present landed on /login, 100% reproducible. Backend
// verification (backend/api/main.py's verify_api_key, explorer repo,
// read-only): in dev mode it bypasses auth entirely and resolves the
// request to the default dev user regardless of what's forwarded, so
// dropping the header here is safe and correct -- in production
// (AUTH_REQUIRED=1, backend not in dev mode) the SAME missing-header
// request still 401s, now from the backend's own real check instead of
// this route's redundant one, an identical outcome.
export async function POST(req: Request): Promise<Response> {
  const cookieStore = await cookies();
  const accessToken = cookieStore.get(ACCESS_TOKEN_COOKIE)?.value;

  let res: Response;
  try {
    // D1/D4/D6 (session-expiry-tuning, 2026-09-10 amendment): relay the
    // caller's ingress verdict so the backend's session_policy response
    // (D1's view-as-demo row) is computed the same way as every other auth
    // route -- this route already forwards the caller's own Authorization.
    const headers: Record<string, string> = { "Content-Type": "application/json", ...ingressHeaders(req) };
    if (accessToken) headers.authorization = `Bearer ${accessToken}`;
    res = await fetch(`${BACKEND}/api/auth/view-as`, {
      method: "POST",
      headers,
      body: JSON.stringify({ profile: "demo" }),
    });
  } catch (err) {
    console.error("view-as: backend request failed:", err);
    return Response.json({ error: "View-as temporarily unavailable." }, { status: 502 });
  }

  if (!res.ok) {
    // Mirrors the refresh route's post-fix restraint: ANY non-2xx (403 not
    // admin / already acting / demo account unavailable, 401 dead token,
    // 5xx) passes through as the SAME status without touching cookies --
    // the admin's existing session is untouched and Header just shows an
    // error for the click that failed.
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = { error: "View-as failed." };
    }
    return Response.json(body, { status: res.status });
  }

  const data = (await res.json()) as {
    access_token: string;
    token_type: string;
    user: { id: number; email: string; name: string };
    session_policy?: unknown;
  };

  // No refresh_token in this response, deliberately (backend: refresh
  // rotation would resurrect the acting-as-demo identity past its 60-min
  // TTL cap). applySessionCookies leaves the admin's existing refresh_token
  // cookie untouched -- it stays live through the acting session and is
  // usable again the moment /api/auth/return restores the admin's own
  // access token.
  //
  // D1 (session-expiry-tuning): the acting policy's resume is false (spec
  // D1's view-as-demo row) -- this is what stops SessionKeeper from ever
  // resuming an expired acting token by rotating the admin's own, still-live
  // refresh_token cookie mid-view-as.
  applySessionCookies(cookieStore, {
    accessToken: data.access_token,
    policy: parseSessionPolicy(data.session_policy) ?? undefined,
  });
  return Response.json({ user: data.user });
}
