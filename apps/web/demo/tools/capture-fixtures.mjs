#!/usr/bin/env node
// Snapshots every API response from a live demo backend into demo/fixtures/raw/,
// so later tasks can replay them from a stub backend. Read-only toward the
// source: only GETs, the login POST, and the query-stream POST are ever issued.
// NEVER call POST /api/recluster, PATCH/PUT/DELETE, or any other mutation.
//
// Resumable: every phase checks for an already-written output file before
// issuing a request and skips it if present, so a partial/interrupted run can
// simply be re-invoked and will only fetch what's still missing.
//
// Usage: BACKEND=http://localhost:8002 ASSETS_BACKEND=http://localhost:8052 \
//          node demo/tools/capture-fixtures.mjs

import { createWriteStream } from 'node:fs';
import {
  mkdir as mkdirP,
  writeFile as writeFileP,
  readFile as readFileP,
  stat as statP,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUT_ROOT = path.join(REPO_ROOT, 'demo', 'fixtures', 'raw');
const QUESTIONS_FILE = path.join(__dirname, 'questions.txt');

// The FastAPI backend (JSON API) and the Dash frontend (static asset host)
// are two separate processes in the demo instance. `/captured-assets/<path>`
// is served by Dash's Flask route (the predecessor app's static-asset route),
// NOT by the FastAPI backend -- so asset downloads need a different base URL.
const BACKEND = process.env.BACKEND || 'http://localhost:8002';
const ASSETS_BACKEND = process.env.ASSETS_BACKEND || 'http://localhost:8052';
const LOGIN_EMAIL = process.env.CAPTURE_LOGIN_EMAIL || 'demo@example.local';
const LOGIN_PASSWORD = 'demo';
const ASSET_CONCURRENCY = 10;

let authHeader = {};
let requestCount = 0;
let skippedCount = 0;

function bumpProgress() {
  requestCount += 1;
  if (requestCount % 25 === 0) {
    console.log(`  ... ${requestCount} requests issued so far (${skippedCount} skipped as already-captured)`);
  }
}

async function ensureDirFor(filePath) {
  await mkdirP(path.dirname(filePath), { recursive: true });
}

async function fileExists(relPath) {
  try {
    const st = await statP(path.join(OUT_ROOT, relPath));
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

async function readJsonIfExists(relPath) {
  try {
    const text = await readFileP(path.join(OUT_ROOT, relPath), 'utf8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function readTextIfExists(relPath) {
  try {
    return await readFileP(path.join(OUT_ROOT, relPath), 'utf8');
  } catch {
    return null;
  }
}

async function writeJson(relPath, data) {
  const full = path.join(OUT_ROOT, relPath);
  await ensureDirFor(full);
  await writeFileP(full, JSON.stringify(data, null, 2) + '\n');
}

async function writeRawBuffer(relPath, buf) {
  const full = path.join(OUT_ROOT, relPath);
  await ensureDirFor(full);
  await writeFileP(full, buf);
}

const ASSETS_DIR = path.join(OUT_ROOT, 'assets');

// Asset paths are regex-extracted from archived third-party HTML -- they are
// UNTRUSTED input, not internally-generated names. A crafted
// src="/captured-assets/../../../../etc/passwd"-shaped value would fetch
// fine (WHATWG URL parsing collapses "../" before the request goes out) but
// must never be allowed to resolve outside demo/fixtures/raw/assets/ on
// write. Reject any ".." path segment outright, then re-check containment
// on the resolved absolute path as defense in depth.
function resolveAssetWritePath(assetPath) {
  const rel = assetPath.replace(/^\/+/, '');
  if (rel.split('/').includes('..')) {
    throw new Error(`refusing to write asset with a ".." path segment: ${assetPath}`);
  }
  const full = path.resolve(ASSETS_DIR, rel);
  const relToAssets = path.relative(ASSETS_DIR, full);
  if (relToAssets.startsWith('..') || path.isAbsolute(relToAssets)) {
    throw new Error(`refusing to write asset outside assets/: ${assetPath}`);
  }
  return full;
}

async function fileExistsAbs(fullPath) {
  try {
    const st = await statP(fullPath);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

async function writeRawBufferAbs(fullPath, buf) {
  await mkdirP(path.dirname(fullPath), { recursive: true });
  await writeFileP(fullPath, buf);
}

// Core fetch wrapper: throws loudly on any non-2xx status not explicitly
// allowed. This is the binding policy for this tool -- non-404 HTTP errors
// (and 404s outside the documented-legitimate cases) must fail the run.
async function apiFetchFrom(base, pathAndQuery, { method = 'GET', body, allow = [] } = {}) {
  const url = `${base}${pathAndQuery}`;
  const headers = { ...authHeader };
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(url, { method, headers, body: payload });
  bumpProgress();
  if (!res.ok && !allow.includes(res.status)) {
    let detail = '';
    try {
      detail = await res.text();
    } catch {
      detail = '<unreadable body>';
    }
    throw new Error(`HTTP ${res.status} for ${method} ${url}: ${detail.slice(0, 300)}`);
  }
  return res;
}

async function apiFetch(pathAndQuery, opts) {
  return apiFetchFrom(BACKEND, pathAndQuery, opts);
}

async function apiJson(pathAndQuery, opts) {
  const res = await apiFetch(pathAndQuery, opts);
  return { status: res.status, body: await res.json() };
}

async function login() {
  console.log(`[capture] logging in as ${LOGIN_EMAIL}...`);
  try {
    const res = await fetch(`${BACKEND}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: LOGIN_EMAIL, password: LOGIN_PASSWORD }),
    });
    requestCount += 1;
    if (res.ok) {
      const loginBody = await res.json();
      authHeader = { Authorization: `Bearer ${loginBody.access_token}` };
      console.log('[capture] login succeeded; using Bearer token for all requests.');
      return;
    }
    const detail = await res.text();
    console.warn(`[capture] WARNING: login failed (HTTP ${res.status}): ${detail.slice(0, 200)}`);
    console.warn('[capture] WARNING: proceeding WITHOUT an Authorization header.');
    console.warn('[capture]   This demo backend has no password_hash set for the pinned demo');
    console.warn('[capture]   user (it relies on a dev-default-user env var for dev/demo access);');
    console.warn('[capture]   unauthenticated requests already resolve to that same user --');
    console.warn('[capture]   verified via GET /api/auth/me returning a pinned demo user with no token.');
  } catch (err) {
    console.warn(`[capture] WARNING: login request errored (${err.message}); proceeding unauthenticated.`);
  }
}

async function loadQuestions() {
  const text = await readFileP(QUESTIONS_FILE, 'utf8');
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

async function main() {
  console.log(`[capture] starting fixture capture against ${BACKEND} (assets from ${ASSETS_BACKEND})`);
  console.log(`[capture] output root: ${OUT_ROOT}`);
  await mkdirP(OUT_ROOT, { recursive: true });

  await login();

  // --- Phase 1: graph + window variants -----------------------------------
  console.log('[capture] phase 1/8: graph + window variants');
  let graph = await readJsonIfExists('graph.json');
  if (graph) {
    skippedCount += 1;
    console.log('  -> graph.json already present; skipping fetch, reusing it for node/page enumeration.');
  } else {
    ({ body: graph } = await apiJson('/api/graph'));
    await writeJson('graph.json', graph);
  }
  const windows = [7, 30, 90, 365];
  for (const w of windows) {
    const relPath = `graph-window-${w}.json`;
    if (await fileExists(relPath)) {
      skippedCount += 1;
      continue;
    }
    const { body } = await apiJson(`/api/graph?window=${w}`);
    await writeJson(relPath, body);
  }
  const nodeIds = graph.nodes.map((n) => n.id);
  console.log(`  -> graph.json: ${graph.nodes.length} nodes, ${graph.links.length} links, ` +
    `${graph.clusters.length} clusters, ${graph.super_clusters.length} super_clusters, ${graph.groups.length} groups`);

  // --- Phase 2: per-node details -------------------------------------------
  console.log(`[capture] phase 2/8: node details (${nodeIds.length} nodes)`);
  let nodeDetailCount = 0;
  for (const id of nodeIds) {
    const relPath = `nodes/${encodeURIComponent(id)}.json`;
    if (await fileExists(relPath)) {
      skippedCount += 1;
      nodeDetailCount += 1;
      continue;
    }
    const { body } = await apiJson(`/api/graph/nodes/${encodeURIComponent(id)}`);
    await writeJson(relPath, body);
    nodeDetailCount += 1;
  }
  console.log(`  -> ${nodeDetailCount} node detail files present`);

  // --- Phase 3: diary windows (unfiltered + per-node filtered) ------------
  console.log('[capture] phase 3/8: diary windows');
  const granularities = ['day', 'week', 'month'];
  for (const g of granularities) {
    const relPath = `diary-${g}.json`;
    if (await fileExists(relPath)) {
      skippedCount += 1;
      continue;
    }
    const { body } = await apiJson(`/api/diary/windows?granularity=${g}`);
    await writeJson(relPath, body);
  }
  let diaryFilteredCount = 0;
  for (const id of nodeIds) {
    for (const g of granularities) {
      const relPath = `diary-filtered/${encodeURIComponent(id)}-${g}.json`;
      if (await fileExists(relPath)) {
        skippedCount += 1;
        diaryFilteredCount += 1;
        continue;
      }
      const { body } = await apiJson(
        `/api/diary/windows?granularity=${g}&filter_node_id=${encodeURIComponent(id)}`
      );
      await writeJson(relPath, body);
      diaryFilteredCount += 1;
    }
  }
  console.log(`  -> 3 unfiltered + ${diaryFilteredCount} filtered diary files present`);

  // --- Phase 4: page content per unique URL --------------------------------
  console.log('[capture] phase 4/8: page content');
  const uniqueUrls = [...new Set(graph.nodes.flatMap((n) => n.page_urls || []))];
  console.log(`  -> ${uniqueUrls.length} unique page_urls across all nodes`);
  const pagesIndex = (await readJsonIfExists('pages/index.json')) || {};
  const contentHits = []; // { pid, has_usable_html }
  let contentMisses = 0;
  for (const url of uniqueUrls) {
    const sha1 = createHash('sha1').update(url).digest('hex');
    const existing = pagesIndex[url];
    if (existing && existing.status === 'absent') {
      skippedCount += 1;
      contentMisses += 1;
      continue;
    }
    if (existing && existing.status === 'ok') {
      const cached = await readJsonIfExists(`pages/${existing.sha1}.json`);
      if (cached) {
        skippedCount += 1;
        contentHits.push({ pid: cached.pid, has_usable_html: !!cached.has_usable_html });
        continue;
      }
      // index said ok but the file is missing -- fall through and refetch.
    }
    const res = await apiFetch(`/api/pages/content?url=${encodeURIComponent(url)}`, { allow: [404] });
    const body = await res.json();
    if (res.status === 404) {
      pagesIndex[url] = { sha1, status: 'absent' };
      contentMisses += 1;
      continue;
    }
    await writeJson(`pages/${sha1}.json`, body);
    pagesIndex[url] = { sha1, pid: body.pid, status: 'ok' };
    contentHits.push({ pid: body.pid, has_usable_html: !!body.has_usable_html });
  }
  await writeJson('pages/index.json', pagesIndex);
  console.log(`  -> ${contentHits.length} hits, ${contentMisses} misses (404, recorded as absent)`);

  // --- Phase 5: previews for has_usable_html pages -------------------------
  console.log('[capture] phase 5/8: previews');
  const previewable = contentHits.filter((h) => h.has_usable_html);
  console.log(`  -> ${previewable.length} pages have has_usable_html:true`);
  const ASSET_RE = /(?:src|href)\s*=\s*["'](\/captured-assets\/[^"']+)["']/g;
  // Preview HTML carries signed asset URLs (`?u=<id>&exp=..&sig=..`, the
  // `&` HTML-escaped as `&amp;`). Strip the query from every
  // /captured-assets/ reference so neither the saved fixture HTML nor the
  // asset file names hold a user id or an expiring signature.
  const SIGNED_QS_RE = /(\/captured-assets\/[^"'?]+)\?[^"']*/g;
  const stripAssetQuery = (h) => h.replace(SIGNED_QS_RE, '$1');
  const assetPaths = new Set();
  let previewCount = 0;
  for (const { pid } of previewable) {
    const relPath = `previews/${pid}.html`;
    let html = await readTextIfExists(relPath);
    if (html !== null) {
      skippedCount += 1;
    } else {
      const res = await apiFetch(`/api/pages/${pid}/preview`);
      html = stripAssetQuery(await res.text());
      await writeRawBuffer(relPath, html);
    }
    html = stripAssetQuery(html);
    previewCount += 1;
    let m;
    ASSET_RE.lastIndex = 0;
    while ((m = ASSET_RE.exec(html)) !== null) {
      assetPaths.add(m[1]);
    }
  }
  console.log(`  -> ${previewCount} preview HTML files present; ${assetPaths.size} unique assets referenced`);

  // --- Phase 5b: download referenced assets (served by the Dash frontend) --
  console.log(`[capture] downloading ${assetPaths.size} unique assets from ${ASSETS_BACKEND} (concurrency=${ASSET_CONCURRENCY})...`);
  const assetList = [...assetPaths];
  let assetIdx = 0;
  let assetsDownloaded = 0;
  let assetsSkipped = 0;
  async function assetWorker() {
    while (assetIdx < assetList.length) {
      const myIdx = assetIdx;
      assetIdx += 1;
      const assetPath = assetList[myIdx];
      const outFull = resolveAssetWritePath(assetPath); // throws on traversal attempts
      if (await fileExistsAbs(outFull)) {
        skippedCount += 1;
        assetsSkipped += 1;
        assetsDownloaded += 1;
        continue;
      }
      const res = await apiFetchFrom(ASSETS_BACKEND, assetPath);
      const buf = Buffer.from(await res.arrayBuffer());
      await writeRawBufferAbs(outFull, buf);
      assetsDownloaded += 1;
      if (assetsDownloaded % 100 === 0) {
        console.log(`  ... ${assetsDownloaded}/${assetList.length} assets present (${assetsSkipped} skipped, already-captured)`);
      }
    }
  }
  await Promise.all(Array.from({ length: ASSET_CONCURRENCY }, assetWorker));
  console.log(`  -> ${assetsDownloaded}/${assetList.length} assets present (${assetsSkipped} skipped, already-captured)`);

  // --- Phase 6: header widgets ----------------------------------------------
  console.log('[capture] phase 6/8: widgets (clustering-status, topics, members, exclusions)');
  let clusteringStatus = await readJsonIfExists('clustering-status.json');
  if (clusteringStatus) {
    skippedCount += 1;
  } else {
    ({ body: clusteringStatus } = await apiJson('/api/clustering/status'));
    await writeJson('clustering-status.json', clusteringStatus);
  }
  let topicsBody = await readJsonIfExists('topics.json');
  if (topicsBody) {
    skippedCount += 1;
  } else {
    ({ body: topicsBody } = await apiJson('/api/topics'));
    await writeJson('topics.json', topicsBody);
  }
  const topics = topicsBody.topics || [];
  for (const t of topics) {
    for (const limit of [5, 50]) {
      const relPath = `members/${encodeURIComponent(t.keyword)}-${limit}.json`;
      if (await fileExists(relPath)) {
        skippedCount += 1;
        continue;
      }
      const { body } = await apiJson(`/api/topics/${encodeURIComponent(t.keyword)}/members?limit=${limit}`);
      await writeJson(relPath, body);
    }
  }
  let exclusions = await readJsonIfExists('exclusions.json');
  if (exclusions) {
    skippedCount += 1;
  } else {
    ({ body: exclusions } = await apiJson('/api/topics/exclusions'));
    await writeJson('exclusions.json', exclusions);
  }
  console.log(`  -> clustering-status, ${topics.length} topics, ${topics.length * 2} member files, exclusions`);

  // --- Phase 7: auth reads + internals --------------------------------------
  console.log('[capture] phase 7/8: auth (me, preferences) + internals');
  let me = await readJsonIfExists('me.json');
  if (me) {
    skippedCount += 1;
  } else {
    ({ body: me } = await apiJson('/api/auth/me'));
    await writeJson('me.json', me);
  }
  let preferences = await readJsonIfExists('preferences.json');
  if (preferences) {
    skippedCount += 1;
  } else {
    ({ body: preferences } = await apiJson('/api/auth/preferences'));
    await writeJson('preferences.json', preferences);
  }
  // /api/agent/internals is admin-gated; a 403 "Admin access required" is a
  // documented first-class response for the plain-demo role (endpoints.md),
  // not a capture-tool failure. Whatever comes back is saved as-is.
  let internalsBody = await readJsonIfExists('internals.json');
  let internalsStatus = internalsBody ? 'cached' : null;
  if (internalsBody) {
    skippedCount += 1;
  } else {
    const internalsRes = await apiFetch('/api/agent/internals', { allow: [403] });
    internalsStatus = internalsRes.status;
    internalsBody = await internalsRes.json();
    await writeJson('internals.json', internalsBody);
  }
  console.log(`  -> internals: ${internalsStatus === 'cached' ? 'already captured' : `HTTP ${internalsStatus}`}`);

  // --- Phase 8: chat SSE streams --------------------------------------------
  console.log('[capture] phase 8/8: chat (agent query-stream)');
  const questions = await loadQuestions();
  console.log(`  -> ${questions.length} questions loaded from questions.txt`);
  const existingChatIndex = (await readJsonIfExists('chat/index.json')) || [];
  const existingByN = new Map(existingChatIndex.map((e) => [e.n, e]));
  const chatIndex = [];
  let chatOk = 0;
  let chatFailed = 0;
  for (let i = 0; i < questions.length; i++) {
    const question = questions[i];
    const nn = String(i + 1).padStart(2, '0');
    const relFile = `chat/${nn}.sse`;
    const fullFile = path.join(OUT_ROOT, relFile);

    const prior = existingByN.get(nn);
    if (prior && prior.ok && (await fileExists(relFile))) {
      skippedCount += 1;
      chatOk += 1;
      console.log(`  [${nn}/${questions.length}] already captured ok; skipping.`);
      chatIndex.push(prior);
      continue;
    }

    await ensureDirFor(fullFile);
    console.log(`  [${nn}/${questions.length}] "${question.slice(0, 70)}${question.length > 70 ? '...' : ''}"`);
    const startedAt = Date.now();
    let httpStatus = null;
    let errorMsg = null;
    let sawComplete = false;
    try {
      const res = await fetch(`${BACKEND}/api/agent/query-stream`, {
        method: 'POST',
        headers: { ...authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: question }),
      });
      requestCount += 1;
      httpStatus = res.status;
      if (!res.body) {
        throw new Error('response had no readable body stream');
      }
      const fileStream = createWriteStream(fullFile);
      let fullText = '';
      const decoder = new TextDecoder();
      const reader = res.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          fileStream.write(value); // raw bytes, verbatim -- never fabricated
          fullText += decoder.decode(value, { stream: true });
        }
      }
      fullText += decoder.decode();
      await new Promise((resolve, reject) => fileStream.end((err) => (err ? reject(err) : resolve())));
      sawComplete = /"type"\s*:\s*"complete"/.test(fullText);
      if (!res.ok) {
        errorMsg = `HTTP ${res.status}`;
      } else if (!sawComplete) {
        errorMsg = 'stream ended without a "complete" event';
      }
    } catch (err) {
      errorMsg = err.message;
    }
    const elapsedS = Number(((Date.now() - startedAt) / 1000).toFixed(1));
    const ok = !errorMsg;
    if (ok) {
      chatOk += 1;
      console.log(`    -> ok (${elapsedS}s)`);
    } else {
      chatFailed += 1;
      console.warn(`    -> FAILED (${elapsedS}s): ${errorMsg}`);
    }
    const entry = { n: nn, question, file: relFile, ok, http_status: httpStatus, error: errorMsg, elapsed_s: elapsedS };
    chatIndex.push(entry);
    // Persist incrementally so a crash mid-phase-8 doesn't lose earlier results.
    await writeJson('chat/index.json', chatIndex);
  }
  await writeJson('chat/index.json', chatIndex);

  // --- Summary ---------------------------------------------------------------
  console.log('');
  console.log('=== Capture complete ===');
  console.log(`  requests issued: ${requestCount} (${skippedCount} skipped as already-captured)`);
  console.log(`  graph nodes: ${graph.nodes.length} (+ 4 window variants)`);
  console.log(`  node details: ${nodeDetailCount}`);
  console.log(`  diary: 3 unfiltered + ${diaryFilteredCount} filtered`);
  console.log(`  page content: ${contentHits.length} hits, ${contentMisses} misses (${uniqueUrls.length} unique urls)`);
  console.log(`  previews: ${previewCount} (of ${previewable.length} has_usable_html)`);
  console.log(`  assets: ${assetsDownloaded}/${assetList.length} unique assets present`);
  console.log(`  widgets: clustering-status, ${topics.length} topics, ${topics.length * 2} member files, exclusions`);
  console.log(`  internals: ${internalsStatus === 'cached' ? 'already captured' : `HTTP ${internalsStatus}`}`);
  console.log(`  chat: ${chatOk} ok / ${chatFailed} failed (of ${questions.length})`);
  if (chatFailed > 0) {
    console.warn(`  WARNING: ${chatFailed} chat capture(s) failed -- see raw/chat/index.json for details.`);
    // All remaining questions still ran (chat failures are per-question, not
    // fatal to the loop) but the run as a whole must not report success: a
    // future re-capture must not exit clean while chat fixtures are broken.
    process.exitCode = 1;
  }
  console.log('Done.');
}

main().catch((err) => {
  console.error('');
  console.error(`[capture] FATAL: ${err.message}`);
  console.error(`  requests issued before failure: ${requestCount}`);
  process.exitCode = 1;
});
