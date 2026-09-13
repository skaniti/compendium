import { NextResponse } from "next/server";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateParams } from "@/lib/almagest/params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Dev-only bake route. Rewrites the FROZEN/TIERS literals in
// almagest-glyphs.cjs (via set-params.cjs) and shells out to build.cjs to
// produce fresh TTFs. Both tools run as spawned child processes, never as a
// `require()` of a runtime-computed path: Turbopack refuses to compile a
// `require(path.join(...))` whose argument isn't a static string literal
// ("server relative imports are not implemented yet") and webpack compiles
// it but throws MODULE_NOT_FOUND at request time (`webpackEmptyContext`) --
// both fail every request, including a valid one, under `next dev`. spawnSync
// sidesteps both bundlers entirely, the same way `npm run fonts:build`
// already runs these tools from a shell.
const APP_ROOT = process.cwd(); // apps/web under `next dev`
const SOURCE = process.env.ALMAGEST_SOURCE ?? path.join(APP_ROOT, "fonts/almagest/tools/almagest-glyphs.cjs");
const BUILD = path.join(APP_ROOT, "fonts/almagest/tools/build.cjs");
const SET_PARAMS_CLI = path.join(APP_ROOT, "fonts/almagest/tools/set-params.cjs");
const OUT = process.env.ALMAGEST_BUILD_OUT ?? null; // tests only; null = tracked public/fonts/almagest
const TTF_DIR = OUT ?? path.join(APP_ROOT, "public/fonts/almagest");
const TIERS = ["Display", "Mid", "Text"];

// Same-origin gate. This route rewrites a tracked source file and rebuilds
// the shipped fonts on POST, so a dev server left running must never act on
// a cross-site request even though it 404s outside development (a running
// :3000 is still reachable from any page open in the same browser).
// `Sec-Fetch-Site` is sent by every modern browser fetch/XHR/form submit:
// "same-origin" (the app's own page) and "none" (no fetch metadata at all --
// a typed URL, a bookmark; never cross-site in practice) both pass. Clients
// that omit it entirely (curl, older browsers) fall back to comparing
// `Origin` against the request's own host. Anything else -- a cross-site
// Sec-Fetch-Site, or a missing/mismatching Origin -- is rejected.
function isSameOrigin(req: Request): boolean {
  const secFetchSite = req.headers.get("sec-fetch-site");
  if (secFetchSite === "same-origin" || secFetchSite === "none") return true;
  const origin = req.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host === new URL(req.url).host;
  } catch {
    return false;
  }
}

export async function POST(req: Request): Promise<Response> {
  if (!isSameOrigin(req)) return NextResponse.json({ error: "same-origin only" }, { status: 403 });
  if (process.env.NODE_ENV !== "development") return new NextResponse(null, { status: 404 });
  let params;
  try {
    params = validateParams(await req.json());
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  const previous = fs.readFileSync(SOURCE, "utf8");
  const tmpJson = path.join(os.tmpdir(), `almagest-bake-${process.pid}-${randomUUID()}.json`);
  fs.writeFileSync(tmpJson, JSON.stringify(params));
  let setParamsRes: SpawnSyncReturns<string>;
  try {
    setParamsRes = spawnSync(process.execPath, [SET_PARAMS_CLI, SOURCE, tmpJson], { cwd: APP_ROOT, encoding: "utf8" });
  } finally {
    fs.rmSync(tmpJson, { force: true });
  }
  if (setParamsRes.status !== 0) {
    const err = (setParamsRes.stderr || "set-params failed").trim();
    return NextResponse.json({ error: err }, { status: 409 });
  }

  const args = [BUILD, ...(OUT ? ["--out", OUT] : [])];
  const env = { ...process.env, ALMAGEST_GLYPHS_SOURCE: SOURCE };
  const res = spawnSync(process.execPath, args, { cwd: APP_ROOT, encoding: "utf8", env });
  const log = (res.stdout || "") + (res.stderr || "");
  if (res.status !== 0) {
    fs.writeFileSync(SOURCE, previous);
    return NextResponse.json({ error: "font build failed; source restored", log }, { status: 500 });
  }
  const h = createHash("sha1");
  for (const t of TIERS) h.update(fs.readFileSync(path.join(TTF_DIR, `Almagest-${t}.ttf`)));
  return NextResponse.json({ ok: true, version: h.digest("hex"), log });
}
