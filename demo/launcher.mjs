#!/usr/bin/env node
// demo/launcher.mjs -- Task 8: `npm run demo` end-to-end launcher. Spawns the
// dependency-free stub backend (demo/server.mjs), waits for it to come up,
// then spawns `next dev` pointed at it via BACKEND_URL -- so the full app can
// be driven with no real backend and no captured API dependency (Tasks 4-7's
// stub replays demo/fixtures/*). Both children are torn down together on
// SIGINT/SIGTERM/normal exit.
//
// `pickPort` is exported (and unit-tested from demo/server.test.ts's
// "pickPort" describe block -- see server.d.mts's neighboring StartServerOptions
// for the stub's own port default) so the "try :8001, fall back to an
// OS-assigned ephemeral port when something else already holds it" behavior
// has test coverage without needing to actually boot the stub or Next.
//
// `isDirectEntry` is likewise exported and unit-tested (demo/server.test.ts's
// "isDirectEntry" describe block) -- it replaces the naive
// `import.meta.url === \`file://${process.argv[1]}\`` string comparison,
// which never matches on win32 (drive letters/backslashes) and breaks on
// POSIX paths that percent-encode in a file URL (e.g. spaces). server.mjs
// duplicates the one-liner locally instead of importing this export, so the
// dependency-free stub backend doesn't pick up this file's child_process/net
// spawn-management code as a module dependency.

import net from "node:net";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// Mirrors server.mjs's own standalone-entrypoint default (`PORT` env var,
// falling back to 8001) -- see that file's bottom
// `if (isDirectEntry(import.meta.url, process.argv[1]))` block.
const STUB_PREFERRED_PORT = 8001;
const STUB_READY_TIMEOUT_MS = 10_000;
const STUB_READY_POLL_MS = 200;

// Resolved relative to THIS file's own location (import.meta.url), not
// process.cwd() -- the stub must be spawn-able regardless of the directory
// `node demo/launcher.mjs` (or a future non-`npm run demo` invocation) was
// started from. REPO_ROOT is passed as the spawned stub's `cwd` for the same
// reason: server.mjs's own default `fixturesDir` ("demo/fixtures") is
// itself cwd-relative, so pinning the child's cwd to the repo root is what
// actually makes the whole spawn cwd-independent end to end, not just the
// path handed to `spawn`.
//
// Deliberately fileURLToPath(import.meta.url) + path.join, NOT
// `new URL("./server.mjs", import.meta.url)` -- this repo's test
// environment (vitest.config.ts's `environment: "jsdom"`, needed for the
// component tests elsewhere in the suite) shadows the global `URL` with
// jsdom's, which mishandles a `file:` string as a relative-resolution base
// and silently falls back to jsdom's own default origin instead (observed
// while implementing this: resolved to "http://localhost:3000/server.mjs").
// A bare fileURLToPath call on import.meta.url's own value sidesteps that
// entirely -- it never performs relative-URL resolution, just a straight
// file-URL-to-path conversion via Node's own internal parser.
const THIS_FILE_PATH = fileURLToPath(import.meta.url);
const STUB_SERVER_PATH = path.join(path.dirname(THIS_FILE_PATH), "server.mjs");
const REPO_ROOT = path.dirname(path.dirname(STUB_SERVER_PATH));

function log(...args) {
  console.log("[demo]", ...args);
}

// Tries `preferred` first; if something else already holds it (e.g. the
// explorer app's real backend already running on :8001 on this machine),
// asks the OS for a free ephemeral port instead. Exported for the launcher
// port-logic test in demo/server.test.ts.
export function pickPort(preferred) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", (err) => {
      if (err.code !== "EADDRINUSE") return reject(err);
      const fallback = net.createServer();
      fallback.once("error", reject);
      fallback.listen(0, () => {
        const port = fallback.address().port;
        fallback.close(() => resolve(port));
      });
    });
    probe.once("listening", () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
    probe.listen(preferred);
  });
}

// True when this module was invoked directly as `node <this file>` (as
// opposed to being imported). Compares via `pathToFileURL` rather than the
// naive `import.meta.url === \`file://${argv1}\`` string concatenation --
// that naive form mismatches whenever the absolute path percent-encodes in
// a file URL (e.g. spaces) and never matches on win32 (drive letters use
// `file:///C:/...`, and backslash path separators aren't URL separators at
// all). `argv1` is undefined in contexts with no invoked script (e.g. a
// REPL); guard that case explicitly rather than passing `undefined` to
// `pathToFileURL`. Exported for the launcher entrypoint-guard test in
// demo/server.test.ts.
export function isDirectEntry(metaUrl, argv1) {
  if (!argv1) return false;
  return pathToFileURL(argv1).href === metaUrl;
}

