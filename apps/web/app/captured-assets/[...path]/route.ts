import { proxyToBackend } from "@/lib/backend-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// /captured-assets/* used to be a Next rewrite straight to BACKEND_URL
// (removed in this same change -- see next.config.ts): a rewrite forwards
// the browser's request as-is, no bearer, full Cookie header. The API now
// gates every route (including this one) behind the same owner bearer
// check as /api/*, which the browser's iframe subresource requests never
// carry -- they hit this origin with cookies, not an Authorization header.
// A route handler is the only way to inject the bearer (from the
// Next-held access_token cookie, via proxyToBackend) before the request
// reaches the backend, and to strip the browser's own Cookie header the
// same way /api/* already does. Tradeoff accepted: this costs one Vercel
// function invocation per asset (image/stylesheet/etc.) instead of a free
// platform-level rewrite -- fine at this traffic level.
//
// Path building (fix round 1, review S1): the upstream path comes from
// req.url's own pathname, NOT from Next's catch-all params.path -- Next's
// route matcher decodeURIComponents each path segment before handing it to
// us, so re-joining those decoded segments into a path string can produce
// a decoded dot-segment that resolves the upstream URL outside this
// prefix (still carrying the bearer), or a decoded #/?/% that truncates or
// rewrites the exact captured_assets file-path lookup key the API route
// matches on. req.url's pathname is exactly what the request line
// encoded, so checking IT against PREFIX is a real guarantee: anything
// that doesn't resolve under this prefix is rejected before
// proxyToBackend -- and therefore before fetch -- ever runs.
const PREFIX = "/captured-assets/";

async function proxy(req: Request): Promise<Response> {
  const { pathname } = new URL(req.url);
  if (!pathname.startsWith(PREFIX)) return new Response(null, { status: 404 });
  return proxyToBackend(req, pathname);
}

export async function GET(req: Request) { return proxy(req); }
export async function HEAD(req: Request) { return proxy(req); }
