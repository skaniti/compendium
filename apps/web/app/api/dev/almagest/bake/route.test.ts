// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { shippedParams } from "@/lib/almagest/params";

// Dev-only bake route: rewrites the FROZEN/TIERS literals in
// almagest-glyphs.cjs (via set-params.cjs) and shells out to build.cjs to
// produce fresh TTFs. The route reads its SOURCE/BUILD_OUT paths from
// ALMAGEST_SOURCE / ALMAGEST_BUILD_OUT env vars at module-import time, so
// every test that needs different values goes through vi.resetModules() +
// a dynamic import -- vi.stubEnv alone would not reach an already-evaluated
// module's top-level consts. NODE_ENV, in contrast, is read at call time
// inside POST (not import time), so it does not need the reset+reimport
// dance -- confirmed by the 404 test below passing with a plain stub.
const APP_ROOT = process.cwd(); // apps/web, matching the route's own APP_ROOT
const TRACKED_SOURCE = path.join(APP_ROOT, "fonts/almagest/tools/almagest-glyphs.cjs");
const TRACKED_TTF_DIR = path.join(APP_ROOT, "public/fonts/almagest");
const TIER_NAMES = ["Display", "Mid", "Text"];

function makeRequest(body?: unknown): Request {
  return new Request("http://localhost/api/dev/almagest/bake", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("POST /api/dev/almagest/bake", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 404 with an empty body when not development", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.resetModules();
    const { POST } = await import("./route");
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
  });

  it("returns 400 for an invalid body in development", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.resetModules();
    const { POST } = await import("./route");
    const res = await POST(makeRequest({ nonsense: true }));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error?: string };
    expect(json.error).toBeTruthy();
  });

  it("rewrites a tmp source, builds tmp TTFs into a version sha, and leaves tracked files untouched", async () => {
    const sourceMtimeBefore = fs.statSync(TRACKED_SOURCE).mtimeMs;
    const ttfMtimesBefore = TIER_NAMES.map(
      (t) => fs.statSync(path.join(TRACKED_TTF_DIR, `Almagest-${t}.ttf`)).mtimeMs
    );

    const tmpSrcDir = fs.mkdtempSync(path.join(os.tmpdir(), "almagest-bake-src-"));
    const tmpSource = path.join(tmpSrcDir, "almagest-glyphs.cjs");
    fs.copyFileSync(TRACKED_SOURCE, tmpSource);
    const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), "almagest-bake-out-"));

    try {
      vi.stubEnv("NODE_ENV", "development");
      vi.stubEnv("ALMAGEST_SOURCE", tmpSource);
      vi.stubEnv("ALMAGEST_BUILD_OUT", tmpOut);
      vi.resetModules();
      const { POST } = await import("./route");

      const params = shippedParams();
      params.frozen.rot = 33;
      const res = await POST(makeRequest(params));
      const json = (await res.json()) as { ok?: boolean; version?: string; log?: string; error?: string };

      expect(res.status, `expected 200, got ${res.status}: ${json.error ?? json.log ?? ""}`).toBe(200);
      expect(json.ok).toBe(true);
      expect(json.version).toMatch(/^[0-9a-f]{40}$/);

      expect(fs.readdirSync(tmpOut).sort()).toEqual([
        "Almagest-Display.ttf",
        "Almagest-Mid.ttf",
        "Almagest-Text.ttf",
      ]);

      const rewritten = fs.readFileSync(tmpSource, "utf8");
      expect(rewritten).toMatch(/rot: 33/);

      expect(fs.statSync(TRACKED_SOURCE).mtimeMs).toBe(sourceMtimeBefore);
      TIER_NAMES.forEach((t, i) => {
        expect(fs.statSync(path.join(TRACKED_TTF_DIR, `Almagest-${t}.ttf`)).mtimeMs).toBe(ttfMtimesBefore[i]);
      });
    } finally {
      fs.rmSync(tmpSrcDir, { recursive: true, force: true });
      fs.rmSync(tmpOut, { recursive: true, force: true });
    }
  });
});
