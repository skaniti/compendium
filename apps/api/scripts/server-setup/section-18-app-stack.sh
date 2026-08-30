#!/bin/bash
#
# section-18-app-stack.sh
#
# Plan: docs/project-plans/_completed/2026-05-03-155517-laptop-server-setup/plan.md section 18
# Stands up the single-stack Compendium deployment via docker compose.
# ONE app, ONE postgres, two users (primary + demo) separated by user_id + role.
#
# Replaces section-18-app-stack-personal.sh + section-19-app-stack-demo.sh
# from the original two-stack design (architectural correction made 2026-05-14).
#
# Prerequisites (NOT scriptable; must be in place BEFORE running):
#   - Docker + Compose installed (section 17 done)
#   - Tailscale joined (section 15 done; needed for CORS_ORIGINS hostname)
#   - Cloudflare Tunnel set up (section 16 done; tunnel routes compendium.example.com
#     to localhost:8051 -- verify this matches your tunnel config; older configs may
#     point at 8052 and need updating, see one-liner in section-18.4 of plan)
#   - ~/.secrets populated with the required keys (see plan section 18.2)
#   - ~/apps/compendium/.env populated with TAILNET_HOSTNAME
#
# What this script DOES (idempotent):
#   - git clones (or git pulls) into ~/apps/compendium/
#   - Ensures /var/lib/compendium-postgres and /var/lib/compendium-assets exist
#   - Builds the app image as compendium:latest
#   - docker compose up -d
#   - Waits for postgres health
#   - Runs `python -m backend.db.migrate` inside the app container
#   - Runs `python -m backend.scripts.bootstrap_user` (provisions BOTH primary and
#     demo user in a single invocation -- bootstrap_user.py reads BOOTSTRAP_* env)
#   - Curls loopback ports + tailnet URL + public URL to verify reachability
#
# What this script does NOT do:
#   - Populate ~/.secrets (you do that once; see plan section 18.2)
#   - Test public isolation (you do that from off-tailnet; see plan 18.7)
#   - Update an existing Cloudflare Tunnel config that points to the old 8052
#     port -- if your section 16 deploy used 8052 (per pre-2026-05-14 plan),
#     run the one-shot fix below before this script:
#       sudo sed -i 's|service: http://localhost:8052|service: http://localhost:8051|' /etc/cloudflared/config.yml && sudo systemctl restart cloudflared

set -euo pipefail

LOGDIR="$HOME/server-setup-logs"
mkdir -p "$LOGDIR"
TS="$(date +%Y%m%d-%H%M%S)"
LOGFILE="$LOGDIR/18-app-stack-$TS.log"
exec > >(tee -a "$LOGFILE") 2>&1

echo "=========================================="
echo "section-18-app-stack.sh start: $TS"
echo "host: $(hostname)"
echo "log:  $LOGFILE"
echo "=========================================="

REPO_URL="${REPO_URL:?Set REPO_URL to your repo's clone URL, e.g. https://github.com/<owner>/<repo>.git}"
APP_DIR="$HOME/apps/compendium"
COMPOSE_FILE="docker/server/docker-compose.yml"

# --- Sanity checks ---
echo "--- pre-flight checks ---"
if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker not installed. Run section-17-docker.sh first."
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "ERROR: 'docker compose' plugin not available. Re-run section-17-docker.sh."
  exit 1
fi
if ! command -v tailscale >/dev/null 2>&1 || ! tailscale ip -4 >/dev/null 2>&1; then
  echo "WARNING: Tailscale not up; CORS_ORIGINS will not resolve. Continue anyway? Re-run section-15-tailscale.sh if not done."
fi
if [[ ! -f "$HOME/.secrets" ]]; then
  echo "ERROR: ~/.secrets does not exist. Populate it first per plan section 18.2."
  echo "       Required keys: OPENAI_API_KEY, ANTHROPIC_API_KEY, JWT_SECRET_KEY,"
  echo "       FLASK_SECRET_KEY, POSTGRES_PASSWORD, BOOTSTRAP_EMAIL,"
  echo "       BOOTSTRAP_PASSWORD, BOOTSTRAP_DEMO_PASSWORD"
  exit 1
fi

set -x

# --- 18.1: Clone the repo ---
echo "--- 18.1: clone/update repo ---"
mkdir -p "$HOME/apps"
if [[ -d "$APP_DIR/.git" ]]; then
  echo "(repo already cloned at $APP_DIR; pulling latest)"
  git -C "$APP_DIR" pull --ff-only
else
  git clone "$REPO_URL" "$APP_DIR"
fi

# --- Ensure host dirs for volumes ---
echo "--- ensure /var/lib/compendium-postgres + /var/lib/compendium-assets ---"
sudo mkdir -p /var/lib/compendium-postgres /var/lib/compendium-assets
sudo chown 999:999 /var/lib/compendium-postgres  # postgres container UID

# --- Sanity-check .env presence ---
set +x
ENV_FILE="$APP_DIR/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  echo ""
  echo "ERROR: $ENV_FILE does not exist. Create it with TAILNET_HOSTNAME=<your.tail.ts.net>"
  echo "Example:"
  echo "  cat > $ENV_FILE <<MARKER"
  echo "  TAILNET_HOSTNAME=compendium-server.tail1234.ts.net"
  echo "MARKER"
  echo ""
  echo "Get your tailnet name from 'tailscale status --json | grep MagicDNSSuffix' or admin console."
  exit 1
