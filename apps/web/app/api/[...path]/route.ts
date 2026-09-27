import { proxyToBackend } from "@/lib/backend-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Streaming chat proxy vs. Vercel's per-function execution ceiling: 300s is
// the Hobby-plan max under Fluid Compute per Vercel's docs (confirm accepted in the deploy log).
export const maxDuration = 300;

// Path building (fix round 1, review S1): see the matching comment in
// app/captured-assets/[...path]/route.ts -- same reasoning, same fix. The
// upstream path comes from req.url's own (still percent-encoded) pathname
// instead of joining Next's decoded params.path, and anything that
// doesn't resolve under this prefix is rejected before it ever reaches
// proxyToBackend/fetch.
const PREFIX = "/api/";

async function proxy(req: Request): Promise<Response> {
  const { pathname } = new URL(req.url);
  if (!pathname.startsWith(PREFIX)) return new Response(null, { status: 404 });
  return proxyToBackend(req, pathname);
}

export async function GET(req: Request) { return proxy(req); }
export async function POST(req: Request) { return proxy(req); }
export async function PUT(req: Request) { return proxy(req); }
export async function PATCH(req: Request) { return proxy(req); }
export async function DELETE(req: Request) { return proxy(req); }
