import { cookies } from "next/headers";
import { ACCESS_TOKEN_COOKIE, applySessionCookies, parseSessionPolicy } from "@/lib/session-cookies";
import { ingressHeaders } from "@/lib/ingress";
import { proxyAttestHeaders } from "@/lib/proxy-attest";

export const runtime = "nodejs";

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:8001";

// D5 (batch 04 auth/session parity): JWT port of Dash's
// /__return_to_admin (frontend/dash/app.py:1627-1659). The backend acts
// only on the acting_as_demo + admin_origin_user_id claims minted by
// /api/auth/view-as -- this route forwards the caller's acting access
// token as Bearer auth and, on success, swaps the cookie back to the
// admin's own.
//
// Task V3 item 4 fix: same fix as the sibling /api/auth/view-as route
// (see that file's own comment for the full root-cause writeup) -- no
// longer self-rejects with 401 when the access_token cookie is absent,
// only conditionally adds the Authorization header, mirroring
// app/api/[...path]/route.ts's own "inject if present" idiom.
export async function POST(req: Request): Promise<Response> {
  const cookieStore = await cookies();
  const accessToken = cookieStore.get(ACCESS_TOKEN_COOKIE)?.value;

  let res: Response;
  try {
    // D1/D4/D6 (session-expiry-tuning, 2026-09-10 amendment): relay the
    // caller's ingress verdict, same as the sibling view-as route -- this
    // route already forwards the caller's own (acting) Authorization.
    const headers: Record<string, string> = { ...ingressHeaders(req), ...proxyAttestHeaders(req) };
    if (accessToken) headers.authorization = `Bearer ${accessToken}`;
    res = await fetch(`${BACKEND}/api/auth/return-to-admin`, {
      method: "POST",
      headers,
    });
  } catch (err) {
    console.error("return-to-admin: backend request failed:", err);
    return Response.json({ error: "Return-to-admin temporarily unavailable." }, { status: 502 });
  }

  if (!res.ok) {
    // Same passthrough restraint as view-as: non-2xx (403 not currently
    // acting / origin admin demoted or missing, 401 dead token, 5xx) is
    // returned as-is without touching cookies.
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = { error: "Return-to-admin failed." };
    }
    return Response.json(body, { status: res.status });
  }

  const data = (await res.json()) as {
    access_token: string;
    token_type: string;
    user: { id: number; email: string; name: string };
    session_policy?: unknown;
  };

  // Same no-refresh-token contract as view-as (see that route) -- the
  // admin's refresh_token cookie was never touched during the acting
  // session, so it's already live again now that the access token is back
  // to the admin's own.
  //
  // D1 (session-expiry-tuning): per plan.md's Task 1 step 5 note, the
  // backend can't know here whether the admin's underlying refresh token was
  // ever marked `remembered` (that flag lives on the token row, not
  // resolvable from this endpoint) -- it returns the DEFAULT admin policy
  // (remembered: false, resume: true) rather than guessing. A remembered
  // admin re-enters the default policy until the next refresh rotation
  // recomputes it from the ingress verdict (2026-09-10 amendment: rotation
  // derives `remembered` from the current request's ingress header, not from
  // the stored flag); applySessionCookies
  // here just writes whatever policy the backend decided to send, same as
  // every other route.
  applySessionCookies(cookieStore, {
    accessToken: data.access_token,
    policy: parseSessionPolicy(data.session_policy) ?? undefined,
  });
  return Response.json({ user: data.user });
}
