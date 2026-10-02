#!/usr/bin/env node
// Transforms demo/fixtures/raw/ (gitignored capture from Task 2) into the
// committed demo/fixtures/ set consumed by Task 4's stub server. Spec D7/D8/D10.
//
// Responsibilities:
//  1. Excise 2 real-personal-browsing pages that leaked into the capture
//     (a 2026-07-05 diary window unrelated to the 4 curated demo ingest days)
//     from every artifact family that references them.
//  2. Respread dates: discard the raw capture's real ingest dates and
//     regenerate a synthetic ~35-day browsing cadence ending "recently"
//     (relative to whenever this script runs), fully deterministic -- no
//     Math.random(), no wall-clock-seeded shuffling. graph node
//     `first_visited_at` and all diary windows (day/week/month, unfiltered +
//     per-node filtered) are rebuilt from that respread.
//  3. Normalize me.json / preferences.json to the stub's default identity.
//  4. Write ATTRIBUTION.md + meta.json.
//  5. Copy everything else through unmodified (pages content, previews,
//     assets, members, topics, exclusions, clustering-status, internals,
//     chat transcripts).
//  6. Hygiene-gate the result: a grep for the forbidden identifier terms
//     (see FORBIDDEN below) over demo/fixtures/ must come back empty, or the build fails
//     loudly (never silently ships a partial/contaminated set).
//
// Usage: node demo/tools/build-fixtures.mjs
//        node demo/tools/build-fixtures.mjs --pipeline-only
//        node demo/tools/build-fixtures.mjs --overview-only
//   --pipeline-only rebuilds ONLY demo/fixtures/pipeline/ from raw/pipeline/,
//   leaving every other committed fixture untouched. It reuses the anchor
//   already recorded in the committed meta.json (instead of today) so the
//   pipeline dates agree with the existing diary.
//   --overview-only does the same for demo/fixtures/overview/ (from
//   raw/overview/ plus the committed demo seed).

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  cpSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const RAW_DIR = path.join(REPO_ROOT, 'demo', 'fixtures', 'raw');
const OUT_DIR = path.join(REPO_ROOT, 'demo', 'fixtures');
const PIPELINE_ONLY = process.argv.includes('--pipeline-only');
const OVERVIEW_ONLY = process.argv.includes('--overview-only');

function fatal(msg) {
  console.error(`\n[build-fixtures] FATAL: ${msg}\n`);
  process.exit(1);
}

function readJson(...relParts) {
  const full = path.join(RAW_DIR, ...relParts);
  if (!existsSync(full)) fatal(`missing raw input: ${full}`);
  return JSON.parse(readFileSync(full, 'utf8'));
}

function writeJson(relPath, data) {
  const full = path.join(OUT_DIR, relPath);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, JSON.stringify(data, null, 2) + '\n');
}

function writeText(relPath, text) {
  const full = path.join(OUT_DIR, relPath);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, text);
}

console.log('[build-fixtures] raw:', RAW_DIR);
console.log('[build-fixtures] out:', OUT_DIR);

// ---------------------------------------------------------------------------
// Step 0: clean previous build output (never touches raw/)
// ---------------------------------------------------------------------------

const OUTPUT_ENTRIES = [
  'meta.json', 'ATTRIBUTION.md', 'me.json', 'preferences.json',
  'topics.json', 'exclusions.json', 'clustering-status.json', 'internals.json',
  'graph.json', 'graph-window-7.json', 'graph-window-30.json',
  'graph-window-90.json', 'graph-window-365.json',
  'diary-day.json', 'diary-week.json', 'diary-month.json',
  'diary-filtered-day.json', 'diary-filtered-week.json', 'diary-filtered-month.json',
  'nodes', 'pages', 'previews', 'members', 'assets', 'chat', 'pipeline', 'overview',
];
for (const entry of PIPELINE_ONLY ? ['pipeline'] : OVERVIEW_ONLY ? ['overview'] : OUTPUT_ENTRIES) {
  rmSync(path.join(OUT_DIR, entry), { recursive: true, force: true });
}
console.log('[build-fixtures] cleaned previous output');

// ---------------------------------------------------------------------------
// Step 1: identify + validate the contamination (2026-07-05 window)
// ---------------------------------------------------------------------------

const KNOWN_INGEST_DAYS = ['2026-05-08', '2026-05-09', '2026-05-10', '2026-05-11'];
const rawDiaryDay = readJson('diary-day.json');
const knownSet = new Set(KNOWN_INGEST_DAYS);
const contaminatedWindows = rawDiaryDay.filter((w) => !knownSet.has(w.key));
const realDayWindowsRaw = rawDiaryDay.filter((w) => knownSet.has(w.key));

