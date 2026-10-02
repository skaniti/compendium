#!/usr/bin/env node
// Records the Prompts dev-view's backend responses from a seeded backend into
// demo/fixtures/raw/prompts/: summary.json (the plain-demo shape, admin null)
// and templates.json (every registry prompt's /templates/<name> response keyed
// by name). The stub replays these (demo/lib/prompts.mjs). BACKEND defaults to
// the ad-hoc :8012 apps/api (never :8001), which must run with
// PROMPT_OVERRIDES_PATH and EVAL_RUNS_DIR empty.
//
// login()/writeJson()/apiJson() are trimmed copies of the same-named helpers in
// capture-clusters-fixtures.mjs; a failed login is fatal here.
//
// Usage: BACKEND=http://127.0.0.1:8012 CAPTURE_LOGIN_EMAIL=<email> \
//          node demo/tools/capture-prompts-fixtures.mjs
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
  console.log(`[capture-prompts] logging in as ${LOGIN_EMAIL} at ${BACKEND}...`);
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
  const summary = await apiJson('/api/prompts/summary');
  if (summary.admin !== null) throw new Error('summary.admin is not null: the recording must be the plain-demo shape');
  await writeJson('prompts/summary.json', summary);
  const names = summary.tasks.flatMap((t) => t.prompts.map((p) => p.name));
  console.log(`[capture-prompts] summary.json <- /api/prompts/summary (${summary.tasks.length} tasks, ${names.length} prompts)`);

  const templates = {};
  for (const [i, name] of names.entries()) {
    const d = await apiJson(`/api/prompts/templates/${name}`);
    if ('override' in d || d.overridden === true) throw new Error(`template ${name} carries an override: record with PROMPT_OVERRIDES_PATH empty`);
    templates[name] = d;
    if ((i + 1) % 100 === 0) console.log(`[capture-prompts] templates ${i + 1}/${names.length}`);
  }
  await writeJson('prompts/templates.json', templates);
  console.log(`[capture-prompts] templates.json <- ${names.length} template routes`);
  console.log('[capture-prompts] done');
}
main().catch((e) => { console.error(e); process.exit(1); });
