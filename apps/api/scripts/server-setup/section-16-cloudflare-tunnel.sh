#!/bin/bash
#
# section-16-cloudflare-tunnel.sh
#
# Plan: docs/project-plans/_completed/2026-05-03-155517-laptop-server-setup/plan.md section 16
# Installs cloudflared, runs `tunnel login` (interactive browser), creates the
# `compendium-tunnel`, writes config.yml, creates the DNS route, installs
# the systemd service.
#
# Interactive: `cloudflared tunnel login` opens a browser-authorization URL and
# blocks until the auth completes (similar to tailscale up). The script pauses
# there naturally.
#
# NOT covered by this script (browser steps in Cloudflare/UptimeRobot dashboards):
#   16.8 Tunnel state notifications (Cloudflare Notifications -> Tunnel Health Alert)
#   16.9 UptimeRobot external monitor (sign up + add HTTPS monitor)
#
# Idempotent: re-runnable. If tunnel already exists, the create step errors but
# the script continues with the existing tunnel ID.

set -euo pipefail

LOGDIR="$HOME/server-setup-logs"
mkdir -p "$LOGDIR"
TS="$(date +%Y%m%d-%H%M%S)"
LOGFILE="$LOGDIR/16-cloudflare-tunnel-$TS.log"
exec > >(tee -a "$LOGFILE") 2>&1

echo "=========================================="
echo "section-16-cloudflare-tunnel.sh start: $TS"
echo "host: $(hostname)"
echo "log:  $LOGFILE"
echo "=========================================="

TUNNEL_NAME="compendium-tunnel"
# No safe default -- must be the operator's own domain.
PUBLIC_HOSTNAME="${PUBLIC_HOSTNAME:?Set PUBLIC_HOSTNAME to your public domain, e.g. compendium.example.com}"
# Renamed 2026-05-23: was "compendium-demo" -- a vestige of the two-stack
# design with a separate demo app (defunct since 2026-05-14 single-stack
# consolidation). Tunnel ID is immutable, so the CF DNS CNAME for the public
# hostname resolved through the rename without disruption.
#
# Single-stack deployment (architectural correction 2026-05-14): the Dash port
# is 8051; both tailnet AND CF Tunnel route to the same app instance, with
# user-role separation handled at the app/auth layer.
APP_LOCAL_PORT="8051"

set -x

# --- 16.1: Install cloudflared ---
echo "--- 16.1: install cloudflared ---"
if ! command -v cloudflared >/dev/null 2>&1; then
  TMPDEB="/tmp/cloudflared.deb"
  curl -L --output "$TMPDEB" \
    https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
  sudo dpkg -i "$TMPDEB"
  rm -f "$TMPDEB"
else
  echo "(cloudflared already installed; version: $(cloudflared --version 2>&1 | head -1))"
fi

# --- 16.2: Authenticate ---
set +x
echo ""
echo "--- 16.2: cloudflared tunnel login ---"
if [[ ! -f "$HOME/.cloudflared/cert.pem" ]]; then
  echo "About to run 'cloudflared tunnel login'."
  echo "It prints a URL like https://dash.cloudflare.com/argotunnel?...; open in browser,"
  echo "sign into Cloudflare, choose the domain that owns PUBLIC_HOSTNAME, and authorize."
  echo "The command BLOCKS here until you complete it. cert.pem will be saved to ~/.cloudflared/."
  echo ""
  cloudflared tunnel login
else
  echo "(~/.cloudflared/cert.pem already exists; skipping login)"
fi
set -x

# --- 16.3: Create tunnel ---
echo "--- 16.3: create tunnel '$TUNNEL_NAME' ---"
set +e
CREATE_OUT=$(cloudflared tunnel create "$TUNNEL_NAME" 2>&1)
set -e
echo "$CREATE_OUT"
# Extract tunnel ID. Format from create output:
#   Created tunnel <NAME> with id <UUID>
TUNNEL_ID=$(echo "$CREATE_OUT" | grep -oE "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}" | head -1)
if [[ -z "$TUNNEL_ID" ]]; then
  # Tunnel may already exist; look up by name
  TUNNEL_ID=$(cloudflared tunnel list 2>&1 | grep "$TUNNEL_NAME" | awk '{print $1}' | head -1)
