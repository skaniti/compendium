import { cookies } from "next/headers";
import { ACCESS_TOKEN_COOKIE, applySessionCookies } from "@/lib/session-cookies";

export const runtime = "nodejs";

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:8001";

// D5 (batch 04 auth/session parity): admin-only demo switch. JWT port of
// Dash's session-cookie /__view_as_demo (frontend/dash/app.py:1566-1624) --
// the backend re-checks admin role from the DB and mints a demo-scoped
// access token carrying acting_as_demo/admin_origin_* claims. This route's
// only job is to forward the caller's own access token as Bearer auth and,
// on success, swap the cookie the same way the login route does.
export async function POST(): Promise<Response> {
  const cookieStore = await cookies();
  const accessToken = cookieStore.get(ACCESS_TOKEN_COOKIE)?.value;
  if (!accessToken) {
    return Response.json({ error: "Not authenticated." }, { status: 401 });
  }

  let res: Response;
  try {
    res = await fetch(`${BACKEND}/api/auth/view-as`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization: `Bearer ${accessToken}`,
      },
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
  };

  // No refresh_token in this response, deliberately (backend: refresh
  // rotation would resurrect the acting-as-demo identity past its 60-min
  // TTL cap). applySessionCookies leaves the admin's existing refresh_token
  // cookie untouched -- it stays live through the acting session and is
  // usable again the moment /api/auth/return restores the admin's own
  // access token.
  applySessionCookies(cookieStore, { accessToken: data.access_token });
  return Response.json({ user: data.user });
}
