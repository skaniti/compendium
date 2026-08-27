import { cookies } from "next/headers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  // Inject the Next-held JWT (set at login) if the caller didn't supply one.
  const token = (await cookies()).get("access_token")?.value;
  if (token && !headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);

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
  return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
}

type Ctx = { params: Promise<{ path: string[] }> };
export async function GET(req: Request, ctx: Ctx) { return proxy(req, (await ctx.params).path); }
export async function POST(req: Request, ctx: Ctx) { return proxy(req, (await ctx.params).path); }
export async function PUT(req: Request, ctx: Ctx) { return proxy(req, (await ctx.params).path); }
export async function PATCH(req: Request, ctx: Ctx) { return proxy(req, (await ctx.params).path); }
export async function DELETE(req: Request, ctx: Ctx) { return proxy(req, (await ctx.params).path); }
