// Task 4: stub server core (static reads). Exercises the real node:http
// server end-to-end (real fetch, real port, real fixture files on disk) --
// no mocking, since the whole point is to prove the router + fixture loader
// + date shift work together against Task 3's actual committed fixtures.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer } from "./server.mjs";

let baseUrl: string;
let close: () => Promise<void>;

beforeAll(async () => {
  const server = await startServer({ port: 0, fixturesDir: "demo/fixtures" });
  baseUrl = `http://localhost:${server.port}`;
  close = server.close;
});

afterAll(async () => {
  await close();
});

function get(pathAndQuery: string) {
  return fetch(`${baseUrl}${pathAndQuery}`);
}

describe("startServer", () => {
  it("binds an ephemeral port and returns {port, close()}", async () => {
    const server = await startServer({ port: 0, fixturesDir: "demo/fixtures" });
    expect(server.port).toBeGreaterThan(0);
    await server.close();
  });
});

describe("GET /docs", () => {
  it("serves 200 (health-probe target)", async () => {
    const res = await get("/docs");
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
  });
});

describe("GET /api/graph", () => {
  it("serves the full graph with nodes/links/clusters/super_clusters/groups", async () => {
    const res = await get("/api/graph");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.nodes)).toBe(true);
    expect(Array.isArray(body.links)).toBe(true);
    expect(Array.isArray(body.clusters)).toBe(true);
    expect(Array.isArray(body.super_clusters)).toBe(true);
    expect(Array.isArray(body.groups)).toBe(true);
    expect(body.nodes.length).toBe(157);
  });

  it("no ?window param serves the same as window=all (graph.json, full 157 nodes)", async () => {
    const res = await get("/api/graph");
    const body = await res.json();
    expect(body.nodes.length).toBe(157);
  });

  it("?window=30 serves graph-window-30.json's narrower node set", async () => {
    const res = await get("/api/graph?window=30");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nodes.length).toBe(151);
  });

  it("?window=7 and ?window=90 each serve a distinct node count", async () => {
    const res7 = await get("/api/graph?window=7");
    const res90 = await get("/api/graph?window=90");
    const body7 = await res7.json();
    const body90 = await res90.json();
    expect(body7.nodes.length).toBe(43);
    expect(body90.nodes.length).toBe(157);
  });

  it("shifts first_visited_at forward so the graph's dates stay recent", async () => {
    const res = await get("/api/graph");
    const body = await res.json();
    const dates = body.nodes.map((n: { first_visited_at: string }) => n.first_visited_at).filter(Boolean);
    const maxDate = dates.sort().at(-1)!;
    const fortyDaysAgo = new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 10);
    expect(maxDate.slice(0, 10) >= fortyDaysAgo).toBe(true);
  });
});

