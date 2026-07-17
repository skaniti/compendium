import { cookies } from "next/headers";
import { applySessionCookies, clearSessionCookies, REFRESH_TOKEN_COOKIE } from "@/lib/session-cookies";

export const runtime = "nodejs";

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:8001";

// Polled by components/SessionKeeper.tsx (D2: activity-scoped sliding
// refresh). Rotation contract mirrors the backend: every successful refresh
// returns a new access_token AND a new refresh_token, both of which replace
// the old cookies here.
export async function POST(): Promise<Response> {
  const cookieStore = await cookies();
  const refreshToken = cookieStore.get(REFRESH_TOKEN_COOKIE)?.value;
  if (!refreshToken) {
    return Response.json({ error: "No refresh token." }, { status: 401 });
  }

  const res = await fetch(`${BACKEND}/api/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });

  if (!res.ok) {
    // The refresh token itself is invalid/expired/revoked -- there is no
    // session left to salvage. Clear all three cookies so the client-side
    // 401 interceptor (lib/api.ts apiFetch) bounces to /login on the very
    // next request instead of retrying against a dead session forever.
    clearSessionCookies(cookieStore);
    return Response.json({ error: "Refresh failed." }, { status: 401 });
  }

  const data = (await res.json()) as { access_token: string; refresh_token: string; token_type: string };
  applySessionCookies(cookieStore, { accessToken: data.access_token, refreshToken: data.refresh_token });
  return Response.json({ ok: true });
}
