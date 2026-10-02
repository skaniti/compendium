// Stub server core (static reads, mutations, auth, SSE chat replay, preview/
// asset serving) plus the launcher's port/entrypoint/boot helpers. Exercises
// the real node:http server end-to-end (real fetch, real port, real fixture
// files on disk) -- no mocking, since the whole point is to prove the router
// + fixture loader + date shift work together against the actual committed
// fixtures.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isEnvFlagOn, isPlainDemo, startServer } from "./server.mjs";
import { mintToken } from "./lib/tokens.mjs";
import { bootStub, isDirectEntry, pickPort } from "./launcher.mjs";
import { fileURLToPath, pathToFileURL } from "node:url";

let baseUrl: string;
let close: () => Promise<void>;

beforeAll(async () => {
  // roleToolingEnabled: true -- this shared server backs every describe
  // block below that logs in as demo@demo.local or exercises
  // POST /api/auth/view-as / return-to-admin (the role machinery this
  // suite has always covered). The default-OFF contract itself is tested
  // separately, against isolated withServer() instances that leave the
  // option at its real default -- see the "role-tooling opt-in" describe
  // block near the end of this file.
  const server = await startServer({ port: 0, fixturesDir: "demo/fixtures", roleToolingEnabled: true });
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

// Spins up a fresh, isolated server (near-zero recluster/chat-token delay so
// mutation and chat-stream tests stay fast) for the duration of `fn`,
// closing it afterward even on failure. `overrides` lets a caller opt back
// into a nonzero chatTokenDelayMs (the abort test needs enough real pacing
// to reliably abort mid-stream).
async function withServer<T>(
  fn: (base: string) => Promise<T>,
  overrides: { reclusterDelayMs?: number; chatTokenDelayMs?: number; roleToolingEnabled?: boolean; now?: Date | number | (() => Date | number) } = {}
): Promise<T> {
  const server = await startServer({
    port: 0,
    fixturesDir: "demo/fixtures",
    reclusterDelayMs: 0,
    chatTokenDelayMs: 0,
    ...overrides,
  });
  const base = `http://localhost:${server.port}`;
  try {
    return await fn(base);
  } finally {
    await server.close();
  }
}

// Parses a raw SSE response body into its frame objects -- splits on lines
// starting "data:" (agnostic to single/double blank-line framing, mirroring
// the server's own parseSseFrames), JSON-parsing each payload.
async function readSseFrames(res: Response): Promise<Array<Record<string, unknown>>> {
  const text = await res.text();
  return text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice("data:".length).trim()));
}

