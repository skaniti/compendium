import { cookies } from "next/headers";
import { ACCESS_TOKEN_COOKIE, applySessionCookies } from "@/lib/session-cookies";

export const runtime = "nodejs";

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:8001";

// D5 (batch 04 auth/session parity): JWT port of Dash's
// /__return_to_admin (frontend/dash/app.py:1627-1659). The backend acts
// only on the acting_as_demo + admin_origin_user_id claims minted by
// /api/auth/view-as -- this route forwards the caller's acting access
// token as Bearer auth and, on success, swaps the cookie back to the
// admin's own.
export async function POST(): Promise<Response> {
  const cookieStore = await cookies();
  const accessToken = cookieStore.get(ACCESS_TOKEN_COOKIE)?.value;
  if (!accessToken) {
    return Response.json({ error: "Not authenticated." }, { status: 401 });
  }

  let res: Response;
  try {
    res = await fetch(`${BACKEND}/api/auth/return-to-admin`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}` },
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
  };

  // Same no-refresh-token contract as view-as (see that route) -- the
  // admin's refresh_token cookie was never touched during the acting
  // session, so it's already live again now that the access token is back
  // to the admin's own.
  applySessionCookies(cookieStore, { accessToken: data.access_token });
  return Response.json({ user: data.user });
}
