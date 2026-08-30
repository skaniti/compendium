#!/bin/bash
#
# section-19-caddy.sh
#
# Plan: docs/project-plans/_completed/2026-05-03-155517-laptop-server-setup/plan.md section 19
# Installs Caddy (official apt repo), writes /etc/caddy/Caddyfile (HTTP on
# loopback :8080 proxying to Dash :8051), then repoints cloudflared + tailscale
# serve from 8051 -> 8080. Idempotent: safe to re-run.
#
# Order is deliberate: Caddy comes up + is verified BEFORE the ingress
# repointing, so the public + tailnet paths never route to a dead Caddy
# mid-script.
#
# Rollback (if something misbehaves):
#   sudo sed -i 's|service: http://localhost:8080|service: http://localhost:8051|' /etc/cloudflared/config.yml
#   sudo systemctl restart cloudflared
#   sudo tailscale serve reset
#   sudo tailscale serve --bg --https=443 http://127.0.0.1:8051
#   sudo systemctl stop caddy

set -euxo pipefail

LOGDIR="$HOME/server-setup-logs"
mkdir -p "$LOGDIR"
TS=$(date +%Y%m%d-%H%M%S)
LOG="$LOGDIR/19-caddy-$TS.log"
exec > >(tee -a "$LOG") 2>&1

echo "section-19-caddy.sh start: $TS"

# === Step 1: install Caddy via official apt repo ===
if command -v caddy >/dev/null; then
  echo "Caddy already installed: $(caddy version | head -1)"
else
  set +x  # quiet the apt-key dance trace
  sudo apt-get update
  sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update
  sudo apt-get install -y caddy
  set -x
  echo "Caddy installed: $(caddy version | head -1)"
fi

# === Step 2: write /etc/caddy/Caddyfile ===
sudo tee /etc/caddy/Caddyfile <<'CADDYFILE' >/dev/null
# /etc/caddy/Caddyfile
# Single-stack reverse proxy (plan section 19).
# Site address ':8080' matches ANY incoming Host (cloudflared forwards with
# Host: compendium.example.com; tailscale serve forwards with Host:
# compendium-server.<tailnet>.ts.net; loopback curl uses Host: 127.0.0.1).
# 'bind 127.0.0.1' constrains the listener to loopback -- defense-in-depth
# in case ufw is later misconfigured. Both ingress edges terminate TLS
# upstream; Caddy does plain HTTP routing.

:8080 {
  bind 127.0.0.1

  log {
    output stdout
    format console
    level INFO
  }

  reverse_proxy 127.0.0.1:8051
}
CADDYFILE

# === Step 3: validate config (fail fast on syntax errors) ===
sudo caddy validate --config /etc/caddy/Caddyfile

# === Step 4: enable + (re)start caddy ===
sudo systemctl daemon-reload
sudo systemctl enable caddy
sudo systemctl restart caddy
sleep 2

# === Step 5: verify Caddy responds BEFORE repointing ingress ===
echo ""
echo "--- pre-repoint: verify Caddy on :8080 ---"
CADDY_HTTP=$(curl -sI -o /dev/null -w "%{http_code}" -m 5 http://127.0.0.1:8080/ || echo "FAIL")
echo "Caddy :8080 -> HTTP $CADDY_HTTP (expect 200 or 302; anything else aborts)"
if [[ "$CADDY_HTTP" != "200" && "$CADDY_HTTP" != "302" ]]; then
  echo "ERROR: Caddy not responding correctly; aborting before repointing ingress."
  exit 1
fi

# === Step 6: repoint cloudflared upstream -> 8080 ===
if [[ -f /etc/cloudflared/config.yml ]]; then
  # Match both 8051 (post-section-18.4) and legacy 8052 (pre-section-18.4)
  sudo sed -i 's|service: http://localhost:805[12]|service: http://localhost:8080|' /etc/cloudflared/config.yml
  sudo systemctl restart cloudflared
  echo "cloudflared repointed to localhost:8080"
else
  echo "WARNING: /etc/cloudflared/config.yml not found; skipping cloudflared repoint."
fi

# === Step 7: repoint tailscale serve -> 8080 ===
sudo tailscale serve reset 2>/dev/null || true
sudo tailscale serve --bg --https=443 http://127.0.0.1:8080
echo "tailscale serve repointed to 127.0.0.1:8080"

# === Step 8: final end-to-end verification ===
# Caveat: status code alone isn't enough -- Caddy can return empty 200 for a
# host that doesn't match any server block. Also check body size to confirm
# the response is real Dash content (>1000 bytes), not an empty NOP-200.
echo ""
echo "=== final verification ==="
sleep 2
LOOPBACK_BYTES=$(curl -s -m 5 http://127.0.0.1:8080/ | wc -c)
PUBLIC_BYTES=$(curl -s -m 10 https://compendium.example.com/ | wc -c || echo "0")
echo "loopback Caddy   :8080 -> $LOOPBACK_BYTES bytes (expect ~50000+ for Dash page)"
echo "public via CF       -> $PUBLIC_BYTES bytes (expect ~50000+ for Dash page)"
if [[ "$LOOPBACK_BYTES" -lt 1000 || "$PUBLIC_BYTES" -lt 1000 ]]; then
  echo "WARNING: one or both responses look empty -- check Caddyfile site address Host matching"
fi
echo ""
echo "tailscale serve status:"
sudo tailscale serve status

echo ""
echo "Recent Caddy log entries:"
sudo journalctl -u caddy -n 10 --no-pager

echo ""
echo "=== rollback commands (if needed) ==="
echo "  sudo sed -i 's|service: http://localhost:8080|service: http://localhost:8051|' /etc/cloudflared/config.yml"
echo "  sudo systemctl restart cloudflared"
echo "  sudo tailscale serve reset"
echo "  sudo tailscale serve --bg --https=443 http://127.0.0.1:8051"
echo "  sudo systemctl stop caddy"

echo ""
echo "DONE: section-19-caddy.sh"
