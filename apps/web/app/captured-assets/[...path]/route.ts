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
type Ctx = { params: Promise<{ path: string[] }> };

async function proxy(req: Request, ctx: Ctx): Promise<Response> {
  const { path } = await ctx.params;
  return proxyToBackend(req, `/captured-assets/${path.join("/")}`);
}

export async function GET(req: Request, ctx: Ctx) { return proxy(req, ctx); }
export async function HEAD(req: Request, ctx: Ctx) { return proxy(req, ctx); }
