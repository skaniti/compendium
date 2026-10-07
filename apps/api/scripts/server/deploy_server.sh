#!/usr/bin/env bash
# Re-deploy one of two apps/api compose stacks with build + health
# verification: owner (api + web, tailnet only) or demo (api + db, public).
#
# The owner stack (docker-compose.server.yml) defines `api` (compendium-api)
# and `web` (compendium-web). The API talks to the real, already-provisioned
# production database; postgres and the Dash frontend stay on the OLD
# explorer-hosted compose (docker/server/docker-compose.yml, a different file
# on the server, not this repo), reached over the shared external
# `compendium-net` network. See docker-compose.server.yml's own header for
# the full split rationale and required env vars. The demo stack
# (docker-compose.demo.yml) is self-contained: api + its own db.
#
# Schema before code, but NOT via a separate step here: the api image's
# entrypoint (apps/api/docker/entrypoint.sh) runs
# `python -m backend.db.migrate --skip-backfill` INSIDE the container,
# before exec'ing uvicorn -- so uvicorn never starts (and the container
# never reports healthy) until migrations have already applied. There is
# no schema/code window to sequence around; this script's job is just to
# build+start, confirm the entrypoint's migration log line, and wait for
# /health to report the database as actually connected.
#
# Usage: see usage() below, or run with --help.
# Exit codes: 0 ok, 1 deploy failure, 2 bad arguments, 3 deploy up but the
# demo-copy refresh dry run failed (refresh not applied).
#
# What this does:
#   1. Source ~/.secrets + ~/apps/compendium/.env (owner; demo sources only
#      ~/apps/compendium/.env.demo, never ~/.secrets) so docker compose ${VAR}
#      substitution resolves cleanly (see docker-compose.server.yml's header
#      for the full list). Compose hard-requires (":?", the `up` below fails
#      without them) POSTGRES_PASSWORD, API_CORS_ORIGINS, and
#      CAPTURES_ASSETS_HOST_DIR in this env/.env pair; JWT_SECRET_KEY is also
#      required but is read from the mounted ~/.secrets file itself, not a
#      compose ${VAR:?...} substitution, so a missing one won't fail the same
#      way -- verify it's set in ~/.secrets directly. API_HOST_PORT (owner) /
#      DEMO_API_HOST_PORT (demo) are optional. ENV_FILE=/path
#      SECRETS_FILE=/path override the default paths.
#   2. docker compose -p <project> -f <compose file> up -d --build (owner with
#      NO_WEB_BUILD=1: `build api` then `up -d --no-build`, so an off-box built
#      and docker-loaded compendium-web:server is used untouched; owner:
#      `api` + `web`; demo: `api` + `db`; migrations run inside the api
#      container at boot, see above).
#   3. docker compose ... ps (container status confirmation).
#   4. Wait for http://127.0.0.1:${API_HOST_PORT}/health to return 200 with
#      db_connected: true.
#   5. Print the entrypoint's migration log lines as evidence (`logs api |
#      grep -i migrat`).
#   6. Owner only: wait for http://127.0.0.1:${WEB_HOST_PORT:-3000}/login to
#      return 200 (the web container).
#   7. Owner only (not with --skip-seed): refresh the owner DB's demo copy via
#      scripts/demo/load_demo_seed.py --replace -- a dry run first, applied
#      only when SEED_APPLY=yes or confirmed at a terminal (never without a
#      terminal unless SEED_APPLY=yes).
#
# What this does NOT do:
#   - git pull (run that first if you want to deploy latest).
#   - deploy the frontend for the public demo. Vercel builds it from the push
#     to main; it goes live only on `vercel promote` (auto-assign of the
#     production domain is off). The closing lines print a stack-specific
#     reminder.
#   - touch the old postgres/Dash stack (still explorer-hosted; unaffected
#     by these compose files).
#   - hand off to diagnose_server.sh; run it separately for a read-only
#     check of both stacks, the tunnel config and tailscale serve.
#
# Logs:
#   <repo>/logs/<YYYY-MM-DD-HHMMSS>-deploy-<stack>.log + logs/latest-deploy.log symlink.