fi
if [[ -z "$TUNNEL_ID" ]]; then
  set +x
  echo "ERROR: could not determine tunnel ID. Run 'cloudflared tunnel list' to debug."
  exit 1
fi
echo "Tunnel ID: $TUNNEL_ID"

# --- 16.4: Write config.yml + credentials to /etc/cloudflared (system path) ---
# `sudo cloudflared service install` searches /etc/cloudflared/ for config (NOT
# the user's ~/.cloudflared/) because sudo's tilde resolves to root's HOME.
# Putting both config and credentials at /etc/cloudflared/ is the standard
# system-mode install pattern.
echo "--- 16.4: write /etc/cloudflared/config.yml + copy credentials ---"
# NOTE: ingress points straight at the app (:$APP_LOCAL_PORT) here. If you run
# section-19 (Caddy reverse proxy) later, it rewrites this ingress to :8080
# (Caddy front), which then proxies to the app. A config.yml showing :8080
# after section-19 is expected, not a bug.
sudo mkdir -p /etc/cloudflared
sudo tee /etc/cloudflared/config.yml > /dev/null <<EOF
tunnel: $TUNNEL_ID
credentials-file: /etc/cloudflared/$TUNNEL_ID.json

ingress:
  - hostname: $PUBLIC_HOSTNAME
    service: http://localhost:$APP_LOCAL_PORT
  - service: http_status:404
EOF

# Copy the tunnel credentials from ~/.cloudflared (where `tunnel create` wrote
# them) to /etc/cloudflared so the systemd service can read them as root.
sudo cp "$HOME/.cloudflared/$TUNNEL_ID.json" /etc/cloudflared/
sudo chown root:root /etc/cloudflared/*
sudo chmod 600 /etc/cloudflared/*.json

# --- 16.5: DNS route ---
echo "--- 16.5: cloudflared tunnel route dns ---"
set +e
cloudflared tunnel route dns "$TUNNEL_NAME" "$PUBLIC_HOSTNAME" 2>&1 || \
  echo "(DNS record may already exist; non-blocking)"
set -e

# --- 16.6: Install as systemd service ---
echo "--- 16.6: service install + enable + start ---"
if ! systemctl list-unit-files cloudflared.service 2>/dev/null | grep -q cloudflared; then
  sudo cloudflared service install
fi
sudo systemctl enable cloudflared
sudo systemctl restart cloudflared
sleep 3

# --- 16.7: Test ---
echo "--- 16.7: verify tunnel info ---"
cloudflared tunnel info "$TUNNEL_NAME"

# --- Summary ---
set +x
echo ""
echo "=========================================="
echo "DONE: section-16-cloudflare-tunnel.sh"
echo "=========================================="
echo ""
echo "Tunnel name:    $TUNNEL_NAME"
echo "Tunnel ID:      $TUNNEL_ID"
echo "Public URL:     https://$PUBLIC_HOSTNAME -> localhost:$APP_LOCAL_PORT"
echo "Service:        $(systemctl is-active cloudflared)"
echo ""
echo "Until the app stack stands up in section 18, https://$PUBLIC_HOSTNAME will return"
echo "502 Bad Gateway -- that's expected. The Tunnel itself is up and routing."
echo ""
echo "Remaining manual steps (NOT scriptable -- browser dashboards):"
echo "  16.8 Cloudflare Notifications -> add 'Tunnel Health Alert' for '$TUNNEL_NAME',"
echo "       channel = your email. Sends alert when tunnel goes offline."
echo "       URL: https://dash.cloudflare.com (Notifications in the left sidebar)"
echo "  16.9 UptimeRobot (or BetterStack / HealthChecks.io): add HTTP(s) monitor at"
echo "       https://$PUBLIC_HOSTNAME with 5-min interval. URL: https://uptimerobot.com"
echo ""
echo "Three-layer monitoring stack reminder (plan 13.8 + 16.8 + 16.9):"
echo "  Layer 1: NUT ntfy.sh push (5-10 sec, power events only) -- DONE in section 13"
echo "  Layer 2: Cloudflare tunnel health (30-90 sec, any tunnel outage)  -- todo 16.8"
echo "  Layer 3: UptimeRobot external HTTP poll (5-10 min, any outage even when home internet is down) -- todo 16.9"
echo ""
echo "Log: $LOGFILE"
