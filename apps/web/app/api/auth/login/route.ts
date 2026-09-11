import { cookies } from "next/headers";
import { applySessionCookies, parseSessionPolicy, stampLastActive } from "@/lib/session-cookies";
import { ingressHeaders } from "@/lib/ingress";

export const runtime = "nodejs";

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:8001";

// D1/D4/D6 (session-expiry-tuning, 2026-09-10 amendment): the "Keep me
// signed in on this device" checkbox and its `remember` body field are
// gone -- LoginRequest on the backend no longer accepts `remember` at all.
// `remembered` is now derived server-side from the tailnet ingress header
// (spec D1), which Caddy sets at the edge (spec D6) and this route simply
// relays via ingressHeaders -- it never sets or invents the header itself.
export async function POST(req: Request): Promise<Response> {
  const body = (await req.json()) as { email: string; password: string };
  const res = await fetch(`${BACKEND}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...ingressHeaders(req) },
    body: JSON.stringify({ email: body.email, password: body.password }),
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
