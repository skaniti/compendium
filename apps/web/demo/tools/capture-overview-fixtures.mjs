#!/usr/bin/env node
// Records the Overview dev-view's one backend-only input from a seeded backend
// into demo/fixtures/raw/overview/summary.json: the latest-run clusters block
// (the stub computes everything else from the Pipeline pages + the demo seed's
// captures). BACKEND defaults to the ad-hoc :8012 apps/api (never :8001).
//
// login()/writeJson()/apiJson() are trimmed copies of the same-named helpers in
// capture-pipeline-fixtures.mjs (which runs its main() on import); a failed
// login is fatal here.
//
// Usage: BACKEND=http://127.0.0.1:8012 CAPTURE_LOGIN_EMAIL=<email> \
//          node demo/tools/capture-overview-fixtures.mjs
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_ROOT = path.resolve(__dirname, '..', 'fixtures', 'raw');
const BACKEND = process.env.BACKEND || 'http://127.0.0.1:8012';
const LOGIN_EMAIL = process.env.CAPTURE_LOGIN_EMAIL || 'demo@example.local';
const LOGIN_PASSWORD = 'demo';

let authHeader = {};

const PATHS = {
  'summary.json': '/api/overview/summary?range=all&tz=UTC',
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
  console.log(`[capture-overview] logging in as ${LOGIN_EMAIL} at ${BACKEND}...`);
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
  for (const [file, p] of Object.entries(PATHS)) {
    const { body } = await apiJson(p);
    await writeJson(`overview/${file}`, body);
    console.log(`[capture-overview] ${file} <- ${p}`);
  }
  console.log('[capture-overview] done');
}
main().catch((e) => { console.error(e); process.exit(1); });
