import { cookies } from "next/headers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Streaming chat proxy vs. Vercel's per-function execution ceiling: 300s is
// the Hobby-plan max under Fluid Compute per Vercel's docs (confirm accepted in the deploy log).
export const maxDuration = 300;

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:8001";
const HOP_BY_HOP = new Set([
  "host", "connection", "keep-alive", "transfer-encoding", "content-length",
  "content-encoding", "te", "trailer", "upgrade",
]);

async function proxy(req: Request, path: string[]): Promise<Response> {
  const search = new URL(req.url).search;
  const url = `${BACKEND}/api/${path.join("/")}${search}`;

  const headers = new Headers(req.headers);
  for (const h of HOP_BY_HOP) headers.delete(h);

  // Force identity upstream: production puts Cloudflare in front of the
  // backend, and Cloudflare picks a compression scheme (zstd, among others)
  // from whatever accept-encoding we forward. The Vercel Node runtime's
  // fetch cannot decode zstd, so relaying the browser's negotiated encoding
  // corrupts the body. Requesting identity keeps the upstream body
  // uncompressed here; Vercel's edge compresses for the browser itself.
  headers.set("accept-encoding", "identity");

  // Inject the Next-held JWT (set at login) if the caller didn't supply one.
  const token = (await cookies()).get("access_token")?.value;
  if (token && !headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);

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

type Ctx = { params: Promise<{ path: string[] }> };
export async function GET(req: Request, ctx: Ctx) { return proxy(req, (await ctx.params).path); }
export async function POST(req: Request, ctx: Ctx) { return proxy(req, (await ctx.params).path); }
export async function PUT(req: Request, ctx: Ctx) { return proxy(req, (await ctx.params).path); }
export async function PATCH(req: Request, ctx: Ctx) { return proxy(req, (await ctx.params).path); }
export async function DELETE(req: Request, ctx: Ctx) { return proxy(req, (await ctx.params).path); }
