#!/usr/bin/env bash
# Standalone, read-only health probe for the two compendium stacks on the
# server (tailnet-owner-demo-split, 2026-10-06). Changes nothing; run anytime.
#
#   owner stack  (docker-compose.server.yml, tailnet only)
#     compendium-api   127.0.0.1:8001  (+ compendium-postgres from the Dash-side stack)
#     compendium-web   127.0.0.1:3000
#     tailscale serve: 443 -> :3000, 8443 -> :8001
#   demo stack   (docker-compose.demo.yml, public via the Cloudflare tunnel)
#     compendium-demo-api  127.0.0.1:8002
#     compendium-demo-db
#     cloudflared routes the public API hostname to :8002 ONLY; the owner
#     ports must never appear on the tunnel.
#
# Usage:
#   bash scripts/server/diagnose_server.sh
#   PUBLIC_API_URL=https://<public-api-host> bash scripts/server/diagnose_server.sh
#
# Exit code:
#   0  if all checks pass
#   1  if any check fails (logs of the unhealthy containers are appended)
#
# Env:
#   PUBLIC_API_URL   public demo API base URL (no default); probed at /health
#                    when set. When unset, https://<PUBLIC_API_HOSTNAME> is
#                    used if ~/apps/compendium/.env (ENV_FILE) defines
#                    PUBLIC_API_HOSTNAME (the same knob section-21 reads);
#                    otherwise the public probe is skipped.
#   ENV_FILE         default ~/apps/compendium/.env (read for PUBLIC_API_HOSTNAME)
#   DEMO_PORT        demo API loopback port the tunnel may target, default 8002
#   CLOUDFLARED_CONFIG  default /etc/cloudflared/config.yml
#
# Tunnel gate (an allowlist): every `service:` line in the cloudflared config
# must be http://localhost:<DEMO_PORT>, http://127.0.0.1:<DEMO_PORT> or
# http_status:404. Anything else fails the check. The credentials-file line is
# never printed.

set -uo pipefail

PUBLIC_API_URL="${PUBLIC_API_URL:-}"
CLOUDFLARED_CONFIG="${CLOUDFLARED_CONFIG:-/etc/cloudflared/config.yml}"
ENV_FILE="${ENV_FILE:-$HOME/apps/compendium/.env}"
DEMO_PORT="${DEMO_PORT:-8002}"

# Public hostname knob: same source as section-21 (reads only this one name).
if [ -z "$PUBLIC_API_URL" ] && [ -r "$ENV_FILE" ]; then
    _ph=$(grep -h '^PUBLIC_API_HOSTNAME=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)
    [ -n "$_ph" ] && PUBLIC_API_URL="https://${_ph}"
fi

PASS=0
FAIL=0
WARN=0
UNHEALTHY=()

ok()   { echo "[PASS] $*"; PASS=$((PASS + 1)); }
bad()  { echo "[FAIL] $*"; FAIL=$((FAIL + 1)); }
warn() { echo "[WARN] $*"; WARN=$((WARN + 1)); }

echo "=== compendium server diagnostic ($(date -Is)) ==="
echo "  public:  ${PUBLIC_API_URL:-<PUBLIC_API_URL not set; public probe skipped>}"
echo ""

# --------------------------------------------------------------------------
# 1. Containers
# --------------------------------------------------------------------------
echo "--- containers ---"
PS_LINE=$(docker ps --format '{{.Names}}|{{.Status}}' 2>/dev/null || true)

# name:kind -- "healthy" needs a passing healthcheck; "up" just needs Up.
for spec in compendium-postgres:healthy compendium-api:healthy compendium-web:up \
            compendium-demo-api:healthy compendium-demo-db:healthy; do
    name="${spec%%:*}"
    kind="${spec##*:}"
    line=$(echo "$PS_LINE" | grep "^${name}|" || true)
    if [ -z "$line" ]; then
        bad "$name: NOT RUNNING"
        UNHEALTHY+=("$name")
        continue
    fi
    status="${line#*|}"
    if [ "$kind" = "up" ]; then
        case "$status" in
            Up*) ok "$name: $status" ;;
            *)   bad "$name: $status"; UNHEALTHY+=("$name") ;;
        esac
    else
        case "$status" in
            *"(healthy)"*)   ok "$name: $status" ;;
            *"(unhealthy)"*) bad "$name: $status"; UNHEALTHY+=("$name") ;;
            *)               warn "$name: $status (no healthcheck pass yet)"; UNHEALTHY+=("$name") ;;
        esac
    fi
done