// Sends a request with an EXACT, unnormalized request-line path -- unlike
// fetch()/the WHATWG URL constructor (which both collapse literal ".."
// path segments client-side before a request ever goes out, per RFC 3986
// path normalization), node:http's `path` option is sent verbatim. Used
// only for the traversal-rejection tests below, so the assertion exercises
// the SERVER's own sanitization (resolveAssetPath) rather than incidentally
// passing because the client already neutralized the payload.
function rawGet(base: string, rawPath: string): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    const req = http.request({ hostname: u.hostname, port: u.port, path: rawPath, method: "GET" }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode! }));
    });
    req.on("error", reject);
    req.end();
  });
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

  it("?window=365 serves graph-window-365.json's node set", async () => {
    const res = await get("/api/graph?window=365");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.nodes)).toBe(true);
    expect(body.nodes.length).toBe(157);
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

  it("an invalid granularity value -> 400 with a descriptive detail", async () => {
    const res = await get("/api/diary/windows?granularity=year");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(typeof body.detail).toBe("string");
  });

  it("missing granularity entirely -> 400 (same validation as an invalid value)", async () => {
    const res = await get("/api/diary/windows");
    expect(res.status).toBe(400);
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

  it("200s for a plain admin token", async () => {
    const res = await get("/api/agent/internals", adminToken());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.system_prompt).toBe("string");
  });

  it("200s for an acting-as-demo token (admin viewing as demo)", async () => {
    const res = await get("/api/agent/internals", actingDemoToken());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.system_prompt).toBe("string");
  });

  it('403s a plain-demo token with {detail: "..."}', async () => {
    const res = await get("/api/agent/internals", plainDemoToken());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(typeof body.detail).toBe("string");
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

// Role-tooling opt-in: `roleToolingEnabled` defaults to false (server.mjs's
// startServer doc comment) so a stranger running `npm run demo` gets a
// single full-control identity and never sees the demo account or
// acting-session machinery. Every test in this block uses withServer() with
// NO override, so it exercises the real out-of-the-box default -- not the
// roleToolingEnabled:true server the rest of this file shares.
describe("role-tooling opt-in (DEMO_ROLE_TOOLING, default off)", () => {
  it("demo login is rejected via the SAME invalid-credentials 401 as a wrong password, not a bespoke path", async () => {
    await withServer(async (base) => {
      const res = await req(base, "POST", "/api/auth/login", { email: "demo@demo.local", password: "demo" });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toEqual({ detail: "invalid credentials" });
    });
  });

  it("admin login is unaffected -- still works with role tooling off", async () => {
    await withServer(async (base) => {
      const res = await req(base, "POST", "/api/auth/login", { email: "admin@demo.local", password: "admin" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(decodeJwtPayload(body.access_token).role).toBe("admin");
    });
  });

  it("POST /api/auth/view-as is inert (404), never 401", async () => {
    await withServer(async (base) => {
      const res = await req(base, "POST", "/api/auth/view-as", { profile: "demo" });
      expect(res.status).toBe(404);
    });
  });

  it("POST /api/auth/return-to-admin is inert (404), never 401", async () => {
    await withServer(async (base) => {
      const res = await req(base, "POST", "/api/auth/return-to-admin");
      expect(res.status).toBe(404);
    });
  });

  it("unauthenticated GET /api/auth/me still serves the default admin identity", async () => {
    await withServer(async (base) => {
      const res = await req(base, "GET", "/api/auth/me");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.role).toBe("admin");
      expect(body.acting_as_demo).toBe(false);
    });
  });

  it("the default identity keeps full write access (a mutation succeeds with no token)", async () => {
    await withServer(async (base) => {
      const res = await req(base, "POST", "/api/topics", { keyword: "unattended-write" });
      expect(res.status).toBe(200);
    });
  });

  it("roleToolingEnabled:true restores demo login and the acting-session endpoints", async () => {
    await withServer(
      async (base) => {
        const loginRes = await req(base, "POST", "/api/auth/login", { email: "demo@demo.local", password: "demo" });
        expect(loginRes.status).toBe(200);

        const adminLoginRes = await req(base, "POST", "/api/auth/login", {
          email: "admin@demo.local",
          password: "admin",
        });
        const adminLogin = await adminLoginRes.json();
        const viewAsRes = await req(base, "POST", "/api/auth/view-as", { profile: "demo" }, adminLogin.access_token);
        expect(viewAsRes.status).toBe(200);
      },
      { roleToolingEnabled: true }
    );
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

  it("rejects an empty/whitespace-only keyword with 400, never 401, and adds nothing", async () => {
    await withServer(async (base) => {
      const admin = adminToken();
      const res = await req(base, "POST", "/api/topics", { keyword: "   " }, admin);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(typeof body.detail).toBe("string");

      const topics = await (await req(base, "GET", "/api/topics")).json();
      expect(topics.topics.length).toBe(4);
    });
  });

  it("rejects a keyword with no `keyword` field at all (missing body) the same way as empty", async () => {
    await withServer(async (base) => {
      const admin = adminToken();
      const res = await req(base, "POST", "/api/topics", {}, admin);
      expect(res.status).toBe(400);
    });
  });

  it("rejects a duplicate keyword case-insensitively with 400, and adds nothing", async () => {
    await withServer(async (base) => {
      const admin = adminToken();
      // "Cephalopods" is one of the 4 fixture-seeded topics.
      const res = await req(base, "POST", "/api/topics", { keyword: "cephalopods" }, admin);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(typeof body.detail).toBe("string");

      const topics = await (await req(base, "GET", "/api/topics")).json();
      expect(topics.topics.length).toBe(4);
    });
  });
});

describe("GET /api/topics/{keyword}/members: reflects the topic's live-state lifecycle", () => {
  it("a topic deleted in-session -> 404 (not a stale 200 replayed from its still-on-disk fixture file)", async () => {
    await withServer(async (base) => {
      const admin = adminToken();
      const before = await req(base, "GET", `/api/topics/${encodeURIComponent("Cephalopods")}/members`);
      expect(before.status).toBe(200);

      const deleteRes = await req(base, "DELETE", `/api/topics/${encodeURIComponent("Cephalopods")}`, undefined, admin);
      expect(deleteRes.status).toBe(200);

      const after = await req(base, "GET", `/api/topics/${encodeURIComponent("Cephalopods")}/members`);
      expect(after.status).toBe(404);
    });
  });

  it("a renamed topic: the OLD keyword 404s, the NEW keyword serves {members: []} (its fixture file is named after the old keyword)", async () => {
    await withServer(async (base) => {
      const admin = adminToken();
      const renameRes = await req(
        base,
        "PATCH",
        `/api/topics/${encodeURIComponent("Cephalopods")}`,
        { keyword: "Renamed Cephalopods" },
        admin
      );
      expect(renameRes.status).toBe(200);

      const oldRes = await req(base, "GET", `/api/topics/${encodeURIComponent("Cephalopods")}/members`);
      expect(oldRes.status).toBe(404);

      const newRes = await req(base, "GET", `/api/topics/${encodeURIComponent("Renamed Cephalopods")}/members`);
      expect(newRes.status).toBe(200);
      const newBody = await newRes.json();
      expect(newBody).toEqual({ members: [] });
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
      expect(before.theme).toBe("Grey");

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
      expect(prefs.theme).toBe("Grey");
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
      expect(prefs.theme).toBe("Grey");

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

describe("readJsonBody: malformed request bodies", () => {
  it("malformed JSON to a mutation endpoint -> 400 with a short error payload, never 401/500", async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/topics`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${adminToken()}` },
        body: "{not valid json",
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(typeof body.detail).toBe("string");
    });
  });

  it("malformed JSON to POST /api/auth/login -> 400, distinct from the wrong-credentials 401", async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{bad json, not parseable",
      });
      expect(res.status).toBe(400);
    });
  });

  it("a fully empty body still resolves to {} for an endpoint that tolerates it (logout, no body at all)", async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/auth/logout`, { method: "POST" });
      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);
    });
  });
});

describe("POST /api/agent/query-stream", () => {
  it("streams status -> tokens -> complete for a matching query, preserving the recorded complete frame's fields", async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/agent/query-stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "How does classifier-free guidance improve image quality?" }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");

      const frames = await readSseFrames(res);
      // chat/01.sse actually opens with 3 status frames (tool-use
      // narration) before the first token -- assert the SHAPE (one-or-more
      // status, then one-or-more token, then exactly one complete, in that
      // order) rather than assuming a single leading status frame.
      const typeSequence = frames.map((f) => f.type).join(",");
      expect(typeSequence).toMatch(/^status(,status)*(,token)+,complete$/);

      const complete = frames.at(-1) as {
        sources: string[];
        cluster_ids?: string[];
        sources_detail?: Array<{ url: string; page_id: number; node_id: string }>;
        images?: unknown[];
        iterations: number;
        model: string;
      };
      // Confirms chat/01.sse (the classifier-free-guidance recording) was
      // picked, not some other recorded stream or the fallback.
      expect(complete.sources).toContain("https://arxiv.org/abs/2207.12598");
      expect(typeof complete.iterations).toBe("number");
      expect(typeof complete.model).toBe("string");
      // Frame fidelity: unrecognized/optional fields on the recorded
      // `complete` frame must survive the parse -> re-stringify round trip
      // untouched, not just the three required fields.
      expect(Array.isArray(complete.cluster_ids)).toBe(true);
      expect(complete.cluster_ids!.every((id) => typeof id === "string")).toBe(true);
      expect(Array.isArray(complete.sources_detail)).toBe(true);
      for (const detail of complete.sources_detail!) {
        expect(typeof detail.url).toBe("string");
        expect(typeof detail.page_id).toBe("number");
        expect(typeof detail.node_id).toBe("string");
      }
      expect(Array.isArray(complete.images)).toBe(true);
    });
  });

  it("falls back to the demo-help answer for an unrelated query, listing every recorded question as a suggestion", async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/agent/query-stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "What's your favorite pizza topping?" }),
      });
      expect(res.status).toBe(200);
      const frames = await readSseFrames(res);
      expect(frames[0]).toEqual({ type: "status", text: "Demo mode" });
      expect(frames.at(-1)).toEqual({ type: "complete", sources: [], iterations: 1, model: "demo-stub" });

      const answerText = frames
        .slice(1, -1)
        .map((f) => (f as { text: string }).text)
        .join("");
      const index = JSON.parse(readFileSync("demo/fixtures/chat/index.json", "utf8")) as Array<{ question: string }>;
      expect(index.length).toBeGreaterThan(0);
      for (const { question } of index) {
        expect(answerText).toContain(question);
      }
    });
  });

  it("a single shared keyword (below the 2-keyword-overlap threshold) still falls back", async () => {
    await withServer(async (base) => {
      // "cephalopod" (singular) is a different token than the recorded
      // questions' "cephalopods" (plural, no stemming) -- overlap is 1, not
      // 0, but 1 is still below the 2-keyword threshold.
      const res = await fetch(`${base}/api/agent/query-stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "cephalopod cephalopods" }),
      });
      const frames = await readSseFrames(res);
      expect(frames[0]).toEqual({ type: "status", text: "Demo mode" });
    });
  });

  it("ties resolve to the first entry in chat/index.json order", async () => {
    await withServer(async (base) => {
      // chat/05.sse ("Trojan War... Greek... Roman...") and chat/06.sse
      // ("Hesiod's Theogony... Roman mythology...") both share exactly 2
      // keywords with this query; 05 comes first in index order.
      const res = await fetch(`${base}/api/agent/query-stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "Greek Roman mythology" }),
      });
      const frames = await readSseFrames(res);
      const complete = frames.at(-1) as { sources: string[] };
      expect(complete.sources).toContain("https://en.wikipedia.org/wiki/Trojan_War");
      expect(complete.sources).not.toContain("https://en.wikipedia.org/wiki/Theogony");
    });
  });

  it("keyword matching is deterministic across repeated identical queries", async () => {
    await withServer(async (base) => {
      const run = async () => {
        const res = await fetch(`${base}/api/agent/query-stream`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: "How do cephalopods change color?" }),
        });
        const frames = await readSseFrames(res);
        return frames.at(-1) as { type: string; sources: string[] } | undefined;
      };
      const first = await run();
      const second = await run();
      expect(first?.type).toBe("complete");
      expect(first?.sources).toContain("https://en.wikipedia.org/wiki/Chromatophore");
      expect(second).toEqual(first);
    });
  });

  it("client abort stops the token timer chain (no crash, no post-abort writes)", async () => {
    await withServer(
      async (base) => {
        const controller = new AbortController();
        const res = await fetch(`${base}/api/agent/query-stream`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: "How does classifier-free guidance improve image quality?" }),
          signal: controller.signal,
        });
        const reader = res.body!.getReader();
        await reader.read(); // consume the first chunk (status frame)
        controller.abort();
        await reader.cancel().catch(() => {});
        // Give the server a moment to process the abort. If a post-abort
        // write ever threw an unhandled exception, it would crash this
        // whole test process, not just fail an assertion -- so the
        // meaningful check is that the server is still alive afterward.
        await new Promise((resolve) => setTimeout(resolve, 100));
        const followUp = await fetch(`${base}/docs`);
        expect(followUp.status).toBe(200);
      },
      { chatTokenDelayMs: 30 } // slow enough that abort lands mid-stream, not after completion
    );
  });
});

describe("GET /api/pages/{pid}/preview", () => {
  it("200s a known pid with the archived HTML document", async () => {
    const res = await get("/api/pages/5343/preview");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("/captured-assets/");
  });

  it("404s an unknown pid", async () => {
    const res = await get("/api/pages/999999999/preview");
    expect(res.status).toBe(404);
  });

  it("rejects encoded-slash traversal in pid (resolved path must stay inside the previews dir)", async () => {
    await withServer(async (base) => {
      // The route pattern's `[^/]+` sees the STILL-ENCODED pathname (new URL()
      // leaves %2f alone), so the escape only appears after the handler's
      // decodeURIComponent -- which is why the pattern alone is not a guard.
      // Each target is a real .html file that exists OUTSIDE previewsDir, so a
      // 404 proves the containment check rejected the path rather than the
      // file merely being absent.
      const attempts = [
        "/api/pages/..%2fraw%2fpreviews%2f5435/preview", // up and across into the pre-hygiene capture dir
        "/api/pages/%2e%2e%2fraw%2fpreviews%2f5435/preview", // fully-encoded ".." segment
        "/api/pages/..%2f..%2fdemo%2ffixtures%2fpreviews%2f5343/preview", // deeper escape, back in by absolute-ish route
      ];
      for (const rawPath of attempts) {
        const { status } = await rawGet(base, rawPath);
        expect(status).toBe(404);
      }
    });
  });
});

describe("GET /captured-assets/<path> (top-level, not under /api)", () => {
  // Referenced by demo/fixtures/previews/5343.html as
  // href="/captured-assets/b1/b1bc02...css".
  const knownAsset = "/captured-assets/b1/b1bc02fbde98738352a8863e07f26b46134734111a2bfb153e111de99bb99104.css";

  it("200s a known asset with a sensible Content-Type by extension", async () => {
    const res = await get(knownAsset);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/css");
    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
  });

  it("404s an absent asset", async () => {
    const res = await get("/captured-assets/aa/not-a-real-hash.jpg");
    expect(res.status).toBe(404);
  });

  it("rejects path traversal / absolute-escape attempts (resolved path must stay inside the assets dir)", async () => {
    await withServer(async (base) => {
      const attempts = [
        "/captured-assets/../../../../../../etc/passwd", // literal ".." segments
        "/captured-assets/28/../../../../etc/passwd", // ".." mixed with a real prefix segment
        "/captured-assets/..%2f..%2f..%2f..%2fetc%2fpasswd", // percent-encoded slash hides ".." from naive splitting
        "/captured-assets//etc/passwd", // leading-slash absolute-escape (path.resolve would otherwise ignore rootDir)
      ];
      for (const rawPath of attempts) {
        const { status } = await rawGet(base, rawPath);
        expect(status).toBe(404);
      }
    });
  });
});

describe("pickPort (Task 8 launcher port logic)", () => {
  it("returns the preferred port when it's free", async () => {
    // Bind an ephemeral port and immediately release it, so `freePort` is a
    // real port number known to be unused an instant before pickPort tries it.
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, () => resolve()));
    const freePort = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const port = await pickPort(freePort);
    expect(port).toBe(freePort);
  });

  it("falls back to another port when a dummy server already holds the preferred one", async () => {
    const holder = net.createServer();
    await new Promise<void>((resolve) => holder.listen(0, () => resolve()));
    const heldPort = (holder.address() as net.AddressInfo).port;
    try {
      const port = await pickPort(heldPort);
      expect(port).not.toBe(heldPort);
      expect(port).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    }
  });
});

describe("isDirectEntry (Task 8 launcher/server entrypoint guard)", () => {
  it("matches when argv1 is the same path as the module URL", () => {
    const p = "/home/user/project/demo/launcher.mjs";
    expect(isDirectEntry(pathToFileURL(p).href, p)).toBe(true);
  });

  it("matches a POSIX path containing spaces (regression case)", () => {
    // The old `import.meta.url === \`file://${argv1}\`` string-concat guard
    // never matched here, since spaces percent-encode (%20) in a file URL
    // but not in the raw argv1 string -- so `node "demo/launcher.mjs"` run
    // from a space-containing directory would silently no-op as an
    // entrypoint.
    const p = "/home/user/has space/project/demo/server.mjs";
    expect(isDirectEntry(pathToFileURL(p).href, p)).toBe(true);
    // Demonstrates the old idiom's failure mode directly, for contrast.
    expect(`file://${p}`).not.toBe(pathToFileURL(p).href);
  });

  it("does not match a different path", () => {
    const p = "/home/user/project/demo/launcher.mjs";
    const other = "/home/user/project/demo/server.mjs";
    expect(isDirectEntry(pathToFileURL(p).href, other)).toBe(false);
  });

  it("returns false (not throw) when argv1 is undefined, e.g. a REPL", () => {
    const p = "/home/user/project/demo/launcher.mjs";
    expect(isDirectEntry(pathToFileURL(p).href, undefined)).toBe(false);
  });

  // No win32 drive-letter/backslash case here: `pathToFileURL` dispatches on
  // `process.platform` internally, so a test run on this (POSIX) machine
  // cannot exercise its win32 code path -- see this repo's fix report for
  // the manually-unverifiable-on-this-machine note.
});

// bootStub (Task 8 launcher, robustness pass): covers the port-fallback +
// readiness wiring end to end -- a REAL `node demo/server.mjs` subprocess is
// spawned each time (not startServer() in-process like the rest of this
// file), since the whole point is to exercise bootStub's own spawn/race
// logic, not just the stub server it boots. Deliberately stops short of also
// booting `next dev` (main()'s other half): a full `npm run demo` process
// tree is heavy and prone to CI flakiness (a real Next dev-server cold
// start), and bootStub already isolates the launcher-owned logic (port pick,
// spawn, readiness race) from that half -- see this repo's fix report for
// this documented boundary.
describe("bootStub (Task 8 launcher: readiness/fallback/error wiring)", () => {
  it(
    "falls back to a different port when the preferred one is already held, and the resolved stub is really reachable there",
    async () => {
      const holder = net.createServer();
      await new Promise<void>((resolve) => holder.listen(0, () => resolve()));
      const heldPort = (holder.address() as net.AddressInfo).port;
      let result: Awaited<ReturnType<typeof bootStub>> | undefined;
      try {
        result = await bootStub({ preferredPort: heldPort });
        expect(result.port).not.toBe(heldPort);
        expect(result.port).toBeGreaterThan(0);
        // Not just pickPort's in-isolation port math -- the actual spawned
        // stub process answers its health-probe target on that port.
        const res = await fetch(`${result.backendUrl}/docs`);
        expect(res.status).toBe(200);
      } finally {
        result?.child.kill();
        await new Promise<void>((resolve) => holder.close(() => resolve()));
      }
    },
    15_000
  );

  it(
    "onSpawn fires with a live, killable child BEFORE the readiness wait resolves (registration-before-wait -- fix report follow-up)",
    async () => {
      // Regression this pins: an earlier bootStub only returned the child
      // reference at the very end (after the readiness race resolved), so
      // main() only pushed it into its own teardown registry post-ready --
      // a SIGINT/SIGTERM arriving DURING the (up to 10s) readiness wait ran
      // teardown over an empty registry and orphaned the detached stub.
      // onSpawn must fire synchronously right after spawn, with no `await`
      // in between, so main() can register the child before that window
      // opens. This test proves the OBSERVABLE contract onSpawn gives
      // main(): a live, kill-able child handle available strictly BEFORE
      // bootStub's own promise settles -- not just "eventually called".
      let capturedChild: Awaited<ReturnType<typeof bootStub>>["child"] | undefined;
      const bootPromise = bootStub({
        preferredPort: 0,
        onSpawn: (child) => {
          capturedChild = child;
        },
      });

      // Poll (well under the 10s readiness deadline) until onSpawn has
      // fired. If this resolves at all, onSpawn ran BEFORE bootPromise
      // settled -- we're racing a captured-variable check against the very
      // promise onSpawn must precede.
      const start = Date.now();
      while (!capturedChild && Date.now() - start < 5_000) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(capturedChild).toBeDefined();
      expect(capturedChild!.pid).toBeGreaterThan(0);
      // A real, currently-live process at this moment (not a stale/dead
      // reference) -- simulates exactly what main()'s teardown() would
      // check/kill if a signal landed here, mid-wait.
      expect(capturedChild!.exitCode).toBeNull();
      expect(capturedChild!.killed).toBe(false);

      // Killing it here (while bootPromise is still pending) proves it's
      // the actual live subprocess under bootStub's control, not a copy --
      // bootStub's own raceStartup detects the exit and rejects the SAME
      // way the "stub exits during the poll" test above already covers.
      capturedChild!.kill();
      await expect(bootPromise).rejects.toThrow(/exited before becoming ready/);
    },
    15_000
  );

  it(
    "fails fast (well under the 10s readiness deadline) when the stub process exits during the poll",
    async () => {
      // FIXTURES pointed at a nonexistent directory makes loadFixtures throw
      // synchronously inside server.mjs's (non-async) startServer(), which
      // is uncaught at that standalone-entrypoint call site -- Node prints a
      // stack trace and exits 1 before ever binding a port, i.e. exactly the
      // "exits before becoming ready" case this test targets.
      const originalFixtures = process.env.FIXTURES;
      process.env.FIXTURES = "/definitely/does/not/exist/for/this/test";
      try {
        const probe = net.createServer();
        await new Promise<void>((resolve) => probe.listen(0, () => resolve()));
        const freePort = (probe.address() as net.AddressInfo).port;
        await new Promise<void>((resolve) => probe.close(() => resolve()));

        const start = Date.now();
        await expect(bootStub({ preferredPort: freePort })).rejects.toThrow(/exited before becoming ready/);
        const elapsedMs = Date.now() - start;
        expect(elapsedMs).toBeLessThan(5_000); // real deadline is 10s -- this must not run it out
      } finally {
        if (originalFixtures === undefined) delete process.env.FIXTURES;
        else process.env.FIXTURES = originalFixtures;
      }
    },
    15_000
  );

  // NOT covered here (documented boundary -- see this repo's fix report):
  // the spawn-'error' branch of raceStartup/main()'s persistent "error"
  // listeners (item 2, spawn failure e.g. ENOENT on the executable itself).
  // bootStub always spawns `process.execPath` (a real, always-valid path),
  // so there's no parameter to inject a genuinely-unspawnable executable
  // through the public bootStub/main() API without adding a test-only
  // override that doesn't otherwise belong on that surface. Verified instead
  // by code review (raceStartup's `stub.once("error", onError)` and main()'s
  // `stub.on("error", ...)` / `next.on("error", ...)` are symmetric with the
  // already-tested "exit" handling) and by the functional `npm run demo`
  // sanity check.
});

describe("bootStub's stub-spawn path is cwd-independent (Task T2A)", () => {
  it(
    "bootStub still finds and boots demo/server.mjs when invoked from a subprocess whose cwd is nowhere near this repo",
    () => {
      const demoDir = path.dirname(fileURLToPath(import.meta.url)); // this test file also lives in demo/
      const launcherUrl = pathToFileURL(path.join(demoDir, "launcher.mjs")).href;
      // Runs bootStub itself, from a REAL subprocess whose cwd is os.tmpdir()
      // (guaranteed to hold no demo/server.mjs) -- a regression to the old
      // `spawn(process.execPath, ["demo/server.mjs"], ...)` relative-path
      // form would make the inner spawn ENOENT here (raceStartup's onError
      // branch), throwing before the fetch below ever runs, which surfaces
      // as this whole execFileSync call throwing (non-zero exit).
      // The subprocess's stdout also carries the grandchild stub's own
      // "[demo-server] listening on ..." line (bootStub spawns it with
      // `stdio: "inherit"`, by design -- so a real `npm run demo` still
      // shows the stub's own logging) -- a distinct marker line, matched by
      // regex, avoids depending on exact interleaving/ordering of that
      // inherited output.
      const script = [
        `import { bootStub } from ${JSON.stringify(launcherUrl)};`,
        "const result = await bootStub({ preferredPort: 0 });",
        "const res = await fetch(`${result.backendUrl}/docs`);",
        "console.log(`RESULT_STATUS:${res.status}`);",
        "result.child.kill();",
      ].join("\n");

      const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
        cwd: os.tmpdir(),
        encoding: "utf8",
        timeout: 15_000,
      });
      expect(out).toMatch(/RESULT_STATUS:200/);
    },
    20_000
  );
});

