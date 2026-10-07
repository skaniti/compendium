#!/bin/bash
#
# section-21-autostart-verify.sh
#
# Plan: the 2026-05-03 laptop-server-setup plan (private), section 21
# Enables auto-start for all services and verifies they come back after a reboot.
#
# Usage:
#   bash section-21-autostart-verify.sh                # default: enable + pre-test verify
#   bash section-21-autostart-verify.sh --post-verify  # after laptop comes back from a power cycle
#
# Pre-test mode: confirms all services are enabled + active, prints the
# pull-plug-test instructions for you to do physically.
#
# Post-verify mode: runs after the laptop has rebooted from the test. Confirms
# all services came back, captures the time-to-ready RTO if `last reboot` is recent.

set -euo pipefail

# tailnet-owner-demo-split: owner web + API on the tailnet, demo API on loopback
# and (optionally) its public hostname. Hostnames come from the non-secret
# ~/apps/compendium/.env (TAILNET_HOSTNAME, PUBLIC_API_HOSTNAME).
url_liveness() {
  local env_file="$HOME/apps/compendium/.env" tailnet public
  tailnet=$(grep -h '^TAILNET_HOSTNAME=' "$env_file" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)
  public=$(grep -h '^PUBLIC_API_HOSTNAME=' "$env_file" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)
  if [[ -n "$tailnet" ]]; then
    curl -s -o /dev/null -w "  owner web  https://$tailnet/login -> HTTP %{http_code}\n" -m 5 "https://$tailnet/login" || echo "  owner web: unreachable"
    curl -s -o /dev/null -w "  owner api  https://$tailnet:8443/health -> HTTP %{http_code}\n" -m 5 "https://$tailnet:8443/health" || echo "  owner api: unreachable"
  else
    echo "  (TAILNET_HOSTNAME not set in $env_file; skipping tailnet probes)"
  fi
  curl -s -o /dev/null -w "  demo api   http://127.0.0.1:8002/health -> HTTP %{http_code}\n" -m 5 "http://127.0.0.1:8002/health" || echo "  demo api: unreachable"
  if [[ -n "$public" ]]; then
    curl -s -o /dev/null -w "  demo public https://$public/health -> HTTP %{http_code}\n" -m 10 "https://$public/health" || echo "  demo public: unreachable"
  fi
}

LOGDIR="$HOME/server-setup-logs"
mkdir -p "$LOGDIR"
TS="$(date +%Y%m%d-%H%M%S)"
LOGFILE="$LOGDIR/21-autostart-$TS.log"
exec > >(tee -a "$LOGFILE") 2>&1

MODE="${1:-pre}"
case "$MODE" in
  --post-verify) MODE="post" ;;
  ""|"pre")      MODE="pre" ;;
  *)
    echo "Unknown arg: $MODE"
    echo "Usage: $0 [--post-verify]"
    exit 1 ;;
esac

echo "=========================================="
echo "section-21-autostart-verify.sh start: $TS  (mode: $MODE)"
echo "host: $(hostname)"
echo "log:  $LOGFILE"
echo "=========================================="

if [[ "$MODE" == "pre" ]]; then
  set -x

  # --- 21.1: Enable everything ---
  echo "--- 21.1: enable services for auto-start ---"
  SERVICES=(docker tailscaled cloudflared nut.target nut-server nut-monitor nut-driver-enumerator)
  for svc in "${SERVICES[@]}"; do
    sudo systemctl enable "$svc" 2>&1 || echo "(could not enable $svc; may not be installed)"
  done

  set +x
  # --- Pre-flight: are all services currently active? ---
  echo ""
  echo "--- pre-test state (everything should be active) ---"
  printf "%-30s %s\n" "service" "active?"
  printf "%-30s %s\n" "---" "---"
  for svc in "${SERVICES[@]}" "nut-driver@homeups.service"; do
    printf "%-30s %s\n" "$svc" "$(systemctl is-active "$svc" 2>/dev/null || echo 'inactive/missing')"
  done

  echo ""
  echo "--- Compose stacks (should have restart: unless-stopped) ---"
  if command -v docker >/dev/null 2>&1; then
    docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null || echo "(no docker access)"
  fi

  echo ""
  echo "--- URL liveness (should respond before the test) ---"
  url_liveness

  echo ""
  echo "=========================================="
  echo "PRE-TEST READY"
  echo "=========================================="
  echo ""
  echo "Now do the actual physical test (plan 21.2):"
  echo "  1. Confirm the URL probes above respond (owner web/api, demo api, demo public if shown)."
  echo "  2. Pull the UPS plug from the WALL (not laptop from UPS)."
  echo "  3. Wait 60-120 seconds."
  echo "  4. Plug the UPS back in."
  echo "  5. Wait for the laptop to boot (~30-60 sec after AC restore)."
  echo "  6. SSH back in once it's up."
  echo "  7. Re-run THIS script with --post-verify"
  echo ""
  echo "Note: with your UPS battery sized for ~2.67 hr runtime at 5% load, a 60-120 sec"
  echo "outage won't actually drain the UPS. NUT won't fire SHUTDOWNCMD. The laptop stays"
  echo "up the whole time. That's a valid test (proves UPS rides through short outages),"
  echo "but it does NOT exercise NUT's shutdown signaling end-to-end."
  echo ""
  echo "To force the full NUT shutdown path, temporarily lower the low-battery threshold:"
  echo "  Add to /etc/nut/upsmon.conf:  RBWARNTIME 14400   # warn-but-not-shutdown 4hr"
  echo "  Or trigger via NUT command:   sudo upsmon -c fsd  # force shutdown immediately"
  echo "  (Both routes documented in plan 13.7 + 21.2.)"
  echo ""
  echo "Log: $LOGFILE"
else
  # --- 21.3: Post-verify mode ---
  echo "--- 21.3: post-recovery verification ---"
  set -x

  # Boot time + uptime
  LAST_BOOT=$(uptime -s)
  UPTIME=$(uptime -p)
  set +x
  echo ""
  echo "Last boot: $LAST_BOOT"
  echo "Uptime:    $UPTIME"
  echo ""

  set -x
  # Check all services
  set +x
  echo "--- service state after boot ---"
  SERVICES=(docker tailscaled cloudflared nut.target nut-server nut-monitor nut-driver-enumerator nut-driver@homeups.service)
  for svc in "${SERVICES[@]}"; do
    printf "%-30s %s\n" "$svc" "$(systemctl is-active "$svc" 2>/dev/null || echo 'inactive/missing')"
  done

  echo ""
  echo "--- Compose stacks ---"
  if command -v docker >/dev/null 2>&1; then
    docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null
  fi

  echo ""
  echo "--- URL liveness ---"
  url_liveness

  echo ""
  echo "--- recent boot errors (journalctl -b --priority=err) ---"
  journalctl -b --priority=err --no-pager | head -30

  echo ""
  echo "=========================================="
  echo "POST-TEST CHECK COMPLETE"
  echo "=========================================="
  echo ""
  echo "Time-to-ready (RTO) from boot to all services active: check $LAST_BOOT against the"
  echo "earliest timestamp on a 'Started X' line for tailscaled / cloudflared / docker."
  echo "Rough estimate: 30-90 seconds is typical."
  echo ""
  echo "If anything didn't come back: fix it now while the test context is fresh."
  echo "Better to surface gaps during a controlled test than during a real 3am outage."
  echo ""
  echo "Log: $LOGFILE"
fi
