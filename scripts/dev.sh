#!/usr/bin/env bash
# Local dev launcher for visual testing: FastAPI backend (optional) + Next dev
# server, with timestamped logs and a clean teardown on Ctrl+C. Repeat-friendly:
# reuses a backend that is already up, and lets Next pick a free port when :3000
# is taken by another project.
#
#   bash scripts/dev.sh                     # backend (if found & down) + frontend
#   FRONTEND_ONLY=1 bash scripts/dev.sh     # just the Next server (backend elsewhere)
#   BACKEND_DIR=/path/to/backend bash scripts/dev.sh   # point at the backend repo
#
# Logs -> logs/<timestamp>-{frontend,backend}.log (+ logs/latest.log). Ctrl+C stops all.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND_URL="${BACKEND_URL:-http://localhost:8001}"
# Role-tooling opt-in: this is the maintainer's own dev stack, so keep the
# demo account + view-as/return-to-admin machinery available with zero
# extra steps (hosted-parity development). `npm run demo` (demo/launcher.mjs)
# deliberately leaves both unset -- a stranger's out-of-the-box run gets a
# single full-control identity and never sees this. Stub-side
# (DEMO_ROLE_TOOLING) only matters if something in this stack ends up
# running demo/server.mjs; exported here regardless, for the same
# zero-extra-steps reason. See demo/server.mjs's startServer doc comment
# and components/GraphCanvas.tsx's isRoleToolingVisible for the two readers.
export DEMO_ROLE_TOOLING="${DEMO_ROLE_TOOLING:-1}"
export NEXT_PUBLIC_DEMO_ROLE_TOOLING="${NEXT_PUBLIC_DEMO_ROLE_TOOLING:-1}"
# Backend repo location: an explicit env var wins; otherwise read BACKEND_DIR from
# the gitignored .env.local so this committed script carries no machine-local path.
if [ -z "${BACKEND_DIR:-}" ] && [ -f "$ROOT/.env.local" ]; then
  BACKEND_DIR="$(grep -E '^BACKEND_DIR=' "$ROOT/.env.local" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r')"
fi

TS="$(date +%Y-%m-%d-%H%M%S)"
LOG_DIR="$ROOT/logs"; mkdir -p "$LOG_DIR"
FE_LOG="$LOG_DIR/${TS}-frontend.log"
BE_LOG="$LOG_DIR/${TS}-backend.log"
ln -sfn "$(basename "$FE_LOG")" "$LOG_DIR/latest.log" 2>/dev/null || true
say() { printf '[dev %s] %s\n' "$(date +%H:%M:%S)" "$*"; }

PIDS=()
cleanup() {
  trap - INT TERM EXIT
  echo; say "stopping..."
  for pid in "${PIDS[@]:-}"; do
    [ -n "${pid:-}" ] || continue
    # Windows/Git Bash: taskkill tree-kills reliably; POSIX kill is the fallback.
    MSYS_NO_PATHCONV=1 taskkill /F /T /PID "$pid" >/dev/null 2>&1 || kill "$pid" 2>/dev/null || true
  done
  say "done. (logs: $LOG_DIR)"
}
trap cleanup INT TERM EXIT

backend_up() { curl -s -m 2 -o /dev/null "$BACKEND_URL/docs"; }

# --- backend: best-effort, reuse if already running ---
if [ "${FRONTEND_ONLY:-}" = "1" ]; then
  say "FRONTEND_ONLY=1 -> not starting the backend."
elif backend_up; then
  say "backend already up at $BACKEND_URL"
elif [ -n "${BACKEND_DIR:-}" ] && [ -f "$BACKEND_DIR/scripts/start_app.sh" ]; then
  say "starting backend from $BACKEND_DIR -> $BE_LOG"
  ( cd "$BACKEND_DIR" && bash scripts/start_app.sh ) >"$BE_LOG" 2>&1 &
  PIDS+=("$!")
  printf '[dev] waiting for backend '
  for _ in $(seq 1 120); do backend_up && break; printf '.'; sleep 1; done; echo
  backend_up && say "backend up at $BACKEND_URL" || say "WARN: backend not up after 120s (see $BE_LOG)"
else
  say "WARN: backend is down and no BACKEND_DIR with scripts/start_app.sh was found."
  say "      add BACKEND_DIR=/path/to/compendium-explorer to .env.local, or run FRONTEND_ONLY=1."
fi

# --- frontend: Next auto-picks a free port; we parse and print it ---
say "starting Next dev server (npm run dev) -> $FE_LOG"
( cd "$ROOT" && npm run dev ) >"$FE_LOG" 2>&1 &
PIDS+=("$!")
FE_URL=""
for _ in $(seq 1 60); do
  FE_URL="$(grep -oE 'http://localhost:[0-9]+' "$FE_LOG" | head -1 || true)"
  [ -n "$FE_URL" ] && break
  sleep 1
done

say "READY   frontend: ${FE_URL:-http://localhost:3000}   backend: $BACKEND_URL"
say "tail -f logs/latest.log   |   Ctrl+C stops everything"
wait
