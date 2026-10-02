#!/usr/bin/env node
// demo/server.mjs -- dependency-free node:http stub backend replaying the
// committed demo fixtures (demo/fixtures/*), so the Next frontend can run
// end-to-end against BACKEND_URL without a real backend. Serves read-only
// GET endpoints, the auth suite (login/logout/refresh/view-as/
// return-to-admin + role-reflecting /api/auth/me, see demo/lib/tokens.mjs),
// in-memory mutations gated behind the plain-demo write gate (topics CRUD,
// exclusions, preferences PATCH, recluster -- see createMutableState/the
// `gated` write gate below), SSE chat replay (POST /api/agent/query-stream,
// keyword-matched against demo/fixtures/chat/*.sse -- see
// parseSseFrames/pickChatEntry below), and preview/asset streaming (GET
// /api/pages/{pid}/preview, GET /captured-assets/<path>) plus gated GET
// /api/agent/internals. NOTE: /captured-assets is a TOP-LEVEL path (not
// under /api) because that's the exact URL pattern captured preview HTML
// references (see demo/tools/capture-fixtures.mjs's module header) -- the
// Next app's /api catch-all proxy does not forward it, so this is served
// through a separate route instead: app/captured-assets/[...path]/route.ts
// forwards /captured-assets/* to BACKEND_URL with an injected bearer, which
// is what actually gets previews their images/styles when driven through
// the full app. Append new routes to the SAME ordered `routes` array below
// rather than building a second router.
//
// Route-table discipline (read before adding a route): entries are checked
// in array order, first match wins. Static/exact-path routes are listed
// before parameterized (regex-capturing) ones for the same path prefix --
// e.g. `/api/topics/exclusions` sits above `/api/topics/{keyword}/members`
// (and above the generic DELETE `/api/topics/{keyword}`) so a literal
// "exclusions" path can never be mistaken for a topic keyword by a looser
// pattern (the routing trap documented in endpoints.md). Keep that ordering
// invariant when appending new routes.

import http from "node:http";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { computeDeltaDays, shiftDiaryWindow, shiftIsoDateTime } from "./lib/dates.mjs";
import { computePages, computeSummary, computeTimeline, isValidTz, PAGE_SORTS } from "./lib/pipeline.mjs";
import { bearerFromRequest, decodeToken, mintToken } from "./lib/tokens.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Fixture loading -- once at boot. JSON fixtures load fully into memory
// (this dataset is small: 157 nodes, ~3.5k files, well under what's sane to
// hold resident). Large/binary families (previews, assets) are Task 7's --
// left as on-disk paths here rather than JSON, so streaming them later
// doesn't require reshaping this loader.
// ---------------------------------------------------------------------------

function loadFixtures(fixturesDir, now = new Date()) {
  const readJson = (relPath) => JSON.parse(readFileSync(path.join(fixturesDir, relPath), "utf8"));

  const meta = readJson("meta.json");
  const deltaDays = computeDeltaDays(meta.anchor, now);

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

  // chat/index.json -> chat/<NN>.sse (Task 7). Each fixture is parsed ONCE
  // here into an ordered frame list (see parseSseFrames below) and its
  // question keyword-tokenized (see keywordSet below), so a request-time
  // match is a cheap in-memory set-intersection rather than re-reading/
  // re-parsing a file per request. Array order == chat/index.json order,
  // which the keyword matcher's tie-break ("first in index order") depends
  // on.
  const chatEntries = readJson("chat/index.json").map((entry) => ({
    question: entry.question,
    keywords: keywordSet(entry.question),
    frames: parseSseFrames(readFileSync(path.join(fixturesDir, entry.file), "utf8")),
  }));

  // previews/<pid>.html + assets/captured-assets/<hash-prefix>/<hash>.<ext>
  // (Task 7) -- left as on-disk paths per the module-header comment (large/
  // binary families are streamed per-request, not loaded eagerly).
  const previewsDir = path.join(fixturesDir, "previews");
  const capturedAssetsDir = path.join(fixturesDir, "assets", "captured-assets");

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
    chatEntries,
    previewsDir,
    capturedAssetsDir,
    clusteringStatus: readJson("clustering-status.json"),
    topics: readJson("topics.json"),
    exclusions: readJson("exclusions.json"),
    internals: readJson("internals.json"),
    me: readJson("me.json"),
    preferences: readJson("preferences.json"),
    // Pipeline dev view (v2): the recorded pages (with skip_category) are
    // shifted to "now"; summary / timeline / pages are computed from them per
    // request (demo/lib/pipeline.mjs). Only skip_gate_config is replayed from
    // the recorded summary.
    pipelineSkipGateConfig: readJson("pipeline/summary.json").skip_gate_config,
    pipelinePages: readJson("pipeline/pages.json").rows.map((r) => ({
      ...r,
      created_at: shiftIsoDateTime(r.created_at, deltaDays),
      visited_at: shiftIsoDateTime(r.visited_at, deltaDays),
    })),
  };
}

