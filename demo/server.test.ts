// Task 4: stub server core (static reads). Exercises the real node:http
// server end-to-end (real fetch, real port, real fixture files on disk) --
// no mocking, since the whole point is to prove the router + fixture loader
// + date shift work together against Task 3's actual committed fixtures.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isPlainDemo, startServer } from "./server.mjs";
import { mintToken } from "./lib/tokens.mjs";

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

function get(pathAndQuery: string, token?: string) {
  return fetch(`${baseUrl}${pathAndQuery}`, token ? { headers: { authorization: `Bearer ${token}` } } : undefined);
}

function post(pathAndQuery: string, body?: unknown, token?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`${baseUrl}${pathAndQuery}`, {
    method: "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
}

// Task 6: mutation helpers. Generalized request helper (any method, optional
// JSON body, optional bearer) parameterized by base URL, since mutation
// tests spin up their own isolated servers rather than sharing the
// module-level `baseUrl` -- mutating shared state would make unrelated
// earlier/later assertions in this file order-dependent.
function req(base: string, method: string, pathAndQuery: string, body?: unknown, token?: string) {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`${base}${pathAndQuery}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// Spins up a fresh, isolated server (near-zero recluster delay so mutation
// tests stay fast) for the duration of `fn`, closing it afterward even on
// failure.
async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const server = await startServer({ port: 0, fixturesDir: "demo/fixtures", reclusterDelayMs: 0 });
  const base = `http://localhost:${server.port}`;
  try {
    return await fn(base);
  } finally {
    await server.close();
  }
}

const adminToken = () => mintToken({ id: 1, email: "admin@demo.local", role: "admin" });
const plainDemoToken = () => mintToken({ id: 2, email: "demo@demo.local", role: "demo" });
const actingDemoToken = () => mintToken({ id: 2, email: "demo@demo.local", role: "demo" }, { actingAsDemo: true });

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

  it("still never 401s even with a garbage bearer token -- falls back to the admin fixture", async () => {
    const res = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { authorization: "Bearer not-a-real-token" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.role).toBe("admin");
  });

  it("an admin login token also serves the fixture identity, role admin, not acting", async () => {
    const token = mintToken({ id: 1, email: "admin@demo.local", role: "admin" });
    const res = await get("/api/auth/me", token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.role).toBe("admin");
    expect(body.acting_as_demo).toBe(false);
  });

  it("a plain-demo login token -> role demo, not acting, demo identity", async () => {
    const token = mintToken({ id: 2, email: "demo@demo.local", role: "demo" });
    const res = await get("/api/auth/me", token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.role).toBe("demo");
    expect(body.acting_as_demo).toBe(false);
    expect(body.email).toBe("demo@demo.local");
    expect(body).not.toHaveProperty("admin_origin_email");
  });

  it("an acting (view-as) token -> role demo, acting_as_demo true, admin_origin_email set", async () => {
    const token = mintToken({ id: 2, email: "demo@demo.local", role: "demo" }, { actingAsDemo: true });
    const res = await get("/api/auth/me", token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.role).toBe("demo");
    expect(body.acting_as_demo).toBe(true);
    expect(body.admin_origin_email).toBe("admin@demo.local");
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

describe("POST /api/auth/login", () => {
  it("demo/demo -> tokens + user; me (with the returned token) shows role demo, not acting", async () => {
    const res = await post("/api/auth/login", { email: "demo@demo.local", password: "demo" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.access_token).toBe("string");
    expect(typeof body.refresh_token).toBe("string");
    expect(body.user).toMatchObject({ email: "demo@demo.local" });
    expect(body.access_token.split(".").length).toBe(3);

    const meRes = await get("/api/auth/me", body.access_token);
    const me = await meRes.json();
    expect(me.role).toBe("demo");
    expect(me.acting_as_demo).toBe(false);
  });

  it("admin/admin -> tokens + user, decoded role admin", async () => {
    const res = await post("/api/auth/login", { email: "admin@demo.local", password: "admin" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user).toMatchObject({ email: "admin@demo.local" });
    expect(decodeJwtPayload(body.access_token).role).toBe("admin");
  });

  it("wrong password -> 401, the ONE permitted 401 in the whole stub", async () => {
    const res = await post("/api/auth/login", { email: "demo@demo.local", password: "wrong" });
    expect(res.status).toBe(401);
  });

  it("unknown email -> 401", async () => {
    const res = await post("/api/auth/login", { email: "nobody@demo.local", password: "whatever" });
    expect(res.status).toBe(401);
  });
});

describe("POST /api/auth/logout", () => {
  it("returns 2xx", async () => {
    const res = await post("/api/auth/logout", { refresh_token: "whatever" });
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
  });

  it("returns 2xx even with no body / a garbage refresh_token (failures swallowed)", async () => {
    const res = await post("/api/auth/logout");
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
  });
});

describe("POST /api/auth/refresh", () => {
  it("rotates both access_token and refresh_token to new, distinct values", async () => {
    const loginRes = await post("/api/auth/login", { email: "demo@demo.local", password: "demo" });
    const login = await loginRes.json();

    const refreshRes = await post("/api/auth/refresh", { refresh_token: login.refresh_token });
    expect(refreshRes.status).toBe(200);
    const refreshed = await refreshRes.json();
    expect(typeof refreshed.access_token).toBe("string");
    expect(typeof refreshed.refresh_token).toBe("string");
    expect(refreshed.token_type).toBeTruthy();
    expect(refreshed.access_token).not.toBe(login.access_token);
    expect(refreshed.refresh_token).not.toBe(login.refresh_token);
  });

  it("preserves the demo identity/role across rotation", async () => {
    const loginRes = await post("/api/auth/login", { email: "demo@demo.local", password: "demo" });
    const login = await loginRes.json();
    const refreshRes = await post("/api/auth/refresh", { refresh_token: login.refresh_token });
    const refreshed = await refreshRes.json();
    expect(decodeJwtPayload(refreshed.access_token).role).toBe("demo");
  });
});

describe("POST /api/auth/view-as and /api/auth/return-to-admin", () => {
  it("view-as then me -> acting_as_demo true; return-to-admin then me -> restores admin", async () => {
    const loginRes = await post("/api/auth/login", { email: "admin@demo.local", password: "admin" });
    const login = await loginRes.json();

    const viewAsRes = await post("/api/auth/view-as", { profile: "demo" }, login.access_token);
    expect(viewAsRes.status).toBe(200);
    const viewAs = await viewAsRes.json();
    expect(viewAs.token_type).toBeTruthy();
    expect(viewAs.user).toBeTruthy();

    const meActingRes = await get("/api/auth/me", viewAs.access_token);
    const meActing = await meActingRes.json();
    expect(meActing.acting_as_demo).toBe(true);
    expect(meActing.admin_origin_email).toBe("admin@demo.local");

    const returnRes = await post("/api/auth/return-to-admin", undefined, viewAs.access_token);
    expect(returnRes.status).toBe(200);
    const back = await returnRes.json();

    const meBackRes = await get("/api/auth/me", back.access_token);
    const meBack = await meBackRes.json();
    expect(meBack.role).toBe("admin");
    expect(meBack.acting_as_demo).toBe(false);
  });

  it("view-as response carries NO refresh_token key", async () => {
    const loginRes = await post("/api/auth/login", { email: "admin@demo.local", password: "admin" });
    const login = await loginRes.json();
    const viewAsRes = await post("/api/auth/view-as", { profile: "demo" }, login.access_token);
    const viewAs = await viewAsRes.json();
    expect(viewAs).not.toHaveProperty("refresh_token");
  });

  it("return-to-admin response carries NO refresh_token key", async () => {
    const loginRes = await post("/api/auth/login", { email: "admin@demo.local", password: "admin" });
    const login = await loginRes.json();
    const viewAsRes = await post("/api/auth/view-as", { profile: "demo" }, login.access_token);
    const viewAs = await viewAsRes.json();
    const returnRes = await post("/api/auth/return-to-admin", undefined, viewAs.access_token);
    const back = await returnRes.json();
    expect(back).not.toHaveProperty("refresh_token");
  });
});

describe("isPlainDemo (exported for Task 6's write gate)", () => {
  it("true for a plain demo login token", () => {
    const token = mintToken({ id: 2, email: "demo@demo.local", role: "demo" });
    expect(isPlainDemo({ headers: { authorization: `Bearer ${token}` } })).toBe(true);
  });

  it("false for an acting-as-demo token", () => {
    const token = mintToken({ id: 2, email: "demo@demo.local", role: "demo" }, { actingAsDemo: true });
    expect(isPlainDemo({ headers: { authorization: `Bearer ${token}` } })).toBe(false);
  });

  it("false for an admin token", () => {
    const token = mintToken({ id: 1, email: "admin@demo.local", role: "admin" });
    expect(isPlainDemo({ headers: { authorization: `Bearer ${token}` } })).toBe(false);
  });

  it("false when there is no Authorization header (admin default)", () => {
    expect(isPlainDemo({ headers: {} })).toBe(false);
  });

  it("false for a garbage bearer token (admin default, never throws)", () => {
    expect(isPlainDemo({ headers: { authorization: "Bearer garbage" } })).toBe(false);
  });
});

describe("mutation endpoints (Task 6): topics CRUD", () => {
  it("adds, renames, deletes a topic; topics list reflects each", async () => {
    await withServer(async (base) => {
      const admin = adminToken();
      const before = await (await req(base, "GET", "/api/topics")).json();
      expect(before.topics.length).toBe(4);

      const addRes = await req(base, "POST", "/api/topics", { keyword: "New Topic" }, admin);
      expect(addRes.status).toBe(200);
      const added = await addRes.json();
      expect(added.topic).toMatchObject({ keyword: "New Topic", icon_id: null });
      expect(added.topics.length).toBe(5);
      expect(added.topics.some((t: { keyword: string }) => t.keyword === "New Topic")).toBe(true);

      const afterAdd = await (await req(base, "GET", "/api/topics")).json();
      expect(afterAdd.topics.length).toBe(5);

      const renameRes = await req(
        base,
        "PATCH",
        `/api/topics/${encodeURIComponent("New Topic")}`,
        { keyword: "Renamed Topic" },
        admin
      );
      expect(renameRes.status).toBe(200);
      const renamed = await renameRes.json();
      expect(renamed.topics.some((t: { keyword: string }) => t.keyword === "Renamed Topic")).toBe(true);
      expect(renamed.topics.some((t: { keyword: string }) => t.keyword === "New Topic")).toBe(false);

      const deleteRes = await req(
        base,
        "DELETE",
        `/api/topics/${encodeURIComponent("Renamed Topic")}`,
        undefined,
        admin
      );
      expect(deleteRes.status).toBe(200);
      const afterDelete = await deleteRes.json();
      expect(afterDelete.topics.length).toBe(4);

      const finalGet = await (await req(base, "GET", "/api/topics")).json();
      expect(finalGet.topics.length).toBe(4);
    });
  });

  it("sets a topic icon via PUT", async () => {
    await withServer(async (base) => {
      const admin = adminToken();
      const res = await req(
        base,
        "PUT",
        `/api/topics/${encodeURIComponent("Cephalopods")}/icon`,
        { icon_id: "squid" },
        admin
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      const topic = body.topics.find((t: { keyword: string }) => t.keyword === "Cephalopods");
      expect(topic.icon_id).toBe("squid");
    });
  });

  it("new topics get icon_id null and a plausible cluster_count", async () => {
    await withServer(async (base) => {
      const admin = adminToken();
      const res = await req(base, "POST", "/api/topics", { keyword: "Fresh Topic" }, admin);
      const body = await res.json();
      expect(body.topic.icon_id).toBeNull();
      expect(typeof body.topic.cluster_count).toBe("number");
      expect(body.topic.cluster_count).toBeGreaterThanOrEqual(0);
    });
  });

  it("a topic added at runtime serves {members: []} instead of 404 (no fixture file exists for it)", async () => {
    await withServer(async (base) => {
      const admin = adminToken();
      await req(base, "POST", "/api/topics", { keyword: "Runtime Topic" }, admin);
      const res = await req(base, "GET", `/api/topics/${encodeURIComponent("Runtime Topic")}/members`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ members: [] });
    });
  });
});

describe("mutation endpoints (Task 6): exclusions", () => {
  it("adds and deletes an exclusion (delete carries a json body); GET reflects state", async () => {
    await withServer(async (base) => {
      const admin = adminToken();
      const addRes = await req(
        base,
        "POST",
        "/api/topics/exclusions",
        { keyword: "Cephalopods", cluster_name: "Animal Coloration" },
        admin
      );
      expect(addRes.status).toBe(200);
      const added = await addRes.json();
      expect(added.exclusions.length).toBe(1);
      expect(added.exclusions[0]).toMatchObject({ keyword: "Cephalopods", cluster_name: "Animal Coloration" });
      expect(typeof added.exclusions[0].cluster_slug).toBe("string");
      expect(typeof added.exclusions[0].created_at).toBe("string");

      const getRes = await req(base, "GET", "/api/topics/exclusions");
      const getBody = await getRes.json();
      expect(getBody.exclusions.length).toBe(1);

      const deleteRes = await req(
        base,
        "DELETE",
        "/api/topics/exclusions",
        { keyword: "Cephalopods", cluster_name: "Animal Coloration" },
        admin
      );
      expect(deleteRes.status).toBe(200);
      const deleted = await deleteRes.json();
      expect(deleted.exclusions.length).toBe(0);

      const getAfter = await (await req(base, "GET", "/api/topics/exclusions")).json();
      expect(getAfter.exclusions.length).toBe(0);
    });
  });
});

describe("routing trap: DELETE /api/topics/exclusions vs DELETE /api/topics/{keyword}", () => {
  it("routes DELETE /api/topics/exclusions (with a json body) to the exclusions handler, not a keyword deletion", async () => {
    await withServer(async (base) => {
      const admin = adminToken();
      const res = await req(
        base,
        "DELETE",
        "/api/topics/exclusions",
        { keyword: "whoever", cluster_name: "whatever" },
        admin
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.exclusions)).toBe(true);
      // A keyword-deletion response carries `topics`, never `exclusions`.
      expect(body.topics).toBeUndefined();

      // The 4 declared topics must be untouched -- proves "exclusions" was
      // never matched as a topic keyword to delete.
      const topics = await (await req(base, "GET", "/api/topics")).json();
      expect(topics.topics.length).toBe(4);
    });
  });
});

describe("mutation endpoints (Task 6): PATCH /api/auth/preferences", () => {
  it("wrapper shape {preferences:{...partial}} merges into state; GET and /api/auth/me reflect it", async () => {
    await withServer(async (base) => {
      const admin = adminToken();
      const before = await (await req(base, "GET", "/api/auth/preferences")).json();
      expect(before.theme).toBe("Brown");

      const patchRes = await req(
        base,
        "PATCH",
        "/api/auth/preferences",
        { preferences: { theme: "Slate", show_noise: true } },
        admin
      );
      expect(patchRes.status).toBeGreaterThanOrEqual(200);
      expect(patchRes.status).toBeLessThan(300);

      const after = await (await req(base, "GET", "/api/auth/preferences")).json();
      expect(after.theme).toBe("Slate");
      expect(after.show_noise).toBe(true);
      // Unmentioned keys survive the merge (partial patch, not a replace).
      expect(after.starfield).toBe("twinkle");

      const me = await (await req(base, "GET", "/api/auth/me", undefined, admin)).json();
      expect(me.preferences.theme).toBe("Slate");
      expect(me.preferences.show_noise).toBe(true);
    });
  });
});

describe("mutation endpoints (Task 6): POST /api/recluster", () => {
  it("bumps run_number in subsequent clustering-status; title tracks the new number, other strings unchanged", async () => {
    await withServer(async (base) => {
      const admin = adminToken();
      const before = await (await req(base, "GET", "/api/clustering/status")).json();
      expect(before.run_number).toBe(141);

      const reclusterRes = await req(base, "POST", "/api/recluster", undefined, admin);
      expect(reclusterRes.status).toBe(200);
      const reclustered = await reclusterRes.json();
      expect(typeof reclustered.cluster_count).toBe("number");
      expect(typeof reclustered.noise_count).toBe("number");
      expect(typeof reclustered.naming_cost).toBe("number");
      expect(typeof reclustered.elapsed_seconds).toBe("number");

      const after = await (await req(base, "GET", "/api/clustering/status")).json();
      expect(after.run_number).toBe(142);
      expect(after.title).toContain("RUN #142");
      expect(after.freshness_color).toBe(before.freshness_color);
      expect(after.stats_line1).toBe(before.stats_line1);
    });
  });

  it("delay is injectable via reclusterDelayMs -- a near-zero delay keeps the test fast", async () => {
    const server = await startServer({ port: 0, fixturesDir: "demo/fixtures", reclusterDelayMs: 5 });
    const base = `http://localhost:${server.port}`;
    try {
      const admin = adminToken();
      const start = Date.now();
      const res = await req(base, "POST", "/api/recluster", undefined, admin);
      const elapsedMs = Date.now() - start;
      expect(res.status).toBe(200);
      expect(elapsedMs).toBeLessThan(500); // real default (2000ms) would blow this budget
    } finally {
      await server.close();
    }
  });
});

describe("mutation endpoints (Task 6): plain-demo write gate", () => {
  it('plain-demo token gets 403 {detail:"forbidden"} on every mutation; nothing is actually mutated', async () => {
    await withServer(async (base) => {
      const plainDemo = plainDemoToken();
      const attempts: Array<[string, string, unknown]> = [
        ["POST", "/api/topics", { keyword: "Nope" }],
        ["DELETE", `/api/topics/${encodeURIComponent("Cephalopods")}`, undefined],
        ["PATCH", `/api/topics/${encodeURIComponent("Cephalopods")}`, { keyword: "Nope" }],
        ["PUT", `/api/topics/${encodeURIComponent("Cephalopods")}/icon`, { icon_id: "x" }],
        ["POST", "/api/topics/exclusions", { keyword: "Cephalopods", cluster_name: "Animal Coloration" }],
        ["DELETE", "/api/topics/exclusions", { keyword: "Cephalopods", cluster_name: "Animal Coloration" }],
        ["PATCH", "/api/auth/preferences", { preferences: { theme: "Nope" } }],
        ["POST", "/api/recluster", undefined],
      ];
      for (const [method, pathAndQuery, body] of attempts) {
        const res = await req(base, method, pathAndQuery, body, plainDemo);
        expect(res.status).toBe(403);
        const resBody = await res.json();
        expect(resBody).toEqual({ detail: "forbidden" });
      }

      const topics = await (await req(base, "GET", "/api/topics")).json();
      expect(topics.topics.length).toBe(4);
      const exclusions = await (await req(base, "GET", "/api/topics/exclusions")).json();
      expect(exclusions.exclusions.length).toBe(0);
      const status = await (await req(base, "GET", "/api/clustering/status")).json();
      expect(status.run_number).toBe(141);
      const prefs = await (await req(base, "GET", "/api/auth/preferences")).json();
      expect(prefs.theme).toBe("Brown");
    });
  });

  it("an acting-as-demo token IS allowed to mutate (isPlainDemo is false for it)", async () => {
    await withServer(async (base) => {
      const res = await req(base, "POST", "/api/topics", { keyword: "Acting Added" }, actingDemoToken());
      expect(res.status).toBe(200);
    });
  });

  it("a plain admin token is allowed to mutate", async () => {
    await withServer(async (base) => {
      const res = await req(base, "POST", "/api/topics", { keyword: "Admin Added" }, adminToken());
      expect(res.status).toBe(200);
    });
  });
});

describe("mutation endpoints (Task 6): reset on restart", () => {
  it("fresh startServer resets mutated state (topics, exclusions, preferences, clustering-status all reseed)", async () => {
    const admin = adminToken();

    const server1 = await startServer({ port: 0, fixturesDir: "demo/fixtures", reclusterDelayMs: 0 });
    const base1 = `http://localhost:${server1.port}`;
    await req(base1, "POST", "/api/topics", { keyword: "Leftover Topic" }, admin);
    await req(
      base1,
      "POST",
      "/api/topics/exclusions",
      { keyword: "Cephalopods", cluster_name: "Animal Coloration" },
      admin
    );
    await req(base1, "PATCH", "/api/auth/preferences", { preferences: { theme: "Leftover" } }, admin);
    await req(base1, "POST", "/api/recluster", undefined, admin);
    const during = await (await req(base1, "GET", "/api/topics")).json();
    expect(during.topics.length).toBe(5);
    await server1.close();

    const server2 = await startServer({ port: 0, fixturesDir: "demo/fixtures", reclusterDelayMs: 0 });
    const base2 = `http://localhost:${server2.port}`;
    try {
      const topics = await (await req(base2, "GET", "/api/topics")).json();
      expect(topics.topics.length).toBe(4);
      expect(topics.topics.some((t: { keyword: string }) => t.keyword === "Leftover Topic")).toBe(false);

      const exclusions = await (await req(base2, "GET", "/api/topics/exclusions")).json();
      expect(exclusions.exclusions.length).toBe(0);

      const prefs = await (await req(base2, "GET", "/api/auth/preferences")).json();
      expect(prefs.theme).toBe("Brown");

      const status = await (await req(base2, "GET", "/api/clustering/status")).json();
      expect(status.run_number).toBe(141);
    } finally {
      await server2.close();
    }
  });
});

describe("unmatched routes", () => {
  it("404s a completely unknown path", async () => {
    const res = await get("/api/not-a-real-endpoint");
    expect(res.status).toBe(404);
  });
});
