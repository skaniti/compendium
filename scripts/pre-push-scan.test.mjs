// node --test scripts/pre-push-scan.test.mjs
// Exercises pre-push-scan.sh against throwaway repos (no network, no pushes).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dirname, "pre-push-scan.sh");
const realGitleaks = spawnSync("bash", ["-c", "command -v gitleaks || ls ~/go/bin/gitleaks"], { encoding: "utf8" }).stdout.trim().split("\n")[0];
const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8" });

function makeRepo(files) {
  const d = mkdtempSync(join(tmpdir(), "pps-"));
  git(d, "init", "-q", "-b", "main");
  git(d, "config", "user.email", "t@example.invalid");
  git(d, "config", "user.name", "t");
  git(d, "config", "commit.gpgsign", "false");
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(d, p, ".."), { recursive: true });
    writeFileSync(join(d, p), c);
  }
  git(d, "add", "-A");
  git(d, "commit", "-q", "-m", "t");
  return d;
}
function terms(d) {
  const f = join(d, "terms.txt");
  writeFileSync(f, "# c\nzz-private-marker\n");
  return f;
}
function stubGitleaks(d, code) {
  const f = join(d, "gl-stub");
  writeFileSync(f, `#!/bin/sh\nexit ${code}\n`);
  chmodSync(f, 0o755);
  return f;
}
const run = (d, env) =>
  spawnSync("bash", [script, "--check", "HEAD"], { cwd: d, encoding: "utf8", env: { ...process.env, ...env } });

test("clean repo passes (gitleaks stubbed clean)", () => {
  const d = makeRepo({ "a.txt": "hello\n" });
  const r = run(d, { GITLEAKS_BIN: stubGitleaks(d, 0), SCAN_TERMS_FILE: terms(d) });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /pre-push-scan: OK/);
});

test("gitleaks findings refuse", () => {
  const d = makeRepo({ "a.txt": "hello\n" });
  const r = run(d, { GITLEAKS_BIN: stubGitleaks(d, 1), SCAN_TERMS_FILE: terms(d) });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /REFUSED/);
});

test("missing gitleaks fails closed", () => {
  const d = makeRepo({ "a.txt": "hello\n" });
  const r = run(d, { GITLEAKS_BIN: join(d, "nope"), SCAN_TERMS_FILE: terms(d) });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /gitleaks not found/);
});

test("plan-path citation in a tracked non-doc file refuses", () => {
  const d = makeRepo({ "src/x.js": "// see docs/project-plans/foo\n" });
  const r = run(d, { GITLEAKS_BIN: stubGitleaks(d, 0), SCAN_TERMS_FILE: terms(d) });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /plan-path citation/);
});

test("plan-path citation under docs/ is allowed", () => {
  const d = makeRepo({ "docs/x.md": "docs/project-plans/foo\n" });
  const r = run(d, { GITLEAKS_BIN: stubGitleaks(d, 0), SCAN_TERMS_FILE: terms(d) });
  assert.equal(r.status, 0, r.stderr);
});

test("identifier term hit refuses; missing terms file fails closed", () => {
  const d = makeRepo({ "src/x.js": "const a = 'zz-private-marker';\n" });
  const r = run(d, { GITLEAKS_BIN: stubGitleaks(d, 0), SCAN_TERMS_FILE: terms(d) });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /identifier matrix hit/);
  const r2 = run(d, { GITLEAKS_BIN: stubGitleaks(d, 0), SCAN_TERMS_FILE: join(d, "absent") });
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /terms file missing/);
});

test("real gitleaks: planted fake key refused, clean input passes", { skip: !existsSync(realGitleaks) }, () => {
  // Assembled at runtime so this file itself stays clean under gitleaks.
  const pre = "gh" + "p_";
  const fake = pre + "aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5";
  const bad = makeRepo({ "cfg.txt": `github_token = "${fake}"\n` });
  const r = run(bad, { GITLEAKS_BIN: realGitleaks, SCAN_TERMS_FILE: terms(bad) });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const ok = makeRepo({ "a.txt": "hello\n" });
  const r2 = run(ok, { GITLEAKS_BIN: realGitleaks, SCAN_TERMS_FILE: terms(ok) });
  assert.equal(r2.status, 0, r2.stderr);
});
