#!/usr/bin/env node
// Records the v2 Pipeline dev-view inputs from a seeded backend into
// demo/fixtures/raw/pipeline/: every page (the stub computes summary counts,
// timeline and windowed pages from them) plus one summary (for its
// skip_gate_config). BACKEND defaults to the ad-hoc :8011 apps/api (never
// :8001).
//
// login()/writeJson() are trimmed copies of the same-named helpers in
// capture-fixtures.mjs (which runs its main() on import, so it cannot be
// imported); unlike that tool, a failed login is fatal here.
//
// Usage: BACKEND=http://127.0.0.1:8011 CAPTURE_LOGIN_EMAIL=<email> \
//          node demo/tools/capture-pipeline-fixtures.mjs
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_ROOT = path.resolve(__dirname, '..', 'fixtures', 'raw');
const BACKEND = process.env.BACKEND || 'http://127.0.0.1:8011';
const LOGIN_EMAIL = process.env.CAPTURE_LOGIN_EMAIL || 'demo@example.local';
const LOGIN_PASSWORD = 'demo';

let authHeader = {};

const PATHS = {
  'summary.json': '/api/pipeline/summary?range=all&tz=UTC',
};

async function writeJson(relPath, data) {
  const full = path.join(OUT_ROOT, relPath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, JSON.stringify(data, null, 2) + '\n');
}

async function apiJson(pathAndQuery) {
  const res = await fetch(`${BACKEND}${pathAndQuery}`, { headers: { ...authHeader } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for GET ${BACKEND}${pathAndQuery}: ${(await res.text()).slice(0, 300)}`);
  return { status: res.status, body: await res.json() };
}

async function login() {
  console.log(`[capture-pipeline] logging in as ${LOGIN_EMAIL} at ${BACKEND}...`);
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
  // pages: the router caps limit at 200, so page through until total is reached
  // and store one merged response (rows = every page, total = row count).
  const rows = [];
  let total = 0;
  do {
    const { body } = await apiJson(`/api/pipeline/pages?limit=200&offset=${rows.length}&sort=created_at&dir=desc&range=all&tz=UTC`);
    total = body.total;
    if (body.rows.length === 0) break;
    rows.push(...body.rows);
  } while (rows.length < total);
  await writeJson('pipeline/pages.json', { rows, total });
  console.log(`[capture-pipeline] pages.json <- ${rows.length}/${total} rows`);
  for (const [file, p] of Object.entries(PATHS)) {
    const { body } = await apiJson(p);
    await writeJson(`pipeline/${file}`, body);
    console.log(`[capture-pipeline] ${file} <- ${p}`);
  }
  console.log('[capture-pipeline] done');
}
main().catch((e) => { console.error(e); process.exit(1); });