set -uo pipefail

usage() {
    cat <<'USAGE'
Usage: bash deploy_server.sh [--stack owner|demo] [--skip-seed]
  --stack owner  (default) tailnet-only owner stack: api + web,
                 docker-compose.server.yml, env ~/apps/compendium/.env + ~/.secrets
  --stack demo   public demo stack: api + db, docker-compose.demo.yml,
                 env ~/apps/compendium/.env.demo ONLY (never ~/.secrets)
  --skip-seed    owner only: skip the demo-copy refresh step
Env: ENV_FILE, SECRETS_FILE (owner only), API_HOST_PORT, WEB_HOST_PORT,
     SEED_APPLY=yes|no (owner: apply the demo-copy refresh without asking),
     NO_WEB_BUILD=1 (owner: build only the api image and start with --no-build,
     so a docker-loaded compendium-web:server is used as is)
Exit: 0 ok, 1 deploy failure, 2 bad arguments, 3 deploy up but the demo-copy
      refresh dry run failed (refresh not applied)
USAGE
}

STACK="owner"
SKIP_SEED=0
while [ $# -gt 0 ]; do
    case "$1" in
        --stack)
            [ $# -ge 2 ] || { echo "ERROR: --stack needs a value (owner|demo)"; usage; exit 2; }
            STACK="$2"; shift 2 ;;
        --stack=*)
            STACK="${1#--stack=}"
            [ -n "$STACK" ] || { echo "ERROR: --stack needs a value (owner|demo)"; usage; exit 2; }
            shift ;;
        --skip-seed) SKIP_SEED=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) echo "ERROR: unknown argument: $1"; usage; exit 2 ;;
    esac
done

PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REPO_ROOT="$(cd "$PROJECT_ROOT/../.." && pwd)"
case "$STACK" in
    owner)
        COMPOSE_FILE="$PROJECT_ROOT/docker/docker-compose.server.yml"
        ENV_FILE="${ENV_FILE:-$HOME/apps/compendium/.env}"
        SECRETS_FILE="${SECRETS_FILE:-$HOME/.secrets}"
        # Historical default (the compose file's directory name, "docker"); changing
        # it would orphan the existing containers and volumes.
        PROJECT="docker"
        API_HOST_PORT="${API_HOST_PORT:-8001}"
        export API_HOST_PORT
        ;;
    demo)
        COMPOSE_FILE="$PROJECT_ROOT/docker/docker-compose.demo.yml"
        ENV_FILE="${ENV_FILE:-$HOME/apps/compendium/.env.demo}"
        PROJECT="compendium-demo"
        SECRETS_FILE=""   # never the owner's secrets, whatever the shell exported
        API_HOST_PORT="${API_HOST_PORT:-8002}"
        export DEMO_API_HOST_PORT="$API_HOST_PORT"
        ;;
    *) echo "ERROR: --stack must be owner or demo (got '$STACK')"; exit 2 ;;
esac

# Demo-copy refresh decision (owner only). SEED_APPLY wins; otherwise ask on a
# terminal and default to NO without one, so a scripted or ssh-without-tty
# deploy can never rewrite the owner DB's demo copy unattended.
seed_apply_mode() {
    if [ "$STACK" != "owner" ] || [ "$SKIP_SEED" = "1" ]; then echo skip; return; fi
    case "${SEED_APPLY:-}" in
        yes) echo yes; return ;;
        no) echo no; return ;;
    esac
    if [ -t 0 ]; then echo ask; else echo no; fi
}

# Owner only: NO_WEB_BUILD=1 keeps a docker-loaded (off-box built) web image
# from being rebuilt on the server. Demo has no web container.
web_build_mode() {
    if [ "$STACK" != "owner" ]; then echo "n/a"; return; fi
    if [ "${NO_WEB_BUILD:-}" = "1" ]; then echo no; else echo yes; fi
}

