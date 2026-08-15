#!/usr/bin/env node
// demo/server.mjs -- dependency-free node:http stub backend replaying Task
// 3's committed demo fixtures, so the Next frontend can run end-to-end
// against BACKEND_URL without a real backend. Task 4 implements read-only
// GET endpoints only; later tasks append to the SAME ordered `routes` array
// below rather than building a second router: auth (Task 5), mutations
// (Task 6), SSE chat + preview/asset streaming (Task 7).
//
// Route-table discipline (read before adding a route): entries are checked
// in array order, first match wins. Static/exact-path routes are listed
// before parameterized (regex-capturing) ones for the same path prefix --
// e.g. `/api/topics/exclusions` sits above `/api/topics/{keyword}/members`
// so a literal "exclusions" path can never be mistaken for a topic keyword
// by a looser pattern (the routing trap documented in endpoints.md). Keep
// that ordering invariant when appending new routes.

import http from "node:http";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeDeltaDays, shiftDiaryWindow, shiftIsoDateTime } from "./lib/dates.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Fixture loading -- once at boot. JSON fixtures load fully into memory
// (this dataset is small: 157 nodes, ~3.5k files, well under what's sane to
// hold resident). Large/binary families (previews, assets) are Task 7's --
// left as on-disk paths here rather than JSON, so streaming them later
// doesn't require reshaping this loader.
// ---------------------------------------------------------------------------

function loadFixtures(fixturesDir) {
  const readJson = (relPath) => JSON.parse(readFileSync(path.join(fixturesDir, relPath), "utf8"));

  const meta = readJson("meta.json");
  const deltaDays = computeDeltaDays(meta.anchor);

  const shiftGraphPayload = (payload) => ({
    ...payload,
    nodes: payload.nodes.map((n) => ({ ...n, first_visited_at: shiftIsoDateTime(n.first_visited_at, deltaDays) })),
  });
  const shiftWindows = (windows, granularity) => windows.map((w) => shiftDiaryWindow(w, granularity, deltaDays));
  const shiftFilteredMap = (map, granularity) => {
    const out = {};
    for (const [nodeId, windows] of Object.entries(map)) out[nodeId] = shiftWindows(windows, granularity);
    return out;
  };

  // /api/graph[?window=7|30|90|365]; no/unrecognized window -> "all" (graph.json).
  const graph = {
    all: shiftGraphPayload(readJson("graph.json")),
    7: shiftGraphPayload(readJson("graph-window-7.json")),
    30: shiftGraphPayload(readJson("graph-window-30.json")),
    90: shiftGraphPayload(readJson("graph-window-90.json")),
    365: shiftGraphPayload(readJson("graph-window-365.json")),
  };

  // nodes/<encodeURIComponent(id)>.json -> keyed here by the DECODED node id
  // read from each file's own `node.id` (not re-derived from the filename),
  // so lookup at request time is a plain decodeURIComponent + Map.get.
  const nodesDir = path.join(fixturesDir, "nodes");
  const nodeDetailById = new Map();
  const shiftGraphNode = (n) => ({ ...n, first_visited_at: shiftIsoDateTime(n.first_visited_at, deltaDays) });
  for (const file of readdirSync(nodesDir)) {
    if (!file.endsWith(".json")) continue;
    const detail = JSON.parse(readFileSync(path.join(nodesDir, file), "utf8"));
    nodeDetailById.set(detail.node.id, {
      node: shiftGraphNode(detail.node),
      subtree: detail.subtree.map(shiftGraphNode),
    });
  }

  // diary-{day,week,month}.json -- bare arrays (unfiltered).
  const diary = {
    day: shiftWindows(readJson("diary-day.json"), "day"),
    week: shiftWindows(readJson("diary-week.json"), "week"),
    month: shiftWindows(readJson("diary-month.json"), "month"),
  };
  // diary-filtered-{day,week,month}.json -- maps keyed by DECODED graph node
  // id (Task 3's documented on-disk key format; not filenames/URLs).
  const diaryFiltered = {
    day: shiftFilteredMap(readJson("diary-filtered-day.json"), "day"),
    week: shiftFilteredMap(readJson("diary-filtered-week.json"), "week"),
    month: shiftFilteredMap(readJson("diary-filtered-month.json"), "month"),
  };

  // pages/index.json: url -> {sha1, pid, status: "ok"|"absent"}. Content
  // files (pages/<sha1>.json) are NOT date-shifted -- page extract text
  // keeps its real dates (brief: do not blind-regex content text); loaded
  // lazily per-request off pagesDir rather than eagerly, since most of the
  // 158 files are never requested in a given demo session.
  const pagesIndex = readJson("pages/index.json");
  const pagesDir = path.join(fixturesDir, "pages");

  const membersDir = path.join(fixturesDir, "members");

  return {
    meta,
    deltaDays,
    graph,
    nodeDetailById,
    diary,
    diaryFiltered,
    pagesIndex,
    pagesDir,
    membersDir,
    clusteringStatus: readJson("clustering-status.json"),
    topics: readJson("topics.json"),
    exclusions: readJson("exclusions.json"),
    internals: readJson("internals.json"),
    me: readJson("me.json"),
    preferences: readJson("preferences.json"),
  };
}

