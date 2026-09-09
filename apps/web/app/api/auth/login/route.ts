import { cookies } from "next/headers";
import { applySessionCookies, parseSessionPolicy, stampLastActive } from "@/lib/session-cookies";

export const runtime = "nodejs";

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:8001";

// D4 (session-expiry-tuning): forwards the login form's "Keep me signed in
// on this device" checkbox to the backend as `remember`. Defaults to false
// (== body.remember === true, not a bare truthy check) so an absent/
// malformed field from an older client never accidentally opts a request
// in. The backend is the sole enforcement point for what `remember`
// actually grants -- it ignores the flag outright for the demo account
// (spec D1) -- this route never special-cases that here.
export async function POST(req: Request): Promise<Response> {
  const body = (await req.json()) as { email: string; password: string; remember?: boolean };
  const res = await fetch(`${BACKEND}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: body.email, password: body.password, remember: body.remember === true }),
  });
  if (!res.ok) {
    // Copy aligned with Dash's _do_login (trailing period) -- empty-field
    // validation stays browser-side, this is only the auth-failure string.
    return Response.json({ error: "Invalid credentials." }, { status: res.status });
  }
  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    user: { id: number; email: string; name: string };
    session_policy?: unknown;
  };
  const cookieStore = await cookies();
  applySessionCookies(cookieStore, {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    policy: parseSessionPolicy(data.session_policy) ?? undefined,
  });
  // Item 3 (session-expiry-tuning review fixes): login is itself genuine
  // activity, so STAMP session_last_active to now rather than delete it --
  // deleting left the cookie absent, which the permissive no-last-active
  // fallbacks in lib/session-policy-client.ts's sessionMayResume/
  // sessionLapsed treat as "may resume" indefinitely; a session with zero
  // recorded activity must not silently read as "always active" that way.
  // This also fixes the same PREVIOUS-session staleness the delete used to
  // guard against (e.g. a demo session that idled out hours ago) --
  // overwriting with a fresh timestamp is strictly stronger than clearing.
  stampLastActive(cookieStore, Date.now());
  return Response.json({ user: data.user });
}
