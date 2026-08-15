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

import net from "node:net";
import { execFileSync, spawn } from "node:child_process";

// Mirrors server.mjs's own standalone-entrypoint default (`PORT` env var,
// falling back to 8001) -- see that file's bottom `if (import.meta.url ...)`
// block.
const STUB_PREFERRED_PORT = 8001;
const STUB_READY_TIMEOUT_MS = 10_000;
const STUB_READY_POLL_MS = 200;

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

// Polls GET <url> until it responds 2xx (the stub's `/docs` health-probe
// target -- see server.mjs's module-header comment) or `timeoutMs` elapses.
async function waitForUp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Not listening yet -- keep polling.
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${url}`);
    }
    await new Promise((resolve) => setTimeout(resolve, STUB_READY_POLL_MS));
  }
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

  const port = await pickPort(STUB_PREFERRED_PORT);
  const heldNote = port === STUB_PREFERRED_PORT ? "" : ` (:${STUB_PREFERRED_PORT} was already taken)`;
  log(`starting stub backend on :${port}${heldNote}`);

  const stub = spawn(process.execPath, ["demo/server.mjs"], {
    env: { ...process.env, PORT: String(port) },
    stdio: "inherit",
    detached: process.platform !== "win32",
  });
  children.push(stub);
  stub.on("exit", (code) => {
    if (shuttingDown) return;
    log(`stub backend exited unexpectedly (code ${code})`);
    teardown();
    process.exitCode = 1;
  });

  const backendUrl = `http://localhost:${port}`;
  log(`waiting for stub backend at ${backendUrl}/docs (10s cap)...`);
  try {
    await waitForUp(`${backendUrl}/docs`, STUB_READY_TIMEOUT_MS);
  } catch (err) {
    log(`ERROR: ${err.message}`);
    teardown();
    process.exitCode = 1;
    return;
  }
  log(`stub backend up: ${backendUrl}`);

  log(`starting next dev (BACKEND_URL=${backendUrl})...`);
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  const next = spawn(npmCmd, ["run", "dev"], {
    env: { ...process.env, BACKEND_URL: backendUrl },
    stdio: "inherit",
    detached: process.platform !== "win32",
  });
  children.push(next);
  next.on("exit", (code) => {
    if (shuttingDown) return;
    log(`next dev exited (code ${code})`);
    teardown();
    process.exitCode = code ?? 1;
  });
}

// Standalone entrypoint: `node demo/launcher.mjs` (wired to `npm run demo`).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("[demo] failed to start:", err);
    process.exit(1);
  });
}
