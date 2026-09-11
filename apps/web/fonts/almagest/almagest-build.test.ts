// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Reproducibility gate: the tracked TTFs under public/fonts/almagest/ are
// build output, not hand-edited. This rebuilds from tools/ into a throwaway
// dir with a fixed timestamp (build.cjs's BUILD_DATE_UNIX) and diffs the
// bytes against what's tracked -- if they differ, someone edited the
// tools/skeletons without re-running `npm run fonts:build`.
const HERE = fileURLToPath(new URL(".", import.meta.url));
const BUILD_SCRIPT = path.join(HERE, "tools", "build.cjs");
const TRACKED_TTF_DIR = path.resolve(HERE, "../../public/fonts/almagest");
const TIERS = ["Display", "Mid", "Text"];
// GLYPH_DIR in build.cjs is pinned to tools/../glyphs, independent of --out --
// this is the tracked-tree export --out must never touch. Absent on a fresh
// clone (gitignored, only materializes after a no---out build has run).
const DISPLAY_MANIFEST_PATH = path.join(HERE, "glyphs", "display", "manifest.json");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "almagest-build-"));

// Captured before the spawn (module eval always precedes the beforeAll below)
// so the post-spawn assertion has a genuine baseline to compare against.
const manifestExisted = fs.existsSync(DISPLAY_MANIFEST_PATH);
const manifestMtimeBefore = manifestExisted ? fs.statSync(DISPLAY_MANIFEST_PATH).mtimeMs : null;

let result: ReturnType<typeof spawnSync>;

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("almagest font build reproducibility", () => {
  beforeAll(() => {
    result = spawnSync(process.execPath, [BUILD_SCRIPT, "--out", tmpDir], {
      encoding: "utf8",
    });
  });

  it("exits 0", () => {
    expect(
      result.status,
      `build.cjs --out ${tmpDir} failed (status ${result.status}, spawn error: ${result.error?.message}):\n${result.stderr}`
    ).toBe(0);
  });

  it.each(TIERS)("Almagest-%s.ttf matches the tracked build output byte-for-byte", (tier) => {
    const freshPath = path.join(tmpDir, `Almagest-${tier}.ttf`);
    const trackedPath = path.join(TRACKED_TTF_DIR, `Almagest-${tier}.ttf`);
    const fresh = fs.readFileSync(freshPath);
    const tracked = fs.readFileSync(trackedPath);
    expect(
      fresh.equals(tracked),
      `public/fonts/almagest/Almagest-${tier}.ttf is stale vs fonts/almagest/tools -- run npm run fonts:build`
    ).toBe(true);
  });

  it("writes only the three TTFs into --out, no glyph export", () => {
    expect(fs.readdirSync(tmpDir).sort()).toEqual([
      "Almagest-Display.ttf",
      "Almagest-Mid.ttf",
      "Almagest-Text.ttf",
    ]);
  });

  it.skipIf(!manifestExisted)("does not touch the tracked glyph export", () => {
    expect(fs.statSync(DISPLAY_MANIFEST_PATH).mtimeMs).toBe(manifestMtimeBefore);
  });
});
