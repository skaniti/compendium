import { describe, it, expect } from "vitest";
import { BAR_GAP, CALLOUT_GAP, CALLOUT_LEAD, MIN_SEGMENT, contrastRatio, layoutSpendBar, pickInk, segmentGeometry, type SpendSegmentInput } from "./spend-bar";

const seg = (key: string, share: number, full = `${key} full label`, short = key): SpendSegmentInput => ({ key, share, full, short });

describe("segmentGeometry", () => {
  it("splits the bar by share, gaps included", () => {
    const g = segmentGeometry([0.75, 0.25], 1002);
    expect(g[0]).toEqual({ start: 0, width: 750 });
    expect(g[1]).toEqual({ start: 750 + BAR_GAP, width: 250 });
  });
  it("freezes tiny shares at the min width and gives the rest what is left", () => {
    const g = segmentGeometry([0.999, 0.001], 202);
    expect(g[1].width).toBe(MIN_SEGMENT);
    expect(g[0].width).toBeCloseTo(200 - MIN_SEGMENT);
  });
});

describe("layoutSpendBar", () => {
  it("puts the full label inside a wide segment and the short one when only it fits", () => {
    // 10 px glyphs: "gates full label" is 160 px + 16 padding in 800 px; c's 320 px full text misses its 200 px, "c" fits.
    const out = layoutSpendBar([seg("gates", 0.8), seg("c", 0.2, `c ${"x".repeat(30)}`)], 1002, 10);
    expect(out[0]).toEqual({ key: "gates", mode: "inside", text: "gates full label" });
    expect(out[1]).toEqual({ key: "c", mode: "inside", text: "c" });
  });
  it("sends a segment that fits neither label to a callout centred on it when there is room", () => {
    const out = layoutSpendBar([seg("a", 0.5), seg("b", 0.01), seg("z", 0.49)], 1000, 10);
    const b = out[1];
    expect(b.mode).toBe("callout");
    if (b.mode !== "callout") return;
    expect(b.text).toBe("b full label");
    expect(b.width).toBe(CALLOUT_LEAD + 120);
    expect(b.left + b.width / 2).toBeCloseTo(b.center); // centred on the segment
  });
  it("keeps a callout at the bar's left edge when its segment is the first one", () => {
    const [first] = layoutSpendBar([seg("g", 0.005), seg("rest", 0.995)], 1000, 10);
    expect(first).toMatchObject({ mode: "callout", left: 0 });
  });
  it("stacks neighbouring callouts right to left without overlap", () => {
    const out = layoutSpendBar([seg("big", 0.97), seg("c", 0.02), seg("o", 0.01)], 1000, 10);
    const [c, o] = [out[1], out[2]];
    expect(c.mode).toBe("callout");
    expect(o.mode).toBe("callout");
    if (c.mode !== "callout" || o.mode !== "callout") return;
    expect(o.left + o.width).toBeLessThanOrEqual(1000);
    expect(c.left + c.width + CALLOUT_GAP).toBeLessThanOrEqual(o.left + 1e-9);
  });
  it("falls back to the short callout text when the full set will not fit the bar", () => {
    const long = (k: string, s: number) => seg(k, s, `${k} ${"x".repeat(40)}`, k);
    const out = layoutSpendBar([long("a", 0.98), long("b", 0.01), long("c", 0.01)], 300, 10);
    expect(out.slice(1).map((s) => s.text)).toEqual(["b", "c"]);
  });
});

describe("ink", () => {
  const black = [0, 0, 0] as const, white = [255, 255, 255] as const;
  it("contrast ratio spans 1 to 21", () => {
    expect(contrastRatio(black, white)).toBeCloseTo(21);
    expect(contrastRatio(white, white)).toBeCloseTo(1);
  });
  it("picks dark ink on a light fill and light ink on a dark fill", () => {
    expect(pickInk([234, 160, 140], [20, 22, 28], [230, 230, 235])).toBe("dark");
    expect(pickInk([60, 50, 90], [20, 22, 28], [230, 230, 235])).toBe("light");
  });
});
