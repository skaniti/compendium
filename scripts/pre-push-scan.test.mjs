// node --test scripts/pre-push-scan.test.mjs
// Exercises pre-push-scan.sh against throwaway repos (no network, no pushes).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Assembled at runtime so this file does not match the gate's own plan-path grep.
const PLAN = "docs/project-" + "plans";
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
  const d = makeRepo({ "src/x.js": `// see ${PLAN}/foo\n` });
  const r = run(d, { GITLEAKS_BIN: stubGitleaks(d, 0), SCAN_TERMS_FILE: terms(d) });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /plan-path citation/);
});

test("plan-path citation under docs/ is allowed", () => {
  const d = makeRepo({ "docs/x.md": `${PLAN}/foo\n` });
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

test("comments-only terms file fails closed", () => {
  const d = makeRepo({ "a.txt": "hello\n" });
  const f = join(d, "c.txt");
  writeFileSync(f, "# only a comment\n\n");
  const r = run(d, { GITLEAKS_BIN: stubGitleaks(d, 0), SCAN_TERMS_FILE: f });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /comments only/);
});

test("scan-ok marker suppresses only in test_url_guard.py", () => {
  const line = "x = 'zz-private-marker'  # scan-ok: test-ip\n";
  const other = makeRepo({ "src/other.py": line });
  const r = run(other, { GITLEAKS_BIN: stubGitleaks(other, 0), SCAN_TERMS_FILE: terms(other) });
  assert.equal(r.status, 1, "marker in another file must not suppress");
  const allowed = makeRepo({ "apps/api/tests/test_url_guard.py": line });
  const r2 = run(allowed, { GITLEAKS_BIN: stubGitleaks(allowed, 0), SCAN_TERMS_FILE: terms(allowed) });
  assert.equal(r2.status, 0, r2.stderr);
  const noMarker = makeRepo({ "apps/api/tests/test_url_guard.py": "x = 'zz-private-marker'\n" });
  const r3 = run(noMarker, { GITLEAKS_BIN: stubGitleaks(noMarker, 0), SCAN_TERMS_FILE: terms(noMarker) });
  assert.equal(r3.status, 1, "path alone must not suppress");
});

test("build-fixtures.mjs is suppressed only on lines 20 and 655", () => {
  const mk = (n) => "x\n".repeat(n - 1) + "zz-private-marker\n";
  for (const [n, want] of [[20, 0], [21, 1]]) {
    const d = makeRepo({ "apps/web/demo/tools/build-fixtures.mjs": mk(n) });
    const r = run(d, { GITLEAKS_BIN: stubGitleaks(d, 0), SCAN_TERMS_FILE: terms(d) });
    assert.equal(r.status, want, `line ${n}: ${r.stderr}`);
  }
});

test("--hook: multi-ref, deletion skipped, new branch, relative env paths", () => {
  const d = makeRepo({ "a.txt": "hello\n" });
  const sha = git(d, "rev-parse", "HEAD").trim();
  const zero = "0".repeat(40);
  const hook = (input) =>
    spawnSync("bash", [script, "--hook"], { cwd: d, input, encoding: "utf8",
      env: { ...process.env, GITLEAKS_BIN: "./gl-stub", SCAN_TERMS_FILE: "terms.txt" } });
  stubGitleaks(d, 0); terms(d);
  const multi = hook(`refs/heads/a ${sha} refs/heads/a ${zero}\nrefs/heads/b ${sha} refs/heads/b ${sha}\n`);
  assert.equal(multi.status, 0, multi.stderr);
  assert.equal((multi.stdout.match(/pre-push-scan: start/g) || []).length, 2);
  assert.match(multi.stdout, /range=\[.* --not --remotes\]/); // new branch
  const del = hook(`(delete) ${zero} refs/heads/gone ${sha}\n`);
  assert.equal(del.status, 0);
  assert.match(del.stdout, /nothing to scan/);
  assert.doesNotMatch(del.stdout, /start/);
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
