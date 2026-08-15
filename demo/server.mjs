#!/usr/bin/env node
// demo/server.mjs -- dependency-free node:http stub backend replaying Task
// 3's committed demo fixtures, so the Next frontend can run end-to-end
// against BACKEND_URL without a real backend. Task 4 implemented read-only
// GET endpoints; Task 5 adds the auth suite (login/logout/refresh/view-as/
// return-to-admin + role-reflecting /api/auth/me, see demo/lib/tokens.mjs).
// Later tasks append to the SAME ordered `routes` array below rather than
// building a second router: mutations (Task 6), SSE chat + preview/asset
// streaming (Task 7).
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
import { bearerFromRequest, decodeToken, mintToken } from "./lib/tokens.mjs";

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

// Reads + JSON-parses a request body. Never rejects -- an empty body or
// invalid JSON resolves to {} rather than throwing, since every route that
// calls this is a stub auth endpoint that degrades gracefully on a
// malformed request rather than 500ing (matches the "never 401 outside
// login" posture: a bad body just falls back to defaults downstream).
function readJsonBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

// ---------------------------------------------------------------------------
// Route table -- see the module-header comment for the ordering discipline.
// ---------------------------------------------------------------------------

// Refresh tokens live longer than access tokens (a stub convention -- the
// contract only requires SOME numeric exp; there is no separate "type"
// claim distinguishing access from refresh in this minting scheme).
const REFRESH_TTL_SEC = 60 * 60 * 24 * 7; // 7 days

// Task 5 accounts (task brief, verbatim): demo@demo.local/demo logs in as
// PLAIN demo (role "demo", no acting claim); admin@demo.local/admin as
// admin. Admin identity (id/email/name) is derived from the me.json fixture
// -- the single source of truth for "who the admin is" -- rather than
// hand-duplicated here.
function buildAccounts(fixtures) {
  const adminUser = { id: fixtures.me.id, email: fixtures.me.email, name: fixtures.me.name, role: "admin" };
  const demoUser = { id: 2, email: "demo@demo.local", name: "Demo User", role: "demo" };
  return {
    adminUser,
    demoUser,
    byEmail: {
      [adminUser.email]: { password: "admin", user: adminUser },
      [demoUser.email]: { password: "demo", user: demoUser },
    },
  };
}

// Reconstructs a mintToken-shaped {id, email, role} user plus the acting
// flag from a decoded token payload, falling back to the admin identity
// when the payload is missing/garbage -- "bearer parsing is decode-only;
// garbage tokens are treated as no-token (admin default), never a 401"
// applies just as much to a presented refresh_token as to an
// Authorization header.
function identityFromPayload(payload, accounts) {
  if (!payload || (payload.role !== "admin" && payload.role !== "demo")) {
    return { user: accounts.adminUser, actingAsDemo: false };
  }
  const base = payload.role === "demo" ? accounts.demoUser : accounts.adminUser;
  const user = {
    id: base.id,
    email: typeof payload.email === "string" ? payload.email : base.email,
    role: payload.role,
  };
  return { user, actingAsDemo: !!payload.acting_as_demo };
}

// /api/auth/me's demo/acting response bodies, derived from the SAME me.json
// fixture object used for the admin identity (per the brief: don't
// hand-author whole new payloads, override the identity/role fields) so
// preference/shape drift between the three identities is impossible.
function buildMeVariants(fixtures, accounts) {
  const meDemo = {
    ...fixtures.me,
    id: accounts.demoUser.id,
    email: accounts.demoUser.email,
    name: accounts.demoUser.name,
    role: "demo",
    acting_as_demo: false,
  };
  const meActing = { ...meDemo, acting_as_demo: true, admin_origin_email: accounts.adminUser.email };
  return { meDemo, meActing };
}

