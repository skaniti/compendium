import { isIP } from "node:net";

// Task 7e (post-flip-closeout): attest the real client address to the
// backend when apps/web is proxying through Vercel. The backend's rate
// limiter keys on the peer address it sees, which behind the Cloudflare
// tunnel AND the Vercel proxy is one shared bucket for everyone -- see
// apps/api/backend/api/rate_limit_key.py for the server-side half.
//
// proxyAttestHeaders() only ever produces the two headers below, and only
// when BACKEND_PROXY_SECRET is configured -- inert (returns {}) otherwise,
// same "safe until explicitly configured" shape as ingressHeaders(). The
// secret proves the request actually came from this proxy (the backend
// only trusts the client-ip header when the secret header matches its own
// configured value via a constant-time compare); X-Compendium-Client-Ip
// carries the first hop of the inbound x-forwarded-for, which Vercel sets
// to the real client address, only when that hop parses as an IPv4/IPv6
// literal -- locally (no Vercel in front) the header is usually absent, so
// the ip header is simply omitted and only the secret is sent.
export const PROXY_SECRET_HEADER = "X-Compendium-Proxy-Secret";
export const PROXY_CLIENT_IP_HEADER = "X-Compendium-Client-Ip";

function firstForwardedHop(req: Request): string | undefined {
  const xff = req.headers.get("x-forwarded-for");
  if (!xff) return undefined;
  const hop = xff.split(",")[0]?.trim();
  return hop || undefined;
}

export function proxyAttestHeaders(req: Request): Record<string, string> {
  const secret = process.env.BACKEND_PROXY_SECRET;
  if (!secret) return {};

  const headers: Record<string, string> = { [PROXY_SECRET_HEADER]: secret };
  const hop = firstForwardedHop(req);
  if (hop && isIP(hop) !== 0) headers[PROXY_CLIENT_IP_HEADER] = hop;
  return headers;
}

// Every call site that forwards headers from an inbound request must strip
// these first -- otherwise a browser could set X-Compendium-Client-Ip
// itself and, combined with a leaked/guessed secret, spoof its rate-limit
// bucket. Applied before proxyAttestHeaders() adds the trusted pair.
export function stripInboundProxyAttestHeaders(headers: Headers): void {
  headers.delete(PROXY_SECRET_HEADER);
  headers.delete(PROXY_CLIENT_IP_HEADER);
}