fi
set -x

# --- 18.3 + 18.5: Build + up ---
echo "--- 18.3 + 18.5: docker compose build + up ---"
cd "$APP_DIR"
# Load ~/.secrets + .env into the script's environment with `set -a` so every
# variable is auto-exported. Required because: (1) compose's ${VAR} substitution
# reads from env, (2) the bootstrap_user step below passes BOOTSTRAP_* env vars
# into the container via -e flags (bootstrap_user.py reads from os.environ
# directly, NOT via pydantic-settings's .env-tuple loader).
set +x
set -a
source "$HOME/.secrets"
source "$ENV_FILE"
set +a
set -x

docker compose -f "$COMPOSE_FILE" build
docker compose -f "$COMPOSE_FILE" up -d

# --- Wait for postgres health ---
echo "--- waiting for postgres healthy ---"
for i in $(seq 1 30); do
  if docker compose -f "$COMPOSE_FILE" exec -T postgres pg_isready -U tbd -d traversal_discovery >/dev/null 2>&1; then
    echo "postgres ready (took ${i} sec)"
    break
  fi
  sleep 2
done

# --- 18.4: Migrate ---
echo "--- 18.4: run db migrations ---"
docker compose -f "$COMPOSE_FILE" exec -T app python -m backend.db.migrate

# --- 18.5: Bootstrap users (provisions BOTH primary + demo in one call) ---
# bootstrap_user.py reads from os.environ directly (not via pydantic-settings's
# .env/secrets loader). The container's env at startup doesn't have these
# values, so we pass them explicitly via -e VAR_NAME (which pulls each from
# THIS shell's env, populated by the `source ~/.secrets` above).
echo "--- 18.5: bootstrap primary + demo users (idempotent) ---"
docker compose -f "$COMPOSE_FILE" exec -T \
  -e BOOTSTRAP_EMAIL \
  -e BOOTSTRAP_PASSWORD \
  -e BOOTSTRAP_DEMO_PASSWORD \
  -e BOOTSTRAP_NAME \
  app python -m backend.scripts.bootstrap_user

# --- 18.6: Verify reachability ---
echo "--- 18.6: verify reachability (loopback + tailnet + public) ---"
sleep 5  # give honcho a beat to bring up both procs
TAILNET_HOSTNAME_VAL=$(grep TAILNET_HOSTNAME "$ENV_FILE" | cut -d= -f2- | tr -d '"' || echo "")
set +e
curl -s -o /dev/null -w "Dash    loopback :8051 -> HTTP %{http_code} (expect 200 or 302)\n" -m 5 http://127.0.0.1:8051/
curl -s -o /dev/null -w "Backend loopback :8001 -> HTTP %{http_code}\n" -m 5 http://127.0.0.1:8001/
if [[ -n "$TAILNET_HOSTNAME_VAL" ]]; then
  curl -s -o /dev/null -w "Tailnet https://$TAILNET_HOSTNAME_VAL/ -> HTTP %{http_code}\n" -m 10 "https://$TAILNET_HOSTNAME_VAL/" || echo "(tailnet URL unreachable; check tailscale serve setup)"
fi
curl -s -o /dev/null -w "Public  https://compendium.example.com/ -> HTTP %{http_code} (via CF Tunnel; expect 200 or 302)\n" -m 10 "https://compendium.example.com/"
set -e

# --- Summary ---
set +x
echo ""
echo "=========================================="
echo "DONE: section-18-app-stack.sh"
echo "=========================================="
echo ""
echo "Stack:"
docker compose -f "$COMPOSE_FILE" ps
echo ""
echo "Loopback URLs (host-only):"
echo "  Dash (frontend):       http://127.0.0.1:8051/"
echo "  FastAPI (backend):     http://127.0.0.1:8001/"
echo ""
echo "Access paths:"
echo "  Private (primary user):    https://${TAILNET_HOSTNAME_VAL:-<your-tailnet-hostname>}/  -- log in as your primary email"
echo "  Public (demo showcase):    https://compendium.example.com/                            -- log in as demo@example.com"
echo ""
echo "Remaining manual steps:"
echo "  18.6 verify-login: load each URL above in a browser. Should see the production login gate."
echo "  18.7 public-isolation check: confirm tailnet URL does NOT resolve from off-tailnet device."
echo "  18.7 demo public-access check: confirm demo@example.com sign-in works at compendium.example.com/."
echo ""
echo "OPEN ITEMS (per architecture-decision handoff 2026-05-14):"
echo "  - Host-header middleware in backend/api/main.py (gates which user-role can authenticate per hostname)"
echo "  - DQ_BOT_DISABLED migration from env var to per-user role check"
echo "  Until those land, both users CAN technically log in via either path. The"
echo "  demo's data is what the public sees; treat primary credentials as private."
echo ""
echo "Useful:"
echo "  Logs (live):       docker compose -f $APP_DIR/$COMPOSE_FILE logs -f"
echo "  Logs (app only):   docker compose -f $APP_DIR/$COMPOSE_FILE logs -f app"
echo "  Stop:              docker compose -f $APP_DIR/$COMPOSE_FILE down"
echo "  Restart:           docker compose -f $APP_DIR/$COMPOSE_FILE restart"
echo ""
echo "Log: $LOGFILE"