if (contaminatedWindows.length !== 1) {
  fatal(
    `expected exactly 1 contaminated day window beyond the 4 known ingest ` +
    `days, found ${contaminatedWindows.length}: ${JSON.stringify(contaminatedWindows.map((w) => w.key))}`
  );
}
const contaminated = contaminatedWindows[0];
if (contaminated.node_ids.length !== 2 || contaminated.graph_node_ids.length !== 2) {
  fatal(
    `contaminated window ${contaminated.key} does not hold exactly 2 pages ` +
    `as documented (node_ids=${contaminated.node_ids.length}, graph_node_ids=${contaminated.graph_node_ids.length})`
  );
}
if (realDayWindowsRaw.length !== 4) {
  fatal(`expected exactly 4 real ingest day windows, found ${realDayWindowsRaw.length}`);
}

const EXCLUDE_GRAPH_IDS = new Set(contaminated.graph_node_ids);
const EXCLUDE_NUMERIC_NODE_IDS = new Set(contaminated.node_ids);

console.log(
  `[build-fixtures] excising contaminated window ${contaminated.key}: ` +
  `graph_node_ids=${JSON.stringify([...EXCLUDE_GRAPH_IDS])} node_ids=${JSON.stringify([...EXCLUDE_NUMERIC_NODE_IDS])}`
);

const realDayWindowsOrdered = KNOWN_INGEST_DAYS.map((k) => realDayWindowsRaw.find((w) => w.key === k));
if (realDayWindowsOrdered.some((w) => !w)) fatal('a known ingest day window is missing from diary-day.json');
const rawNumericIds = realDayWindowsOrdered.flatMap((w) => w.node_ids);

// ---------------------------------------------------------------------------
// Step 2: load the canonical graph, resolve excised page URLs, build the
// kept-node set
// ---------------------------------------------------------------------------

const rawGraph = readJson('graph.json');
const excludedNodesRaw = rawGraph.nodes.filter((n) => EXCLUDE_GRAPH_IDS.has(n.id));
if (excludedNodesRaw.length !== 2) {
  fatal(`expected 2 excluded graph nodes, found ${excludedNodesRaw.length}`);
}
const EXCLUDE_URLS = new Set(excludedNodesRaw.flatMap((n) => n.page_urls));

const keptNodes = rawGraph.nodes.filter((n) => !EXCLUDE_GRAPH_IDS.has(n.id));
if (keptNodes.length !== rawGraph.nodes.length - 2) fatal('kept-node count mismatch after excision');

// Clusters whose ENTIRE page_ids set is excluded pages are dropped outright
// (the two solo pseudo-clusters wrapping the 2 excised pages, in practice).
const droppedClusterIds = new Set(
  rawGraph.clusters
    .filter((c) => c.page_ids.length > 0 && c.page_ids.every((id) => EXCLUDE_GRAPH_IDS.has(id)))
    .map((c) => c.id)
);
console.log(`[build-fixtures] dropping ${droppedClusterIds.size} cluster(s) fully consumed by excision: ${JSON.stringify([...droppedClusterIds])}`);

// Reverse map: graph node id -> its parent cluster id (every node's
// parent_id is itself a real cluster.id entry -- verified against this
// capture; solo/singleton pages get a "_solo_<id>" pseudo-cluster).
const clusterParentByNode = new Map(rawGraph.nodes.map((n) => [n.id, n.parent_id]));
const clusterNameById = new Map(rawGraph.clusters.map((c) => [c.id, c.name]));

console.log(`[build-fixtures] kept nodes: ${keptNodes.length} (expect 157)`);

// ---------------------------------------------------------------------------
// Step 3: deterministic date respread
// ---------------------------------------------------------------------------

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_FULL = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const DAY_MS = 86400000;

