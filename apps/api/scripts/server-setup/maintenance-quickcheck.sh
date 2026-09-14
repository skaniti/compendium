#!/bin/bash
#
# maintenance-quickcheck.sh
#
# Plan: the 2026-05-03 laptop-server-setup plan (private), section 22
# Routine maintenance check -- run weekly or whenever you want a quick health-status.
# Read-only; no changes made.
#
# Combines the bullets from the section 22 maintenance cadence table into one
# script that prints a pasteable summary.

set -uo pipefail

echo "=========================================="
echo "Server maintenance quickcheck: $(date)"
echo "host: $(hostname), uptime: $(uptime -p)"
echo "=========================================="

# --- Weekly: error journal ---
echo ""
echo "--- recent journal errors (this boot) ---"
ERRS_NOW=$(journalctl -b --priority=err --no-pager 2>/dev/null | wc -l)
echo "Error-level journal entries since boot: $ERRS_NOW"
if [[ "$ERRS_NOW" -gt 0 ]]; then
  echo "(Last 5 errors -- full list: journalctl -b --priority=err)"
  journalctl -b --priority=err --no-pager -n 5 2>/dev/null | sed 's/^/  /'
fi

# --- Weekly: memory + swap ---
echo ""
echo "--- memory + swap ---"
free -h | head -3
SWAP_USED_KB=$(free -k | awk '/^Swap:/ {print $3}')
SWAP_USED_MB=$((SWAP_USED_KB / 1024))
echo ""
if [[ "$SWAP_USED_MB" -gt 100 ]]; then
  echo "  WARNING: swap usage ${SWAP_USED_MB} MB exceeds 100 MB threshold from plan 1.2."
  echo "  RAM upgrade trigger MET. See spec.md 'Constraints discovered' for upgrade path."
else
  echo "  Swap usage ${SWAP_USED_MB} MB -- under 100 MB threshold (no upgrade needed)."
fi

# --- Weekly: app process memory (if running) ---
echo ""
echo "--- top 5 RSS consumers ---"
ps aux --sort=-rss --no-headers | head -5 | awk '{printf "  %-20s %8.1f MB  %s\n", $11, $6/1024, $0}' | cut -c1-120

# --- Monthly: SMART ---
echo ""
echo "--- NVMe SMART headlines ---"
SMART_OUT=$(sudo smartctl -H -A /dev/nvme0n1 2>/dev/null || echo "(smartctl unavailable)")
echo "$SMART_OUT" | grep -E "(overall-health|Available Spare|Percentage Used|Critical Warning|Media and Data)" | sed 's/^/  /'

# --- Monthly: backup freshness ---
echo ""
echo "--- backup repo + last snapshot ---"
if mountpoint -q /mnt/backup-ssd 2>/dev/null; then
  if command -v restic >/dev/null && [[ -f "$HOME/.restic-password" ]]; then
    LAST_SNAP=$(RESTIC_PASSWORD_FILE="$HOME/.restic-password" restic -r /mnt/backup-ssd/personal snapshots --last 2>/dev/null | tail -3 | head -1 || echo "(no snapshots)")
    echo "  Last snapshot: $LAST_SNAP"
  else
    echo "  (restic or password file missing -- run section-20-backups.sh)"
  fi
else
  echo "  WARNING: /mnt/backup-ssd not mounted. Plug in the SSD or check fstab."
fi

# --- Disk free ---
echo ""
echo "--- disk free ---"
df -h / /home /var /mnt/backup-ssd 2>/dev/null | grep -v "Filesystem"

# --- Services health ---
echo ""
echo "--- key services ---"
for svc in docker tailscaled cloudflared caddy nut.target nut-server nut-monitor; do
  printf "  %-22s %s\n" "$svc" "$(systemctl is-active "$svc" 2>/dev/null || echo 'inactive/missing')"
done

# --- Docker containers ---
echo ""
echo "--- docker containers ---"
if command -v docker >/dev/null; then
  docker ps --format "  {{.Names}}\t{{.Status}}" 2>/dev/null || echo "  (docker not reachable from this user; try sudo)"
fi

echo ""
echo "=========================================="
echo "Quickcheck complete: $(date)"
echo "Full cadence reference: plan section 22"
echo "=========================================="
