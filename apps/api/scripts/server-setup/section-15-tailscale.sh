#!/bin/bash
#
# section-15-tailscale.sh
#
# Plan: docs/project-plans/_completed/2026-05-03-155517-laptop-server-setup/plan.md section 15
# Installs Tailscale, brings it up (interactive OAuth via URL), sets hostname, verifies.
#
# Interactive: `sudo tailscale up` prints an auth URL and BLOCKS until you click
# "authorize" in the browser. The script pauses there naturally; no --continue
# mechanism needed.
#
# Alternative: pass an auth key as the first arg (--auth-key=tskey-XXXX-XXXX) to
# skip the browser step. Generate keys at https://login.tailscale.com/admin/settings/keys.
#
# Idempotent: re-runnable. Already-installed apt package is no-op. Re-running
# `tailscale up` on an already-authorized device is also no-op.

set -euo pipefail

LOGDIR="$HOME/server-setup-logs"
mkdir -p "$LOGDIR"
TS="$(date +%Y%m%d-%H%M%S)"
LOGFILE="$LOGDIR/15-tailscale-$TS.log"
exec > >(tee -a "$LOGFILE") 2>&1

echo "=========================================="
echo "section-15-tailscale.sh start: $TS"
echo "host: $(hostname)"
echo "log:  $LOGFILE"
echo "=========================================="

AUTH_KEY="${1:-}"
HOSTNAME_TARGET="compendium-server"

set -x

# --- 15.1: Install Tailscale ---
echo "--- 15.1: install Tailscale ---"
if ! command -v tailscale >/dev/null 2>&1; then
  curl -fsSL https://tailscale.com/install.sh | sh
else
  echo "(tailscale already installed)"
fi

# --- 15.1 (cont): bring it up ---
echo "--- 15.1: tailscale up ---"
set +x
if [[ -n "$AUTH_KEY" ]]; then
  echo "Running 'sudo tailscale up' with auth-key (non-interactive)..."
  sudo tailscale up --auth-key="$AUTH_KEY" --hostname="$HOSTNAME_TARGET" --accept-routes
else
  echo ""
  echo "About to run 'sudo tailscale up'. It will print a URL like:"
  echo "    https://login.tailscale.com/a/XXXXXXXXXXXX"
  echo "Open that URL in any browser on any device (your daily-driver laptop is fine),"
  echo "sign in to Tailscale, and click 'Connect'. The command BLOCKS here until you do."
  echo ""
  sudo tailscale up --hostname="$HOSTNAME_TARGET" --accept-routes
fi
set -x

# --- 15.2: confirm + 15.3 set hostname ---
echo "--- 15.2 + 15.3: status + hostname ---"
sudo tailscale set --hostname="$HOSTNAME_TARGET"
sleep 2
tailscale status

# --- Summary ---
set +x
TS_IP=$(tailscale ip -4 2>/dev/null | head -1 || echo "(no IP yet)")
TS_HOSTNAME=$(tailscale status --json 2>/dev/null | grep -oE '"DNSName":"[^"]+"' | head -1 | cut -d'"' -f4 || echo "(check admin console)")

echo ""
echo "=========================================="
echo "DONE: section-15-tailscale.sh"
echo "=========================================="
echo ""
echo "Tailscale IPv4 on this host: $TS_IP"
echo "Tailscale DNS name:          ${TS_HOSTNAME:-not-yet-resolved}"
echo ""
echo "Remaining manual steps (NOT scriptable):"
echo "  1. Enable MagicDNS in admin console: https://login.tailscale.com/admin/dns"
echo "     (Toggle 'MagicDNS' to on. After this, '$HOSTNAME_TARGET.<tailnet>.ts.net' resolves on all your tailnet devices.)"
echo "  2. From your daily-driver laptop (also on the tailnet), test reachability:"
echo "       ssh <user>@$HOSTNAME_TARGET.<tailnet>.ts.net"
echo "     Expected: connects via Tailscale's WireGuard mesh, NOT via your home LAN."
echo "  3. From a phone-on-cellular (NOT on tailnet), confirm the hostname does NOT resolve."
echo "     This proves the tailnet is private."
echo ""
echo "Optional 15.5 (HTTPS via tailscale serve, for the app later):"
echo "  Defer until after section 18 (the app is up). When ready:"
echo "    sudo tailscale serve --https=443 http://localhost:8051"
echo "  After that, the app is reachable at https://$HOSTNAME_TARGET.<tailnet>.ts.net/ with a real cert."
echo ""
echo "Log: $LOGFILE"