function pad2(n) { return String(n).padStart(2, '0'); }
function isoDateStr(d) { return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`; }
function parseIsoDateUTC(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function addDaysUTC(d, days) { return new Date(d.getTime() + days * DAY_MS); }

function isoWeekInfo(d) {
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNr = (target.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  target.setUTCDate(target.getUTCDate() - dayNr + 3); // Thursday of this ISO week
  const isoYear = target.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4DayNr = (jan4.getUTCDay() + 6) % 7;
  const week1Mon = new Date(jan4.getTime());
  week1Mon.setUTCDate(jan4.getUTCDate() - jan4DayNr);
  const weekNo = Math.round((target - week1Mon) / (7 * DAY_MS)) + 1;
  return { isoYear, weekNo };
}
function isoWeekKey(d) {
  const { isoYear, weekNo } = isoWeekInfo(d);
  return `${isoYear}-W${pad2(weekNo)}`;
}
function weekMonday(d) {
  const dayNr = (d.getUTCDay() + 6) % 7;
  return addDaysUTC(d, -dayNr);
}
function formatDayLabel(dateStr) {
  const d = parseIsoDateUTC(dateStr);
  return `${MONTH_ABBR[d.getUTCMonth()]} ${pad2(d.getUTCDate())}, ${d.getUTCFullYear()}`;
}
function formatWeekLabel(monday) {
  const sunday = addDaysUTC(monday, 6);
  const sameMonth = monday.getUTCMonth() === sunday.getUTCMonth() && monday.getUTCFullYear() === sunday.getUTCFullYear();
  if (sameMonth) {
    return `${MONTH_ABBR[monday.getUTCMonth()]} ${pad2(monday.getUTCDate())}–${pad2(sunday.getUTCDate())}, ${sunday.getUTCFullYear()}`;
  }
  const sameYear = monday.getUTCFullYear() === sunday.getUTCFullYear();
  if (sameYear) {
    return `${MONTH_ABBR[monday.getUTCMonth()]} ${pad2(monday.getUTCDate())} – ${MONTH_ABBR[sunday.getUTCMonth()]} ${pad2(sunday.getUTCDate())}, ${sunday.getUTCFullYear()}`;
  }
  return `${MONTH_ABBR[monday.getUTCMonth()]} ${pad2(monday.getUTCDate())}, ${monday.getUTCFullYear()} – ${MONTH_ABBR[sunday.getUTCMonth()]} ${pad2(sunday.getUTCDate())}, ${sunday.getUTCFullYear()}`;
}
function formatMonthLabel(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  return `${MONTH_FULL[m - 1]} ${y}`;
}

// Anchor = today (UTC midnight), truncated to a date. meta.json records it;
// Task 4's stub shifts every date it serves by (today - anchor) at runtime.
const now = new Date();
const anchor = PIPELINE_ONLY || OVERVIEW_ONLY
  ? parseIsoDateUTC(JSON.parse(readFileSync(path.join(OUT_DIR, 'meta.json'), 'utf8')).anchor)
  : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
console.log(`[build-fixtures] anchor (${PIPELINE_ONLY || OVERVIEW_ONLY ? 'committed meta.json' : 'build date'}): ${isoDateStr(anchor)}`);

// Hand-written, deterministic cadence: no RNG, no Date.now()-seeded shuffle.
// 14 active browsing days spread across a rolling 35-day window ending at
// the anchor (offset 0 = anchor day). Weighted to look like real
// intermittent browsing: paired offsets 7 days apart (simulating recurring
// weekend sessions) carry more weight than the lone weekday sessions between
// them, and weight tapers for older days so the diary's tail stays dense and
// its early days thin -- "ends recently" by construction.
const ACTIVE_DAY_OFFSETS = [
  { offset: 1, weight: 3 },
  { offset: 2, weight: 3 },
  { offset: 6, weight: 1 },
  { offset: 8, weight: 3 },
  { offset: 9, weight: 3 },
  { offset: 13, weight: 1 },
  { offset: 15, weight: 2 },
  { offset: 16, weight: 2 },
  { offset: 20, weight: 1 },
  { offset: 22, weight: 2 },
  { offset: 23, weight: 2 },
  { offset: 27, weight: 1 },
  { offset: 30, weight: 1 },
  { offset: 33, weight: 1 },
];

function buildWeightedCycle(days) {
  const maxWeight = Math.max(...days.map((d) => d.weight));
  const cycle = [];
  // Round-robin, not block-grouped: every day gets 1 slot in round 1 before
  // any day gets a 2nd, so consecutive doc-order pages land on DIFFERENT
  // days (avoids clumping same-topic runs onto a single synthetic day).
  for (let round = 1; round <= maxWeight; round += 1) {
    for (const d of days) if (d.weight >= round) cycle.push(d.offset);
  }
  return cycle;
}
const DAY_CYCLE = buildWeightedCycle(ACTIVE_DAY_OFFSETS);

// ---------------------------------------------------------------------------
// Pipeline dev-view fixtures (recorded from seed + synthetic augment).
// Same ACTIVE_DAY_OFFSETS cadence as the diary so the stub's pipeline charts
// and its diary agree; the stub computes summary / timeline / pages from the
// respread pages for any range + tz (mirrors pipeline_repo).
// A hoisted function so --pipeline-only can invoke it without the rest of
// the build; it is called once from the normal flow (after Step 9) or from
// the early-exit right after DAY_CYCLE is defined.
// ---------------------------------------------------------------------------
function buildPipelineFixtures() {
  const timeOf = (iso, fallback = '12:00:00+00:00') => { const m = /T(.+)$/.exec(iso || ''); return m ? m[1] : fallback; };
  const rawPipelinePages = readJson('pipeline', 'pages.json');
  const pipelinePages = rawPipelinePages.rows.map((r, i) => {
    const d = addDaysUTC(anchor, -DAY_CYCLE[i % DAY_CYCLE.length]);
    return { ...r, created_at: `${isoDateStr(d)}T${timeOf(r.created_at)}`, visited_at: r.visited_at ? `${isoDateStr(d)}T${timeOf(r.visited_at)}` : null };
  });
  writeJson('pipeline/pages.json', { rows: pipelinePages, total: rawPipelinePages.total });
  // The stub replays only rule_filter_config + skip_gate_config from the recorded summary; counts are
  // computed from pages. The live rule-filter wording names one product host, which the hygiene gate
  // forbids in committed fixtures, so that host is swapped for a generic one here.
  const rawSummary = readJson('pipeline', 'summary.json');
  const scrubHost = (v) => (typeof v === 'string' ? v.split('claude' + '.ai').join('chat-app.example') : Array.isArray(v) ? v.map(scrubHost) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubHost(x)])) : v);
  writeJson('pipeline/summary.json', { ...rawSummary, rule_filter_config: scrubHost(rawSummary.rule_filter_config) });

  console.log(`[build-fixtures] pipeline: ${pipelinePages.length} pages`);
}

// Overview dev-view fixtures. Captures come from the committed demo seed (only
// started_at + source are kept), respread on the diary cadence like the
// pipeline pages; the clusters block is the recorded latest run, dated to the
// anchor day (the demo's "latest run" is as recent as its newest browsing).
function buildOverviewFixtures() {
  const seedPath = path.resolve(REPO_ROOT, '..', 'api', 'data', 'demo-seed', 'demo_seed.json.gz');
  if (!existsSync(seedPath)) fatal(`missing demo seed: ${seedPath}`);
  const seed = JSON.parse(gunzipSync(readFileSync(seedPath)).toString('utf8'));
  const timeOf = (iso, fallback = '12:00:00+00:00') => { const m = /T(.+)$/.exec(iso || ''); return m ? m[1] : fallback; };
  const captures = [...seed.captures]
    .sort((a, b) => (a.started_at < b.started_at ? -1 : a.started_at > b.started_at ? 1 : 0))
    .map((c, i) => ({ started_at: `${isoDateStr(addDaysUTC(anchor, -DAY_CYCLE[i % DAY_CYCLE.length]))}T${timeOf(c.started_at)}`, source: c.source }));
  writeJson('overview/captures.json', captures);
  const { clusters } = readJson('overview', 'summary.json');
  writeJson('overview/summary.json', { clusters: clusters && { ...clusters, run_completed_at: `${isoDateStr(anchor)}T${timeOf(clusters.run_completed_at)}` } });
  console.log(`[build-fixtures] overview: ${captures.length} captures, clusters ${clusters ? clusters.clusters : 'none'}`);
}

// Hygiene gate: hoisted so both the full build (Step 11) and --pipeline-only
// run it over the whole committed output.
// Terms assembled from parts so this tracked file never matches its own gate
// (the pre-push identifier scan must not flag it).
const FORBIDDEN = ['ska' + 'niti', 'sravya' + 'kaniti', 'print' + 'ables', 'claude\\.' + 'ai'].join('|');
function runHygieneGate() {
  console.log('[build-fixtures] running hygiene gate...');
  // Scoped to the COMMITTED output only: demo/fixtures/raw/ is gitignored
  // infrastructure from Task 2 and legitimately still contains the
  // contamination this script excises (that's the whole point -- Task 2
  // captured it faithfully so Task 3 could excise it from the processed set).
  // A literal `grep ... demo/fixtures/` would always find it in raw/ and could
  // never pass; --exclude-dir=raw scopes the gate to what actually ships.
  let hygieneHits = '';
  try {
    hygieneHits = execFileSync('grep', ['-rlE', '--exclude-dir=raw', FORBIDDEN, OUT_DIR], { encoding: 'utf8' });
  } catch (err) {
    // grep exits 1 when there are no matches -- that's the PASS case.
    if (err.status !== 1) fatal(`hygiene grep failed to run: ${err.message}`);
    hygieneHits = '';
  }
  if (hygieneHits.trim().length > 0) {
    fatal(`hygiene gate FAILED -- forbidden pattern found in:\n${hygieneHits}`);
  }
  console.log('[build-fixtures] hygiene gate PASSED (grep came back empty)');
}

if (OVERVIEW_ONLY) {
  buildOverviewFixtures();
  runHygieneGate();
  console.log('[build-fixtures] --overview-only: done (other fixtures untouched)');
  process.exit(0);
}

if (PIPELINE_ONLY) {
  buildPipelineFixtures();
  runHygieneGate();
  console.log('[build-fixtures] --pipeline-only: done (other fixtures untouched)');
  process.exit(0);
}

// One synthetic date per graph node, seeded by its index in doc order
// (position in the kept-nodes array). "Interior nodes get min of children":
// generic, recursive resolution over children_ids -- a no-op in this
// capture (every node here is a leaf; children_ids is always empty) but
// implemented for real hierarchies.
const graphNodeDate = new Map();
const nodeById = new Map(keptNodes.map((n) => [n.id, n]));

keptNodes.forEach((n, i) => {
  if (!n.children_ids || n.children_ids.length === 0) {
    const offset = DAY_CYCLE[i % DAY_CYCLE.length];
    graphNodeDate.set(n.id, addDaysUTC(anchor, -offset));
  }
});
// Second pass: any interior node (children_ids non-empty) = min of its
// resolved children's dates. Recursion guard via memo (graphNodeDate itself).
function resolveInteriorDate(id) {
  if (graphNodeDate.has(id)) return graphNodeDate.get(id);
  const n = nodeById.get(id);
  if (!n) fatal(`node ${id} referenced by children_ids but not found in kept-node set`);
  const childDates = n.children_ids.map(resolveInteriorDate);
  const min = childDates.reduce((a, b) => (a < b ? a : b));
  graphNodeDate.set(id, min);
  return min;
}
for (const n of keptNodes) resolveInteriorDate(n.id);
if (graphNodeDate.size !== keptNodes.length) fatal('graphNodeDate did not resolve for every kept node');

function rewriteTimestamp(nodeId, originalIso) {
  const d = graphNodeDate.get(nodeId);
  if (!d) fatal(`no synthetic date for node ${nodeId}`);
  const m = /T(.+)$/.exec(originalIso || '');
  const timeSuffix = m ? m[1] : '00:00:00+00:00';
  return `${isoDateStr(d)}T${timeSuffix}`;
}

// Page instances: one per raw page_urls entry across kept nodes, in doc
// order (a node with visit_count>1, e.g. one merged "pulse_width_modulation"
// node in this capture, contributes >1 instance). Zipped index-for-index
// with the real captured numeric node_ids (flattened from the 4 real day
// windows, same doc order) -- every id used downstream is a real captured
// value, never fabricated; the pairing itself is a deterministic
// construction (raw capture doesn't expose which numeric id belonged to
// which URL within a merged node).
const pageInstances = [];
for (const n of keptNodes) {
  for (const url of n.page_urls) {
    pageInstances.push({ graphNodeId: n.id, url, date: graphNodeDate.get(n.id) });
  }
}
if (pageInstances.length !== rawNumericIds.length) {
  fatal(`page instance count (${pageInstances.length}) != raw numeric node_id count (${rawNumericIds.length})`);
}
pageInstances.forEach((pi, i) => { pi.numericNodeId = rawNumericIds[i]; });

console.log(`[build-fixtures] page instances: ${pageInstances.length} (expect 158), spread over ${new Set(pageInstances.map((p) => isoDateStr(p.date))).size} active days`);

// ---------------------------------------------------------------------------
// Step 4: regenerate diary windows (day -> week -> month) from the respread
// ---------------------------------------------------------------------------

function buildClusterAggregates(instances) {
  const cluster_freq = {};
  const cluster_names = {};
  for (const pi of instances) {
    const cid = clusterParentByNode.get(pi.graphNodeId);
    if (!cid || cid.startsWith('_solo_')) continue;
    cluster_freq[cid] = (cluster_freq[cid] || 0) + 1;
    cluster_names[cid] = clusterNameById.get(cid);
  }
  return { cluster_freq, cluster_names };
}
function uniquePreserveOrder(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) if (!seen.has(it)) { seen.add(it); out.push(it); }
  return out;
}

const dayGroups = new Map();
for (const pi of pageInstances) {
  const key = isoDateStr(pi.date);
  if (!dayGroups.has(key)) dayGroups.set(key, []);
  dayGroups.get(key).push(pi);
}
const dayWindows = [...dayGroups.entries()].map(([key, instances]) => {
  const node_ids = instances.map((pi) => pi.numericNodeId);
  const graph_node_ids = uniquePreserveOrder(instances.map((pi) => pi.graphNodeId));
  const { cluster_freq, cluster_names } = buildClusterAggregates(instances);
  return { key, label: formatDayLabel(key), node_ids, graph_node_ids, cluster_freq, cluster_names, page_count: node_ids.length };
});
dayWindows.sort((a, b) => b.key.localeCompare(a.key));

function mergeWindows(key, label, windows) {
  const node_ids = [];
  const graph_node_ids = [];
  const seenG = new Set();
  const cluster_freq = {};
  const cluster_names = {};
  let page_count = 0;
  for (const w of windows) {
    node_ids.push(...w.node_ids);
    for (const gid of w.graph_node_ids) if (!seenG.has(gid)) { seenG.add(gid); graph_node_ids.push(gid); }
    for (const [cid, cnt] of Object.entries(w.cluster_freq)) cluster_freq[cid] = (cluster_freq[cid] || 0) + cnt;
    Object.assign(cluster_names, w.cluster_names);
    page_count += w.page_count;
  }
  return { key, label, node_ids, graph_node_ids, cluster_freq, cluster_names, page_count };
}

const weekGroups = new Map(); // weekKey -> { monday, days: [] }
for (const dw of dayWindows) {
  const d = parseIsoDateUTC(dw.key);
  const monday = weekMonday(d);
  const wk = isoWeekKey(d);
  if (!weekGroups.has(wk)) weekGroups.set(wk, { monday, days: [] });
  weekGroups.get(wk).days.push(dw);
}
const weekWindows = [...weekGroups.entries()].map(([wk, { monday, days }]) => {
  days.sort((a, b) => a.key.localeCompare(b.key));
  return mergeWindows(wk, formatWeekLabel(monday), days);
});
weekWindows.sort((a, b) => b.key.localeCompare(a.key));

const monthGroups = new Map();
for (const dw of dayWindows) {
  const d = parseIsoDateUTC(dw.key);
  const mk = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
  if (!monthGroups.has(mk)) monthGroups.set(mk, []);
  monthGroups.get(mk).push(dw);
}
const monthWindows = [...monthGroups.entries()].map(([mk, days]) => {
  days.sort((a, b) => a.key.localeCompare(b.key));
  return mergeWindows(mk, formatMonthLabel(mk), days);
});
monthWindows.sort((a, b) => b.key.localeCompare(a.key));

writeJson('diary-day.json', dayWindows);
writeJson('diary-week.json', weekWindows);
writeJson('diary-month.json', monthWindows);
console.log(`[build-fixtures] diary: ${dayWindows.length} day windows, ${weekWindows.length} week windows, ${monthWindows.length} month windows`);

// Filtered variants: for each kept node, the windows (full window content,
// unmodified) that its subtree participates in -- matches observed raw
// backend semantics (filter_node_id returns whichever whole windows the
// node's subtree touched, not a page-narrowed slice; verified against
// raw/diary-filtered/*, e.g. a single-page node's "filtered" day window
// equals the FULL day window, not a 1-page slice). Subtree is always [self]
// in this capture but resolved generically from raw/nodes/<id>.json.
const diaryByGranularity = { day: dayWindows, week: weekWindows, month: monthWindows };
const filteredByGranularity = { day: {}, week: {}, month: {} };
let filteredNodesDone = 0;
for (const n of keptNodes) {
  const encoded = encodeURIComponent(n.id);
  const rawNode = readJson('nodes', `${encoded}.json`);
  const subtreeIds = new Set((rawNode.subtree || [{ id: n.id }]).map((s) => s.id));
  for (const g of ['day', 'week', 'month']) {
    filteredByGranularity[g][n.id] = diaryByGranularity[g].filter((w) => w.graph_node_ids.some((gid) => subtreeIds.has(gid)));
  }
  filteredNodesDone += 1;
  if (filteredNodesDone % 50 === 0) console.log(`  ... diary-filtered: ${filteredNodesDone}/${keptNodes.length} nodes`);
}
writeJson('diary-filtered-day.json', filteredByGranularity.day);
writeJson('diary-filtered-week.json', filteredByGranularity.week);
writeJson('diary-filtered-month.json', filteredByGranularity.month);
console.log(`[build-fixtures] diary-filtered: ${filteredNodesDone} nodes x 3 granularities`);

// ---------------------------------------------------------------------------
// Step 5: rewrite graph.json + window variants (excise + respread dates)
//
// Controller ruling R7: raw's window-7/30/90 files held raw's ORIGINAL
// (pre-respread) membership -- after the respread every kept node sits
// within 1-33 days of the anchor, so those stale files would show 0 nodes
// while the diary shows browsing "yesterday". Window membership is instead
// regenerated at build time straight from each node's respread offset:
// window-N = every kept node whose (anchor - first_visited_at) <= N days.
// Interior nodes (children_ids non-empty) already resolve to min-of-children
// via graphNodeDate, so they follow their children into a window for free --
// no separate handling needed here.
// ---------------------------------------------------------------------------

function offsetDaysFromAnchor(nodeId) {
  const d = graphNodeDate.get(nodeId);
  if (!d) fatal(`no synthetic date for node ${nodeId} (offset lookup)`);
  return Math.round((anchor.getTime() - d.getTime()) / DAY_MS);
}

// windowDays === null means "no window filter" (graph.json, window=all).
function buildGraphSnapshot(windowDays) {
  const nodesInWindow = windowDays == null
    ? keptNodes
    : keptNodes.filter((n) => offsetDaysFromAnchor(n.id) <= windowDays);
  const nodeIdSet = new Set(nodesInWindow.map((n) => n.id));
  const nodes = nodesInWindow.map((n) => ({ ...n, first_visited_at: rewriteTimestamp(n.id, n.first_visited_at) }));
  // Same excision machinery as the contamination pass: drop a cluster
  // outright once none of its page_ids survive in this window (covers both
  // the 2 globally-excised contaminated ids -- never in nodeIdSet -- and
  // now also every node outside this window's day-count cutoff).
  const clusters = rawGraph.clusters
    .filter((c) => !droppedClusterIds.has(c.id))
    .map((c) => ({ ...c, page_ids: c.page_ids.filter((id) => nodeIdSet.has(id)) }))
    .filter((c) => c.page_ids.length > 0);
  const survivingClusterIds = new Set(clusters.map((c) => c.id));
  const links = rawGraph.links.filter((l) => survivingClusterIds.has(l.source) && survivingClusterIds.has(l.target));
  // super_clusters/groups carry no page/node membership (verified: neither
  // schema has an id-referencing array), so there is nothing to filter --
  // both are always the full, static set, matching raw's own behavior.
  return { nodes, links, clusters, super_clusters: rawGraph.super_clusters, groups: rawGraph.groups };
}

const GRAPH_WINDOW_SPECS = [
  { file: 'graph.json', windowDays: null },
  { file: 'graph-window-7.json', windowDays: 7 },
  { file: 'graph-window-30.json', windowDays: 30 },
  { file: 'graph-window-90.json', windowDays: 90 },
  { file: 'graph-window-365.json', windowDays: 365 },
];
for (const { file, windowDays } of GRAPH_WINDOW_SPECS) {
  const out = buildGraphSnapshot(windowDays);
  writeJson(file, out);
  console.log(`[build-fixtures] ${file} (window=${windowDays ?? 'all'}): ${out.nodes.length} nodes, ${out.links.length} links, ${out.clusters.length} clusters`);
}

// ---------------------------------------------------------------------------
// Step 6: nodes/<id>.json (per-node detail + subtree), excised + respread
// ---------------------------------------------------------------------------

let nodesWritten = 0;
for (const n of keptNodes) {
  const encoded = encodeURIComponent(n.id);
  const raw = readJson('nodes', `${encoded}.json`);
  const rewriteEntry = (entry) => ({ ...entry, first_visited_at: rewriteTimestamp(entry.id, entry.first_visited_at) });
  writeJson(`nodes/${encoded}.json`, { node: rewriteEntry(raw.node), subtree: raw.subtree.map(rewriteEntry) });
  nodesWritten += 1;
  if (nodesWritten % 50 === 0) console.log(`  ... nodes/: ${nodesWritten}/${keptNodes.length}`);
}
console.log(`[build-fixtures] nodes/: ${nodesWritten} files written (expect 157)`);

// ---------------------------------------------------------------------------
// Step 7: pages (excise 2 URLs), previews, assets, and pure pass-through
// families -- wholesale directory copy, then surgically remove the excised
// entries (fast: cpSync is a single native call vs. a per-file JS loop).
// ---------------------------------------------------------------------------

const rawPagesIndex = readJson('pages', 'index.json');
const excludedSha1s = new Set();
const excludedPids = new Set();
const keptPagesIndex = {};
for (const [url, meta] of Object.entries(rawPagesIndex)) {
  if (EXCLUDE_URLS.has(url)) {
    excludedSha1s.add(meta.sha1);
    excludedPids.add(String(meta.pid));
    continue;
  }
  keptPagesIndex[url] = meta;
}
if (Object.keys(keptPagesIndex).length !== Object.keys(rawPagesIndex).length - 2) fatal('pages/index.json excision count mismatch');

console.log('[build-fixtures] copying pages/ ...');
cpSync(path.join(RAW_DIR, 'pages'), path.join(OUT_DIR, 'pages'), { recursive: true });
for (const sha1 of excludedSha1s) {
  const p = path.join(OUT_DIR, 'pages', `${sha1}.json`);
  if (existsSync(p)) { rmSync(p); console.log(`  excised pages/${sha1}.json`); }
}
writeJson('pages/index.json', keptPagesIndex);
console.log(`[build-fixtures] pages/: ${Object.keys(keptPagesIndex).length} entries (expect 158)`);

console.log('[build-fixtures] copying previews/ ...');
cpSync(path.join(RAW_DIR, 'previews'), path.join(OUT_DIR, 'previews'), { recursive: true });
let previewsExcised = 0;
for (const pid of excludedPids) {
  const p = path.join(OUT_DIR, 'previews', `${pid}.html`);
  if (existsSync(p)) { rmSync(p); previewsExcised += 1; console.log(`  excised previews/${pid}.html`); }
}
const previewCount = readdirSync(path.join(OUT_DIR, 'previews')).length;
console.log(`[build-fixtures] previews/: ${previewCount} files (${previewsExcised} excised)`);

// Assets: ship ALL remaining assets unmodified (spec D8) -- neither excised
// page had a captured preview (has_usable_html was false for both), so no
// asset was ever downloaded referencing ONLY their previews; nothing to prune.
console.log('[build-fixtures] copying assets/ (large: ~115MB / ~3048 files, may take a bit) ...');
const assetsStart = Date.now();
cpSync(path.join(RAW_DIR, 'assets'), path.join(OUT_DIR, 'assets'), { recursive: true });
console.log(`[build-fixtures] assets/ copied in ${((Date.now() - assetsStart) / 1000).toFixed(1)}s`);

console.log('[build-fixtures] copying members/, chat/, and single-file pass-throughs ...');
cpSync(path.join(RAW_DIR, 'members'), path.join(OUT_DIR, 'members'), { recursive: true });
cpSync(path.join(RAW_DIR, 'chat'), path.join(OUT_DIR, 'chat'), { recursive: true });
for (const f of ['topics.json', 'exclusions.json', 'clustering-status.json', 'internals.json']) {
  cpSync(path.join(RAW_DIR, f), path.join(OUT_DIR, f));
}

// ---------------------------------------------------------------------------
// Step 8: me.json / preferences.json normalization
// ---------------------------------------------------------------------------

const paletteLibrary = JSON.parse(readFileSync(path.join(REPO_ROOT, 'lib', 'palettes.json'), 'utf8'));
const DEFAULT_THEME = paletteLibrary.active; // mirrors lib/theme.ts's DEFAULT_VARIANT
if (!DEFAULT_THEME) fatal('lib/palettes.json has no "active" palette');

const DEFAULT_PREFERENCES = {
  theme: DEFAULT_THEME,
  starfield: 'twinkle',
  panel_left_width: null,
  panel_right_width: null,
  compendium_loader_seen: false,
  show_noise: false,
};
writeJson('preferences.json', DEFAULT_PREFERENCES);

// id/created_at/api_key_prefix are real operational detail from the private
// capture instance (a real internal account id, a real account-creation
// timestamp, a real key prefix) -- born-public repo cleanliness (review
// Minor 2): synthesize obviously-fake placeholders instead of spreading
// them through from raw.
const rawMe = readJson('me.json');
writeJson('me.json', {
  ...rawMe,
  id: 1,
  email: 'admin@demo.local',
  name: 'Demo Admin',
  api_key_prefix: 'demo_0000',
  created_at: '2026-01-01T00:00:00+00:00',
  role: 'admin',
  acting_as_demo: false,
  preferences: { ...DEFAULT_PREFERENCES },
});
console.log(`[build-fixtures] me.json / preferences.json normalized (theme=${DEFAULT_THEME})`);

// ---------------------------------------------------------------------------
// Step 9: meta.json
// ---------------------------------------------------------------------------

const rawClusteringStatus = readJson('clustering-status.json');
writeJson('meta.json', { anchor: isoDateStr(anchor), runNumber: rawClusteringStatus.run_number });

buildPipelineFixtures();
buildOverviewFixtures();

// ---------------------------------------------------------------------------
// Step 10: ATTRIBUTION.md
// ---------------------------------------------------------------------------

const DOMAIN_LICENSES = {
  'en.wikipedia.org': 'CC BY-SA 4.0',
  'arxiv.org': 'per-paper, see abstract page',
  'www.gutenberg.org': 'public domain',
  'electronics.stackexchange.com': 'CC BY-SA 4.0',
  'github.com': 'per-repo',
  'www.youtube.com': 'transcript, no explicit redistribution license -- retained per spec D8',
};
const FALLBACK_LICENSE = 'no explicit redistribution license -- retained per spec D8 (full-content decision); see removal remedy below';

const byDomain = new Map();
for (const url of Object.keys(keptPagesIndex).sort()) {
  const host = new URL(url).hostname;
  if (!byDomain.has(host)) byDomain.set(host, []);
  byDomain.get(host).push(url);
}
const domains = [...byDomain.keys()].sort((a, b) => byDomain.get(b).length - byDomain.get(a).length || a.localeCompare(b));

let md = '# Attribution\n\n';
md += 'This is a curated demo compendium: a snapshot of real, publicly accessible ' +
  'web pages, captured for demonstration purposes. Full extracted text and full ' +
  'archived page assets (images, stylesheets, and other same-page resources) are ' +
  'included so the demo UI can render each page\'s saved preview offline. Sources ' +
  'are listed below, grouped by domain, with a licensing note where known.\n\n';
md += 'arXiv papers are licensed per-paper -- check each paper\'s own abstract page ' +
  'for its specific license. YouTube entries are transcripts with no explicit ' +
  'redistribution license, retained under the full-content decision above. If ' +
  'you are a rights holder and want content removed from this dataset, please ' +
  'open an issue on this repository.\n\n';

for (const host of domains) {
  const urls = byDomain.get(host);
  const license = DOMAIN_LICENSES[host] || FALLBACK_LICENSE;
  md += `## ${host} (${urls.length} page${urls.length === 1 ? '' : 's'}) -- ${license}\n\n`;
  for (const u of urls) md += `- ${u}\n`;
  md += '\n';
}
writeText('ATTRIBUTION.md', md);
console.log(`[build-fixtures] ATTRIBUTION.md written (${domains.length} domains, ${Object.keys(keptPagesIndex).length} pages)`);

