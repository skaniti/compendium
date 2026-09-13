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

// Default headers mark every request same-origin (Sec-Fetch-Site, sent by
// every modern browser fetch) so existing tests exercise the route's actual
// logic, not the origin gate -- the origin-gate tests below override this
// explicitly per case.
function makeRequest(body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/dev/almagest/bake", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin", ...headers },
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

  it("returns 404, not 403, for a cross-site request when not development", async () => {
    // The dev-only gate runs FIRST: outside development every request gets
    // the identical uniform 404 regardless of origin, so a cross-site
    // prober against a production deployment never learns this route
    // exists or that it enforces an origin check.
    vi.stubEnv("NODE_ENV", "production");
    vi.resetModules();
    const { POST } = await import("./route");
    const res = await POST(makeRequest({}, { "Sec-Fetch-Site": "cross-site" }));
    expect(res.status).toBe(404);
  });

  it("returns 403 for a cross-site request in development", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.resetModules();
    const { POST } = await import("./route");
    const res = await POST(makeRequest({}, { "Sec-Fetch-Site": "cross-site" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "same-origin only" });
  });

  it("returns 403 when Origin does not match the request host", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.resetModules();
    const { POST } = await import("./route");
    const res = await POST(
      makeRequest({}, { "Sec-Fetch-Site": "cross-site", Origin: "http://evil.example" })
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "same-origin only" });
  });

  it("proceeds past the origin gate when Sec-Fetch-Site is same-origin", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.resetModules();
    const { POST } = await import("./route");
    // An invalid body still reaches the 400 body-validation gate -- i.e. the
    // request was not rejected at 403.
    const res = await POST(makeRequest({ nonsense: true }, { "Sec-Fetch-Site": "same-origin" }));
    expect(res.status).toBe(400);
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

  it("returns 500 with a log and restores the source when the build fails", async () => {
    const tmpSrcDir = fs.mkdtempSync(path.join(os.tmpdir(), "almagest-bake-src-"));
    const tmpSource = path.join(tmpSrcDir, "almagest-glyphs.cjs");
    fs.copyFileSync(TRACKED_SOURCE, tmpSource);
    const previousText = fs.readFileSync(tmpSource, "utf8");

    // A regular FILE (not a directory) as the build's --out target: build.cjs
    // tries to fs.mkdirSync(dirname(ttfPath), { recursive: true }) into it,
    // which throws EEXIST because a non-directory already occupies that
    // path -- a reliable, environment-independent way to fail the build
    // step without touching anything the route is supposed to protect.
    const tmpOutParent = fs.mkdtempSync(path.join(os.tmpdir(), "almagest-bake-out-"));
    const badOut = path.join(tmpOutParent, "not-a-directory");
    fs.writeFileSync(badOut, "regular file, not a directory");

    try {
      vi.stubEnv("NODE_ENV", "development");
      vi.stubEnv("ALMAGEST_SOURCE", tmpSource);
      vi.stubEnv("ALMAGEST_BUILD_OUT", badOut);
      vi.resetModules();
      const { POST } = await import("./route");

      const params = shippedParams();
      params.frozen.rot = 44;
      const res = await POST(makeRequest(params));
      const json = (await res.json()) as { error?: string; log?: string };

      expect(res.status).toBe(500);
      expect(json.error).toBeTruthy();
      expect(json.log).toBeTruthy();
      // The rewrite happened (set-params succeeded) but the failed build
      // must restore the pre-request text -- no half-baked source left
      // behind for the next attempt.
      expect(fs.readFileSync(tmpSource, "utf8")).toBe(previousText);
    } finally {
      fs.rmSync(tmpSrcDir, { recursive: true, force: true });
      fs.rmSync(tmpOutParent, { recursive: true, force: true });
    }
  });

  it("returns 409 when a table literal cannot be located in the source", async () => {
    const tmpSrcDir = fs.mkdtempSync(path.join(os.tmpdir(), "almagest-bake-src-"));
    const tmpSource = path.join(tmpSrcDir, "almagest-glyphs.cjs");
    const original = fs.readFileSync(TRACKED_SOURCE, "utf8");
    const mangled = original.replace("var TIERS = {", "var TIERS_MANGLED = {");
    expect(mangled).not.toBe(original); // sanity: the replace actually matched
    fs.writeFileSync(tmpSource, mangled);

    try {
      vi.stubEnv("NODE_ENV", "development");
      vi.stubEnv("ALMAGEST_SOURCE", tmpSource);
      vi.resetModules();
      const { POST } = await import("./route");

      const res = await POST(makeRequest(shippedParams()));
      const json = (await res.json()) as { error?: string };

      expect(res.status).toBe(409);
      expect(json.error).toMatch(/TIERS/);
      // set-params never got to the write step, so the mangled source is
      // untouched.
      expect(fs.readFileSync(tmpSource, "utf8")).toBe(mangled);
    } finally {
      fs.rmSync(tmpSrcDir, { recursive: true, force: true });
    }
  });
});
