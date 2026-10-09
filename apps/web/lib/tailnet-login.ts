// Passwordless owner sign-in over the tailnet (tailnet-passwordless-login,
// 2026-10-09). `tailscale serve` puts the requester's Tailscale login on
// every proxied request as Tailscale-User-Login and strips any copy the
// client sent, so the owner web (listening on localhost behind serve) can
// trust it. Off unless the owner stack sets TAILNET_LOGIN=1 and the shared
// TAILNET_ASSERT_SECRET; Vercel and the demo stack never do, so a header a
// public client forges is ignored there. A request that came through
// Cloudflare is never treated as a tailnet request.

export type HeaderReader = Pick<Headers, "get" | "has">;

export const TAILSCALE_LOGIN_HEADER = "tailscale-user-login";
export const TAILNET_ASSERT_HEADER = "X-Compendium-Tailnet-Assert";
export const TRUSTED_BROWSER_COOKIE = "trusted_browser";
export const TAILNET_PAUSED_COOKIE = "tailnet_login_paused";
export const TAILNET_LOGIN_ROUTE = "/api/auth/tailnet/login";

const LONG_COOKIE_MAX_AGE_SECONDS = 400 * 24 * 3600; // browsers cap max-age at 400 days
const CLOUDFLARE_HEADERS = ["cf-connecting-ip", "cf-ray", "cf-ipcountry", "cf-visitor"];

export function tailnetLoginEnabled(): boolean {
  return (
    process.env.AUTH_REQUIRED === "1" &&
    process.env.TAILNET_LOGIN === "1" &&
    (process.env.TAILNET_ASSERT_SECRET ?? "").length >= 32
  );
}

export function hasCloudflareHeaders(headers: HeaderReader): boolean {
  return CLOUDFLARE_HEADERS.some((name) => headers.has(name));
}

export function tailnetLoginFrom(headers: HeaderReader): string | null {
  if (!tailnetLoginEnabled() || hasCloudflareHeaders(headers)) return null;
  const login = headers.get(TAILSCALE_LOGIN_HEADER)?.trim();
  return login ? login : null;
}

export function safeNextPath(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  if (/[^\x20-\x7e]/.test(raw)) return "/";
  // Resolve dot segments, backslashes and percent-escapes the way a browser
  // will, then refuse anything that lands on the API.
  let u: URL;
  try {
    u = new URL(raw, "http://x.invalid");
  } catch {
    return "/";
  }
  if (u.origin !== "http://x.invalid") return "/";
  let decoded: string;
  try {
    decoded = decodeURIComponent(u.pathname);
  } catch {
    return "/";
  }
  decoded = decoded.toLowerCase().replace(/\\/g, "/");
  if (decoded === "/api" || decoded.startsWith("/api/")) return "/";
  return u.pathname + u.search;
}

export function tailnetAssertHeaders(): Record<string, string> {
  return { [TAILNET_ASSERT_HEADER]: process.env.TAILNET_ASSERT_SECRET ?? "" };
}

export function longCookieOptions() {
  return {
    httpOnly: true as const,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/" as const,
    maxAge: LONG_COOKIE_MAX_AGE_SECONDS,
  };
}
