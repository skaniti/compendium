#!/usr/bin/env bash
# Re-deploy the server compose stack with build + health verification.
# This is the steady-state redeploy script (post-bootstrap). For fresh-install,
# use scripts/server-setup/section-18-app-stack.sh instead.
#
# Usage:
#   bash scripts/server/deploy_server.sh
#
# What this does:
#   1. Source ~/.secrets + ~/apps/compendium/.env so docker compose ${VAR}
#      substitution resolves cleanly.
#   2. docker compose ... up -d --build (the SERVER compose file).
#   3. Wait for postgres healthy.
#   4. Run migrations.
#   5. Wait for honcho's frontend proc to bind 127.0.0.1:8051.
#   6. Hand off to scripts/server/diagnose_server.sh for full verification.
#
# What this does NOT do:
#   - git pull (run that first if you want to deploy latest).
#   - bootstrap users (one-time only; see section-18-app-stack.sh).
#   - touch /var/lib/compendium-* host volumes (already set up in section-18).
#
# Logs:
#   <repo>/logs/<YYYY-MM-DD-HHMMSS>-deploy.log + logs/latest-deploy.log symlink.

set -uo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
COMPOSE_FILE="$PROJECT_ROOT/docker/server/docker-compose.yml"
ENV_FILE="${ENV_FILE:-$HOME/apps/compendium/.env}"
SECRETS_FILE="${SECRETS_FILE:-$HOME/.secrets}"

# --------------------------------------------------------------------------
# 0. Log capture (mirrors start_app.sh convention)
# --------------------------------------------------------------------------
LOG_DIR="$PROJECT_ROOT/logs"
LOG_TS=$(date +"%Y-%m-%d-%H%M%S")
LOG_NAME="${LOG_TS}-deploy.log"
LOG_PATH="$LOG_DIR/$LOG_NAME"
mkdir -p "$LOG_DIR"
ln -sfn "$LOG_NAME" "$LOG_DIR/latest-deploy.log" 2>/dev/null || true

# stdbuf -oL forces line-buffered tee so tail -f sees writes immediately.
exec > >(stdbuf -oL tee "$LOG_PATH") 2>&1
echo "=== deploy_server.sh launched at $(date -Is) ==="
echo "=== log: $LOG_PATH ==="
echo "===   latest-deploy.log -> $LOG_NAME"
echo ""

# --------------------------------------------------------------------------
# 1. Sanity checks
# --------------------------------------------------------------------------
echo "--- sanity checks ---"
fail=0
for f in "$ENV_FILE" "$SECRETS_FILE" "$COMPOSE_FILE"; do
    if [ ! -f "$f" ]; then
        echo "ERROR: required file not found: $f"
        fail=1
    fi
done
if [ "$fail" -ne 0 ]; then
    echo ""
    echo "Override paths via env vars if needed:"
    echo "  ENV_FILE=/path/to/.env SECRETS_FILE=/path/to/.secrets bash $0"
    exit 1
fi
echo "ok"

# --------------------------------------------------------------------------
# 2. Load env + secrets
# --------------------------------------------------------------------------
# set -a auto-exports every variable defined below (matches the section-18
# pattern). Required because compose's ${VAR} substitution reads from env,
# and bootstrap-style scripts may also read os.environ directly.
set -a
# shellcheck disable=SC1090
source "$SECRETS_FILE"
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

# --------------------------------------------------------------------------
# 3. Build + up
# --------------------------------------------------------------------------
echo ""
echo "--- docker compose up -d --build ---"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --build

# --------------------------------------------------------------------------
# 4. Wait for postgres healthy (compose-level healthcheck)
# --------------------------------------------------------------------------
echo ""
echo "--- waiting for postgres healthy ---"
for i in $(seq 1 30); do
    if docker compose -f "$COMPOSE_FILE" exec -T postgres \
        pg_isready -U tbd -d traversal_discovery >/dev/null 2>&1; then
        echo "postgres ready (${i}s)"
        break
    fi
    sleep 2
    if [ "$i" -eq 30 ]; then
        echo "ERROR: postgres did not become healthy within 60s"
        docker compose -f "$COMPOSE_FILE" logs --tail 30 postgres
        exit 1
    fi
done

# --------------------------------------------------------------------------
# 5. Run migrations (idempotent per backend.db.migrate's contract)
# --------------------------------------------------------------------------
echo ""
echo "--- running migrations ---"
docker compose -f "$COMPOSE_FILE" exec -T app python -m backend.db.migrate

# --------------------------------------------------------------------------
# 6. Wait for honcho's frontend proc to bind 127.0.0.1:8051
# --------------------------------------------------------------------------
# Dash boot is heavier than uvicorn (theme regen, font scan, transitive
# backend imports), so we allow 60s. This is the gap where cloudflared
# starts returning 502 because the app isn't listening yet.
echo ""
echo "--- waiting for app loopback (honcho frontend startup) ---"
for i in $(seq 1 60); do
    if curl -sf -m 2 http://127.0.0.1:8051/ >/dev/null 2>&1; then
        echo "frontend loopback responsive (${i}s)"
        break
    fi
    sleep 1
    if [ "$i" -eq 60 ]; then
        echo "WARN: frontend loopback not responsive after 60s -- continuing to diagnostic"
    fi
done

# --------------------------------------------------------------------------
# 7. Full diagnostic
# --------------------------------------------------------------------------
echo ""
echo "--- running full diagnostic ---"
bash "$PROJECT_ROOT/scripts/server/diagnose_server.sh"
DIAG_EXIT=$?

echo ""
echo "=== deploy complete (diagnostic exit: $DIAG_EXIT) ==="
echo "  Log:     $LOG_PATH"
echo "  Stop:    docker compose -f $COMPOSE_FILE down"
echo "  Logs:    docker compose -f $COMPOSE_FILE logs -f"
echo "  Re-diag: bash scripts/server/diagnose_server.sh"

exit $DIAG_EXIT
