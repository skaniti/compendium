#!/usr/bin/env node
// Records the Clusters dev-view's backend responses from a seeded backend into
// demo/fixtures/raw/clusters/: summary.json, members.json (every cluster's
// /pages response keyed by cluster id) and unclustered.json (all pages of
// /unclustered, plus the featured / since_run counts from the summary). The
// stub replays these (demo/lib/clusters.mjs). BACKEND defaults to the ad-hoc
// :8012 apps/api (never :8001).
//
// login()/writeJson()/apiJson() are trimmed copies of the same-named helpers in
// capture-overview-fixtures.mjs; a failed login is fatal here.
//
// Usage: BACKEND=http://127.0.0.1:8012 CAPTURE_LOGIN_EMAIL=<email> \
//          node demo/tools/capture-clusters-fixtures.mjs
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_ROOT = path.resolve(__dirname, '..', 'fixtures', 'raw');
const BACKEND = process.env.BACKEND || 'http://127.0.0.1:8012';
const LOGIN_EMAIL = process.env.CAPTURE_LOGIN_EMAIL || 'demo@example.local';
const LOGIN_PASSWORD = 'demo';

let authHeader = {};

async function writeJson(relPath, data) {
  const full = path.join(OUT_ROOT, relPath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, JSON.stringify(data, null, 2) + '\n');
}

async function apiJson(pathAndQuery) {
  const res = await fetch(`${BACKEND}${pathAndQuery}`, { headers: { ...authHeader } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for GET ${BACKEND}${pathAndQuery}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

async function login() {
  console.log(`[capture-clusters] logging in as ${LOGIN_EMAIL} at ${BACKEND}...`);
  const res = await fetch(`${BACKEND}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: LOGIN_EMAIL, password: LOGIN_PASSWORD }),
  });
  if (!res.ok) throw new Error(`login failed: HTTP ${res.status}`);
  authHeader = { Authorization: `Bearer ${(await res.json()).access_token}` };
}

async function main() {
  await login();
  const summary = await apiJson('/api/clusters/summary');
  await writeJson('clusters/summary.json', summary);
  console.log(`[capture-clusters] summary.json <- /api/clusters/summary (${summary.clusters.length} clusters)`);

  const members = {};
  for (const [i, c] of summary.clusters.entries()) {
    const body = await apiJson(`/api/clusters/${c.id}/pages`);
    if (body.total !== c.size) throw new Error(`cluster ${c.id}: members total ${body.total} != size ${c.size}`);
    members[String(c.id)] = body;
    if ((i + 1) % 100 === 0) console.log(`[capture-clusters] members ${i + 1}/${summary.clusters.length}`);
  }
  await writeJson('clusters/members.json', members);
  console.log(`[capture-clusters] members.json <- ${summary.clusters.length} cluster routes`);

  const pages = [];
  let total = 0;
  for (let offset = 0; ; offset += 200) {
    const body = await apiJson(`/api/clusters/unclustered?limit=200&offset=${offset}`);
    total = body.total;
    pages.push(...body.pages);
    if (offset + 200 >= total) break;
  }
  const expected = summary.pages ? summary.pages.not_clustered : 0;
  if (total !== expected || pages.length !== total) throw new Error(`unclustered total ${total} (${pages.length} rows) != summary not_clustered ${expected}`);
  await writeJson('clusters/unclustered.json', {
    total,
    featured: summary.pages ? summary.pages.featured : 0,
    since_run: summary.pages ? summary.pages.since_run : 0,
    pages,
  });
  console.log(`[capture-clusters] unclustered.json <- ${total} pages`);
  console.log('[capture-clusters] done');
}
main().catch((e) => { console.error(e); process.exit(1); });