describe("isEnvFlagOn (env-flag parsing: DEMO_ROLE_TOOLING / NEXT_PUBLIC_DEMO_ROLE_TOOLING accept \"1\" or \"true\")", () => {
  it('true for "1"', () => {
    expect(isEnvFlagOn("1")).toBe(true);
  });

  it('true for "true"', () => {
    expect(isEnvFlagOn("true")).toBe(true);
  });

  it('false for "0", "false", "yes", and empty string', () => {
    expect(isEnvFlagOn("0")).toBe(false);
    expect(isEnvFlagOn("false")).toBe(false);
    expect(isEnvFlagOn("yes")).toBe(false);
    expect(isEnvFlagOn("")).toBe(false);
  });

  it("false for undefined (unset)", () => {
    expect(isEnvFlagOn(undefined)).toBe(false);
  });
});

describe("pipeline routes (flow contract, computed from the recorded pages)", () => {
  type Outcomes = { before_gate: number; rule_filter: number; gate: number; processed: number; pending: number };
  type Bucket = { start: string; label_key: string; total: number; archived: number; outcomes: Outcomes; reached_gate: number; categories: Record<string, number> };
  type Cnt = { count: number };
  const sum = (xs: Cnt[]) => xs.reduce((n, x) => n + x.count, 0);
  const NOW_EOD = new Date("2026-10-01T23:59:59Z"); // every fixture visit today is <= now
  // Boots with the clock at `boot` (fixtures shift to that day), then lets a
  // test move the clock via setClock() without re-shifting the data.
  const withNow = <T,>(boot: Date, fn: (get: (p: string) => Promise<Response>, setClock: (d: Date) => void) => Promise<T>) => {
    let clock = boot;
    return withServer((base) => fn((p) => fetch(`${base}${p}`), (d) => { clock = d; }), { now: () => clock });
  };
  const jget = async (g: (p: string) => Promise<Response>, p: string) => (await g(p)).json();

  it("summary (all): flow reconciles, every outcome present, ordered details, configs replayed", async () => {
    await withNow(NOW_EOD, async (g) => {
      const s = await jget(g, "/api/pipeline/summary?range=all&tz=UTC");
      expect(s.range).toBe("all");
      expect(s.status_counts).toEqual({ archived: 109, active: 158, pending: 4 });
      expect(s.total_pages).toBe(271);
      expect(s.archive_ratio).toBeCloseTo(109 / 271);
      expect(Object.keys(s).sort()).toEqual(["archive_ratio", "flow", "range", "rule_filter_config", "skip_gate_config", "status_counts", "total_pages"]);
      const f = s.flow;
      expect(f.total).toBe(271);
      expect(f.outcomes.map((o: { key: string }) => o.key)).toEqual(["before_gate", "rule_filter", "gate", "processed", "pending"]);
      expect(f.outcomes.map((o: { label: string }) => o.label)).toEqual(["Archived before gate", "Rule filter \u00b7 no LLM", "Skipped by LLM gate", "Processed \u00b7 kept", "Pending"]);
      expect(f.outcomes.every((o: Cnt) => o.count > 0)).toBe(true);
      expect(f.outcomes.find((o: { key: string }) => o.key === "pending").count).toBe(4);
      expect(f.fates.map((x: { key: string }) => x.key)).toEqual(["archived", "active", "pending"]);
      expect(f.fates.map((x: Cnt) => x.count)).toEqual([109, 158, 4]);
      // Totals reconcile: outcomes = total = fates; per outcome details; per detail fates.
      expect(sum(f.outcomes)).toBe(f.total);
      expect(sum(f.fates)).toBe(f.total);
      for (const o of f.outcomes) {
        const ds = f.details.filter((d: { outcome: string }) => d.outcome === o.key);
        expect(sum(ds)).toBe(o.count);
        expect(o.top_domains.length).toBeLessThanOrEqual(3);
      }
      for (const d of f.details) {
        expect(d.count).toBeGreaterThan(0);
        expect(Object.values(d.fates).reduce((n: number, v) => n + (v as number), 0)).toBe(d.count);
        expect(Object.keys(d.fates)).toEqual(["archived", "active", "pending"]);
        expect(d.top_domains.length).toBeLessThanOrEqual(3);
        const keys = d.top_domains.map((x: { domain: string; count: number }) => [-x.count, x.domain]);
        expect(keys).toEqual([...keys].sort((x: [number, string], y: [number, string]) => x[0] - y[0] || (x[1] < y[1] ? -1 : 1)));
      }
      const det = (o: string) => f.details.filter((d: { outcome: string }) => d.outcome === o).map((d: { key: string }) => d.key);
      expect(det("rule_filter")).toEqual(["domain", "url_pattern"]);
      expect(det("before_gate")).toEqual(["placeholder", "manual", "chrome", "duplicate", "other"]);
      expect(det("processed")).toEqual(["later_manual", "later_duplicate", "active"]);
      expect(det("pending")).toEqual(["waiting"]);
      expect(f.details.find((d: { key: string }) => d.key === "url_pattern").label).toBe("URL pattern rule");
      // gate details: count desc, uncategorized (if any) last, labelled from the skip categories.
      const gate = f.details.filter((d: { outcome: string }) => d.outcome === "gate");
      expect(gate.map((d: Cnt) => d.count)).toEqual([...gate.map((d: Cnt) => d.count)].sort((x: number, y: number) => y - x));
      expect(gate.find((d: { key: string }) => d.key === "login_wall").label).toBe("Login Wall");
      expect(gate.every((d: { key: string }) => d.key !== "uncategorized")).toBe(true);
      // demo visitors are non-admin: counts only, lists redacted.
      expect(s.rule_filter_config.lists_visible).toBe(false);
      expect(s.rule_filter_config.counts.url_patterns).toBeGreaterThan(0);
      expect(s.rule_filter_config.counts.domains).toBeGreaterThan(0);
      expect(s.rule_filter_config.counts.path_rules).toBe(4);
      for (const k of ["domains", "domain_suffixes", "url_patterns", "path_rules"]) expect(s.rule_filter_config[k]).toEqual([]);
      expect(s.skip_gate_config.categories).toHaveLength(13);
      expect(s.skip_gate_config.tools.length).toBeGreaterThan(0);
    });
  });

  it("summary 7d is a strict window of all, and an unknown range falls back to all", async () => {
    await withNow(NOW_EOD, async (g) => {
      const all = await jget(g, "/api/pipeline/summary");
      const w = await jget(g, "/api/pipeline/summary?range=7d");
      expect(w.range).toBe("7d");
      expect(w.total_pages).toBeGreaterThan(0);
      expect(w.total_pages).toBeLessThan(all.total_pages);
      expect((await jget(g, "/api/pipeline/summary?range=bogus")).range).toBe("all");
    });
  });

  it("empty period: zeros everywhere, ratio 0 (not NaN), zero-filled 6h buckets", async () => {
    await withNow(NOW_EOD, async (g, setClock) => {
      setClock(new Date("2027-06-01T12:00:00Z")); // a quiet stretch: every visit is >90 days old
      const s = await jget(g, "/api/pipeline/summary?range=7d");
      expect(s.status_counts).toEqual({ active: 0, pending: 0, archived: 0 });
      expect(s.total_pages).toBe(0);
      expect(s.archive_ratio).toBe(0);
      expect(s.flow.total).toBe(0);
      expect(s.flow.details).toEqual([]);
      expect(s.flow.outcomes.map((o: Cnt) => o.count)).toEqual([0, 0, 0, 0, 0]);
      expect(s.flow.fates.map((x: Cnt) => x.count)).toEqual([0, 0, 0]);
      const t = await jget(g, "/api/pipeline/timeline?range=7d&tz=UTC");
      expect(t.buckets.length).toBeGreaterThan(24);
      expect(t.buckets.every((b: Bucket) => b.total + b.archived + b.reached_gate === 0 && Object.values(b.outcomes).every((n) => n === 0) && Object.keys(b.categories).length === 0)).toBe(true);
      const p = await jget(g, "/api/pipeline/pages?range=7d");
      expect(p).toMatchObject({ rows: [], total: 0 });
    });
  });

  it("timeline 7d: 6h blocks aligned to local midnight in a non-UTC zone, offset-bearing ISO starts", async () => {
    await withNow(new Date("2026-10-01T15:00:00Z"), async (g) => {
      const t = await jget(g, "/api/pipeline/timeline?range=7d&tz=America/New_York");
      expect(t.range).toBe("7d");
      expect(t.granularity).toBe("6h");
      expect(t.buckets).toHaveLength(29); // 7 days x 4 blocks + the current one
      expect(t.buckets[0].start).toBe("2026-09-24T06:00:00-04:00");
      expect(t.buckets[28].start).toBe("2026-10-01T06:00:00-04:00");
      expect(t.buckets.every((b: Bucket) => b.label_key === "block" && /T(00|06|12|18):00:00-04:00$/.test(b.start))).toBe(true);
      // Same data: windowed pages total == sum of bucket totals; each bucket reconciles.
      const pages = await jget(g, "/api/pipeline/pages?range=7d&tz=America/New_York&limit=1");
      expect(t.buckets.reduce((n: number, b: Bucket) => n + b.total, 0)).toBe(pages.total);
      for (const b of t.buckets as Bucket[]) {
        expect(Object.keys(b.outcomes)).toEqual(["before_gate", "rule_filter", "gate", "processed", "pending"]);
        expect(Object.values(b.outcomes).reduce((n, v) => n + v, 0)).toBe(b.total);
        expect(b.archived).toBeLessThanOrEqual(b.total);
        expect(b.reached_gate).toBeLessThanOrEqual(b.total);
        expect(b.reached_gate).toBeGreaterThanOrEqual(b.outcomes.gate);
        expect(Object.values(b.categories).reduce((n, v) => n + v, 0)).toBe(b.outcomes.gate);
      }
      const ist = await jget(g, "/api/pipeline/timeline?range=7d&tz=Asia/Kolkata");
      expect(ist.buckets.every((b: Bucket) => /T(00|06|12|18):00:00\+05:30$/.test(b.start))).toBe(true);
    });
  });

  it("timeline 7d across a DST change: no duplicated or missing 6h bucket", async () => {
    await withNow(new Date("2026-11-03T15:00:00Z"), async (g) => {
      const t = await jget(g, "/api/pipeline/timeline?range=7d&tz=America/New_York");
      const starts = t.buckets.map((b: Bucket) => b.start);
      expect(new Set(starts).size).toBe(starts.length);
      expect(starts).toHaveLength(29);
      expect(starts.some((x: string) => x.endsWith("-04:00"))).toBe(true);
      expect(starts.some((x: string) => x.endsWith("-05:00"))).toBe(true);
      expect(starts.every((x: string) => /T(00|06|12|18):00:00-0[45]:00$/.test(x))).toBe(true);
    });
  });

  it("timeline 30d is daily, 90d weekly from Monday, all monthly from the first visited month", async () => {
    await withNow(NOW_EOD, async (g) => {
      const d = await jget(g, "/api/pipeline/timeline?range=30d&tz=UTC");
      expect(d.granularity).toBe("day");
      expect(d.buckets).toHaveLength(31);
      expect(d.buckets.every((b: Bucket) => b.label_key === "day" && b.start.endsWith("T00:00:00+00:00"))).toBe(true);
      const w = await jget(g, "/api/pipeline/timeline?range=90d&tz=UTC");
      expect(w.granularity).toBe("week");
      expect(w.buckets.every((b: Bucket) => b.label_key === "week" && new Date(b.start).getUTCDay() === 1)).toBe(true);
      const m = await jget(g, "/api/pipeline/timeline?range=all&tz=UTC");
      expect(m.granularity).toBe("month");
      expect(m.buckets.every((b: Bucket) => b.label_key === "month" && /-01T00:00:00\+00:00$/.test(b.start))).toBe(true);
      expect(m.buckets.reduce((n: number, b: Bucket) => n + b.total, 0)).toBe(271);
      expect(m.buckets.reduce((n: number, b: Bucket) => n + b.archived, 0)).toBe(109);
      expect(m.buckets.reduce((n: number, b: Bucket) => n + b.outcomes.rule_filter, 0)).toBe(28);
      // Gate categories count LLM-gate skips only: the 8 URL-pattern rows are rule-filter, not categories.
      const cats = m.buckets.flatMap((b: Bucket) => Object.entries(b.categories));
      expect(cats.reduce((n: number, [, c]: [string, number]) => n + c, 0)).toBe(40);
      expect(m.buckets.reduce((n: number, b: Bucket) => n + b.outcomes.gate, 0)).toBe(40);
    });
  });

  it("pages: windowed, paged, sorted, carrying the flow fields; pages cap at now", async () => {
    await withNow(new Date("2026-10-01T15:00:00Z"), async (g, setClock) => {
      setClock(new Date("2026-09-30T12:00:00Z")); // mid-day: later visits that day are after `now`
      const first = await jget(g, "/api/pipeline/pages?limit=200");
      const all = await jget(g, "/api/pipeline/pages?limit=200&range=all");
      expect(all.total).toBeLessThan(271); // later-today visits are after `now`
      expect(first.rows).toHaveLength(Math.min(200, first.total));
      expect(Object.keys(first.rows[0]).sort()).toEqual(
        ["archive_reason", "created_at", "detail", "detail_label", "domain", "fate", "id", "outcome", "processing_depth", "skip_category", "skip_reasoning", "status", "title", "visited_at"],
      );
      const OUTCOMES = ["before_gate", "rule_filter", "gate", "processed", "pending"];
      expect(first.rows.every((r: { outcome: string; detail: string; detail_label: string; fate: string }) => OUTCOMES.includes(r.outcome) && r.detail.length > 0 && r.detail_label.length > 0 && ["archived", "active", "pending"].includes(r.fate))).toBe(true);
      expect(first.rows.every((r: { visited_at: string | null }) => r.visited_at === null || Date.parse(r.visited_at) <= Date.parse("2026-09-30T12:00:00Z"))).toBe(true);
      const seven = await jget(g, "/api/pipeline/pages?range=7d&limit=200");
      expect(seven.total).toBeLessThan(first.total);
      expect(seven.rows.every((r: { visited_at: string }) => Date.parse(r.visited_at) >= Date.parse("2026-09-23T12:00:00Z"))).toBe(true);
      const byDomain = await jget(g, "/api/pipeline/pages?limit=5&sort=domain&dir=asc");
      expect(byDomain).toMatchObject({ sort: "domain", dir: "asc", limit: 5, offset: 0 });
      const domains = byDomain.rows.map((r: { domain: string }) => r.domain);
      expect(domains).toEqual([...domains].sort());
      const page2 = await jget(g, "/api/pipeline/pages?limit=5&offset=5&sort=domain&dir=asc");
      expect(page2.offset).toBe(5);
      expect((await g("/api/pipeline/pages?sort=id")).status).toBe(422);
      expect((await g("/api/pipeline/pages?dir=sideways")).status).toBe(422);
      expect((await g("/api/pipeline/pages?limit=0")).status).toBe(422);
    });
  });

  it("an invalid time zone is a 422 on every route; a valid one is accepted", async () => {
    await withNow(NOW_EOD, async (g) => {
      for (const route of ["summary", "timeline", "pages"]) {
        expect((await g(`/api/pipeline/${route}?tz=Not/AZone`)).status).toBe(422);
        expect((await g(`/api/pipeline/${route}?tz=%2B05:00`)).status).toBe(422);
        expect((await g(`/api/pipeline/${route}?tz=america/new_york`)).status).toBe(422);
        expect((await g(`/api/pipeline/${route}?tz=utc`)).status).toBe(422);
        expect((await g(`/api/pipeline/${route}?tz=Europe/Berlin`)).status).toBe(200);
      }
    });
  });

  it("the retired skip-trends and archive-health routes are gone", async () => {
    expect((await get("/api/pipeline/skip-trends")).status).toBe(404);
    expect((await get("/api/analytics/archive-health")).status).toBe(404);
  });
});

