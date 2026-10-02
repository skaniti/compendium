import { describe, it, expect } from "vitest";
import { membersFor, pageUnclustered, shiftClustersFixtures } from "./clusters.mjs";

const all = { total: 3, featured: 1, since_run: 0, pages: [
  { id: 1, title: "A", domain: "a.example", url: "https://a.example", featured: true, since_run: false },
  { id: 2, title: "B", domain: "b.example", url: "https://b.example", featured: false, since_run: false },
  { id: 3, title: "C", domain: "c.example", url: "https://c.example", featured: false, since_run: false },
] };

describe("pageUnclustered", () => {
  it("defaults and slicing", () => {
    expect(pageUnclustered(all, new URLSearchParams())).toEqual({ status: 200, body: { total: 3, limit: 50, offset: 0, pages: all.pages } });
    expect(pageUnclustered(all, new URLSearchParams("limit=1&offset=1")).body).toEqual({ total: 3, limit: 1, offset: 1, pages: [all.pages[1]] });
  });
  it("422 like the API", () => {
    for (const q of ["limit=0", "limit=201", "offset=-1", "limit=x", "offset=1.5"]) {
      expect(pageUnclustered(all, new URLSearchParams(q)).status).toBe(422);
    }
  });
});

describe("membersFor / shift", () => {
  it("unknown id -> null", () => {
    expect(membersFor({ "5": { cluster_id: 5, total: 0, pages: [] } }, "5")).toEqual({ cluster_id: 5, total: 0, pages: [] });
    expect(membersFor({}, "6")).toBeNull();
  });
  it("shifts run and history dates only", () => {
    const raw = {
      run: { id: 9, started_at: "2026-08-01T10:00:00+00:00", completed_at: "2026-08-01T10:01:00+00:00" },
      runs: { total: 1, items: [{ id: 9, status: "completed", started_at: "2026-08-01T10:00:00+00:00", completed_at: null }] },
      clusters: [], pages: null,
    };
    const s = shiftClustersFixtures(raw, 3);
    expect(s.run!.started_at).toBe("2026-08-04T10:00:00+00:00");
    expect(s.run!.completed_at).toBe("2026-08-04T10:01:00+00:00");
    expect(s.runs.items[0].started_at).toBe("2026-08-04T10:00:00+00:00");
    expect(s.runs.items[0].completed_at).toBeNull();
    expect(raw.run.started_at).toBe("2026-08-01T10:00:00+00:00"); // input untouched
  });
});