// Polls GET <url> until it responds 2xx (the stub's `/docs` health-probe
// target -- see server.mjs's module-header comment) or `timeoutMs` elapses.
// `isCancelled` (default: never) is checked each iteration so a caller that
// has already given up for some OTHER reason (e.g. raceStartup below,
// reacting to the stub process exiting) can stop this loop within one poll
// tick instead of leaving it running in the background for the rest of
// `timeoutMs`.
async function waitForUp(url, timeoutMs, isCancelled = () => false) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (isCancelled()) throw new Error("readiness poll cancelled");
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Not listening yet -- keep polling.
    }
    if (isCancelled()) throw new Error("readiness poll cancelled");
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${url}`);
    }
    await new Promise((resolve) => setTimeout(resolve, STUB_READY_POLL_MS));
  }
}

// Races the readiness poll above against the stub child itself exiting or
// failing to spawn -- so a stub that crashes (or never starts) during the
// wait fails immediately with a clear reason, instead of the caller running
// out the full `timeoutMs` deadline only to then report a generic timeout.
// Listeners are removed as soon as ANY branch settles, which also bounds how
// long the now-abandoned `waitForUp` loop keeps polling in the background
// (at most one more `STUB_READY_POLL_MS` tick, via `isCancelled` above).
function raceStartup(stub, url, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    let cancelled = false;
    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      cancelled = true;
      stub.removeListener("error", onError);
      stub.removeListener("exit", onExit);
      fn(arg);
    };
    const onError = (err) => finish(reject, new Error(`failed to spawn stub backend: ${err.message}`));
    const onExit = (code) =>
      finish(reject, new Error(`stub backend exited before becoming ready (code ${code ?? "unknown"})`));
    stub.once("error", onError);
    stub.once("exit", onExit);
    waitForUp(url, timeoutMs, () => cancelled)
      .then(() => finish(resolve, undefined))
      .catch((err) => finish(reject, err));
  });
}

// Tears a spawned child (and anything IT spawned) down. Both children below
// are launched with `detached: true` on POSIX, making each the leader of its
// own process group -- signaling the NEGATED pid reaches that whole group,
// not just the immediate child, which matters because `npm run dev` spawns
// Next (and Next's own dev-time subprocesses) as further descendants rather
// than exec-replacing itself. win32 has no equivalent process-group signal,
// so `taskkill /F /T` (tree-kill by PID) runs there instead, falling back to
// a plain child.kill() if taskkill itself is unavailable/fails.
function killChild(child) {
  if (!child || child.pid == null || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" });
      return;
    } catch {
      // fall through to the plain kill below
    }
    child.kill();
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill();
  }
}

// Boots the stub backend end to end: picks a port (falling back off
// `preferredPort` when something else already holds it -- pickPort above),
// spawns demo/server.mjs (STUB_SERVER_PATH/REPO_ROOT, cwd-independent), and
// waits for it to report ready via raceStartup -- which rejects immediately
// (not after the full readiness deadline) if the stub exits or fails to
// spawn first. On any failure the partially-started child is killed before
// rethrowing, so a caller never has to know killChild's POSIX/win32 details
// just to clean up a failed boot attempt.
//
// Exported (and `log` left as an injectable no-op-by-default rather than the
// module's own console-writing `log`) so the port-fallback + readiness
// wiring has direct test coverage without also needing to boot `next dev` --
// see demo/server.test.ts's "bootStub" describe block. `main()` below is the
// only real caller and always passes the module's own `log`.
export async function bootStub({ preferredPort = STUB_PREFERRED_PORT, log = () => {} } = {}) {
  const port = await pickPort(preferredPort);
  const heldNote = port === preferredPort ? "" : ` (:${preferredPort} was already taken)`;
  log(`starting stub backend on :${port}${heldNote}`);

  const stub = spawn(process.execPath, [STUB_SERVER_PATH], {
    cwd: REPO_ROOT,
    env: { ...process.env, PORT: String(port) },
    stdio: "inherit",
    detached: process.platform !== "win32",
  });

  const backendUrl = `http://localhost:${port}`;
  log(`waiting for stub backend at ${backendUrl}/docs (10s cap)...`);
  try {
    await raceStartup(stub, `${backendUrl}/docs`, STUB_READY_TIMEOUT_MS);
  } catch (err) {
    killChild(stub);
    throw err;
  }
  log(`stub backend up: ${backendUrl}`);
  return { port, backendUrl, child: stub };
}

async function main() {
  const children = [];
  let shuttingDown = false;

  const teardown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("stopping...");
    for (const child of children) killChild(child);
  };
  process.once("SIGINT", () => {
    teardown();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    teardown();
    process.exit(0);
  });
  process.once("exit", teardown);

  let stub, backendUrl;
  try {
    ({ child: stub, backendUrl } = await bootStub({ log }));
  } catch (err) {
    log(`ERROR: ${err.message}`);
    process.exitCode = 1;
    return;
  }
  children.push(stub);
  // Post-ready failure modes -- bootStub's own raceStartup already owns the
  // pre-ready spawn-error/early-exit path (and removes its own listeners
  // once settled), so these only fire for a stub that dies/errors AFTER
  // successfully coming up.
  stub.on("error", (err) => {
    if (shuttingDown) return;
    log(`ERROR: stub backend error: ${err.message}`);
    teardown();
    process.exitCode = 1;
  });
  stub.on("exit", (code) => {
    if (shuttingDown) return;
    log(`stub backend exited unexpectedly (code ${code})`);
    teardown();
    process.exitCode = 1;
  });

  log(`starting next dev (BACKEND_URL=${backendUrl})...`);
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  // win32 requires `shell: true` for a `.cmd` target -- Node >= 20.12
  // hardened shell-less spawns of Windows batch/cmd files (CVE-2024-27980)
  // and throws instead of executing them. POSIX is unaffected and keeps
  // spawning the plain `npm` binary directly (no shell).
  const next = spawn(npmCmd, ["run", "dev"], {
    env: { ...process.env, BACKEND_URL: backendUrl },
    stdio: "inherit",
    detached: process.platform !== "win32",
    shell: process.platform === "win32",
  });
  children.push(next);
  next.on("error", (err) => {
    if (shuttingDown) return;
    log(`ERROR: failed to start next dev: ${err.message}`);
    teardown();
    process.exitCode = 1;
  });
  next.on("exit", (code) => {
    if (shuttingDown) return;
    log(`next dev exited (code ${code})`);
    teardown();
    process.exitCode = code ?? 1;
  });
}

// Standalone entrypoint: `node demo/launcher.mjs` (wired to `npm run demo`).
if (isDirectEntry(import.meta.url, process.argv[1])) {
  main().catch((err) => {
    console.error("[demo] failed to start:", err);
    process.exit(1);
  });
}
