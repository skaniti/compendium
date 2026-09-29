// node --test scripts/ops-run.test.mjs
// Exercises apps/api/scripts/server/ops-run.sh against a temp journal dir.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const wrapper = resolve(import.meta.dirname, "../apps/api/scripts/server/ops-run.sh");
// Assembled at runtime so no token-shaped literal is committed.
const FAKE = "hf_" + "aB3dE5gH".repeat(4);
const EXACT = "exact" + "Val" + "ue99";

function setup() {
  const d = mkdtempSync(join(tmpdir(), "ops-"));
  const journal = join(d, "journal");
  mkdirSync(join(journal, "runs"), { recursive: true });
  const secrets = join(d, "secrets");
  writeFileSync(secrets, `MY_KEY=${EXACT}\n`);
  const script = join(d, "noisy.sh");
  writeFileSync(script, `#!/bin/sh\necho "out ${FAKE}"\necho "err ${EXACT}" >&2\necho "args: $1|$2"\nexit 3\n`);
  chmodSync(script, 0o755);
  return { d, journal, secrets, script };
}
const run = (env, args) =>
  spawnSync("bash", [wrapper, ...args], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: env.d, OPS_JOURNAL_DIR: env.journal, OPS_MASK_SECRETS: env.secrets } });

test("journals start and end, propagates exit, masks the run log", () => {
  const e = setup();
  const r = run(e, [e.script, 'a "quoted" arg', "two words"]);
  assert.equal(r.status, 3);
  assert.match(r.stdout, new RegExp(FAKE), "terminal keeps raw output");
  assert.match(r.stdout, /args: a "quoted" arg\|two words/);

  const lines = readFileSync(join(e.journal, "journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  const [start, end] = lines;
  for (const l of lines) {
    for (const k of ["ts", "run_id", "phase", "script", "argv", "cwd", "git_sha", "host_user"]) assert.ok(k in l, k);
    assert.deepEqual(l.argv, ['a "quoted" arg', "two words"]);
    assert.equal(l.script, e.script);
  }
  assert.equal(start.phase, "start");
  assert.equal(end.phase, "end");
  assert.equal(end.exit, 3);
  assert.equal(typeof end.duration_s, "number");
  assert.equal(start.run_id, end.run_id);
  assert.match(start.run_id, /^\d{4}-\d{2}-\d{2}-\d{6}-noisy\.sh$/);

  const logs = readdirSync(join(e.journal, "runs"));
  assert.deepEqual(logs, [`${start.run_id}.log`]);
  const log = readFileSync(join(e.journal, "runs", logs[0]), "utf8");
  assert.ok(!log.includes(FAKE));
  assert.ok(!log.includes(EXACT));
  assert.match(log, /<REDACTED:token>/);
  assert.match(log, /<SECRET:MY_KEY>/);
});

test("refuses with exit 2 when the journal dir is missing", () => {
  const e = setup();
  e.journal = join(e.d, "absent");
  const r = run(e, [e.script]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /section-22/);
});

test("stdin passes through to the wrapped command", () => {
  const e = setup();
  const s = join(e.d, "reader.sh");
  writeFileSync(s, '#!/bin/sh\nread x\necho "got:$x"\n');
  chmodSync(s, 0o755);
  const r = spawnSync("bash", [wrapper, s], { encoding: "utf8", input: "hello\n", env: { PATH: process.env.PATH, HOME: e.d, OPS_JOURNAL_DIR: e.journal, OPS_MASK_SECRETS: e.secrets } });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /got:hello/);
});

test("a dying mask filter never aborts the wrapped command", () => {
  const e = setup();
  const filter = join(e.d, "dead_filter.py");
  writeFileSync(filter, "import sys\nsys.exit(1)\n");
  const s = join(e.d, "five.sh");
  writeFileSync(s, "#!/bin/sh\nfor i in 1 2 3 4 5; do echo line$i; done\nexit 4\n");
  chmodSync(s, 0o755);
  const r = spawnSync("bash", [wrapper, s], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: e.d, OPS_JOURNAL_DIR: e.journal, OPS_MASK_SECRETS: e.secrets, OPS_MASK_SCRIPT: filter } });
  assert.equal(r.status, 4);
  assert.equal((r.stdout.match(/line\d/g) || []).length, 5);
  const lines = readFileSync(join(e.journal, "journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[1].exit, 4);
  assert.equal(lines[1].mask_failed, true);
  assert.match(r.stderr, /mask filter failed/);
});

test("refuses with exit 2 when python3 is not on PATH", () => {
  const e = setup();
  const bin = join(e.d, "bin");
  mkdirSync(bin);
  for (const t of ["bash", "dirname", "basename", "date", "id", "mktemp", "cat", "rm", "tee", "git", "readlink"]) {
    const p = spawnSync("bash", ["-c", `command -v ${t}`], { encoding: "utf8" }).stdout.trim();
    if (p) spawnSync("ln", ["-s", p, join(bin, t)]);
  }
  const r = spawnSync("bash", [wrapper, e.script], { encoding: "utf8", env: { PATH: bin, HOME: e.d, OPS_JOURNAL_DIR: e.journal } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /python3/);
});

test("git_sha is the full sha of the checkout containing the script", () => {
  const e = setup();
  const r = run(e, [wrapper.replace(/ops-run\.sh$/, "ops_mask.py"), "--version"]);
  void r;
  const lines = readFileSync(join(e.journal, "journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.match(lines[0].git_sha, /^[0-9a-f]{40}$/);
});