# --------------------------------------------------------------------------
# 2. Loopback probes (host -> docker port mapping)
# --------------------------------------------------------------------------
echo ""
echo "--- loopback probes ---"
probe() {
    local label="$1" url="$2" code
    # curl -w "%{http_code}" already prints "000" on connection failure; the
    # fallback covers curl aborting before emitting anything.
    code=$(curl -s -o /dev/null -w "%{http_code}" -m 5 "$url" 2>/dev/null)
    code="${code:-000}"
    case "$code" in
        2*)  ok  "$label $url -> $code" ;;
        000) bad "$label $url -> not listening (connection refused / timeout)" ;;
        *)   bad "$label $url -> $code" ;;
    esac
}
probe "owner api: " "http://127.0.0.1:8001/health"
probe "owner web: " "http://127.0.0.1:3000/login"
probe "demo api:  " "http://127.0.0.1:8002/health"

# --------------------------------------------------------------------------
# 3. Cloudflared tunnel (must route the demo only)
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

# Only hostname:/service: lines are printed, never the credentials-file line.
if [ -r "$CLOUDFLARED_CONFIG" ]; then
    echo "  routes in $CLOUDFLARED_CONFIG:"
    grep -E '^\s*-? *(hostname|service):' "$CLOUDFLARED_CONFIG" | sed 's/^/    /'
    # Allowlist: only the demo port and the catch-all 404 may appear.
    bad_services=$(grep -E '^\s*-? *service:' "$CLOUDFLARED_CONFIG" \
        | sed -E 's/^\s*-? *service:\s*//; s/\s*#.*$//; s/\s+$//; s/^["'"'"']//; s/["'"'"']$//' \
        | grep -Evx "http://(localhost|127\.0\.0\.1):${DEMO_PORT}|http_status:404" || true)
    if [ -n "$bad_services" ]; then
        bad "cloudflared has service targets outside the allowlist (http://localhost:${DEMO_PORT}, http://127.0.0.1:${DEMO_PORT}, http_status:404):"
        echo "$bad_services" | sed 's/^/      /'
    else
        ok "cloudflared: every service target is the demo port ${DEMO_PORT} or http_status:404"
    fi
else
    warn "cloudflared config not readable at $CLOUDFLARED_CONFIG (run with sudo or set CLOUDFLARED_CONFIG)"
fi

# --------------------------------------------------------------------------
# 4. Tailscale serve (owner web on the tailnet)
# --------------------------------------------------------------------------
echo ""
echo "--- tailscale serve ---"
TS_SERVE=$(tailscale serve status 2>&1 || true)
echo "$TS_SERVE" | sed 's/^/  /'
if echo "$TS_SERVE" | grep -q '127\.0\.0\.1:3000'; then
    ok "tailscale serve maps to 127.0.0.1:3000"
else
    bad "tailscale serve does not mention 127.0.0.1:3000"
fi

# --------------------------------------------------------------------------
# 5. Public demo API (end-to-end via Cloudflare)
# --------------------------------------------------------------------------
echo ""
echo "--- public demo API ---"
if [ -n "$PUBLIC_API_URL" ]; then
    pub_url="${PUBLIC_API_URL%/}/health"
    pub_code=$(curl -s -o /dev/null -w "%{http_code}" -m 10 "$pub_url" 2>/dev/null)
    pub_code="${pub_code:-000}"
    case "$pub_code" in
        2*)  ok "$pub_url -> $pub_code" ;;
        502) bad "$pub_url -> 502 (cloudflared cannot reach the demo API; check the loopback section above)" ;;
        503) bad "$pub_url -> 503 (origin overloaded or no healthy upstream)" ;;
        000) bad "$pub_url -> no response (cloudflared down OR DNS/CF outage)" ;;
        *)   warn "$pub_url -> $pub_code" ;;
    esac
else
    echo "  skipped (set PUBLIC_API_URL, or PUBLIC_API_HOSTNAME in $ENV_FILE, to probe)"
fi

# --------------------------------------------------------------------------
# 6. If anything failed, dump logs of the relevant app containers
# --------------------------------------------------------------------------
if [ "$FAIL" -gt 0 ]; then
    for name in compendium-api compendium-web compendium-demo-api; do
        # Show logs for any app container that is not healthy/up, or all of
        # them when a probe failed without a container finding.
        want=0
        for u in "${UNHEALTHY[@]:-}"; do [ "$u" = "$name" ] && want=1; done
        [ "${#UNHEALTHY[@]}" -eq 0 ] && want=1
        [ "$want" -eq 1 ] || continue
        echo ""
        echo "=== last 30 lines of $name log (failures detected) ==="
        if docker ps -a --format '{{.Names}}' | grep -q "^${name}\$"; then
            docker logs --tail 30 "$name" 2>&1 | sed 's/^/  /'
        else
            echo "  (container does not exist -- nothing to fetch)"
        fi
    done
fi

# --------------------------------------------------------------------------
# 7. Summary + exit code
# --------------------------------------------------------------------------
echo ""
echo "=== summary: $PASS PASS, $FAIL FAIL, $WARN WARN ==="

[ "$FAIL" -eq 0 ]
