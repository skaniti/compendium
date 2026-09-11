#!/usr/bin/env bash
# Re-deploy the apps/api server compose stack (compendium-api) with build +
# health verification.
#
# This targets the CURRENT monorepo cutover architecture:
# apps/api/docker/docker-compose.server.yml defines a single `api` service
# (compendium-api) against the real, already-provisioned production
# database -- postgres and the Dash frontend stay on the OLD
# explorer-hosted compose (docker/server/docker-compose.yml, a different
# file on the server, not this repo), reached over the shared external
# `compendium-net` network. See docker-compose.server.yml's own header for
# the full split rationale and required env vars.
#
# Schema before code, but NOT via a separate step here: this compose's
# image entrypoint (apps/api/docker/entrypoint.sh) runs
# `python -m backend.db.migrate --skip-backfill` INSIDE the container,
# before exec'ing uvicorn -- so uvicorn never starts (and the container
# never reports healthy) until migrations have already applied. There is
# no schema/code window to sequence around for this compose; this script's
# job is just to build+start, confirm the entrypoint's migration log line,
# and wait for /health to report the database as actually connected.
#
# This is the OLD honcho-stack script's replacement for the api-only
# cutover target -- NOT the same deployment as
# scripts/server-setup/section-18-app-stack.sh /
# scripts/server/diagnose_server.sh, which still drive the 3-service
# postgres+app+frontend stack at docker/server/docker-compose.yml. This
# script no longer touches that stack at all.
#
# Usage:
#   bash scripts/server/deploy_server.sh
#
# What this does:
#   1. Source ~/.secrets + ~/apps/compendium/.env so docker compose ${VAR}
#      substitution resolves cleanly (same two-file convention as before;
#      see docker-compose.server.yml's header for the full list). Compose
#      hard-requires (":?", the `up` below fails without them)
#      POSTGRES_PASSWORD, API_CORS_ORIGINS, and CAPTURES_ASSETS_HOST_DIR in
#      this env/.env pair; JWT_SECRET_KEY is also required but is read from
#      the mounted ~/.secrets file itself, not a compose ${VAR:?...}
#      substitution, so a missing one won't fail the same way -- verify it's
#      set in ~/.secrets directly. API_HOST_PORT is optional (defaults to
#      8001 below). ENV_FILE=/path SECRETS_FILE=/path (see "Sanity checks"
#      below) override the default paths for both files.
#   2. docker compose -f docker-compose.server.yml up -d --build (the `api`
#      service; migrations run inside the container at boot, see above).
#   3. docker compose ... ps (container status confirmation).
#   4. Wait for http://127.0.0.1:${API_HOST_PORT}/health to return 200 with
#      db_connected: true.
#   5. Print the entrypoint's migration log lines as evidence (`logs api |
#      grep -i migrat`).
#
# What this does NOT do:
#   - git pull (run that first if you want to deploy latest).
#   - touch the old postgres/Dash stack (still explorer-hosted; unaffected
#     by this compose file).
#   - hand off to diagnose_server.sh -- that script's checks (compendium-
#     postgres / compendium-app containers, :8051 frontend loopback,
#     cloudflared) all target the OLD 3-service stack, none of which this
#     compose defines. Re-target it (or write an api-specific diagnostic)
#     if a post-deploy diagnostic handoff is wanted here.
#
# Logs:
#   <repo>/logs/<YYYY-MM-DD-HHMMSS>-deploy.log + logs/latest-deploy.log symlink.

set -uo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
COMPOSE_FILE="$PROJECT_ROOT/docker/docker-compose.server.yml"
ENV_FILE="${ENV_FILE:-$HOME/apps/compendium/.env}"
SECRETS_FILE="${SECRETS_FILE:-$HOME/.secrets}"
API_HOST_PORT="${API_HOST_PORT:-8001}"
export API_HOST_PORT

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
# 3. Build + start compendium-api
# --------------------------------------------------------------------------
# Single-service compose (`api`) -- migrations run inside the container's
# entrypoint before uvicorn starts, so this one command covers build,
# migrate, and start. No separate migration step, no postgres wait: this
# compose's database is the real, already-running production database
# reached over the external compendium-net network, not a compose-managed
# service here.
echo ""
echo "--- docker compose up -d --build ---"
# Explicit exit check: this script runs under `set -uo pipefail` (no `-e`,
# see the loop below that needs a failing curl to not abort the script), so
# without this check a failed build/up would leave the OLD container running
# untouched and the health wait below would then pass against it, masking
# the failure entirely.
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --build || { echo "ERROR: docker compose up failed"; exit 1; }

# --------------------------------------------------------------------------
# 4. Confirm container status
# --------------------------------------------------------------------------
echo ""
echo "--- docker compose ps ---"
docker compose -f "$COMPOSE_FILE" ps

# --------------------------------------------------------------------------
# 5. Wait for /health (200, db_connected: true)
# --------------------------------------------------------------------------
# /health always returns HTTP 200 (status: "healthy" vs "degraded" is
# carried in the body, see backend/api/main.py::health_check) so a bare
# status-code check would pass even with a dead DB connection -- check the
# db_connected field itself. Bounded generously (120s) to cover the
# compose healthcheck's own worst case (start_period 20s + interval 5s x
# retries 30); the runbook's observed cutover run took 30-60s.
echo ""
echo "--- waiting for http://127.0.0.1:${API_HOST_PORT}/health (db_connected: true) ---"
for i in $(seq 1 60); do
    resp=$(curl -sf -m 2 "http://127.0.0.1:${API_HOST_PORT}/health" 2>/dev/null) || resp=""
    if echo "$resp" | grep -q '"db_connected":[[:space:]]*true'; then
        echo "health ok ($((i * 2))s): $resp"
        break
    fi
    sleep 2
    if [ "$i" -eq 60 ]; then
        echo "ERROR: /health did not report db_connected: true within 120s"
        echo "  last response: ${resp:-<no response>}"
        docker compose -f "$COMPOSE_FILE" logs --tail 50 api
        exit 1
    fi
done

# --------------------------------------------------------------------------
# 6. Migration evidence (entrypoint log)
# --------------------------------------------------------------------------
# Confirms what ran inside the container at boot -- either
# "No new migrations to apply." (expected steady state) or "Applied N
# migration(s): ..." (this deploy shipped new schema). Either is fine; an
# absence of any migration-related line is the actual red flag.
echo ""
echo "--- migration evidence (docker compose logs api | grep -i migrat) ---"
docker compose -f "$COMPOSE_FILE" logs api | grep -i migrat || echo "  (no migration-related log lines found -- check container logs directly)"

echo ""
echo "=== deploy complete ==="
echo "  Log:     $LOG_PATH"
echo "  Health:  http://127.0.0.1:${API_HOST_PORT}/health"
echo "  Stop:    docker compose -f $COMPOSE_FILE down"
echo "  Logs:    docker compose -f $COMPOSE_FILE logs -f api"

exit 0
