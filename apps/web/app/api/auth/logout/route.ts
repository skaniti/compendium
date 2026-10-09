import { cookies } from "next/headers";
import { clearSessionCookies, REFRESH_TOKEN_COOKIE } from "@/lib/session-cookies";
import { TAILNET_PAUSED_COOKIE, TRUSTED_BROWSER_COOKIE, longCookieOptions } from "@/lib/tailnet-login";

export const runtime = "nodejs";

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:8001";

export async function POST(): Promise<Response> {
  const cookieStore = await cookies();
  const refreshToken = cookieStore.get(REFRESH_TOKEN_COOKIE)?.value;
  if (refreshToken) {
    // Best-effort revocation -- clear cookies regardless of the backend's
    // response (network down, already-revoked, whatever): the local
    // session ends either way, and a lingering revoked-server-side token
    // isn't a client-visible problem.
    try {
      await fetch(`${BACKEND}/api/auth/logout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
    } catch (err) {
      console.error("logout: backend revocation failed:", err);
    }
  }
  clearSessionCookies(cookieStore);
  // tailnet-passwordless-login: a trusted browser would otherwise be
  // signed straight back in; the pause holds until "Continue as ...".
  if (cookieStore.get(TRUSTED_BROWSER_COOKIE)) {
    cookieStore.set(TAILNET_PAUSED_COOKIE, "1", longCookieOptions());
  }
  return Response.json({ ok: true });
}
