// @vitest-environment node
import { describe, it, expect } from "vitest";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const HERE = fileURLToPath(new URL(".", import.meta.url));
const SRC = path.join(HERE, "tools", "almagest-glyphs.cjs");
const { applyParams, readParams } = require("./tools/set-params.cjs");

describe("set-params", () => {
  it("readParams returns the shipped tables", () => {
    const text = fs.readFileSync(SRC, "utf8");
    const p = readParams(text);
    const g = require(SRC);
    expect(p.frozen).toEqual(g.FROZEN);
    expect(p.tiers.Display).toEqual(g.TIERS.Display);
  });
  it("applyParams rewrites only the two literals and the result loads with the new values", () => {
    const text = fs.readFileSync(SRC, "utf8");
    const p = readParams(text);
    p.frozen.rot = 33; p.tiers.Mid.stroke = 40;
    const out = applyParams(text, p);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "almagest-set-"));
    const f = path.join(tmp, "almagest-glyphs.cjs");
    fs.writeFileSync(f, out);
    const g2 = require(f);
    expect(g2.FROZEN.rot).toBe(33);
    expect(g2.TIERS.Mid.stroke).toBe(40);
    // Everything outside the two literals is byte-identical.
    const strip = (s: string) => s.replace(/var FROZEN = \{[^}]*\};/, "").replace(/var TIERS = \{[\s\S]*?\n  \};/, "");
    expect(strip(out)).toBe(strip(text));
    expect(applyParams(out, readParams(out))).toBe(out); // idempotent
  });
  it("applyParams throws when a literal cannot be located", () => {
    expect(() => applyParams("var nothing = 1;", readParams(fs.readFileSync(SRC, "utf8")))).toThrow(/FROZEN/);
  });
});