// ---------------------------------------------------------------------------
// Mutable state (Task 6) -- seeded fresh from the just-loaded fixtures on
// every `startServer` call (loadFixtures itself re-reads the JSON files from
// disk each call, so this is a genuine per-call reset, not a shared
// module-level singleton). Deep-cloned via per-item spreads rather than a
// shared reference into `fixtures.*`, so mutating state never corrupts the
// fixtures object other code in this module still reads.
// ---------------------------------------------------------------------------

function createMutableState(fixtures) {
  return {
    topics: fixtures.topics.topics.map((t) => ({ ...t })),
    exclusions: fixtures.exclusions.exclusions.map((e) => ({ ...e })),
    preferences: { ...fixtures.preferences },
    clusteringStatus: { ...fixtures.clusteringStatus },
  };
}

// ---------------------------------------------------------------------------
// SSE chat replay (Task 7) -- fixture parsing + keyword matching.
// ---------------------------------------------------------------------------

// Recorded fixtures are raw byte streams (`data: {json}\n\n` per frame, as
// actually captured off the real agent -- see demo/fixtures/chat/*.sse).
// Parses into an ordered array of the ALREADY-DECODED frame objects rather
// than re-splitting on blank lines: any line that isn't a `data: ` line
// (blank separators, stray whitespace) is simply not a match and is
// skipped, so this is agnostic to single- vs double-newline framing and to
// a trailing newline (or lack of one) at EOF.
function parseSseFrames(raw) {
  const frames = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trimEnd();
    if (!trimmed.startsWith("data:")) continue;
    const jsonText = trimmed.slice("data:".length).trim();
    if (!jsonText) continue;
    frames.push(JSON.parse(jsonText));
  }
  return frames;
}

// Compact standard English stopword list (function words only -- articles,
// auxiliaries, pronouns, prepositions, conjunctions -- plus common
// contraction remnants left over after splitting on non-alphanumerics, e.g.
// "doesn't" -> "doesn"/"t"). Deliberately does NOT stem/lemmatize (brief:
// "lowercase + stopword-strip" only) -- "cephalopod" and "cephalopods" are
// distinct tokens, matching the documented contract.
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "being", "but", "by",
  "can", "could", "did", "do", "does", "doesn", "doing", "don", "down", "during",
  "each", "few", "for", "from", "further",
  "had", "has", "have", "having", "he", "her", "here", "hers", "herself", "him", "himself", "his", "how",
  "i", "if", "in", "into", "is", "isn", "it", "its", "itself",
  "just",
  "ll", "me", "more", "most", "my", "myself",
  "no", "nor", "not", "now",
  "of", "off", "on", "once", "only", "or", "other", "our", "ours", "ourselves", "out", "over", "own",
  "re", "same", "she", "should", "so", "some", "such",
  "than", "that", "the", "their", "theirs", "them", "themselves", "then", "there", "these", "they", "this", "those", "through", "to", "too",
  "under", "until", "up",
  "ve", "very",
  "was", "we", "were", "what", "when", "where", "which", "while", "who", "whom", "why", "will", "with", "won", "would",
  "you", "your", "yours", "yourself", "yourselves",
]);

// Lowercase, split on runs of non-alphanumerics (so hyphens/punctuation/
// apostrophes all act as separators), drop stopwords and single-character
// fragments (the latter mops up contraction remnants like the "s"/"t"/"d"
// left behind by STOPWORDS' 2+ char entries above).
function keywordSet(text) {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 1 && !STOPWORDS.has(word))
  );
}

// Picks the recorded chat entry whose question shares the most keywords
// with the query. Strict `>` (not `>=`) when updating `best` means the
// FIRST entry reaching a given overlap count wins any tie, matching the
// contract ("ties -> first in index order") since chatEntries is iterated
// in chat/index.json order. Returns null (caller falls back to the
// built-in demo-mode stream) when nothing clears the 2-keyword threshold --
// including when the query itself has no keywords left after stripping.
function pickChatEntry(query, chatEntries) {
  const queryKeywords = keywordSet(query);
  let best = null;
  let bestOverlap = -1;
  for (const entry of chatEntries) {
    let overlap = 0;
    for (const keyword of entry.keywords) {
      if (queryKeywords.has(keyword)) overlap += 1;
    }
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = entry;
    }
  }
  return bestOverlap >= 2 ? best : null;
}

