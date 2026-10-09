import { cookies } from "next/headers";
import { applySessionCookies, parseSessionPolicy, stampLastActive } from "@/lib/session-cookies";
import { proxyAttestHeaders } from "@/lib/proxy-attest";
import {
  TAILNET_PAUSED_COOKIE,
  TRUSTED_BROWSER_COOKIE,
  safeNextPath,
  tailnetAssertHeaders,
  tailnetLoginFrom,
} from "@/lib/tailnet-login";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:8001";

// Relative Location (RFC 7231): the browser resolves it against the address
// it used, so this never depends on how the Host header reached Next.
function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { Location: location } });
}

// tailnet-passwordless-login: signs in a trusted browser of the owner from
// the Tailscale login `tailscale serve` attached (proxy.ts sends page
// requests here; the login page's "Continue as" link adds resume=1, which
// also lifts the sign-out pause). Any missing condition falls back to the
// password form at /login.
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const next = safeNextPath(url.searchParams.get("next"));
  const resume = url.searchParams.get("resume") === "1";
  const login = tailnetLoginFrom(req.headers);
  const cookieStore = await cookies();
  const browserToken = cookieStore.get(TRUSTED_BROWSER_COOKIE)?.value;
  if (!login || !browserToken) return seeOther("/login");
  if (cookieStore.get(TAILNET_PAUSED_COOKIE) && !resume) return seeOther("/login");

  let res: Response;
  try {
    res = await fetch(`${BACKEND}/api/auth/tailnet/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...tailnetAssertHeaders(), ...proxyAttestHeaders(req) },
      body: JSON.stringify({ tailnet_login: login, browser_token: browserToken }),
    });
  } catch (err) {
    console.error("tailnet login: backend request failed:", err);
    return seeOther("/login?tailnet=error");
  }
  if (res.status === 401) {
    // Revoked, or this browser's token is unknown: forget it so the next
    // visit shows the password form with "Trust this browser" again.
    cookieStore.delete(TRUSTED_BROWSER_COOKIE);
    return seeOther("/login?tailnet=failed");
  }
  if (!res.ok) {
    console.error(`tailnet login: backend returned ${res.status}`);
    return seeOther("/login?tailnet=error");
  }

  const data = (await res.json()) as { access_token: string; refresh_token: string; session_policy?: unknown };
  applySessionCookies(cookieStore, {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    policy: parseSessionPolicy(data.session_policy) ?? undefined,
  });
  stampLastActive(cookieStore, Date.now());
  if (resume) cookieStore.delete(TAILNET_PAUSED_COOKIE);
  return seeOther(next);
}
