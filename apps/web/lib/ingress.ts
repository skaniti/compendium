// Server-only helper (route handlers, no "use client"). D1/D4/D6
// (session-expiry-tuning, 2026-09-10 amendment) ORIGINALLY had this relay
// the inbound request's ingress header, on the premise that a Caddy
// listener in front of apps/web always overwrote it first. batch-06
// (deploy-flip fix wave) retired that premise: apps/web is fronted by
// Vercel, and NOTHING trusted sits in front of it there -- the tailnet
// Caddy listener that used to stamp this header serves direct API/Dash
// traffic only and never fronts the Next app. A browser can set any header
// it likes on a request to a Vercel deployment, so relaying it would let
// any caller claim the "remembered" long-lived-refresh policy for itself
// just by sending X-Compendium-Ingress: <trusted value>.
//
// ingressHeaders() therefore never reads the inbound request at all -- it
// always returns {}, regardless of what the caller sent. The `req`
// parameter is kept unused for call-site signature stability across the
// four auth routes (login/refresh/view-as/return); nothing about their
// call shape needs to change for this fix. With no header forwarded, the
// API's own missing-header handling applies -- its documented default is
// the public (non-remembered) policy.
//
// Name coupling: the API reads `settings.session_ingress_header` (env
// SESSION_INGRESS_HEADER, default "X-Compendium-Ingress") and
// `settings.session_ingress_trusted_value` to decide the same trust
// question from its own side; see settings.py's production-secrets
// validator (batch-06) for the server-side half of this fix. A future
// Caddy tailnet listener serving direct, non-Vercel traffic may still set
// this header at the edge for the API to read directly -- that path never
// passes through apps/web, so it is unaffected by this file returning {}.
export const INGRESS_HEADER = "X-Compendium-Ingress";

export function ingressHeaders(_req: Request): Record<string, string> {
  return {};
}
