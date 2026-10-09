import { cookies } from "next/headers";
import { TAILNET_ASSERT_HEADER } from "@/lib/tailnet-login";
import { proxyAttestHeaders, stripInboundProxyAttestHeaders } from "@/lib/proxy-attest";

// Same default-resolution convention as this constant used to have inline
// in app/api/[...path]/route.ts before the extraction (batch post-flip
// closeout, task 3b). Several other call sites (app/login/page.tsx, the
// app/api/auth/*/route.ts handlers, lib/preferences.server.ts) define
// their own equivalent BACKEND_URL fallback for their own purposes; this
// one is just the constant the two proxy route handlers below share.
const BACKEND = process.env.BACKEND_URL ?? "http://localhost:8001";
const HOP_BY_HOP = new Set([
  "host", "connection", "keep-alive", "transfer-encoding", "content-length",
  "content-encoding", "te", "trailer", "upgrade",
]);

// Shared proxy body for every route handler that forwards a browser request
// to the backend with an injected bearer token: app/api/[...path]/route.ts
// (every /api/* call) and app/captured-assets/[...path]/route.ts (page
// preview images/stylesheets, which the backend serves outside /api).
// `upstreamPath` is the full path to hit on BACKEND (e.g. "/api/topics/demo"
// or "/captured-assets/a/b/load.php"); the caller's own query string is
// appended here.
export async function proxyToBackend(req: Request, upstreamPath: string): Promise<Response> {
  const search = new URL(req.url).search;
  const url = `${BACKEND}${upstreamPath}${search}`;

  const headers = new Headers(req.headers);
  for (const h of HOP_BY_HOP) headers.delete(h);

  // Task 7e (post-flip-closeout): strip any attest headers the browser
  // supplied itself (it must never be able to claim its own rate-limit
  // key), then set the trusted pair -- inert ({}) unless BACKEND_PROXY_
  // SECRET is configured. See lib/proxy-attest.ts.
  stripInboundProxyAttestHeaders(headers);
  // tailnet-passwordless-login: only the auth route handlers present the
  // tailnet assert secret; a browser can never supply its own.
  headers.delete(TAILNET_ASSERT_HEADER);
  for (const [k, v] of Object.entries(proxyAttestHeaders(req))) headers.set(k, v);

  // Force identity upstream: production puts Cloudflare in front of the
  // backend, and Cloudflare picks a compression scheme (zstd, among others)
  // from whatever accept-encoding we forward. The Vercel Node runtime's
  // fetch cannot decode zstd, so relaying the browser's negotiated encoding
  // corrupts the body. Requesting identity keeps the upstream body
  // uncompressed here; Vercel's edge compresses for the browser itself.
  headers.set("accept-encoding", "identity");

  // Inject the Next-held JWT (set at login) if the caller didn't supply
  // one. An X-API-Key is an explicit credential (browser extension, Android
  // collector) and must win over the ambient cookie: the API prefers a
  // Bearer token over X-API-Key, so injecting here would silently
  // re-attribute the upload to whoever's session cookie the browser holds.
  const token = (await cookies()).get("access_token")?.value;
  if (token && !headers.has("authorization") && !headers.has("x-api-key")) headers.set("authorization", `Bearer ${token}`);

  // Proxy hygiene (batch-06 deploy-flip fix wave): the API authenticates
  // via the Authorization header above and never reads cookies, so
  // forwarding the browser's own Cookie header upstream too would send
  // both the access and refresh tokens over the same hop for no reason --
  // unnecessary exposure if the upstream leg is ever compromised or logged.
  headers.delete("cookie");

  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const upstream = await fetch(url, {
    method: req.method,
    headers,
    body: hasBody ? await req.arrayBuffer() : undefined,
    // Propagate client cancellation: if the caller aborts, tear down the
    // upstream backend request too (no runaway agent/LLM call).
    signal: req.signal,
  });

  // Pass the (possibly streaming SSE) response straight through.
  const outHeaders = new Headers();
  upstream.headers.forEach((v, k) => {
    if (!HOP_BY_HOP.has(k.toLowerCase())) outHeaders.set(k, v);
  });
  // Never relay upstream's content-encoding/content-length: fetch may have
  // already decoded a gzip/br body (making the header wrong), and with
  // identity requested upstream they're unnecessary anyway.
  outHeaders.delete("content-encoding");
  outHeaders.delete("content-length");
  return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
}
