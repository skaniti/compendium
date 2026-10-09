import { NextResponse, type NextRequest } from "next/server";
import {
  TAILNET_LOGIN_ROUTE,
  TAILNET_PAUSED_COOKIE,
  TRUSTED_BROWSER_COOKIE,
  tailnetLoginFrom,
} from "@/lib/tailnet-login";

// D1 (batch 04 auth/session parity): this proxy (Next 16's rename of
// "middleware" -- the "middleware" filename/export are deprecated as of
// Next 16.2, see nextjs.org/docs/messages/middleware-to-proxy) is UX only,
// never the security boundary -- the backend's verify_api_key
// (backend/api/main.py) remains the sole enforcement point; API routes are
// never proxy-gated. AUTH_REQUIRED ("1") is the single prod-gate env knob,
// default off so local dev keeps its existing no-auth loop.
//
// The matcher below already excludes _next/*, /api/*, /login, favicon.ico,
// and any path with a file extension at Next's routing layer -- this
// function is never invoked for them on a real request. The pathname
// checks are kept here too, redundantly: they make the function correct in
// isolation (unit tests call `proxy()` directly, bypassing the matcher
// entirely) and guard against a future matcher edit silently reopening a
// redirect loop on /login or breaking the API proxy route.
export function proxy(req: NextRequest): NextResponse {
  if (process.env.AUTH_REQUIRED !== "1") return NextResponse.next();

  const { pathname } = req.nextUrl;
  if (
    pathname === "/login" || pathname.startsWith("/api/") ||
    pathname.startsWith("/captured-assets/")
  ) {
    return NextResponse.next();
  }

  if (req.cookies.has("access_token")) return NextResponse.next();

  // tailnet-passwordless-login: a browser the owner trusted once signs in
  // with no login page when `tailscale serve` vouches for the user (the
  // header is absent on Vercel/demo, where TAILNET_LOGIN is off anyway).
  // A paused browser (signed out) goes to /login and its "Continue as".
  if (
    tailnetLoginFrom(req.headers) &&
    !!req.cookies.get(TRUSTED_BROWSER_COOKIE)?.value &&
    !req.cookies.has(TAILNET_PAUSED_COOKIE)
  ) {
    const next = `${pathname}${req.nextUrl.search}`;
    return NextResponse.redirect(
      new URL(`${TAILNET_LOGIN_ROUTE}?next=${encodeURIComponent(next)}`, req.url),
    );
  }

  return NextResponse.redirect(new URL("/login", req.url));
}

export const config = {
  // Standard Next matcher idiom (negative lookahead on the leading path
  // segment / any dotted filename): skip _next internals, the API proxy,
  // the login page itself, favicon.ico, and any static file (has a `.` in
  // its path -- covers .js/.css/.svg/etc without enumerating extensions).
  // captured-assets/ is skipped too: archived-preview subresources are
  // fetched by a sandboxed iframe that cannot send the session cookie, and
  // an extensionless asset would otherwise be redirected to /login before
  // its signed URL reached the route handler. The route handler + API
  // enforce auth there (bearer or URL signature).
  matcher: ["/((?!_next/|api/|captured-assets/|favicon\\.ico|login|.*\\..*).*)"],
};
