import { describe, it, expect } from "vitest";
import {
  finishedRuns, formatDuration, formatRunDateTime, noiseShare, percent, runStatusLabel,
  safeHref, sizeBins, sortClusters, visibleEdgeBins, type ClusterRow, type ClusterRun, type EdgeSummary,
} from "./clusters";

const run = (id: number, status: ClusterRun["status"], cluster_count: number | null = 5): ClusterRun => ({
  id, status, started_at: `2026-03-0${id}T10:00:00Z`, completed_at: null,
  cluster_count, noise_count: cluster_count === null ? null : 2, naming_cost: null, elapsed_seconds: null,
});
const row = (id: number, name: string, size: number, confidence: number | null): ClusterRow => ({
  id, name, slug: name.toLowerCase(), size, confidence, name_carried: false, super_cluster: null, group: null,
});

describe("noiseShare", () => {
  it("noise over noise + clustered", () => {
    expect(noiseShare({ noise_count: 3 } as never, { clustered: 9 } as never)).toEqual({ noise: 3, considered: 12, share: "25.0%" });
  });
  it("never NaN", () => {
    expect(noiseShare({ noise_count: null } as never, { clustered: 0 } as never)).toEqual({ noise: 0, considered: 0, share: "0.0%" });
  });
});

describe("sizeBins", () => {
  it("spans the smallest to the largest bin, keeping empty bins", () => {
    expect(sizeBins([2, 2, 3, 9, 12])).toEqual([
      { label: "2", count: 2 }, { label: "3", count: 1 }, { label: "4", count: 0 }, { label: "5", count: 0 },
      { label: "6–7", count: 0 }, { label: "8–9", count: 1 }, { label: "10–14", count: 1 },
    ]);
  });
  it("open-ended top bin; empty input; ignores empty clusters", () => {
    expect(sizeBins([150]).at(-1)).toEqual({ label: "100+", count: 1 });
    expect(sizeBins([])).toEqual([]);
    expect(sizeBins([0, 0])).toEqual([]);
  });
});

describe("visibleEdgeBins", () => {
  const edges: EdgeSummary = { count: 3, min: 0.2, max: 0.8, mean: 0.5, bins: Array.from({ length: 10 }, (_, i) => ({ lo: i / 10, hi: (i + 1) / 10, count: i === 7 ? 3 : 0 })) };
  it("starts at the threshold's bin", () => {
    const v = visibleEdgeBins(edges, 0.15);
    expect(v).toHaveLength(9);
    expect(v[0].label).toBe("10–20%");
    expect(v.at(-1)!.label).toBe("90–100%");
    expect(v[6].count).toBe(3);
  });
});

describe("runs", () => {
  it("labels completed runs current or kept", () => {
    expect(runStatusLabel(run(4, "completed"), 4)).toBe("current");
    expect(runStatusLabel(run(3, "completed"), 4)).toBe("kept");
    expect(runStatusLabel(run(2, "archived"), 4)).toBe("archived");
    expect(runStatusLabel(run(1, "failed", null), 4)).toBe("failed");
    expect(runStatusLabel(run(5, "running", null), null)).toBe("running");
  });
  it("finished runs, oldest first, without failed/running", () => {
    const items = [run(5, "running", null), run(4, "completed"), run(3, "failed", null), run(2, "archived"), run(1, "completed")];
    expect(finishedRuns(items).map((r) => r.id)).toEqual([1, 2, 4]);
  });
});

describe("formatting", () => {
  it("durations", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(8.42)).toBe("8.4s");
    expect(formatDuration(119.6)).toBe("2m 00s");
    expect(formatDuration(125)).toBe("2m 05s");
    expect(formatDuration(3725)).toBe("1h 02m");
  });
  it("run datetime, with the year only when it differs", () => {
    const now = new Date(2026, 9, 2);
    expect(formatRunDateTime(new Date(2026, 8, 23, 14, 5).toISOString(), now)).toBe("Sep 23, 14:05");
    expect(formatRunDateTime(new Date(2025, 11, 1, 9, 0).toISOString(), now)).toBe("Dec 1 2025, 09:00");
    expect(formatRunDateTime(null, now)).toBe("—");
  });
  it("percent", () => {
    expect(percent(0.7)).toBe("70%");
    expect(percent(null)).toBe("—");
  });
  it("safeHref keeps http(s) only", () => {
    expect(safeHref("https://example.org/a")).toBe("https://example.org/a");
    expect(safeHref("http://example.org")).toBe("http://example.org");
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref(null)).toBeNull();
  });
});

describe("sortClusters", () => {
  const rows = [row(1, "Beta", 3, 0.5), row(2, "alpha", 3, null), row(3, "Gamma", 9, 0.9), row(4, "Delta", 1, 0.2)];
  it("size desc, ties by name", () => {
    expect(sortClusters(rows, "size", "desc").map((r) => r.id)).toEqual([3, 2, 1, 4]);
  });
  it("name asc, case-insensitive", () => {
    expect(sortClusters(rows, "name", "asc").map((r) => r.id)).toEqual([2, 1, 4, 3]);
  });
  it("confidence: nulls last in both directions", () => {
    expect(sortClusters(rows, "confidence", "desc").map((r) => r.id)).toEqual([3, 1, 4, 2]);
    expect(sortClusters(rows, "confidence", "asc").map((r) => r.id)).toEqual([4, 1, 3, 2]);
  });
});