if [ -n "${PLAN_ONLY:-}" ]; then
    echo "stack=$STACK"
    echo "project=$PROJECT"
    echo "compose_file=$COMPOSE_FILE"
    echo "env_file=$ENV_FILE"
    echo "secrets_file=${SECRETS_FILE:-<none>}"
    echo "api_host_port=$API_HOST_PORT"
    echo "seed_apply=$(seed_apply_mode)"
    echo "web_build=$(web_build_mode)"
    exit 0
fi

compose() { docker compose -p "$PROJECT" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }

# --------------------------------------------------------------------------
# 0. Log capture (mirrors start_app.sh convention)
# --------------------------------------------------------------------------
LOG_DIR="$PROJECT_ROOT/logs"
LOG_TS=$(date +"%Y-%m-%d-%H%M%S")
LOG_NAME="${LOG_TS}-deploy-${STACK}.log"
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
for f in "$ENV_FILE" ${SECRETS_FILE:+"$SECRETS_FILE"} "$COMPOSE_FILE"; do
    if [ ! -f "$f" ]; then
        echo "ERROR: required file not found: $f"
        fail=1
    fi
done
if [ "$fail" -ne 0 ]; then
    echo ""
    echo "Override paths via env vars if needed:"
    if [ -n "$SECRETS_FILE" ]; then
        echo "  ENV_FILE=/path/to/.env SECRETS_FILE=/path/to/.secrets bash $0 --stack $STACK"
    else
        echo "  ENV_FILE=/path/to/env bash $0 --stack $STACK"
    fi
    exit 1
fi
echo "ok"

# --------------------------------------------------------------------------
# 2. Load env + secrets
# --------------------------------------------------------------------------
# set -a auto-exports every variable defined below (matches the section-18
# pattern). Required because compose's ${VAR} substitution reads from env,
# and bootstrap-style scripts may also read os.environ directly.
# Snapshot the seed decision first: nothing sourced below may change it.
SEED_MODE="$(seed_apply_mode)"
set -a
# shellcheck disable=SC1090
if [ -n "$SECRETS_FILE" ]; then source "$SECRETS_FILE"; fi
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
# Demo: .env.demo's DEMO_API_HOST_PORT overrides the one exported above and is
# what the container binds, so the health probe and hints must follow it.
if [ "$STACK" = "demo" ]; then API_HOST_PORT="${DEMO_API_HOST_PORT:-$API_HOST_PORT}"; fi

# --------------------------------------------------------------------------
# 3. Build + start the stack
# --------------------------------------------------------------------------
# Owner: `api` + `web`; demo: `api` + `db`. Migrations run inside the api
# container's entrypoint before uvicorn starts, so this one command covers
# build, migrate, and start. No separate migration step. Owner only: no
# postgres wait either -- its database is the real, already-running
# production database reached over the external compendium-net network, not
# a compose-managed service. The demo compose DOES have its own db service
# (healthchecked; the api waits for it via depends_on).
echo ""
echo "--- docker compose up -d --build ---"
# Explicit exit check: this script runs under `set -uo pipefail` (no `-e`,
# see the loop below that needs a failing curl to not abort the script), so
# without this check a failed build/up would leave the OLD container running
# untouched and the health wait below would then pass against it, masking
# the failure entirely.
if [ "$(web_build_mode)" = "no" ]; then
    compose build api || { echo "ERROR: docker compose build api failed"; exit 1; }
    compose up -d --no-build || { echo "ERROR: docker compose up failed"; exit 1; }
else
    compose up -d --build || { echo "ERROR: docker compose up failed"; exit 1; }
fi

# --------------------------------------------------------------------------
# 4. Confirm container status
# --------------------------------------------------------------------------
echo ""
echo "--- docker compose ps ---"
compose ps

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
        compose logs --tail 50 api
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
compose logs api | grep -i migrat || echo "  (no migration-related log lines found -- check container logs directly)"

