import { cookies } from "next/headers";
import { applySessionCookies, deleteAuthCookie, parseSessionPolicy, stampLastActive } from "@/lib/session-cookies";
import { proxyAttestHeaders } from "@/lib/proxy-attest";
import {
  TAILNET_PAUSED_COOKIE,
  TRUSTED_BROWSER_COOKIE,
  longCookieOptions,
  tailnetAssertHeaders,
  tailnetLoginFrom,
} from "@/lib/tailnet-login";
import { onPasskeyHost, passkeysEnabled } from "@/lib/passkey-config";
import {
  BACKEND_UNREACHABLE_MESSAGE,
  ENROLL_LINK_UNUSABLE_MESSAGE,
  NO_PASSKEY_MESSAGE,
  PASSKEY_FAILED_MESSAGE,
  PASSKEY_NEEDS_TAILNET_MESSAGE,
  PASSKEY_SETUP_FAILED_MESSAGE,
  TOO_MANY_ATTEMPTS_MESSAGE,
} from "@/lib/login-messages";

// Shared by the four /api/auth/passkey/* routes (owner-passkeys). They are
// thin: check the request may use passkeys, forward to the backend with the
// tailnet assert secret (the only way the backend endpoints can be reached),
// map the status to the spec's copy, and set cookies on success -- the same
// shape as app/api/auth/tailnet/login/route.ts.
const BACKEND = process.env.BACKEND_URL ?? "http://localhost:8001";

export type PasskeyFlow = "login" | "enroll";
export type BackendResult = { ok: true; data: Record<string, unknown> } | { ok: false; status: number };

// The owner's tailnet login when this request may use passkeys at all:
// passkeys on, on the relying-party host, carrying a tailnet login.
export function passkeyTailnetLogin(req: Request): string | null {
  if (!passkeysEnabled() || !onPasskeyHost(req.headers, req.url)) return null;
  return tailnetLoginFrom(req.headers);
}

export function needsTailnetResponse(): Response {
  return Response.json({ error: PASSKEY_NEEDS_TAILNET_MESSAGE }, { status: 403 });
}

export async function postToPasskeyBackend(
  req: Request,
  path: string,
  body: Record<string, unknown>,
): Promise<BackendResult> {
  let res: Response;
  try {
    res = await fetch(`${BACKEND}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...tailnetAssertHeaders(),
        ...proxyAttestHeaders(req),
        // The API labels a newly trusted browser from it.
        "User-Agent": req.headers.get("user-agent") ?? "",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error(`passkey: backend request failed (${path}):`, err);
    return { ok: false, status: 503 };
  }
  if (!res.ok) {
    if (res.status >= 500) console.error(`passkey: backend returned ${res.status} (${path})`);
    return { ok: false, status: res.status };
  }
  return { ok: true, data: (await res.json()) as Record<string, unknown> };
}

export function passkeyErrorResponse(status: number, flow: PasskeyFlow): Response {
  if (status === 429) return Response.json({ error: TOO_MANY_ATTEMPTS_MESSAGE }, { status: 429 });
  if (status >= 500) return Response.json({ error: BACKEND_UNREACHABLE_MESSAGE }, { status: 503 });
  if (status === 409) return Response.json({ error: NO_PASSKEY_MESSAGE }, { status: 409 });
  if (status === 410) return Response.json({ error: ENROLL_LINK_UNUSABLE_MESSAGE }, { status: 410 });
  const error = flow === "login" ? PASSKEY_FAILED_MESSAGE : PASSKEY_SETUP_FAILED_MESSAGE;
  return Response.json({ error }, { status: 401 });
}

export async function finishPasskeySignIn(data: Record<string, unknown>): Promise<Response> {
  const cookieStore = await cookies();
  applySessionCookies(cookieStore, {
    accessToken: String(data.access_token),
    refreshToken: String(data.refresh_token),
    policy: parseSessionPolicy(data.session_policy) ?? undefined,
  });
  stampLastActive(cookieStore, Date.now());
  if (typeof data.browser_token === "string" && data.browser_token) {
    cookieStore.set(TRUSTED_BROWSER_COOKIE, data.browser_token, longCookieOptions());
    deleteAuthCookie(cookieStore, TAILNET_PAUSED_COOKIE);
  }
  return Response.json({ user: data.user });
}

export async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await req.json();
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
