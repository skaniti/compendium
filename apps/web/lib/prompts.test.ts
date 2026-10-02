import { describe, it, expect } from "vitest";
import {
  compareRows, evalFamilies, fixtureFilter, formatAccuracy, formatDeltaPts, formatEvalDateTime,
  formatPrice, formatPriceCell, formatSeconds, formatShare, initialPrompt, lineDiff,
  type EvalRunDetail, type EvalRunRow, type PromptTask,
} from "./prompts";

describe("formatters", () => {
  it("price", () => {
    expect(formatPrice(0.15)).toBe("$0.15");
    expect(formatPrice(2.5)).toBe("$2.50");
    expect(formatPrice(0)).toBe("$0.00");
    expect(formatPrice(0.004)).toBe("<$0.01");
    expect(formatPrice(null)).toBe("—");
    expect(formatPriceCell({ price_in: 0.15, price_out: 0.6 })).toBe("$0.15 · $0.60");
    expect(formatPriceCell({ price_in: null, price_out: null })).toBe("—");
  });
  it("accuracy, share and deltas", () => {
    expect(formatAccuracy({ accuracy: 0.92, n: 50 })).toBe("92.0% (50)");
    expect(formatAccuracy({ accuracy: 0.5, n: null })).toBe("50.0%");
    expect(formatAccuracy(null)).toBe("—");
    expect(formatAccuracy({ accuracy: null, n: 3 })).toBe("—");
    expect(formatShare(0.4)).toBe("40.0%");
    expect(formatShare(null)).toBe("—");
    expect(formatDeltaPts(0.02)).toBe("+2.0 pts");
    expect(formatDeltaPts(-0.015)).toBe("−1.5 pts");
    expect(formatDeltaPts(0.0004)).toBe("±0.0 pts");
    expect(formatDeltaPts(null)).toBe("—");
  });
  it("seconds and dates", () => {
    expect(formatSeconds(48)).toBe("48.0s");
    expect(formatSeconds(125)).toBe("2m 05s");
    expect(formatSeconds(3720)).toBe("1h 02m");
    expect(formatSeconds(null)).toBe("—");
    const now = new Date(2026, 9, 2);
    expect(formatEvalDateTime(new Date(2026, 7, 14, 10, 44).toISOString(), now)).toBe("Aug 14, 10:44");
    expect(formatEvalDateTime(new Date(2025, 0, 3, 9, 5).toISOString(), now)).toBe("Jan 3, 09:05, 2025");
    expect(formatEvalDateTime(null, now)).toBe("—");
    expect(formatEvalDateTime("not a date", now)).toBe("—");
  });
});

describe("lineDiff", () => {
  it("same, deletions before additions", () => {
    expect(lineDiff("a\nb\nc", "a\nB\nc")).toEqual([
      { op: "same", text: "a" }, { op: "del", text: "b" }, { op: "add", text: "B" }, { op: "same", text: "c" },
    ]);
    expect(lineDiff("a", "a\nz")).toEqual([{ op: "same", text: "a" }, { op: "add", text: "z" }]);
    expect(lineDiff("x\ny", "y")).toEqual([{ op: "del", text: "x" }, { op: "same", text: "y" }]);
    expect(lineDiff("same", "same")).toEqual([{ op: "same", text: "same" }]);
  });
});

const task = (t: string, live: string | null, names: string[]): PromptTask => ({
  task: t, label: t, live, selector: null,
  prompts: names.map((n) => ({ name: n, version: n.split("_v")[1] ?? "", description: "", techniques: [], live: n === live, overridden: false })),
});

describe("selection and filters", () => {
  it("initialPrompt", () => {
    expect(initialPrompt([task("a", null, ["a_v1"]), task("b", "b_v2", ["b_v1", "b_v2"])])).toBe("b_v2");
    expect(initialPrompt([task("a", null, ["a_v1"])])).toBe("a_v1");
    expect(initialPrompt([])).toBeNull();
  });
  it("evalFamilies", () => {
    const r = (prompt_name: string | null) => ({ prompt_name }) as EvalRunRow;
    expect(evalFamilies([r("beta"), r("alpha"), r(null), r("beta")])).toEqual(["alpha", "beta"]);
  });
  it("fixtureFilter", () => {
    const f = [{ status: "correct" }, { status: "wrong" }, { status: "error" }] as never[];
    expect(fixtureFilter(f, "all")).toHaveLength(3);
    expect(fixtureFilter(f, "misses")).toHaveLength(2);
  });
  it("compareRows", () => {
    const d = (sel: number | null, threats: Record<string, number>) => ({
      metrics: {
        ...(sel === null ? {} : { selection: { accuracy: sel } }),
        stress: { accuracy: 0.5, per_threat_recall: threats },
      },
    }) as unknown as EvalRunDetail;
    const rows = compareRows(d(0.8, { b: 0.9, a: 0.4 }), d(null, { a: 0.5 }));
    expect(rows.map((x) => x.metric)).toEqual(["Selection accuracy", "Stress accuracy", "Recall · a", "Recall · b"]);
    expect(rows[0]).toEqual({ metric: "Selection accuracy", a: 0.8, b: null, delta: null });
    expect(rows[2].delta).toBeCloseTo(-0.1);
    expect(rows[3]).toEqual({ metric: "Recall · b", a: 0.9, b: null, delta: null });
  });
});