describe("GET /api/graph/nodes/{id}", () => {
  it("404s an unknown node id", async () => {
    const res = await get("/api/graph/nodes/definitely_not_a_real_node_id");
    expect(res.status).toBe(404);
  });

  it("200s a real node id with {node, subtree}", async () => {
    const res = await get(`/api/graph/nodes/${encodeURIComponent("aeneid")}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.node).toBeTruthy();
    expect(body.node.id).toBe("aeneid");
    expect(Array.isArray(body.subtree)).toBe(true);
    expect(body.subtree.length).toBeGreaterThan(0);
  });
});

describe("GET /api/diary/windows", () => {
  it("day windows are a bare array whose keys end recently (anchor shift ran)", async () => {
    const res = await get("/api/diary/windows?granularity=day");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(14);
    const maxKey = [...body].map((w: { key: string }) => w.key).sort().at(-1)!;
    const fortyDaysAgo = new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 10);
    expect(maxKey >= fortyDaysAgo).toBe(true);
  });

  it("week windows are a bare array with re-formatted labels", async () => {
    const res = await get("/api/diary/windows?granularity=week");
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(5);
    expect(body[0].key).toMatch(/^\d{4}-W\d{2}$/);
    expect(typeof body[0].label).toBe("string");
  });

  it("month windows are a bare array with re-formatted labels", async () => {
    const res = await get("/api/diary/windows?granularity=month");
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(2);
    expect(body[0].key).toMatch(/^\d{4}-\d{2}$/);
  });

  it("filter_node_id returns the full window(s) that node's subtree touched (a map lookup, not a per-page slice)", async () => {
    const unfiltered = await (await get("/api/diary/windows?granularity=day")).json();
    const filtered = await (
      await get(`/api/diary/windows?granularity=day&filter_node_id=${encodeURIComponent("aeneid")}`)
    ).json();
    expect(Array.isArray(filtered)).toBe(true);
    expect(filtered.length).toBeGreaterThan(0);
    // Every filtered window must be a byte-for-byte window that also exists
    // in the unfiltered set (full window, not narrowed to just this node).
    for (const w of filtered) {
      const match = unfiltered.find((u: { key: string }) => u.key === w.key);
      expect(match).toBeTruthy();
      expect(w.page_count).toBe(match.page_count);
    }
  });

  it("unknown filter_node_id returns an empty array rather than erroring", async () => {
    const res = await get("/api/diary/windows?granularity=day&filter_node_id=not_a_real_node");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });
});

describe("GET /api/pages/content", () => {
  it("200s a known url with the page content shape", async () => {
    const url = "https://arxiv.org/abs/1503.03585";
    const res = await get(`/api/pages/content?url=${encodeURIComponent(url)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pid).toBe(5343);
    expect(body.url).toBe(url);
    expect(typeof body.extracted_text).toBe("string");
  });

  it("404s an absent url", async () => {
    const res = await get(`/api/pages/content?url=${encodeURIComponent("https://example.com/never-captured")}`);
    expect(res.status).toBe(404);
  });

  it("404s when url is missing entirely", async () => {
    const res = await get("/api/pages/content");
    expect(res.status).toBe(404);
  });
});

describe("GET /api/clustering/status", () => {
  it("serves the presentation-ready status fixture verbatim", async () => {
    const res = await get("/api/clustering/status");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.run_number).toBe(141);
    expect(typeof body.title).toBe("string");
  });
});

describe("GET /api/topics", () => {
  it("serves the 4 declared topics", async () => {
    const res = await get("/api/topics");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.topics.length).toBe(4);
  });
});

describe("routing trap: /api/topics/exclusions vs /api/topics/{keyword}", () => {
  it("routes /api/topics/exclusions to the exclusions handler, not a keyword lookup", async () => {
    const res = await get("/api/topics/exclusions");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.exclusions)).toBe(true);
    // A keyword-lookup response would never carry this key.
    expect(body.members).toBeUndefined();
  });
});

describe("GET /api/topics/{keyword}/members", () => {
  it("defaults to the 50-file when no limit is given", async () => {
    const res = await get(`/api/topics/${encodeURIComponent("Cephalopods")}/members`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const res50 = await get(`/api/topics/${encodeURIComponent("Cephalopods")}/members?limit=50`);
    const body50 = await res50.json();
    expect(body).toEqual(body50);
  });

  it("limit=5 serves the 5-file (a different, shorter list)", async () => {
    const res5 = await get(`/api/topics/${encodeURIComponent("Cephalopods")}/members?limit=5`);
    const res50 = await get(`/api/topics/${encodeURIComponent("Cephalopods")}/members?limit=50`);
    expect(res5.status).toBe(200);
    const body5 = await res5.json();
    const body50 = await res50.json();
    expect(body5.members.length).toBeLessThanOrEqual(5);
    expect(body5.members.length).toBeLessThanOrEqual(body50.members.length);
  });

  it("404s an unknown keyword", async () => {
    const res = await get(`/api/topics/${encodeURIComponent("Not A Real Topic")}/members`);
    expect(res.status).toBe(404);
  });
});

describe("GET /api/agent/internals", () => {
  it("serves the internals fixture with system_prompt + tools", async () => {
    const res = await get("/api/agent/internals");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.system_prompt).toBe("string");
    expect(Array.isArray(body.tools)).toBe(true);
  });
});

describe("GET /api/auth/me", () => {
  it("never 401s: no Authorization header still returns 200, role admin", async () => {
    const res = await get("/api/auth/me");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.role).toBe("admin");
  });

  it("still never 401s even with a garbage bearer token", async () => {
    const res = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { authorization: "Bearer not-a-real-token" },
    });
    expect(res.status).toBe(200);
  });
});

describe("GET /api/auth/preferences", () => {
  it("serves the flat preferences fixture", async () => {
    const res = await get("/api/auth/preferences");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("theme");
    expect(body).toHaveProperty("starfield");
  });
});

describe("unmatched routes", () => {
  it("404s a completely unknown path", async () => {
    const res = await get("/api/not-a-real-endpoint");
    expect(res.status).toBe(404);
  });
});
