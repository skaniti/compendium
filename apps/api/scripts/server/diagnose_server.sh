#!/usr/bin/env bash
# Standalone health probe for the server compose stack + cloudflared tunnel.
# Run anytime to triage a 502 from compendium.example.com WITHOUT redeploying.
#
# Usage:
#   bash scripts/server/diagnose_server.sh
#
# Exit code:
#   0  if all checks pass
#   1  if any check fails (logs of compendium-app are appended in that case)
#
# Env overrides (defaults match the standard server install):
#   APP_DIR       = $HOME/apps/compendium
#   COMPOSE_FILE  = $APP_DIR/docker/server/docker-compose.yml
#   PUBLIC_URL    = https://compendium.example.com/

set -uo pipefail

APP_DIR="${APP_DIR:-$HOME/apps/compendium}"
COMPOSE_FILE="${COMPOSE_FILE:-$APP_DIR/docker/server/docker-compose.yml}"
PUBLIC_URL="${PUBLIC_URL:-https://compendium.example.com/}"

PASS=0
FAIL=0
WARN=0

ok()   { echo "[PASS] $*"; PASS=$((PASS + 1)); }
bad()  { echo "[FAIL] $*"; FAIL=$((FAIL + 1)); }
warn() { echo "[WARN] $*"; WARN=$((WARN + 1)); }

echo "=== compendium server diagnostic ($(date -Is)) ==="
echo "  compose: $COMPOSE_FILE"
echo "  public:  $PUBLIC_URL"
echo ""

# --------------------------------------------------------------------------
# 1. Containers
# --------------------------------------------------------------------------
echo "--- containers ---"
PS_LINE=$(docker ps --format '{{.Names}}|{{.Status}}' 2>/dev/null || true)

for name in compendium-postgres compendium-app; do
    line=$(echo "$PS_LINE" | grep "^${name}|" || true)
    if [ -z "$line" ]; then
        bad "$name: NOT RUNNING"
        continue
    fi
    status="${line#*|}"
    case "$name:$status" in
        compendium-postgres:*"(healthy)"*)
            ok "$name: $status" ;;
        compendium-postgres:*)
            warn "$name: $status (no healthcheck pass yet)" ;;
        *)
            # app container has no compose-level healthcheck; up == ok
            ok "$name: $status" ;;
    esac
done

# --------------------------------------------------------------------------
# 2. Frontend loopback port (cloudflared + tailscale serve target)
# --------------------------------------------------------------------------
echo ""
echo "--- frontend loopback (host -> docker port mapping) ---"
# curl -w "%{http_code}" already prints "000" on connection failure; the
# fallback handles only the unlikely case of curl itself aborting before
# emitting anything.
fe_code=$(curl -s -o /dev/null -w "%{http_code}" -m 5 "http://127.0.0.1:8051/" 2>/dev/null)
fe_code="${fe_code:-000}"
case "$fe_code" in
    2*|3*) ok  "http://127.0.0.1:8051/ -> $fe_code" ;;
    000)   bad "http://127.0.0.1:8051/ -> connection refused / timeout (frontend not listening)" ;;
    *)     bad "http://127.0.0.1:8051/ -> $fe_code" ;;
esac

# --------------------------------------------------------------------------
# 3. Backend health (in-container; backend binds container-loopback per Procfile)
# --------------------------------------------------------------------------
# The Procfile binds uvicorn to 127.0.0.1:8000 INSIDE the container, so the
# backend is unreachable from the host even though docker-compose declares
# a 127.0.0.1:8001:8000 mapping (loopback-in-container is invisible to
# docker's port-forward proxy). The meaningful test is whether the backend
# is alive on the container's loopback -- which is also where the frontend
# proc talks to it (same network namespace, both procs in honcho).
#
# Why python and not curl: the python:3.11-slim base image (per Dockerfile)
# does NOT include curl. Earlier versions of this script used curl and
# silently false-FAILed because docker exec swallowed "curl: not found".
# Python's stdlib urllib is guaranteed available since this is a Python app.
echo ""
echo "--- backend (in-container health) ---"
if docker ps --format '{{.Names}}' | grep -q '^compendium-app$'; then
    be_code=$(docker exec -i compendium-app python - <<'PYEOF' 2>/dev/null
import urllib.request, urllib.error
try:
    print(urllib.request.urlopen("http://127.0.0.1:8000/health", timeout=5).status)
except urllib.error.HTTPError as ex:
    print(ex.code)
except Exception:
    print("000")
PYEOF
)
    be_code="${be_code:-000}"
    case "$be_code" in
        2*|3*) ok  "container 127.0.0.1:8000/health -> $be_code" ;;
        404)   warn "container 127.0.0.1:8000/health -> 404 (path may not exist; uvicorn is serving though)" ;;
        000)   bad "container 127.0.0.1:8000/health -> unreachable (uvicorn proc may have died)" ;;
        *)     bad "container 127.0.0.1:8000/health -> $be_code" ;;
    esac
else
    bad "cannot check backend: compendium-app container not running"
fi

# --------------------------------------------------------------------------
# 4. Cloudflared tunnel
# --------------------------------------------------------------------------
echo ""
echo "--- cloudflared ---"
if systemctl is-active --quiet cloudflared 2>/dev/null; then
    ok "cloudflared: systemd service active"
elif docker ps --format '{{.Names}}' 2>/dev/null | grep -qi cloudflared; then
    cname=$(docker ps --format '{{.Names}}' | grep -i cloudflared | head -1)
    ok "cloudflared: running as docker container ($cname)"
else
    bad "cloudflared: NOT FOUND (neither systemd service nor docker container)"
fi

# --------------------------------------------------------------------------
# 5. Public URL (end-to-end via Cloudflare)
# --------------------------------------------------------------------------
echo ""
echo "--- public URL ---"
pub_code=$(curl -s -o /dev/null -w "%{http_code}" -m 10 "$PUBLIC_URL" 2>/dev/null)
pub_code="${pub_code:-000}"
case "$pub_code" in
    2*|3*)
        ok "$PUBLIC_URL -> $pub_code" ;;
    502)
        bad "$PUBLIC_URL -> 502 (cloudflared cannot reach origin; check loopback section above)" ;;
    503)
        bad "$PUBLIC_URL -> 503 (origin overloaded or no healthy upstream)" ;;
    000)
        bad "$PUBLIC_URL -> no response (cloudflared down OR DNS/CF outage)" ;;
    *)
        warn "$PUBLIC_URL -> $pub_code" ;;
esac

# --------------------------------------------------------------------------
# 6. If anything failed, dump the most relevant log
# --------------------------------------------------------------------------
if [ "$FAIL" -gt 0 ]; then
    echo ""
    echo "=== last 50 lines of compendium-app log (failures detected) ==="
    if docker ps --format '{{.Names}}' | grep -q '^compendium-app$'; then
        docker logs --tail 50 compendium-app 2>&1 | sed 's/^/  /'
    else
        echo "  (container not running -- nothing to fetch)"
    fi
fi

# --------------------------------------------------------------------------
# 7. Summary + exit code
# --------------------------------------------------------------------------
echo ""
echo "=== summary: $PASS PASS, $FAIL FAIL, $WARN WARN ==="

[ "$FAIL" -eq 0 ]
