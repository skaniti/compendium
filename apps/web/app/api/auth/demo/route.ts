import { cookies } from "next/headers";
import { applySessionCookies, parseSessionPolicy, stampLastActive } from "@/lib/session-cookies";
import { proxyAttestHeaders } from "@/lib/proxy-attest";
import {
  BACKEND_UNREACHABLE_MESSAGE,
  CHALLENGE_FAILED_MESSAGE,
  TOO_MANY_ATTEMPTS_MESSAGE,
} from "@/lib/login-messages";

export const runtime = "nodejs";

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:8001";

// demo-one-click-entry: forwards the visitor's Turnstile token to the API,
// which verifies it with Cloudflare and mints a 24-hour demo session. The
// attest headers let the API's limiter and the siteverify remoteip see the
// real visitor instead of the Vercel egress address. No ingress headers:
// the demo role is never remembered.
export async function POST(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { turnstileToken?: unknown };
  const token = typeof body.turnstileToken === "string" ? body.turnstileToken.trim() : "";
  if (!token) return Response.json({ error: CHALLENGE_FAILED_MESSAGE }, { status: 400 });

  let res: Response;
  try {
    res = await fetch(`${BACKEND}/api/auth/demo`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...proxyAttestHeaders(req) },
      body: JSON.stringify({ turnstile_token: token }),
    });
  } catch (err) {
    console.error("demo entry: backend request failed:", err);
    return Response.json({ error: BACKEND_UNREACHABLE_MESSAGE }, { status: 503 });
  }

  if (res.status === 404) return new Response(null, { status: 404 });
  if (res.status === 403) return Response.json({ error: CHALLENGE_FAILED_MESSAGE }, { status: 403 });
  if (res.status === 429) return Response.json({ error: TOO_MANY_ATTEMPTS_MESSAGE }, { status: 429 });
  if (!res.ok) {
    console.error(`demo entry: backend returned ${res.status}`);
    return Response.json({ error: BACKEND_UNREACHABLE_MESSAGE }, { status: 503 });
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
  stampLastActive(cookieStore, Date.now());
  return Response.json({ user: data.user });
}
