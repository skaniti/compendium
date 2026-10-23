// node --test scripts/setup-env.test.mjs
// Exercises setup-env.sh against throwaway directories. It never touches a
// repo-root .env: every run gets --output into a temp dir (or a copy of the
// script in a temp tree, for the default-path test).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync,
  statSync, symlinkSync, copyFileSync, lstatSync, readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dirname, "setup-env.sh");
const BASH = spawnSync("bash", ["-c", "command -v bash"], { encoding: "utf8" }).stdout.trim();
const realExample = resolve(import.meta.dirname, "..", ".env.example");
const REAL_TEMPLATE = readFileSync(realExample, "utf8");

// Keep the developer's own shell from leaking values into a run.
const SCRUB = [
  "BOOTSTRAP_EMAIL", "BOOTSTRAP_PASSWORD", "BOOTSTRAP_NAME", "OPENAI_API_KEY",
  "JWT_SECRET_KEY", "SESSION_INGRESS_TRUSTED_VALUE", "API_BIND_ADDRESS",
  "CORS_ORIGINS", "FRONTEND_URL", "ANTHROPIC_API_KEY", "EXTRA_THING",
];
function baseEnv() {
  const e = { ...process.env };
  for (const k of SCRUB) delete e[k];
  return e;
}

function sandbox(template = REAL_TEMPLATE) {
  const dir = mkdtempSync(join(tmpdir(), "setup-env-"));
  const example = join(dir, "env.example");
  writeFileSync(example, template);
  return { dir, example, out: join(dir, ".env") };
}
function run(sb, { input = "", env = {}, args = [], baseline } = {}) {
  return spawnSync(BASH, [script, "--example", sb.example, "--output", sb.out, ...args], {
    input, encoding: "utf8", env: { ...(baseline ?? baseEnv()), ...env },
  });
}
const lines = (...a) => a.join("\n") + "\n";
const read = (sb) => readFileSync(sb.out, "utf8");
function parse(text) {
  const o = {};
  for (const l of text.split("\n")) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(l);
    if (m) o[m[1]] = m[2];
  }
  return o;
}
const EMAIL = "me@example.com";
const PASS = "correct-horse-9";
const OAI = "sk-test-0123456789abcdef";
const ALL = lines(EMAIL, PASS, OAI);
const ENV_ALL = { BOOTSTRAP_EMAIL: EMAIL, BOOTSTRAP_PASSWORD: PASS, OPENAI_API_KEY: OAI };

test("writes .env from the real .env.example: filled, generated, comments kept, mode 600", () => {
  const sb = sandbox();
  const r = run(sb, { input: ALL });
  assert.equal(r.status, 0, r.stderr);
  const text = read(sb);
  const v = parse(text);
  assert.equal(v.BOOTSTRAP_EMAIL, EMAIL);
  assert.equal(v.BOOTSTRAP_PASSWORD, PASS);
  assert.equal(v.OPENAI_API_KEY, OAI);
  assert.match(v.JWT_SECRET_KEY, /^[0-9a-f]{64}$/);
  assert.match(v.SESSION_INGRESS_TRUSTED_VALUE, /^[0-9a-f]{64}$/);
  assert.notEqual(v.JWT_SECRET_KEY, v.SESSION_INGRESS_TRUSTED_VALUE);
  // Every template line that is not an empty KEY= survives, in order.
  const kept = REAL_TEMPLATE.split("\n").filter((l) => !/^[A-Za-z_]\w*=$/.test(l));
  const out = text.split("\n");
  let at = 0;
  for (const l of kept) {
    const i = out.indexOf(l, at);
    assert.notEqual(i, -1, `template line lost: ${l}`);
    at = i + 1;
  }
  assert.equal(statSync(sb.out).mode & 0o777, 0o600);
  assert.match(r.stdout, /docker compose up --build/);
  assert.match(r.stdout, /rotate_api_key/);
});

test("two runs generate different secrets", () => {
  const a = sandbox(), b = sandbox();
  run(a, { input: ALL });
  run(b, { input: ALL });
  assert.notEqual(parse(read(a)).JWT_SECRET_KEY, parse(read(b)).JWT_SECRET_KEY);
});