// Built-in fallback stream (authored inline, not read from a fixture) for
// queries that don't clear the keyword-overlap threshold against any
// recorded question. Shaped exactly like a parsed .sse fixture (status ->
// tokens -> complete) so the SAME re-emit/pacing code in the route handler
// below serves it with no special-casing.
function buildFallbackFrames(chatEntries) {
  const suggestions = chatEntries.map((entry, i) => `${i + 1}. ${entry.question}`).join("\n");
  const paragraph =
    "This is a demo instance: it replays a fixed set of prerecorded questions and " +
    "answers instead of calling a live agent, so I don't have a recorded response " +
    "for that one. Here are the questions I *can* answer -- try one of these:\n\n" +
    suggestions;
  const words = paragraph.split(" ");
  return [
    { type: "status", text: "Demo mode" },
    ...words.map((word, i) => ({ type: "token", text: i === 0 ? word : ` ${word}` })),
    { type: "complete", sources: [], iterations: 1, model: "demo-stub" },
  ];
}

// ---------------------------------------------------------------------------
// Preview/asset serving (Task 7) -- shared path containment for the two
// routes that turn request input into a filesystem read: GET
// /captured-assets/<path> and GET /api/pages/{pid}/preview. Both call this
// AFTER their decodeURIComponent, which is the only ordering that works --
// a route pattern matches the still-encoded pathname and therefore cannot
// see a "/" or ".." that is hiding behind %2f/%2e.
// Mirrors demo/tools/capture-fixtures.mjs's
// resolveAssetWritePath (same double layer: reject a literal ".." path
// segment outright, THEN re-verify the resolved absolute path is still
// contained under rootDir as defense in depth -- the second check is what
// actually catches an absolute-path escape, e.g. a requested path
// containing a leading "/" that would make path.resolve ignore rootDir
// entirely and jump straight to filesystem root).
function resolveAssetPath(rootDir, relPath) {
  if (relPath.split("/").includes("..")) return null;
  const full = path.resolve(rootDir, relPath);
  const relToRoot = path.relative(rootDir, full);
  if (relToRoot.startsWith("..") || path.isAbsolute(relToRoot)) return null;
  return full;
}

// Extension -> Content-Type for archived assets. ".php" is a deliberate
// extra beyond the brief's jpg/png/svg/gif/css set: the one captured
// example (a Wikipedia load.php stylesheet bundle, referenced by ~125
// preview `<link rel="stylesheet">` tags across the fixture set) is plain
// CSS text on disk despite the extension -- mapping it keeps those previews
// actually styled. Anything else falls back to application/octet-stream.
const ASSET_CONTENT_TYPES = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".gif": "image/gif",
  ".css": "text/css; charset=utf-8",
  ".php": "text/css; charset=utf-8",
};

// Lowercase/underscore slug for a cluster name -- matches the shape
// (`cluster_slug`) the real backend derives for exclusion entries; not
// consumed by the frontend today, but keeps the stub's exclusion entries
// shaped like the real contract (endpoints.md: {keyword, cluster_slug,
// cluster_name, created_at}).
function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
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

// Thrown by readJsonBody when the request body is present but not valid
// JSON. A distinct class (rather than a plain Error) so the dispatcher below
// can tell "caller sent garbage" apart from a genuine handler bug and answer
// 400 instead of 500 -- while every other thrown/rejected error still gets
// the 500 path unchanged.
class MalformedJsonBodyError extends Error {
  constructor() {
    super("malformed JSON body");
    this.name = "MalformedJsonBodyError";
  }
}