describe("overview routes (computed from the pipeline pages + seed captures)", () => {
  const NOW_EOD = new Date("2026-10-01T23:59:59Z");
  const withNow = <T,>(fn: (get: (p: string) => Promise<Response>) => Promise<T>) =>
    withServer((base) => fn((p) => fetch(`${base}${p}`)), { now: () => NOW_EOD });
  const jget = async (g: (p: string) => Promise<Response>, p: string) => (await g(p)).json();

  it("summary: pages, captures and clusters present; spend is the empty shape", async () => {
    await withNow(async (g) => {
      const s = await jget(g, "/api/overview/summary?range=all&tz=UTC");
      expect(s.pages.captured).toBeGreaterThan(0);
      expect(s.pages.all_time_captured).toBe(s.pages.captured);
      expect(s.captures.total).toBeGreaterThan(0);
      expect(s.spend).toEqual({ usd: 0, calls: 0, all_time_usd: 0, purposes: [] });
      expect(s.spend.calls).toBe(0);
      expect(s.clusters.clusters).toBeGreaterThan(0);
    });
  });

  it("clusters block counts the graph's superclusters and the topics fixture", async () => {
    const fx = (f: string) => JSON.parse(readFileSync(`demo/fixtures/${f}`, "utf8"));
    const sc = new Set(fx("graph.json").clusters.map((c: { super_cluster?: string }) => c.super_cluster).filter(Boolean)).size;
    await withNow(async (g) => {
      const s = await jget(g, "/api/overview/summary");
      expect(s.clusters.superclusters).toBe(sc);
      expect(s.clusters.topics).toBe(fx("topics.json").topics.length);
      expect(sc).toBeGreaterThan(0);
    });
  });

  it("captured agrees with the pipeline summary for the same range", async () => {
    await withNow(async (g) => {
      for (const range of ["7d", "30d", "90d", "all"]) {
        const o = await jget(g, `/api/overview/summary?range=${range}`);
        const p = await jget(g, `/api/pipeline/summary?range=${range}`);
        expect(o.pages.captured).toBe(p.total_pages);
        expect(o.pages.in_graph).toBe(p.status_counts.active);
      }
    });
  });

  it("timeline 30d: 31 daily buckets reconciling with the summary", async () => {
    await withNow(async (g) => {
      const t = await jget(g, "/api/overview/timeline?range=30d&tz=UTC");
      const s = await jget(g, "/api/overview/summary?range=30d&tz=UTC");
      expect(t.buckets).toHaveLength(31);
      // no NULL-visit rows fall in a windowed range
      expect(t.buckets.reduce((n: number, b: { captured: number }) => n + b.captured, 0)).toBe(s.pages.captured);
    });
  });

  it("an invalid time zone is a 422 on both routes", async () => {
    await withNow(async (g) => {
      for (const route of ["summary", "timeline"]) {
        expect((await g(`/api/overview/${route}?tz=Not/AZone`)).status).toBe(422);
        expect((await g(`/api/overview/${route}?tz=Europe/Berlin`)).status).toBe(200);
      }
    });
  });
});