test("never echoes the password, the API key or the generated secrets", () => {
  const sb = sandbox();
  const r = run(sb, { input: ALL });
  assert.equal(r.status, 0, r.stderr);
  const v = parse(read(sb));
  for (const secret of [PASS, OAI, v.JWT_SECRET_KEY, v.SESSION_INGRESS_TRUSTED_VALUE]) {
    assert.ok(!r.stdout.includes(secret), "secret in stdout");
    assert.ok(!r.stderr.includes(secret), "secret in stderr");
  }
});

test("refuses to overwrite an existing .env and leaves it untouched", () => {
  const sb = sandbox();
  writeFileSync(sb.out, "KEEP=me\n");
  const r = run(sb, { input: ALL });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /REFUSED/);
  assert.match(r.stderr, /already exists/);
  assert.equal(read(sb), "KEEP=me\n");
});

test("refuses a dangling symlink at the output path", () => {
  const sb = sandbox();
  symlinkSync(join(sb.dir, "nowhere"), sb.out);
  const r = run(sb, { input: ALL });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /already exists/);
  assert.ok(lstatSync(sb.out).isSymbolicLink());
  assert.ok(!existsSync(join(sb.dir, "nowhere")));
});

test("values from same-named environment variables skip the prompts", () => {
  const sb = sandbox();
  const r = run(sb, { input: "", env: ENV_ALL });
  assert.equal(r.status, 0, r.stderr);
  const v = parse(read(sb));
  assert.equal(v.BOOTSTRAP_EMAIL, EMAIL);
  assert.equal(v.OPENAI_API_KEY, OAI);
  assert.match(r.stdout, /BOOTSTRAP_EMAIL.*environment/);
  assert.match(r.stdout, /JWT_SECRET_KEY.*generated/);
  for (const secret of [PASS, OAI]) assert.ok(!r.stdout.includes(secret) && !r.stderr.includes(secret));
});