// Reads + JSON-parses a request body. An EMPTY body still resolves to {}
// (never rejects) -- most routes that call this tolerate "no body" and fall
// back to defaults downstream, matching the never-401-outside-login posture.
// A NON-EMPTY body that fails to parse, though, rejects with
// MalformedJsonBodyError rather than silently degrading to {} -- silently
// treating "the caller sent garbage" the same as "the caller sent nothing"
// made a malformed request indistinguishable from an honest empty one (e.g.
// POST /api/auth/login with unparseable JSON used to fall through to the
// SAME 401 an honest wrong-password attempt gets, which is misleading: it
// isn't wrong credentials, the request itself never parsed). The dispatcher
// below (onHandlerError) turns this rejection into 400, never 401/500.
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new MalformedJsonBodyError());
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
//
// Role-tooling opt-in (out-of-the-box hiding, see startServer's
// `roleToolingEnabled` doc comment): when disabled, the demo account is
// simply omitted from `byEmail` -- POST /api/auth/login for
// demo@demo.local then falls through the SAME "account not found" branch
// unknown-email already takes, landing on the ONE permitted 401 rather than
// a bespoke rejection path. `demoUser` itself is still built either way
// (cheap, and buildMeVariants/view-as's minting need the shape); it just
// never becomes reachable through login when disabled.
function buildAccounts(fixtures, roleToolingEnabled) {
  const adminUser = { id: fixtures.me.id, email: fixtures.me.email, name: fixtures.me.name, role: "admin" };
  const demoUser = { id: 2, email: "demo@demo.local", name: "Demo User", role: "demo" };
  const byEmail = { [adminUser.email]: { password: "admin", user: adminUser } };
  if (roleToolingEnabled) {
    byEmail[demoUser.email] = { password: "demo", user: demoUser };
  }
  return { adminUser, demoUser, byEmail };
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

function buildRoutes(fixtures, state, { reclusterDelayMs, chatTokenDelayMs, roleToolingEnabled, getNow }) {
  const accounts = buildAccounts(fixtures, roleToolingEnabled);
  const { meDemo, meActing } = buildMeVariants(fixtures, accounts);

  // Task 6 write gate: every mutation handler gets wrapped with this so the
  // 403-for-plain-demo check is applied uniformly and can't be forgotten on
  // a newly-added route. isPlainDemo (Task 5) never throws, so this never
  // needs its own try/catch. Task 7 reuses it for GET /api/agent/internals
  // too -- despite the name, `gated` is really "isPlainDemo -> 403, else
  // run the handler," which is exactly the role gate the real backend
  // applies to internals (a READ, not a mutation) as well: plain demo gets
  // 403, an acting-as-demo token (isPlainDemo is false for it) and a plain
  // admin token both pass through untouched.
  const gated = (handler) => (req, res, m, url) => {
    if (isPlainDemo(req)) return sendJson(res, 403, { detail: "forbidden" });
    return handler(req, res, m, url);
  };

  // Task 7: fallback SSE stream, built once per buildRoutes call (cheap --
  // just string/array work over the already-parsed chatEntries).
  const fallbackFrames = buildFallbackFrames(fixtures.chatEntries);

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

    // GET /api/pages/{pid}/preview -- pid is a page_content.id (endpoints.md),
    // NOT a pages.id; archived HTML files are named previews/<pid>.html.
    // The route pattern is NOT a containment guard: dispatch matches against
    // url.pathname, which keeps %2f encoded, so `[^/]+` happily captures a
    // segment whose decoded form carries real "/" and ".." parts. Containment
    // therefore has to be checked AFTER the decode, via the same
    // resolveAssetPath helper the asset route below uses.
    {
      method: "GET",
      pattern: /^\/api\/pages\/([^/]+)\/preview$/,
      handler: (req, res, m) => {
        const pid = decodeURIComponent(m[1]);
        const file = resolveAssetPath(fixtures.previewsDir, `${pid}.html`);
        if (!file || !existsSync(file)) return sendJson(res, 404, { detail: "preview not found" });
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(readFileSync(file));
      },
    },

    // GET /captured-assets/<path> -- TOP-LEVEL path (not under /api); see
    // the module-header note on why. `<path>` is untrusted input lifted
    // straight out of archived third-party HTML (module header, and
    // demo/tools/capture-fixtures.mjs's matching write-side comment) --
    // resolveAssetPath rejects any ".." segment and re-verifies containment
    // on the resolved absolute path before it ever reaches readFileSync.
    {
      method: "GET",
      pattern: /^\/captured-assets\/(.+)$/,
      handler: (req, res, m) => {
        const requested = decodeURIComponent(m[1]);
        const full = resolveAssetPath(fixtures.capturedAssetsDir, requested);
        if (!full || !existsSync(full)) return sendJson(res, 404, { detail: "asset not found" });
        const contentType = ASSET_CONTENT_TYPES[path.extname(full).toLowerCase()] ?? "application/octet-stream";
        res.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
        res.end(readFileSync(full));
      },
    },

    // POST /api/agent/query-stream {query} -> text/event-stream. Picks the
    // recorded chat entry whose question shares the most keywords with the
    // query (pickChatEntry; below the 2-keyword threshold -> the built-in
    // fallback stream), then re-emits its ALREADY-PARSED frames verbatim as
    // `data: {json}\n\n`, pacing token events chatTokenDelayMs apart
    // (status/complete get no artificial delay). Re-serializing parsed JSON
    // objects (rather than replaying raw fixture bytes) never drops/
    // reorders fields -- JSON.parse/JSON.stringify round-trips every key a
    // recorded `complete` frame carries (sources, sources_detail, images,
    // cluster_ids, iterations, model, and any future field) untouched.
    {
      method: "POST",
      pattern: /^\/api\/agent\/query-stream$/,
      handler: async (req, res) => {
        const body = await readJsonBody(req);
        const query = typeof body.query === "string" ? body.query : "";
        const entry = pickChatEntry(query, fixtures.chatEntries);
        const frames = entry ? entry.frames : fallbackFrames;

        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        res.socket?.setNoDelay?.(true);

        let index = 0;
        let timer = null;
        let stopped = false;
        // Client abort (req 'aborted', or the underlying connection closing
        // for any reason before we're done -- res 'close') must stop the
        // timer chain immediately: no further writes, no leaked timer. A
        // listener on res 'error' keeps a write racing an already-closing
        // socket from surfacing as an unhandled error event.
        const stop = () => {
          if (stopped) return;
          stopped = true;
          if (timer) clearTimeout(timer);
        };
        req.on("aborted", stop);
        res.on("close", stop);
        res.on("error", stop);

        const pump = () => {
          if (stopped) return;
          if (index >= frames.length) {
            stopped = true;
            res.end();
            return;
          }
          const frame = frames[index];
          index += 1;
          const delay = frame.type === "token" ? chatTokenDelayMs : 0;
          timer = setTimeout(() => {
            if (stopped) return;
            res.write(`data: ${JSON.stringify(frame)}\n\n`);
            pump();
          }, delay);
        };
        pump();
      },
    },

    // GET /api/clustering/status
    {
      method: "GET",
      pattern: /^\/api\/clustering\/status$/,
      handler: (req, res) => sendJson(res, 200, state.clusteringStatus),
    },

    // POST /api/recluster (no body) -- ~2s delay (injectable via startServer's
    // reclusterDelayMs, default 2000; tests pass small/zero so the suite
    // doesn't pay the real delay), bumps run_number, updates the status
    // title's embedded run number, leaves every other status string as-is.
    // Response values are awaited but never rendered (endpoints.md) -- any
    // plausible numbers satisfy the contract.
    {
      method: "POST",
      pattern: /^\/api\/recluster$/,
      handler: gated(async (req, res) => {
        await new Promise((resolve) => setTimeout(resolve, reclusterDelayMs));
        state.clusteringStatus.run_number += 1;
        state.clusteringStatus.title = state.clusteringStatus.title.replace(
          /RUN #\d+/,
          `RUN #${state.clusteringStatus.run_number}`
        );
        sendJson(res, 200, {
          cluster_count: 49,
          noise_count: 9,
          naming_cost: 0.02,
          elapsed_seconds: reclusterDelayMs / 1000,
        });
      }),
    },

    // GET /api/topics -- reflects mutations (Task 6).
    {
      method: "GET",
      pattern: /^\/api\/topics$/,
      handler: (req, res) => sendJson(res, 200, { topics: state.topics }),
    },

    // POST /api/topics {keyword} -> {topic, topics} (only `topics` is
    // consumed downstream; `topic` is returned per contract regardless).
    // New topics get icon_id null and a plausible (0) cluster_count.
    //
    // Validation (400, never 401): rejects an empty/whitespace-only keyword,
    // and a keyword that already exists (case-insensitively). The frontend's
    // own add form (components/ScPopover.tsx's handleAdd) already guards
    // both cases client-side before ever calling this endpoint, so this
    // doesn't change any reachable frontend behavior -- it just stops the
    // stub from silently accepting input the real backend (and the
    // frontend's own contract) would never produce, e.g. a direct/scripted
    // POST bypassing the form.
    {
      method: "POST",
      pattern: /^\/api\/topics$/,
      handler: gated(async (req, res) => {
        const body = await readJsonBody(req);
        const keyword = typeof body.keyword === "string" ? body.keyword.trim() : "";
        if (!keyword) return sendJson(res, 400, { detail: "keyword must not be empty" });
        const isDuplicate = state.topics.some((t) => t.keyword.toLowerCase() === keyword.toLowerCase());
        if (isDuplicate) return sendJson(res, 400, { detail: "a topic with this keyword already exists" });
        const topic = { keyword, icon_id: null, cluster_count: 0 };
        state.topics.push(topic);
        sendJson(res, 200, { topic, topics: state.topics });
      }),
    },

    // GET /api/topics/exclusions -- MUST precede the /{keyword}/... pattern
    // below (routing trap; see module-header comment). Reflects mutations.
    {
      method: "GET",
      pattern: /^\/api\/topics\/exclusions$/,
      handler: (req, res) => sendJson(res, 200, { exclusions: state.exclusions }),
    },

    // POST /api/topics/exclusions {keyword, cluster_name} -> {exclusions,
    // unlabeled}. `unlabeled` mirrors the real backend's shape (a bool: was
    // a currently-painted cluster unlabeled by this exclusion) -- this stub
    // has no cluster-painting state to actually unlabel, so it's always
    // false. Dedupes case-insensitively on (keyword, cluster_name), matching
    // the real backend.
    {
      method: "POST",
      pattern: /^\/api\/topics\/exclusions$/,
      handler: gated(async (req, res) => {
        const body = await readJsonBody(req);
        const keyword = typeof body.keyword === "string" ? body.keyword : "";
        const clusterName = typeof body.cluster_name === "string" ? body.cluster_name : "";
        const exists = state.exclusions.some(
          (e) => e.keyword.toLowerCase() === keyword.toLowerCase() && e.cluster_name.toLowerCase() === clusterName.toLowerCase()
        );
        if (!exists) {
          state.exclusions.push({
            keyword,
            cluster_slug: slugify(clusterName),
            cluster_name: clusterName,
            created_at: new Date().toISOString(),
          });
        }
        sendJson(res, 200, { exclusions: state.exclusions, unlabeled: false });
      }),
    },

    // DELETE /api/topics/exclusions WITH A JSON BODY {keyword, cluster_name}
    // -> {exclusions}. MUST precede the generic DELETE /api/topics/{keyword}
    // pattern below -- this is the routing trap made real for the first
    // time (module-header comment): without this ordering, a bare
    // `([^/]+)$` pattern on DELETE /api/topics/{keyword} would capture
    // "exclusions" as a keyword instead.
    {
      method: "DELETE",
      pattern: /^\/api\/topics\/exclusions$/,
      handler: gated(async (req, res) => {
        const body = await readJsonBody(req);
        state.exclusions = state.exclusions.filter(
          (e) => !(e.keyword === body.keyword && e.cluster_name === body.cluster_name)
        );
        sendJson(res, 200, { exclusions: state.exclusions });
      }),
    },

    // DELETE /api/topics/{keyword} -> {topics}. Sits AFTER the exclusions
    // routes above (same method-group ordering discipline).
    {
      method: "DELETE",
      pattern: /^\/api\/topics\/([^/]+)$/,
      handler: gated((req, res, m) => {
        const keyword = decodeURIComponent(m[1]);
        state.topics = state.topics.filter((t) => t.keyword !== keyword);
        sendJson(res, 200, { topics: state.topics });
      }),
    },

    // PATCH /api/topics/{keyword} {keyword:<new>} -> {topics}. No PATCH
    // /api/topics/exclusions route exists in the contract, so there is no
    // ordering trap on this method -- a rename attempt against a
    // nonexistent "exclusions" topic is simply a no-op.
    {
      method: "PATCH",
      pattern: /^\/api\/topics\/([^/]+)$/,
      handler: gated(async (req, res, m) => {
        const keyword = decodeURIComponent(m[1]);
        const body = await readJsonBody(req);
        const topic = state.topics.find((t) => t.keyword === keyword);
        if (topic && typeof body.keyword === "string") topic.keyword = body.keyword;
        sendJson(res, 200, { topics: state.topics });
      }),
    },

    // PUT /api/topics/{keyword}/icon {icon_id} -> {topics}.
    {
      method: "PUT",
      pattern: /^\/api\/topics\/([^/]+)\/icon$/,
      handler: gated(async (req, res, m) => {
        const keyword = decodeURIComponent(m[1]);
        const body = await readJsonBody(req);
        const topic = state.topics.find((t) => t.keyword === keyword);
        if (topic && typeof body.icon_id === "string") topic.icon_id = body.icon_id;
        sendJson(res, 200, { topics: state.topics });
      }),
    },

    // GET /api/topics/{keyword}/members[?limit=5|50] -- files on disk are
    // percent-encoded keyword names: members/<encodeURIComponent(keyword)>-<limit>.json.
    // Current STATE (not fixture-file existence) decides 404 first: a
    // keyword that is no longer a live topic -- deleted this session, or the
    // OLD name of a topic that was renamed -- 404s even though its original
    // fixture file is still sitting on disk (renaming/deleting never
    // touches/removes those files). Only once the keyword is confirmed live
    // does fixture-file presence decide the body: the original 4 topics'
    // files serve verbatim; anything else current (added at runtime via
    // POST, or a topic's NEW post-rename keyword) gets {members: []}.
    {
      method: "GET",
      pattern: /^\/api\/topics\/([^/]+)\/members$/,
      handler: (req, res, m, url) => {
        const keyword = decodeURIComponent(m[1]);
        if (!state.topics.some((t) => t.keyword === keyword)) return sendJson(res, 404, { detail: "unknown topic" });
        const limit = url.searchParams.get("limit") === "5" ? 5 : 50;
        const file = path.join(fixtures.membersDir, `${encodeURIComponent(keyword)}-${limit}.json`);
        if (existsSync(file)) return sendJson(res, 200, JSON.parse(readFileSync(file, "utf8")));
        sendJson(res, 200, { members: [] });
      },
    },

    // GET /api/agent/internals -- 403 for plain-demo (Task 7); acting-as-
    // demo and plain admin both get the fixture verbatim. See the `gated`
    // definition above for why reusing it here is correct even though this
    // is a read, not a mutation.
    {
      method: "GET",
      pattern: /^\/api\/agent\/internals$/,
      handler: gated((req, res) => sendJson(res, 200, fixtures.internals)),
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
        const base = !payload || payload.role !== "demo" ? fixtures.me : payload.acting_as_demo ? meActing : meDemo;
        // `preferences` is overridden from the mutable state fresh on every
        // request (Task 6) rather than baked into meDemo/meActing at
        // buildRoutes time, so a PATCH /api/auth/preferences shows up here
        // immediately.
        sendJson(res, 200, { ...base, preferences: state.preferences });
      },
    },

    // GET /api/auth/preferences -- reflects mutations (Task 6).
    {
      method: "GET",
      pattern: /^\/api\/auth\/preferences$/,
      handler: (req, res) => sendJson(res, 200, state.preferences),
    },

    // PATCH /api/auth/preferences {preferences:{...partial}} (wrapper
    // shape!) -- shallow-merges the partial into the mutable prefs state.
    {
      method: "PATCH",
      pattern: /^\/api\/auth\/preferences$/,
      handler: gated(async (req, res) => {
        const body = await readJsonBody(req);
        if (body.preferences && typeof body.preferences === "object") {
          Object.assign(state.preferences, body.preferences);
        }
        sendJson(res, 200, state.preferences);
      }),
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

    // Pipeline dev view (v2): demo-visitable reads (no write gate), computed
    // from the recorded pages. The router matches on pathname (query
    // stripped), so patterns carry no query suffix. `tz` is validated like the
    // real API (invalid -> 422); `range` falls back to "all".
    {
      method: "GET",
      pattern: /^\/api\/pipeline\/summary$/,
      handler: (req, res, m, url) => {
        const tz = url.searchParams.get("tz") ?? "UTC";
        if (!isValidTz(tz)) return sendJson(res, 422, { detail: "invalid time zone" });
        sendJson(res, 200, computeSummary(fixtures.pipelinePages, url.searchParams.get("range"), getNow().getTime(), fixtures.pipelineSkipGateConfig));
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/pipeline\/timeline$/,
      handler: (req, res, m, url) => {
        const tz = url.searchParams.get("tz") ?? "UTC";
        if (!isValidTz(tz)) return sendJson(res, 422, { detail: "invalid time zone" });
        sendJson(res, 200, computeTimeline(fixtures.pipelinePages, url.searchParams.get("range"), tz, getNow().getTime()));
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/pipeline\/pages$/,
      handler: (req, res, m, url) => {
        const q = url.searchParams;
        const intParam = (name, dflt, min, max) => {
          const raw = q.get(name);
          if (raw === null) return dflt;
          const n = Number(raw);
          return Number.isInteger(n) && n >= min && n <= max ? n : null;
        };
        const limit = intParam("limit", 50, 1, 200);
        const offset = intParam("offset", 0, 0, Number.MAX_SAFE_INTEGER);
        const sort = q.get("sort") ?? "created_at";
        const dir = q.get("dir") ?? "desc";
        const tz = q.get("tz") ?? "UTC";
        if (limit === null || offset === null || !PAGE_SORTS.includes(sort) || !["asc", "desc"].includes(dir)) {
          return sendJson(res, 422, { detail: "invalid query parameters" });
        }
        if (!isValidTz(tz)) return sendJson(res, 422, { detail: "invalid time zone" });
        sendJson(res, 200, computePages(fixtures.pipelinePages, q.get("range"), getNow().getTime(), { limit, offset, sort, dir }));
      },
    },

    // POST /api/auth/view-as and POST /api/auth/return-to-admin -- the two
    // acting-session endpoints, spread in ONLY when roleToolingEnabled
    // (both omitted entirely otherwise). Omitting them from the table
    // rather than adding an inline gate check means an unrecognized path
    // falls through to the SAME "not found" 404 every other unmatched
    // route already gets -- inert, never a 401 -- with no special-casing
    // in the request dispatcher.
    ...(roleToolingEnabled
      ? [
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
        ]
      : []),
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

export function startServer({
  port = 0,
  fixturesDir = "demo/fixtures",
  reclusterDelayMs = 2000,
  // Task 7: pacing between re-emitted SSE token events for POST
  // /api/agent/query-stream (default 15ms, matching the brief's "~15ms
  // pacing" contract). Tests pass a small/zero value so reading a whole
  // fixture's stream (hundreds of token events) doesn't blow the test
  // budget -- see server.d.mts's StartServerOptions.
  chatTokenDelayMs = 15,
  // Role-tooling opt-in -- OFF by default, matching the out-of-the-box
  // `npm run demo` experience: a stranger gets a single full-control
  // (admin) identity and never sees the demo account or acting-session
  // machinery (buildAccounts/buildRoutes above). The maintainer's own dev
  // stack opts in by setting the DEMO_ROLE_TOOLING=1 env var, read ONLY at
  // this module's standalone-entrypoint boundary below (mirrors the
  // existing PORT/FIXTURES env-read pattern) and threaded through as this
  // explicit option -- so importers (tests, a future embedder) opt in via
  // the option directly rather than mutating process.env. NEXT_PUBLIC_
  // DEMO_ROLE_TOOLING is this flag's frontend-side sibling (gates
  // rendering the view-as control in components/GraphCanvas.tsx); the two
  // are set together but read independently, one per process.
  roleToolingEnabled = false,
  // Test seam: the clock (Date | ms | () => Date | ms) the fixtures are shifted
  // to at boot and the pipeline windows are cut at per request. Default: the
  // real clock.
  now = undefined,
} = {}) {
  const getNow = () => (now === undefined ? new Date() : new Date(typeof now === "function" ? now() : now));
  const resolvedFixturesDir = path.resolve(process.cwd(), fixturesDir);
  const fixtures = loadFixtures(resolvedFixturesDir, getNow());
  const state = createMutableState(fixtures);
  const routes = buildRoutes(fixtures, state, { reclusterDelayMs, chatTokenDelayMs, roleToolingEnabled, getNow });

  const onHandlerError = (req, res, url, err) => {
    // Malformed request body -- a caller mistake, not a handler bug -- gets
    // its own short 400 (readJsonBody's doc comment) instead of the generic
    // 500 below, and is never logged as a server-side error.
    if (err instanceof MalformedJsonBodyError) {
      if (!res.headersSent) return sendJson(res, 400, { detail: "malformed json body" });
      return res.end();
    }
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

// True when this module was invoked directly as `node demo/server.mjs` (as
// opposed to being imported, e.g. by demo/server.test.ts). Compares via
// `pathToFileURL` rather than the naive `import.meta.url === \`file://${
// process.argv[1]}\`` string concatenation, which mismatches on POSIX paths
// that percent-encode in a file URL (e.g. spaces) and never matches on
// win32 (drive letters, backslash separators). `argv1` is undefined in
// contexts with no invoked script (e.g. a REPL); guard that case explicitly.
// Duplicated from launcher.mjs's identically-behaved exported `isDirectEntry`
// rather than imported, so this stub stays dependency-free of that file's
// child_process/net spawn-management code -- see launcher.mjs's module
// header for the full rationale.
function isDirectEntry(metaUrl, argv1) {
  if (!argv1) return false;
  return pathToFileURL(argv1).href === metaUrl;
}

// Parses an opt-in boolean env flag: "1" or "true" is ON, anything else
// (unset, "0", "false", garbage) is OFF. Shared accepted-value CONTRACT with
// components/GraphCanvas.tsx's isRoleToolingVisible (NEXT_PUBLIC_DEMO_ROLE_TOOLING)
// -- kept as two independent implementations, one per process, per that
// function's own doc comment. Exported for direct test coverage without
// spawning this module as a subprocess.
export function isEnvFlagOn(value) {
  return value === "1" || value === "true";
}

// Standalone entrypoint: `node demo/server.mjs`.
if (isDirectEntry(import.meta.url, process.argv[1])) {
  const port = process.env.PORT ? Number(process.env.PORT) : 8001;
  const fixturesDir = process.env.FIXTURES || "demo/fixtures";
  // Role-tooling opt-in -- see startServer's `roleToolingEnabled` doc
  // comment. `npm run demo` (demo/launcher.mjs) spawns this process with
  // `...process.env` untouched, so it stays unset (default off) there;
  // scripts/dev.sh exports DEMO_ROLE_TOOLING=1 for the maintainer's own
  // dev stack (accepts "true" too, via isEnvFlagOn -- see that function).
  const roleToolingEnabled = isEnvFlagOn(process.env.DEMO_ROLE_TOOLING);
  startServer({ port, fixturesDir, roleToolingEnabled })
    .then(({ port: boundPort }) => {
      console.log(`[demo-server] listening on :${boundPort} (fixtures: ${fixturesDir})`);
    })
    .catch((err) => {
      console.error("[demo-server] failed to start:", err);
      process.exit(1);
    });
}
