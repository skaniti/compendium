// Server-only helper (route handlers, no "use client"). D1/D4/D6
// (session-expiry-tuning, 2026-09-10 amendment): the backend derives
// `remembered` from this header instead of a client-supplied `remember`
// flag. The value is authoritative ONLY because Caddy overwrites it at the
// edge on BOTH its loopback listeners -- `tailnet` on the tailscale-serve
// listener, `public` on the Cloudflare Tunnel listener (spec D6) -- so a
// public caller can never forge it. apps/web never sets or invents this
// header itself; it only relays whatever the inbound request already
// carries. An absent header (e.g. local dev with no Caddy in front) is
// forwarded as absent too -- callers must NOT fill the gap with a guessed
// value -- letting the API fall back to its own default (public) or its
// dev-only `session_trust_missing_ingress` knob.
//
// DEPLOYMENT CONSTRAINT: this relay is safe only while every network path
// into apps/web's auth routes crosses a Caddy listener that overwrites the
// header, and the API is reachable solely through such a path. Front
// apps/web with anything else (Vercel, the clone-and-run compose's bare
// :3000) and the value becomes client-controlled -- the API's edge must
// then re-stamp it or the batch-06 hosting decision must add a fail-closed
// relay gate here. Recorded in spec D6 + infra-runbook.md.
//
// Name coupling: the API reads `settings.session_ingress_header` (env
// SESSION_INGRESS_HEADER, default "X-Compendium-Ingress"). Renaming it there
// silently stops this relay on the four auth routes (the catch-all proxy
// still forwards every header) -- change both together.
export const INGRESS_HEADER = "X-Compendium-Ingress";

export function ingressHeaders(req: Request): Record<string, string> {
  const value = req.headers.get(INGRESS_HEADER);
  return value ? { [INGRESS_HEADER]: value } : {};
}