describe("clusters routes (replayed from the recorded seed run)", () => {
  const NOW = new Date("2026-10-01T23:59:59Z");
  const withNow = <T,>(fn: (base: string) => Promise<T>) => withServer(fn, { now: () => NOW });
  const fx = (f: string) => JSON.parse(readFileSync(`demo/fixtures/${f}`, "utf8"));
  const jget = async (base: string, p: string) => (await fetch(`${base}${p}`)).json();

  it("summary: one run, its clusters, and superclusters from the graph fixture", async () => {
    await withNow(async (base) => {
      const s = await jget(base, "/api/clusters/summary");
      expect(s.run).not.toBeNull();
      expect(s.clusters.length).toBeGreaterThan(0);
      expect(s.runs.total).toBeGreaterThanOrEqual(1);
      const sc = new Set(fx("graph.json").clusters.map((c: { super_cluster?: string }) => c.super_cluster).filter(Boolean)).size;
      expect(s.groups.superclusters).toBe(sc);
      expect(s.pages.clustered_in_graph + s.pages.not_clustered).toBe(s.pages.in_graph);
    });
  });

  it("in your graph agrees with the pipeline stub's All-time active", async () => {
    await withNow(async (base) => {
      const s = await jget(base, "/api/clusters/summary");
      const p = await jget(base, "/api/pipeline/summary?range=all&tz=UTC");
      expect(s.pages.in_graph).toBe(p.status_counts.active);
    });
  });

  it("members for every cluster; unknown id 404s", async () => {
    await withNow(async (base) => {
      const s = await jget(base, "/api/clusters/summary");
      for (const c of s.clusters) {
        const m = await jget(base, `/api/clusters/${c.id}/pages`);
        expect(m.total).toBe(c.size);
      }
      const r = await fetch(`${base}/api/clusters/987654321/pages`);
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ detail: "cluster not found" });
    });
  });

  it("unclustered pages agree with the summary and page like the API", async () => {
    await withNow(async (base) => {
      const s = await jget(base, "/api/clusters/summary");
      const first = await jget(base, "/api/clusters/unclustered?limit=5&offset=0");
      expect(first.total).toBe(s.pages.not_clustered);
      expect(first.pages.length).toBe(Math.min(5, first.total));
      expect((await fetch(`${base}/api/clusters/unclustered?limit=0`)).status).toBe(422);
    });
  });

  it("the run completes on the shifted anchor day", async () => {
    await withNow(async (base) => {
      const s = await jget(base, "/api/clusters/summary");
      // The fixture's run sits on the anchor day; the stub shifts the anchor
      // onto the UTC date of its clock by whole days.
      const anchorMs = Date.parse(`${fx("meta.json").anchor}T00:00:00Z`);
      const nowDayMs = Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), NOW.getUTCDate());
      const shifted = new Date(anchorMs + (nowDayMs - anchorMs)).toISOString().slice(0, 10);
      expect(shifted).toBe("2026-10-01");
      expect(s.run.completed_at.slice(0, 10)).toBe(shifted);
    });
  });
});