function buildRoutes(fixtures) {
  const accounts = buildAccounts(fixtures);
  const { meDemo, meActing } = buildMeVariants(fixtures, accounts);

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
    // app to /login). Reflects the presented bearer: no token, an
    // undecodable/garbage token, or an admin token all serve the fixture
    // identity verbatim (role admin); a plain demo-login token serves the
    // demo variant; an acting (view-as) token serves the acting variant
    // (acting_as_demo: true, admin_origin_email set).
    {
      method: "GET",
      pattern: /^\/api\/auth\/me$/,
      handler: (req, res) => {
        const payload = decodeToken(bearerFromRequest(req));
        if (!payload || payload.role !== "demo") return sendJson(res, 200, fixtures.me);
        sendJson(res, 200, payload.acting_as_demo ? meActing : meDemo);
      },
    },

    // GET /api/auth/preferences -- PATCH (mutation) is Task 6's.
    {
      method: "GET",
      pattern: /^\/api\/auth\/preferences$/,
      handler: (req, res) => sendJson(res, 200, fixtures.preferences),
    },

    // POST /api/auth/login -- {email, password} -> {access_token,
    // refresh_token, user:{id,email,name}}. Wrong creds is the ONE
    // permitted 401 in the whole stub (the login page owns rendering it as
    // "Invalid credentials.").
    {
      method: "POST",
      pattern: /^\/api\/auth\/login$/,
      handler: async (req, res) => {
        const body = await readJsonBody(req);
        const account = typeof body.email === "string" ? accounts.byEmail[body.email] : undefined;
        if (!account || account.password !== body.password) {
          return sendJson(res, 401, { detail: "invalid credentials" });
        }
        const { user } = account;
        sendJson(res, 200, {
          access_token: mintToken(user),
          refresh_token: mintToken(user, { ttlSec: REFRESH_TTL_SEC }),
          user: { id: user.id, email: user.email, name: user.name },
        });
      },
    },

    // POST /api/auth/logout -- any 2xx; failures are swallowed by the
    // frontend proxy, so there is nothing to validate here.
    {
      method: "POST",
      pattern: /^\/api\/auth\/logout$/,
      handler: async (req, res) => {
        await readJsonBody(req); // drain the body so the connection can be reused cleanly
        sendJson(res, 200, { ok: true });
      },
    },

    // POST /api/auth/refresh -- {refresh_token} -> {access_token,
    // refresh_token, token_type} (rotates BOTH). The presented refresh_token
    // is decode-only (never verified) to recover which identity to reissue
    // for -- garbage/missing falls back to the admin identity, same
    // never-401 posture as everywhere else outside login.
    {
      method: "POST",
      pattern: /^\/api\/auth\/refresh$/,
      handler: async (req, res) => {
        const body = await readJsonBody(req);
        const { user, actingAsDemo } = identityFromPayload(decodeToken(body.refresh_token), accounts);
        sendJson(res, 200, {
          access_token: mintToken(user, { actingAsDemo }),
          refresh_token: mintToken(user, { actingAsDemo, ttlSec: REFRESH_TTL_SEC }),
          token_type: "bearer",
        });
      },
    },

    // POST /api/auth/view-as -- Bearer (if present) + {profile:"demo"} ->
    // {access_token, token_type, user} with NO refresh_token key
    // (deliberately -- rotating a refresh token for an acting session would
    // let it outlive the demo view past its own TTL; the frontend leaves
    // the admin's existing refresh_token cookie untouched instead).
    {
      method: "POST",
      pattern: /^\/api\/auth\/view-as$/,
      handler: async (req, res) => {
        await readJsonBody(req); // drain; only shape supported is {profile:"demo"}
        sendJson(res, 200, {
          access_token: mintToken(accounts.demoUser, { actingAsDemo: true }),
          token_type: "bearer",
          user: { id: accounts.demoUser.id, email: accounts.demoUser.email, name: accounts.demoUser.name },
        });
      },
    },

    // POST /api/auth/return-to-admin -- Bearer (acting token), no body ->
    // same no-refresh-token shape as view-as, admin token restored.
    {
      method: "POST",
      pattern: /^\/api\/auth\/return-to-admin$/,
      handler: (req, res) => {
        sendJson(res, 200, {
          access_token: mintToken(accounts.adminUser),
          token_type: "bearer",
          user: { id: accounts.adminUser.id, email: accounts.adminUser.email, name: accounts.adminUser.name },
        });
      },
    },
  ];
}

// Exported for Task 6's write gate: plain demo = bearer decodes to role
// "demo" WITHOUT acting_as_demo (an acting admin gets full write access,
// same as a real admin). No token, an admin token, or an undecodable token
// all fall through to `false` (admin default), matching the never-401
// posture -- isPlainDemo never throws.
export function isPlainDemo(req) {
  const payload = decodeToken(bearerFromRequest(req));
  return !!payload && payload.role === "demo" && !payload.acting_as_demo;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export function startServer({ port = 0, fixturesDir = "demo/fixtures" } = {}) {
  const resolvedFixturesDir = path.resolve(process.cwd(), fixturesDir);
  const fixtures = loadFixtures(resolvedFixturesDir);
  const routes = buildRoutes(fixtures);

  const onHandlerError = (req, res, url, err) => {
    console.error(`[demo-server] handler error for ${req.method} ${url.pathname}:`, err);
    if (!res.headersSent) sendJson(res, 500, { detail: "internal error" });
    else res.end();
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    for (const route of routes) {
      if (route.method !== req.method) continue;
      const m = route.pattern.exec(url.pathname);
      if (!m) continue;
      try {
        // Auth handlers (login/logout/refresh/view-as) read the request
        // body and are async; read-only handlers stay synchronous. Await
        // whichever shape comes back so a rejected promise is caught the
        // same way a thrown error is.
        const result = route.handler(req, res, m, url);
        if (result && typeof result.catch === "function") {
          result.catch((err) => onHandlerError(req, res, url, err));
        }
      } catch (err) {
        onHandlerError(req, res, url, err);
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