// ---------------------------------------------------------------------------
// Response helper
// ---------------------------------------------------------------------------

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(data);
}

// ---------------------------------------------------------------------------
// Route table -- see the module-header comment for the ordering discipline.
// ---------------------------------------------------------------------------

function buildRoutes(fixtures) {
  return [
    // Health-probe target (scripts/dev.sh) -- any 2xx is sufficient.
    {
      method: "GET",
      pattern: /^\/docs\/?$/,
      handler: (req, res) => {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end("demo stub server: ok");
      },
    },

    // GET /api/graph[?window=7|30|90|365]
    {
      method: "GET",
      pattern: /^\/api\/graph$/,
      handler: (req, res, m, url) => {
        const windowParam = url.searchParams.get("window");
        const key = ["7", "30", "90", "365"].includes(windowParam) ? windowParam : "all";
        sendJson(res, 200, fixtures.graph[key]);
      },
    },

    // GET /api/graph/nodes/{id} -- id arrives percent-encoded.
    {
      method: "GET",
      pattern: /^\/api\/graph\/nodes\/([^/]+)$/,
      handler: (req, res, m) => {
        const id = decodeURIComponent(m[1]);
        const detail = fixtures.nodeDetailById.get(id);
        if (!detail) return sendJson(res, 404, { detail: "node not found" });
        sendJson(res, 200, detail);
      },
    },

    // GET /api/diary/windows?granularity=day|week|month[&filter_node_id=<id>]
    {
      method: "GET",
      pattern: /^\/api\/diary\/windows$/,
      handler: (req, res, m, url) => {
        const granularity = url.searchParams.get("granularity");
        if (!["day", "week", "month"].includes(granularity)) {
          return sendJson(res, 400, { detail: "granularity must be day, week, or month" });
        }
        const filterNodeId = url.searchParams.get("filter_node_id");
        if (filterNodeId) {
          const decoded = decodeURIComponent(filterNodeId);
          const windows = fixtures.diaryFiltered[granularity][decoded] ?? [];
          return sendJson(res, 200, windows);
        }
        sendJson(res, 200, fixtures.diary[granularity]);
      },
    },

    // GET /api/pages/content?url=<encoded absolute url>
    {
      method: "GET",
      pattern: /^\/api\/pages\/content$/,
      handler: (req, res, m, url) => {
        const pageUrl = url.searchParams.get("url");
        const entry = pageUrl ? fixtures.pagesIndex[pageUrl] : undefined;
        if (!entry || entry.status !== "ok") return sendJson(res, 404, { detail: "page not found" });
        const content = JSON.parse(readFileSync(path.join(fixtures.pagesDir, `${entry.sha1}.json`), "utf8"));
        sendJson(res, 200, content);
      },
    },

    // GET /api/clustering/status
    {
      method: "GET",
      pattern: /^\/api\/clustering\/status$/,
      handler: (req, res) => sendJson(res, 200, fixtures.clusteringStatus),
    },

    // GET /api/topics
    {
      method: "GET",
      pattern: /^\/api\/topics$/,
      handler: (req, res) => sendJson(res, 200, fixtures.topics),
    },

    // GET /api/topics/exclusions -- MUST precede the /{keyword}/... pattern
    // below (routing trap; see module-header comment).
    {
      method: "GET",
      pattern: /^\/api\/topics\/exclusions$/,
      handler: (req, res) => sendJson(res, 200, fixtures.exclusions),
    },

    // GET /api/topics/{keyword}/members[?limit=5|50] -- files on disk are
    // percent-encoded keyword names: members/<encodeURIComponent(keyword)>-<limit>.json.
    {
      method: "GET",
      pattern: /^\/api\/topics\/([^/]+)\/members$/,
      handler: (req, res, m, url) => {
        const keyword = decodeURIComponent(m[1]);
        const limit = url.searchParams.get("limit") === "5" ? 5 : 50;
        const file = path.join(fixtures.membersDir, `${encodeURIComponent(keyword)}-${limit}.json`);
        if (!existsSync(file)) return sendJson(res, 404, { detail: "unknown topic" });
        sendJson(res, 200, JSON.parse(readFileSync(file, "utf8")));
      },
    },

    // GET /api/agent/internals
    {
      method: "GET",
      pattern: /^\/api\/agent\/internals$/,
      handler: (req, res) => sendJson(res, 200, fixtures.internals),
    },

    // GET /api/auth/me -- NEVER 401s (a 401 from any endpoint bounces the
    // app to /login); the stub always serves the fixture identity, admin by
    // default, regardless of whether/what Authorization header was sent.
    // Real token validation is Task 5's.
    {
      method: "GET",
      pattern: /^\/api\/auth\/me$/,
      handler: (req, res) => sendJson(res, 200, fixtures.me),
    },

    // GET /api/auth/preferences -- PATCH (mutation) is Task 6's.
    {
      method: "GET",
      pattern: /^\/api\/auth\/preferences$/,
      handler: (req, res) => sendJson(res, 200, fixtures.preferences),
    },
  ];
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export function startServer({ port = 0, fixturesDir = "demo/fixtures" } = {}) {
  const resolvedFixturesDir = path.resolve(process.cwd(), fixturesDir);
  const fixtures = loadFixtures(resolvedFixturesDir);
  const routes = buildRoutes(fixtures);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    for (const route of routes) {
      if (route.method !== req.method) continue;
      const m = route.pattern.exec(url.pathname);
      if (!m) continue;
      try {
        route.handler(req, res, m, url);
      } catch (err) {
        console.error(`[demo-server] handler error for ${req.method} ${url.pathname}:`, err);
        if (!res.headersSent) sendJson(res, 500, { detail: "internal error" });
        else res.end();
      }
      return;
    }
    sendJson(res, 404, { detail: "not found" });
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, () => {
      const actualPort = server.address().port;
      resolve({
        port: actualPort,
        close: () => new Promise((res2) => server.close(() => res2())),
      });
    });
  });
}

// Standalone entrypoint: `node demo/server.mjs`.
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = process.env.PORT ? Number(process.env.PORT) : 8001;
  const fixturesDir = process.env.FIXTURES || "demo/fixtures";
  startServer({ port, fixturesDir })
    .then(({ port: boundPort }) => {
      console.log(`[demo-server] listening on :${boundPort} (fixtures: ${fixturesDir})`);
    })
    .catch((err) => {
      console.error("[demo-server] failed to start:", err);
      process.exit(1);
    });
}