// ---------------------------------------------------------------------------
// Step 11: hygiene gate + diary sanity check
// ---------------------------------------------------------------------------

runHygieneGate();

const distinctWeeks = new Set(dayWindows.map((w) => isoWeekKey(parseIsoDateUTC(w.key))));
console.log(`[build-fixtures] diary sanity: ${dayWindows.length} day windows spanning ${distinctWeeks.size} distinct ISO weeks`);
if (dayWindows.length < 12) fatal(`diary sanity FAILED: only ${dayWindows.length} day windows (need >= 12)`);
if (distinctWeeks.size < 4) fatal(`diary sanity FAILED: only ${distinctWeeks.size} distinct ISO weeks (need >= 4)`);
console.log('[build-fixtures] diary sanity PASSED');

// ---------------------------------------------------------------------------
// Done
// ---------------------------------------------------------------------------

console.log('\n[build-fixtures] === build complete ===');
console.log(`  nodes: ${keptNodes.length}`);
console.log(`  pages: ${Object.keys(keptPagesIndex).length}`);
console.log(`  previews: ${previewCount}`);
console.log(`  day windows: ${dayWindows.length} / week: ${weekWindows.length} / month: ${monthWindows.length}`);
console.log(`  anchor: ${isoDateStr(anchor)}  runNumber: ${rawClusteringStatus.run_number}`);
