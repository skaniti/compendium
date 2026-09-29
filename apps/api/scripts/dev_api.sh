#!/usr/bin/env bash
# Dev launcher for the Compendium API (apps/api): uvicorn backend.api.main:app.
#
#   bash apps/api/scripts/dev_api.sh             # 127.0.0.1:8001
#   API_PORT=8012 bash apps/api/scripts/dev_api.sh
#   bash apps/api/scripts/dev_api.sh --reload    # extra args go to uvicorn
#
# Env: API_PORT (8001), API_PYTHON (interpreter override),
#      DB_WAIT=0 (skip postgres wait), DB_WAIT_HOST (127.0.0.1), DB_WAIT_PORT (5433).
# Interpreter: $API_PYTHON, else ~/.venvs/compendium/bin/python3, else python3.
# Logs -> <repo>/logs/<timestamp>-api-dev.log (+ logs/latest-api.log symlink).
set -euo pipefail

API_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$API_DIR/../.." && pwd)"
PORT="${API_PORT:-8001}"
say() { printf '[dev_api %s] %s\n' "$(date +%H:%M:%S)" "$*"; }

if [ -n "${API_PYTHON:-}" ]; then
  PY="$API_PYTHON"
elif [ -x "$HOME/.venvs/compendium/bin/python3" ]; then
  PY="$HOME/.venvs/compendium/bin/python3"
else
  PY="python3"
fi

if [ "${DB_WAIT:-1}" != "0" ]; then
  host="${DB_WAIT_HOST:-127.0.0.1}"; dport="${DB_WAIT_PORT:-5433}"
  say "waiting up to 60s for postgres at $host:$dport"
  ok=0
  for i in $(seq 1 60); do
    if (echo > "/dev/tcp/$host/$dport") 2>/dev/null; then ok=1; break; fi
    if [ $((i % 10)) -eq 0 ]; then say "still waiting for postgres (${i}s)"; fi
    sleep 1
  done
  if [ "$ok" -ne 1 ]; then
    say "ERROR: postgres not reachable at $host:$dport after 60s (DB_WAIT=0 to skip)"
    exit 1
  fi
fi

LOG_DIR="$ROOT/logs"; mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/$(date +%Y-%m-%d-%H%M%S)-api-dev.log"
ln -sfn "$(basename "$LOG")" "$LOG_DIR/latest-api.log"

say "start: $PY -m uvicorn backend.api.main:app on 127.0.0.1:$PORT -> $LOG"
cd "$API_DIR"
export PYTHONUNBUFFERED=1
rc=0
"$PY" -m uvicorn backend.api.main:app --host 127.0.0.1 --port "$PORT" "$@" 2>&1 | tee -a "$LOG" || rc=$?
say "done (exit $rc)"
exit "$rc"
