#!/bin/bash
#
# section-22-ops-journal.sh
#
# Plan: the 2026-09-28 server-audit-and-ops-journal plan (private), spec
# section 4.2 / 4.3.
#
# User-run once (uses sudo inside). Sets up the server side of the ops
# journal:
#   1. /var/log/compendium-ops, /runs and /api, owned $USER:adm, mode 2750
#      (setgid so new files inherit group adm, which the read-only
#      claude-ro user belongs to).
#   2. $HOME/bin/ops -> apps/api/scripts/server/ops-run.sh in this checkout.
#   3. /etc/logrotate.d/compendium-api for /var/log/compendium-ops/api/api.jsonl
#      (daily, rotate 14, compress, copytruncate).
#   4. Prints the umask note. Nothing here reads or prints a secret.
#
# Idempotent: safe to re-run. RENDER_ONLY=1 prints what would be done (and
# the logrotate drop-in) to stdout and exits before any sudo, log file, or
# mutation.

set -euo pipefail

RENDER_ONLY="${RENDER_ONLY:-}"
JOURNAL_ROOT="/var/log/compendium-ops"
LOGROTATE_DEST="/etc/logrotate.d/compendium-api"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPS_RUN="$(cd "$HERE/../server" && pwd)/ops-run.sh"
OPS_LINK="$HOME/bin/ops"
OWNER="${USER:-$(id -un)}"

if [[ -z "$RENDER_ONLY" ]]; then
  LOGDIR="$HOME/server-setup-logs"
  mkdir -p "$LOGDIR"
  TS=$(date +%Y%m%d-%H%M%S)
  LOG="$LOGDIR/22-ops-journal-$TS.log"
  exec > >(tee -a "$LOG") 2>&1
  echo "section-22-ops-journal.sh start: $TS"
else
  echo "section-22-ops-journal.sh start: RENDER_ONLY=1 (no sudo, no log file, no mutation)"
fi

LOGROTATE_CONTENT=$(cat <<ROTATE
$JOURNAL_ROOT/api/api.jsonl {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
ROTATE
)

if [[ -n "$RENDER_ONLY" ]]; then
  echo "would: sudo install -d -o $OWNER -g adm -m 2750 $JOURNAL_ROOT $JOURNAL_ROOT/runs $JOURNAL_ROOT/api"
  echo "would: sudo chmod 2750 on the three dirs (install -d does not reliably keep setgid on existing dirs)"
  echo "would: ln -sfn $OPS_RUN $OPS_LINK"
  echo "would: write $LOGROTATE_DEST (root:root 0644):"
  echo "$LOGROTATE_CONTENT"
  exit 0
fi

set -x

# === Step 1: journal directories ===
sudo install -d -o "$OWNER" -g adm -m 2750 "$JOURNAL_ROOT" "$JOURNAL_ROOT/runs" "$JOURNAL_ROOT/api"
sudo chown "$OWNER":adm "$JOURNAL_ROOT" "$JOURNAL_ROOT/runs" "$JOURNAL_ROOT/api"
sudo chmod 2750 "$JOURNAL_ROOT" "$JOURNAL_ROOT/runs" "$JOURNAL_ROOT/api"
ls -ld "$JOURNAL_ROOT" "$JOURNAL_ROOT/runs" "$JOURNAL_ROOT/api"

# === Step 2: ~/bin/ops symlink ===
if [[ ! -x "$OPS_RUN" ]]; then
  echo "ERROR: $OPS_RUN missing or not executable" >&2
  exit 1
fi
mkdir -p "$HOME/bin"
ln -sfn "$OPS_RUN" "$OPS_LINK"
ls -l "$OPS_LINK"

# === Step 3: logrotate drop-in for the API file log ===
printf '%s\n' "$LOGROTATE_CONTENT" | sudo tee "$LOGROTATE_DEST" >/dev/null
sudo chown root:root "$LOGROTATE_DEST"
sudo chmod 0644 "$LOGROTATE_DEST"
sudo logrotate --debug "$LOGROTATE_DEST" || echo "WARNING: logrotate --debug reported a problem; review above"

set +x
echo ""
echo "Note: the journal files inherit group adm via setgid, but their mode comes"
echo "from the writer's umask. Add 'umask 027' to your shell profile so run logs"
echo "and journal.jsonl are created group-readable (not world-readable)."
echo "Ensure \$HOME/bin is on PATH so 'ops <script>' resolves."
echo ""
echo "DONE: section-22-ops-journal.sh"