if [ "$STACK" = "owner" ]; then
    WEB_HOST_PORT="${WEB_HOST_PORT:-3000}"
    echo ""
    echo "--- waiting for http://127.0.0.1:${WEB_HOST_PORT}/login (web) ---"
    for i in $(seq 1 60); do
        code=$(curl -s -o /dev/null -w "%{http_code}" -m 2 "http://127.0.0.1:${WEB_HOST_PORT}/login" 2>/dev/null) || code=""
        if [ "$code" = "200" ]; then
            echo "web ok ($((i * 2))s)"
            break
        fi
        sleep 2
        if [ "$i" -eq 60 ]; then
            echo "ERROR: web /login did not return 200 within 120s (last: ${code:-none})"
            compose logs --tail 50 web
            exit 1
        fi
    done
fi

mode="$SEED_MODE"
seed_dry_failed=0
if [ "$mode" != "skip" ]; then
    echo ""
    echo "--- demo copy refresh (owner DB): dry run ---"
    compose exec -T api python scripts/demo/load_demo_seed.py --replace --dry-run </dev/null
    dry_rc=$?
    apply=no
    if [ "$dry_rc" -ne 0 ]; then
        echo "dry run failed (exit $dry_rc) -- NOT applying. Exit 2 = a seed id collision, a capture-id clash or other-account rows under demo rows (see above)."
        seed_dry_failed=1
    elif [ "$mode" = "yes" ]; then
        apply=yes
    elif [ "$mode" = "ask" ]; then
        read -r -p "Apply this refresh to the owner DB's demo copy? Take a pg_dump first. [y/N] " ans
        if [ "$ans" = "y" ] || [ "$ans" = "Y" ]; then apply=yes; fi
    else
        if [ "${SEED_APPLY:-}" = "no" ]; then
            echo "SEED_APPLY=no -- not applying (SEED_APPLY=yes applies)"
        else
            echo "no terminal and SEED_APPLY is not yes -- not applying (SEED_APPLY=yes applies)"
        fi
    fi
    if [ "$apply" = "yes" ]; then
        echo "--- copying demo preview assets into ${CAPTURES_ASSETS_HOST_DIR:-<unset>} (no overwrite) ---"
        if [ -n "${CAPTURES_ASSETS_HOST_DIR:-}" ]; then
            cp -rn "$REPO_ROOT/apps/web/demo/fixtures/assets/captured-assets/." "$CAPTURES_ASSETS_HOST_DIR/" \
                || echo "WARNING: asset copy failed; rerun: sudo cp -rn $REPO_ROOT/apps/web/demo/fixtures/assets/captured-assets/. $CAPTURES_ASSETS_HOST_DIR/"
        else
            echo "WARNING: CAPTURES_ASSETS_HOST_DIR unset; preview assets not copied"
        fi
        echo "--- demo copy refresh: apply ---"
        compose exec -T api python scripts/demo/load_demo_seed.py --replace </dev/null \
            || { echo "ERROR: refresh failed (rolled back, nothing changed)"; exit 1; }
    fi
fi

echo ""
echo "=== deploy complete ==="
echo "  Log:     $LOG_PATH"
echo "  Health:  http://127.0.0.1:${API_HOST_PORT}/health"
echo "  Stop:    docker compose -p $PROJECT --env-file $ENV_FILE -f $COMPOSE_FILE down"
echo "  Logs:    docker compose -p $PROJECT --env-file $ENV_FILE -f $COMPOSE_FILE logs -f api"
echo ""
if [ "$STACK" = "owner" ]; then
    echo "  Owner stack: tailnet only (tailscale serve 443 -> :3000, 8443 -> :8001)."
else
    echo "  Demo stack: public via the Cloudflare tunnel -> :${API_HOST_PORT}. Frontend changes go live via Vercel promote."
fi

if [ "$seed_dry_failed" -eq 1 ]; then
    echo ""
    echo "WARNING: demo-copy refresh dry run failed -- deploy is up, refresh NOT applied (exit 3)"
    exit 3
fi
exit 0