test("rejects bad values from the environment and writes nothing", () => {
  const cases = [
    ["BOOTSTRAP_EMAIL", "not-an-email", /BOOTSTRAP_EMAIL/],
    ["BOOTSTRAP_EMAIL", "a b@example.com", /BOOTSTRAP_EMAIL/],
    ["BOOTSTRAP_EMAIL", "me@localhost", /BOOTSTRAP_EMAIL/],
    ["BOOTSTRAP_PASSWORD", "short7!", /8 to 128/],
    ["BOOTSTRAP_PASSWORD", "x".repeat(129), /8 to 128/],
    ["BOOTSTRAP_PASSWORD", "line1\nline2-long", /BOOTSTRAP_PASSWORD/],
    ["OPENAI_API_KEY", "sk has space", /OPENAI_API_KEY/],
  ];
  for (const [key, bad, expected] of cases) {
    const sb = sandbox();
    const r = run(sb, { env: { ...ENV_ALL, [key]: bad } });
    assert.equal(r.status, 2, `${key}=${JSON.stringify(bad).slice(0, 20)}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, expected);
    assert.ok(!existsSync(sb.out), "file written despite invalid value");
    if (bad.length >= 7) assert.ok(!r.stderr.includes(bad) && !r.stdout.includes(bad), "invalid value echoed");
  }
});

test("accepts an 8 and a 128 character password", () => {
  for (const pw of ["abcdefgh", "p".repeat(128)]) {
    const sb = sandbox();
    const r = run(sb, { env: { ...ENV_ALL, BOOTSTRAP_PASSWORD: pw } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(parse(read(sb)).BOOTSTRAP_PASSWORD, pw);
  }
});

test("a bad answer at a prompt is asked again", () => {
  const sb = sandbox();
  const r = run(sb, { input: lines("nope", EMAIL, "short", PASS, OAI) });
  assert.equal(r.status, 0, r.stderr);
  const v = parse(read(sb));
  assert.equal(v.BOOTSTRAP_EMAIL, EMAIL);
  assert.equal(v.BOOTSTRAP_PASSWORD, PASS);
  assert.match(r.stderr, /not an email/);
  assert.match(r.stderr, /8 to 128/);
});

test("three bad answers in a row give up and write nothing", () => {
  const sb = sandbox();
  const r = run(sb, { input: lines(EMAIL, "a", "b", "c") });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /BOOTSTRAP_PASSWORD/);
  assert.ok(!existsSync(sb.out));
});

test("end of input at a required prompt names the key and writes nothing", () => {
  const sb = sandbox();
  const r = run(sb, { input: lines(EMAIL, PASS) });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no value for OPENAI_API_KEY/);
  assert.ok(!existsSync(sb.out));
});

test("API bind: n writes 127.0.0.1 in place of the commented default", () => {
  const sb = sandbox();
  const r = run(sb, { input: lines(EMAIL, PASS, OAI, "n") });
  assert.equal(r.status, 0, r.stderr);
  const text = read(sb);
  assert.equal(parse(text).API_BIND_ADDRESS, "127.0.0.1");
  assert.ok(!/^# API_BIND_ADDRESS=/m.test(text), "commented default still present");
});

test("API bind: yes, Enter and end of input keep the default (still commented)", () => {
  for (const tail of ["y\n", "\n", ""]) {
    const sb = sandbox();
    const r = run(sb, { input: ALL + tail });
    assert.equal(r.status, 0, r.stderr);
    const text = read(sb);
    assert.equal(parse(text).API_BIND_ADDRESS, undefined);
    assert.match(text, /^# API_BIND_ADDRESS=0\.0\.0\.0$/m);
  }
});

test("API bind: environment value is used without asking", () => {
  const sb = sandbox();
  const r = run(sb, { env: { ...ENV_ALL, API_BIND_ADDRESS: "203.0.113.7" } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(parse(read(sb)).API_BIND_ADDRESS, "203.0.113.7");
});

test("API bind: an unusable answer three times gives up and writes nothing", () => {
  const sb = sandbox();
  const r = run(sb, { input: ALL + lines("maybe", "perhaps", "what") });
  assert.equal(r.status, 2);
  assert.ok(!existsSync(sb.out));
});

test("template drift: a new required key is prompted for; other lines pass through", () => {
  const tpl = REAL_TEMPLATE.replace("OPENAI_API_KEY=\n", "OPENAI_API_KEY=\nEXTRA_THING=\nFIXED_FLAG=on\n");
  const sb = sandbox(tpl);
  const r = run(sb, { input: lines(EMAIL, PASS, OAI, "extra value one") });
  assert.equal(r.status, 0, r.stderr);
  const v = parse(read(sb));
  assert.equal(v.EXTRA_THING, "'extra value one'");
  assert.equal(v.FIXED_FLAG, "on");
  assert.match(r.stdout, /EXTRA_THING/);
});

test("template drift: a required key that is not special-cased is also taken from the environment", () => {
  const tpl = REAL_TEMPLATE.replace("OPENAI_API_KEY=\n", "OPENAI_API_KEY=\nEXTRA_THING=\n");
  const sb = sandbox(tpl);
  const r = run(sb, { env: { ...ENV_ALL, EXTRA_THING: "from-env" } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(parse(read(sb)).EXTRA_THING, "from-env");
});

test("a CRLF template (Windows checkout) still works and is written with LF", () => {
  const sb = sandbox(REAL_TEMPLATE.replace(/\n/g, "\r\n"));
  const r = run(sb, { input: ALL });
  assert.equal(r.status, 0, r.stderr);
  const text = read(sb);
  assert.ok(!text.includes("\r"));
  assert.equal(parse(text).BOOTSTRAP_EMAIL, EMAIL);
});

test("a template with no required keys, or a missing template, is an error", () => {
  const sb = sandbox("# nothing here\nFOO=bar\n");
  const r = run(sb, { input: ALL });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no required/);
  assert.ok(!existsSync(sb.out));

  const sb2 = sandbox();
  const r2 = spawnSync(BASH, [script, "--example", join(sb2.dir, "absent"), "--output", sb2.out], {
    input: ALL, encoding: "utf8", env: baseEnv(),
  });
  assert.equal(r2.status, 2);
  assert.match(r2.stderr, /absent/);
});

const AWKWARD = [
  "pa$$ word#1",
  "it's $x # \"q\" \\b",
  "ends-with-backslash\\",
  "${HOME}/x",
  "`backtick` & (parens) !bang; *star",
  "  padded  ",
  "a=b=c=d=e",
  "ünïcödé-pass",
];
const composeOk = spawnSync("docker", ["compose", "version"], { encoding: "utf8" }).status === 0;

test("awkward passwords are accepted and written", () => {
  for (const pw of AWKWARD) {
    const sb = sandbox();
    const r = run(sb, { env: { ...ENV_ALL, BOOTSTRAP_PASSWORD: pw } });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(parse(read(sb)).BOOTSTRAP_PASSWORD.length > 0);
  }
});

test("awkward passwords are quoted so docker compose reads them back exactly",
  { skip: !composeOk && "docker compose unavailable" }, () => {
    for (const pw of AWKWARD) {
      const sb = sandbox();
      const r = run(sb, { env: { ...ENV_ALL, BOOTSTRAP_PASSWORD: pw } });
      assert.equal(r.status, 0, r.stderr);
      // `docker compose config` interpolates the .env without needing a daemon.
      writeFileSync(join(sb.dir, "docker-compose.yml"),
        'services:\n  a:\n    image: x\n    environment:\n      V: "${BOOTSTRAP_PASSWORD}"\n');
      const c = spawnSync("docker", ["compose", "config", "--format", "json"], {
        cwd: sb.dir, encoding: "utf8", env: baseEnv(),
      });
      assert.equal(c.status, 0, c.stderr);
      // config re-escapes every literal $ as $$ in its rendered output.
      const got = JSON.parse(c.stdout).services.a.environment.V.replaceAll("$$", "$");
      assert.equal(got, pw);
    }
  });

test("quoting shape: plain stays bare, $ # space single-quoted, apostrophe double-quoted", () => {
  const cases = [
    ["plain-Pass_9.x", "plain-Pass_9.x"],
    ["pa$$ word#1", "'pa$$ word#1'"],
    ["it's $x ok", '"it\'s \\$x ok"'],
  ];
  for (const [pw, want] of cases) {
    const sb = sandbox();
    const r = run(sb, { env: { ...ENV_ALL, BOOTSTRAP_PASSWORD: pw } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(parse(read(sb)).BOOTSTRAP_PASSWORD, want);
  }
});

test("falls back to /dev/urandom when openssl is not on PATH", () => {
  const sb = sandbox();
  const bin = join(sb.dir, "bin");
  mkdirSync(bin);
  // Only the tools the script is allowed to need; deliberately no openssl.
  for (const tool of ["head", "od", "tr", "sed", "chmod", "dirname", "basename", "cat", "mktemp", "ln", "rm"]) {
    const p = spawnSync("bash", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
    if (p) symlinkSync(p, join(bin, tool));
  }
  const probe = spawnSync(BASH, ["-c", "command -v openssl"], { env: { PATH: bin }, encoding: "utf8" });
  assert.notEqual(probe.status, 0, "test setup: openssl still reachable");
  const r = run(sb, { input: ALL, baseline: { PATH: bin, HOME: sb.dir } });
  assert.equal(r.status, 0, r.stderr);
  const v = parse(read(sb));
  assert.match(v.JWT_SECRET_KEY, /^[0-9a-f]{64}$/);
  assert.match(v.SESSION_INGRESS_TRUSTED_VALUE, /^[0-9a-f]{64}$/);
  assert.notEqual(v.JWT_SECRET_KEY, v.SESSION_INGRESS_TRUSTED_VALUE);
});

test("defaults: reads .env.example and writes .env next to the script's repo root, whatever the cwd", () => {
  const root = mkdtempSync(join(tmpdir(), "setup-env-tree-"));
  mkdirSync(join(root, "scripts"));
  copyFileSync(script, join(root, "scripts", "setup-env.sh"));
  writeFileSync(join(root, ".env.example"), REAL_TEMPLATE);
  const elsewhere = mkdtempSync(join(tmpdir(), "setup-env-cwd-"));
  const r = spawnSync(BASH, [join(root, "scripts", "setup-env.sh")], {
    cwd: elsewhere, input: ALL, encoding: "utf8", env: baseEnv(),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(root, ".env")));
  assert.ok(!existsSync(join(elsewhere, ".env")));
  assert.equal(parse(readFileSync(join(root, ".env"), "utf8")).BOOTSTRAP_EMAIL, EMAIL);
});

test("--output elsewhere warns that compose only reads .env beside docker-compose.yml", () => {
  const root = mkdtempSync(join(tmpdir(), "setup-env-tree-"));
  mkdirSync(join(root, "scripts"));
  copyFileSync(script, join(root, "scripts", "setup-env.sh"));
  writeFileSync(join(root, ".env.example"), REAL_TEMPLATE);
  const out = join(root, "custom.env");
  const r = spawnSync(BASH, [join(root, "scripts", "setup-env.sh"), "--output", out], {
    input: ALL, encoding: "utf8", env: baseEnv(),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /not .*\.env.*docker compose/is);
});

test("--help exits 0 with usage; an unknown flag exits 2", () => {
  const h = spawnSync(BASH, [script, "--help"], { encoding: "utf8", env: baseEnv() });
  assert.equal(h.status, 0);
  assert.match(h.stdout, /Usage/);
  const u = spawnSync(BASH, [script, "--bogus"], { encoding: "utf8", env: baseEnv() });
  assert.equal(u.status, 2);
  assert.match(u.stderr, /--bogus/);
});

test("API bind: IPv4 and IPv6 addresses are accepted", () => {
  for (const addr of ["0.0.0.0", "127.0.0.1", "203.0.113.7", "255.255.255.255", "::1", "::", "[::1]", "fe80::1", "1:2:3:4:5:6:7:8"]) {
    const sb = sandbox();
    const r = run(sb, { env: { ...ENV_ALL, API_BIND_ADDRESS: addr } });
    assert.equal(r.status, 0, `${addr}: ${r.stderr}`);
    assert.ok(read(sb).split("\n").some((l) => l === `API_BIND_ADDRESS=${addr}` || l === `API_BIND_ADDRESS='${addr}'`), addr);
  }
});

test("API bind: hostnames and malformed addresses are rejected and nothing is written", () => {
  // localhost is refused on purpose: compose's ports entry needs an IP ("invalid IP address: localhost").
  for (const addr of ["localhost", "example.com", "999.1.1.1", "1.2.3", "01.2.3.4", "1:2:3", "::1::2", ":1:2", "12345::1", "with space"]) {
    const sb = sandbox();
    const r = run(sb, { env: { ...ENV_ALL, API_BIND_ADDRESS: addr } });
    assert.equal(r.status, 2, addr);
    assert.match(r.stderr, /API_BIND_ADDRESS/);
    assert.ok(!existsSync(sb.out), addr);
  }
});

test("a write that fails after the file starts leaves no .env and no temp file, and says so", () => {
  const sb = sandbox();
  // ulimit -f 1 (1 KiB) is below the size of the finished file; stdout/stderr are pipes, so only the .env write is limited.
  const r = spawnSync(BASH, ["-c", 'ulimit -f 1; exec "$@"', "x", BASH, script, "--example", sb.example, "--output", sb.out], {
    input: ALL, encoding: "utf8", env: baseEnv(),
  });
  assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /could not write/);
  assert.doesNotMatch(r.stderr, /REFUSED/);
  assert.deepEqual(readdirSync(sb.dir).sort(), ["env.example"]);
});

test("a successful run leaves no temp file behind", () => {
  const sb = sandbox();
  const r = run(sb, { input: ALL });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readdirSync(sb.dir).sort(), [".env", "env.example"]);
});
