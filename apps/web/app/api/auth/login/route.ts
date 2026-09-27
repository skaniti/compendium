import { cookies } from "next/headers";
import { applySessionCookies, parseSessionPolicy, stampLastActive } from "@/lib/session-cookies";
import { ingressHeaders } from "@/lib/ingress";
import {
  BACKEND_UNREACHABLE_MESSAGE,
  INVALID_CREDENTIALS_MESSAGE,
  TOO_MANY_ATTEMPTS_MESSAGE,
} from "@/lib/login-messages";

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

  // Task 7a (post-flip-closeout): during the batch-06 rollback rehearsal an
  // upstream 503 surfaced as "Invalid credentials." -- a thrown fetch
  // (connection refused, DNS, abort) is a backend-reachability problem, not
  // proof the password is wrong, so it gets the same distinct outage
  // message as an upstream 5xx below rather than falling through uncaught.
  let res: Response;
  try {
    res = await fetch(`${BACKEND}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...ingressHeaders(req) },
      body: JSON.stringify({ email: body.email, password: body.password }),
    });
  } catch (err) {
    console.error("login: backend request failed:", err);
    return Response.json({ error: BACKEND_UNREACHABLE_MESSAGE }, { status: 503 });
  }

  if (!res.ok) {
    // Copy aligned with Dash's _do_login (trailing period) -- empty-field
    // validation stays browser-side, this is only the auth-failure string.
    if (res.status === 401 || res.status === 403) {
      return Response.json({ error: INVALID_CREDENTIALS_MESSAGE }, { status: res.status });
    }
    if (res.status >= 500) {
      // Fixed 503 (not the upstream code) so the client only has one
      // outage branch to handle, same reasoning as the fetch-throw case.
      console.error(`login: backend returned ${res.status}`);
      return Response.json({ error: BACKEND_UNREACHABLE_MESSAGE }, { status: 503 });
    }
    if (res.status === 429) {
      // The login rate limit (5/minute) is server-side truth the user
      // should see, not a generic "Invalid credentials."
      return Response.json({ error: TOO_MANY_ATTEMPTS_MESSAGE }, { status: 429 });
    }
    return Response.json({ error: INVALID_CREDENTIALS_MESSAGE }, { status: res.status });
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
