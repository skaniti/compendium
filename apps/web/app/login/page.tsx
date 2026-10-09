import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { TAILNET_LOGIN_ROUTE, TAILNET_PAUSED_COOKIE, TRUSTED_BROWSER_COOKIE, tailnetLoginFrom } from "@/lib/tailnet-login";
import LoginPageClient from "./LoginPageClient";

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:8001";
// Short enough that a genuinely unreachable backend can't hang the /login
// render -- fails open to the credential form well before a user would
// notice a stall.
const PROBE_TIMEOUT_MS = 2000;

// Dev-login recovery: an idle-session lapse (or any 401) bounces the app to
// /login via lib/api.ts's redirectToLogin, but in dev/stub auth modes no
// real credentials exist to type into that form -- the backend resolves
// EVERY request, even one with no Authorization header at all, to a default
// anonymous identity (the same dev-mode bypass lib/preferences.server.ts's
// cookie-less readers rely on -- see getInitialPanelWidths's own comment).
// Presenting a form that can never succeed there is a dead end; this probes
// that identity BEFORE deciding whether to render the form at all.
//
// Deliberately its own fetch, not lib/preferences.server.ts's fetchMeRow --
// that helper always sends a Bearer token off the visitor's own
// access_token cookie and has no timeout; this probe is the opposite on
// both counts. It must resolve identity from a COOKIE-LESS, anonymous
// request (a signed-in visitor's cookie is never what this rides on -- the
// point is resolving identity for a browser holding none), and it needs a
// short timeout so a genuinely unreachable backend fails open to the form
// (property (d) below) instead of hanging the render.
//
// Mode-agnostic by construction -- no NEXT_PUBLIC_* env gate here. The
// probe result IS the signal: a hosted/prod backend 401s an anonymous
// GET /api/auth/me (no dev bypass), so this always falls through to the
// real form there; a dev/stub backend resolves it, so this always redirects
// there. Same reasoning covers a deliberate sign-out on the dev stack: dev
// mode has no real signed-out state to return to (the backend still
// resolves the same default identity), so /login bounces straight back
// into the app afterward -- accepted by design, not a bug.
//
// Can't introduce a redirect loop with apiFetch's own 401 interceptor
// (lib/api.ts's redirectToLogin): that only fires client-side on a REAL 401
// from an authenticated call, and that can't happen once redirect("/")
// below only ever fires when the anonymous probe already confirmed a
// usable identity.
async function probeAnonymousIdentity(): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${BACKEND}/api/auth/me`, {
      cache: "no-store",
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    // Network error, timeout/abort, backend down -- fail OPEN to the form
    // rather than crash or hang the /login render.
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export default async function LoginPage({
  searchParams,
}: { searchParams?: Promise<{ tailnet?: string }> } = {}) {
  const identityResolved = await probeAnonymousIdentity();
  if (identityResolved) {
    redirect("/");
  }
  // tailnet-passwordless-login: the Tailscale login `tailscale serve`
  // attached (null unless TAILNET_LOGIN is on and the request did not come
  // through Cloudflare), whether this browser is trusted, and the notice
  // the tailnet route sent back on a failed automatic sign-in.
  const tailnetLogin = tailnetLoginFrom(await headers());
  const cookieStore = await cookies();
  const trustedBrowser = tailnetLogin !== null && cookieStore.has(TRUSTED_BROWSER_COOKIE);
  const paused = cookieStore.has(TAILNET_PAUSED_COOKIE);
  // A crafted ?tailnet= means nothing where tailnet login is off.
  const tailnet = (await searchParams)?.tailnet;
  const tailnetNotice =
    tailnetLogin !== null && (tailnet === "failed" || tailnet === "error") ? tailnet : null;
  // A trusted browser that did not just sign out and was not just refused is
  // signed in again automatically (spec section 1).
  if (trustedBrowser && !paused && !tailnetNotice) {
    redirect(`${TAILNET_LOGIN_ROUTE}?next=/`);
  }
  return (
    <LoginPageClient
      tailnetLogin={tailnetLogin}
      trustedBrowser={trustedBrowser}
      paused={paused}
      tailnetNotice={tailnetNotice}
    />
  );
}
