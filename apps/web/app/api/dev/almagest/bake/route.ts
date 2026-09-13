import { NextResponse } from "next/server";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { validateParams } from "@/lib/almagest/params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const require = createRequire(import.meta.url);
const APP_ROOT = process.cwd(); // apps/web under `next dev`
const SOURCE = process.env.ALMAGEST_SOURCE ?? path.join(APP_ROOT, "fonts/almagest/tools/almagest-glyphs.cjs");
const BUILD = path.join(APP_ROOT, "fonts/almagest/tools/build.cjs");
const OUT = process.env.ALMAGEST_BUILD_OUT ?? null; // tests only; null = tracked public/fonts/almagest
const TTF_DIR = OUT ?? path.join(APP_ROOT, "public/fonts/almagest");
const TIERS = ["Display", "Mid", "Text"];

export async function POST(req: Request): Promise<Response> {
  if (process.env.NODE_ENV !== "development") return new NextResponse(null, { status: 404 });
  let params;
  try { params = validateParams(await req.json()); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
  const setParams = require(path.join(APP_ROOT, "fonts/almagest/tools/set-params.cjs")) as { applyToFile(p: string, params: unknown): string };
  let previous: string;
  try { previous = setParams.applyToFile(SOURCE, params); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 409 }); }
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
