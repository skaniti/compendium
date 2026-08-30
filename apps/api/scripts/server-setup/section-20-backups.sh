#!/bin/bash
#
# section-20-backups.sh
#
# Plan: docs/project-plans/_completed/2026-05-03-155517-laptop-server-setup/plan.md section 20
#       docs/project-plans/_completed/2026-06-09-214610-server-ro-access-local-mirror-backups/
#         plan.md Phase 4 + spec.md ADDENDUM 2026-06-18 (CRR = Cloud Restic Repo)
#
# Sets up restic + a nightly cron backup for the single-stack deployment.
#
# === 2026-06-18 refactor (CRR workstream) =================================
#   * CLOUD-FIRST. The off-site cloud repo (Cloudflare R2) is the keystone layer
#     and runs with NO external SSD and NO manual step -- so a server loss never
#     costs more than ~1 day. The SSD repo is now an OPTIONAL second layer added
#     only when the disk is physically mounted: you can run this script while
#     travelling (it sets up cloud-only and skips the SSD WITHOUT failing), then
#     re-run it when home to add the SSD layer. The old script hard-exited when
#     /mnt/backup-ssd was absent -- dead on arrival away from the server.
#   * RESTORE-SAFE DB ARTIFACT. The old runner copied the RAW live
#     /var/lib/compendium-postgres directory -- file-copying a running cluster is
#     not a consistent, restore-safe backup. The runner now takes a proper
#     `pg_dump -Fc` THROUGH the Postgres container (same container-dump pattern as
#     scripts/backup_db.sh, commit 8c504f3) and backs up that dump file instead.
# =========================================================================
#
# Prerequisites:
#   - $HOME/.secrets contains (sourced as shell; keep it mode 600):
#       RESTIC_PASSWORD=<long-strong-random-string>   # repo encryption key (BOTH repos)
#       R2_ACCOUNT_ID=<cloudflare account id>          # cloud repo (Cloudflare R2)
#       R2_BUCKET=<r2 bucket name>                     #   "
#       AWS_ACCESS_KEY_ID=<r2 api token access key id>     # restic s3 backend auth
#       AWS_SECRET_ACCESS_KEY=<r2 api token secret>        #   "
#     RESTIC_PASSWORD is CRITICAL -- losing it makes BOTH repos unrecoverable
#     forever. Save it in your password manager BEFORE running this.
#   - (optional, SSD layer) External SSD mounted at /mnt/backup-ssd. If absent,
#     the SSD layer is skipped with a notice; the cloud layer still sets up.
#
# What this script DOES:
#   - Installs restic (apt) if it isn't already on PATH
#   - Writes $HOME/.restic-password (mode 600) from RESTIC_PASSWORD
#   - `restic init`s the cloud repo (R2) if configured + not already initialised
#   - `restic init`s the SSD repo at /mnt/backup-ssd/personal IF the SSD is mounted
#   - Writes $HOME/scripts/backup-personal.sh (the nightly runner; see below)
#   - Installs a 03:00 daily cron entry running that runner
#
# The nightly runner (backup-personal.sh):
#   1. pg_dump -Fc THROUGH the `compendium-postgres` container -> dated .dump file
#      in $HOME/backups/db/ (validates the PGDMP magic before continuing)
#   2. restic backup {that dump, ~/.secrets, app .env, /var/lib/compendium-assets}
#      to the cloud repo (always) AND the SSD repo (only when mounted)
#   3. restic forget --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune
#
# NOT covered:
#   - SSD format / fstab setup (do it manually per plan 20.1 before re-running
#     with the disk attached; the pre-flight prints the exact commands)
#   - Off-site USB rotation: OBSOLETE -- the cloud repo IS the off-site layer now.
#   - Demo backups: the assets tree is content-addressed + commingled, so demo
#     bytes ride along by hash; section 20.5's demo-exclusion is consciously
#     waived (see the assets note in the runner).
#   - Quarterly restore test: the summary prints the command; do it once now.

set -euo pipefail

LOGDIR="$HOME/server-setup-logs"
mkdir -p "$LOGDIR"
TS="$(date +%Y%m%d-%H%M%S)"
LOGFILE="$LOGDIR/20-backups-$TS.log"
exec > >(tee -a "$LOGFILE") 2>&1

echo "=========================================="
echo "section-20-backups.sh start: $TS"
echo "host: $(hostname)"
echo "log:  $LOGFILE"
echo "=========================================="

BACKUP_MOUNT="/mnt/backup-ssd"
SSD_REPO="$BACKUP_MOUNT/personal"
BACKUP_SCRIPT="$HOME/scripts/backup-personal.sh"
RESTIC_PW_FILE="$HOME/.restic-password"
PG_CONTAINER="compendium-postgres"

# --- Pre-flight ---
echo "--- pre-flight checks ---"

if [[ ! -f "$HOME/.secrets" ]]; then
  echo "ERROR: ~/.secrets missing. It must define RESTIC_PASSWORD plus the R2_* / AWS_* cloud creds (see header)."
  exit 1
fi
# shellcheck disable=SC1090
source "$HOME/.secrets"

if [[ -z "${RESTIC_PASSWORD:-}" ]]; then
  echo "ERROR: RESTIC_PASSWORD not set in ~/.secrets."
  echo "  Generate one: openssl rand -hex 32   (paste into ~/.secrets as RESTIC_PASSWORD=<hex>)"
  echo "  Save it ALSO in your password manager -- losing it = unrecoverable backups (BOTH repos)."
  exit 1
fi

# Cloud repo (Cloudflare R2) availability: all four vars must be present.
CLOUD_AVAILABLE=false
CLOUD_REPO=""
if [[ -n "${R2_ACCOUNT_ID:-}" && -n "${R2_BUCKET:-}" \
      && -n "${AWS_ACCESS_KEY_ID:-}" && -n "${AWS_SECRET_ACCESS_KEY:-}" ]]; then
  CLOUD_AVAILABLE=true
  CLOUD_REPO="s3:https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET}"
  export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
  # If `restic init` below fails with a region / SignatureDoesNotMatch error,
  # add `AWS_DEFAULT_REGION=auto` to ~/.secrets and re-run (R2 accepts "auto").
  echo "cloud repo (R2): CONFIGURED -> $CLOUD_REPO"
else
  echo "cloud repo (R2): NOT configured (R2_*/AWS_* missing in ~/.secrets)."
fi

# SSD repo availability: only when the external disk is mounted.
SSD_AVAILABLE=false
if mountpoint -q "$BACKUP_MOUNT"; then
  SSD_AVAILABLE=true
  echo "ssd repo: AVAILABLE ($BACKUP_MOUNT mounted) -> $SSD_REPO"
else
  echo "ssd repo: SKIPPED ($BACKUP_MOUNT not mounted -- expected while travelling)."
  echo "  To add the SSD layer later (when physically at the server):"
  echo "    sudo mkfs.ext4 /dev/sdX1      # ONLY when formatting a fresh disk; DESTROYS /dev/sdX1 -- verify first"
  echo "    sudo mkdir -p $BACKUP_MOUNT && sudo mount /dev/sdX1 $BACKUP_MOUNT"
  echo "    echo 'UUID=<from blkid> $BACKUP_MOUNT ext4 defaults,nofail 0 2' | sudo tee -a /etc/fstab"
  echo "  ...then re-run this script; it inits the SSD repo and the runner picks it up automatically."
fi

if [[ "$CLOUD_AVAILABLE" == false && "$SSD_AVAILABLE" == false ]]; then
  echo "ERROR: neither the cloud repo nor the SSD is available -- nothing to back up to."
  echo "  Configure R2_*/AWS_* in ~/.secrets (cloud) and/or mount the SSD, then re-run."
  exit 1
fi

# --- Install restic + cron (skip whichever is already present) ---
# cron is required for the nightly schedule; minimal server images often ship
# without it, in which case the `crontab` step at the end would fail (with set -e,
# after the repo + runner were already set up). Install both up front.
echo "--- install restic + cron ---"
NEED_PKGS=()
command -v restic  >/dev/null 2>&1 || NEED_PKGS+=(restic)
command -v crontab >/dev/null 2>&1 || NEED_PKGS+=(cron)
if [[ ${#NEED_PKGS[@]} -gt 0 ]]; then
  echo "installing: ${NEED_PKGS[*]}"
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y "${NEED_PKGS[@]}"
else
  echo "(restic + cron already present)"
fi
# Ensure the cron daemon is enabled + running so installed entries actually fire.
if command -v systemctl >/dev/null 2>&1; then
  sudo systemctl enable --now cron 2>/dev/null \
    || sudo systemctl enable --now crond 2>/dev/null \
    || echo "WARNING: could not enable the cron daemon; check 'systemctl status cron'."
fi
echo "(restic: $(command -v restic || echo MISSING) | crontab: $(command -v crontab || echo MISSING))"

# --- Write password file (mode 600) ---
echo "--- write $RESTIC_PW_FILE (mode 600) ---"
( umask 077; printf '%s\n' "$RESTIC_PASSWORD" > "$RESTIC_PW_FILE" )
chmod 600 "$RESTIC_PW_FILE"
export RESTIC_PASSWORD_FILE="$RESTIC_PW_FILE"

# --- Init repos (idempotent) ---
if [[ "$CLOUD_AVAILABLE" == true ]]; then
  echo "--- restic init cloud repo (if needed) ---"
  if restic -r "$CLOUD_REPO" cat config >/dev/null 2>&1; then
    echo "(cloud repo already initialised)"
  else
    restic -r "$CLOUD_REPO" init
  fi
fi

if [[ "$SSD_AVAILABLE" == true ]]; then
  echo "--- restic init SSD repo (if needed) ---"
  if [[ -d "$SSD_REPO/keys" ]]; then
    echo "(SSD repo already initialised at $SSD_REPO)"
  else
    restic -r "$SSD_REPO" init
  fi
fi

# --- Write the nightly runner ---
# Fully-quoted heredoc: NOTHING expands at write-time. Every $VAR below is a
# RUNTIME variable resolved on the server when cron runs the runner. Paths are
# derived from $HOME so the runner is install-location independent.
echo "--- write $BACKUP_SCRIPT ---"
mkdir -p "$HOME/scripts"
cat > "$BACKUP_SCRIPT" <<'RUNNER_EOF'
#!/bin/bash
# Nightly restic backup -- CLOUD-FIRST, SSD when mounted.
# GENERATED by scripts/server-setup/section-20-backups.sh -- do not hand-edit;
# re-run the setup script to regenerate. Plan ref: 2026-06-09 DR plan Phase 4 +
# spec ADDENDUM 2026-06-18 (CRR).
#
# Deliberately NOT `set -e`: a failure pushing to one repo must not stop the
# other, and restic's "completed with warnings" (exit 3) is tolerated.
set -uo pipefail

# cron runs with a minimal PATH; make sure docker + restic are findable
# regardless of whether restic came from apt (/usr/bin) or a ~/bin static binary.
export PATH="$HOME/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"

# shellcheck disable=SC1090
source "$HOME/.secrets"
export RESTIC_PASSWORD_FILE="$HOME/.restic-password"
# R2 (restic s3 backend) auth; harmless no-ops if the cloud repo isn't configured.
export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-}"

APP_DIR="$HOME/apps/compendium"
PG_CONTAINER="${PG_CONTAINER:-compendium-postgres}"
SSD_REPO="/mnt/backup-ssd/personal"
CLOUD_REPO=""
if [[ -n "${R2_ACCOUNT_ID:-}" && -n "${R2_BUCKET:-}" ]]; then
  CLOUD_REPO="s3:https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET}"
fi

RETENTION=( --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune )
RUNNER_FAILED=0

# --- 1. Restore-safe DB dump THROUGH the container (not the raw data dir) ---
DUMP_DIR="$HOME/backups/db"
mkdir -p "$DUMP_DIR"
DUMP_FILE="$DUMP_DIR/traversal_discovery-$(date +%Y%m%d-%H%M%S).dump"
echo "[backup] pg_dump -Fc via container '$PG_CONTAINER' -> $DUMP_FILE"
# $POSTGRES_PASSWORD is evaluated INSIDE the container, so the secret never lands
# on the host process list. -Fc = custom format (compressed, pg_restore-able).
docker exec "$PG_CONTAINER" sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U tbd -d traversal_discovery -Fc --no-owner --no-privileges' \
  > "$DUMP_FILE"

# Validate before it reaches restic: a custom-format dump begins with "PGDMP".
if [[ ! -s "$DUMP_FILE" || "$(head -c5 "$DUMP_FILE")" != "PGDMP" ]]; then
  echo "[backup] FATAL: '$DUMP_FILE' missing or not a valid PGDMP dump; aborting before restic." >&2
  exit 1
fi
echo "[backup] dump OK ($(du -h "$DUMP_FILE" | cut -f1))"

# Keep only the 5 newest local dumps; restic holds the real retained history.
ls -1t "$DUMP_DIR"/traversal_discovery-*.dump 2>/dev/null | tail -n +6 | xargs -r rm -f

# --- 2. Build the backup target set ---
# DB dump (primary restore artifact), app secrets, non-secret deploy config.
BACKUP_TARGETS=( "$DUMP_FILE" "$HOME/.secrets" )
[[ -f "$APP_DIR/.env" ]] && BACKUP_TARGETS+=( "$APP_DIR/.env" )
# Assets: content-addressed UNSCOPED tree (personal + demo bytes commingled by
# hash; section 20.5 demo-exclusion consciously waived). Populated + world-
# readable as of 2026-06-18 (~419 MB; files are root:root mode 644 under a 0755
# tree, so this deploy user reads them), so restic backs them up cleanly. The
# rc=3 ("completed with warnings") branch below still covers any one unreadable
# file defensively.
[[ -d /var/lib/compendium-assets ]] && BACKUP_TARGETS+=( /var/lib/compendium-assets )

backup_repo() {
  local label="$1" repo="$2"
  echo "[backup] -> $label  ($repo)"
  restic -r "$repo" backup "${BACKUP_TARGETS[@]}"
  local rc=$?
  if [[ $rc -eq 0 || $rc -eq 3 ]]; then
    [[ $rc -eq 3 ]] && echo "[backup] $label: completed WITH WARNINGS (rc=3; some files unreadable)"
    restic -r "$repo" forget "${RETENTION[@]}" || echo "[backup] $label: forget/prune warning (non-fatal)"
    echo "[backup] $label: OK"
  else
    echo "[backup] $label: FAILED (restic rc=$rc)" >&2
    RUNNER_FAILED=1
  fi
}

# --- 3. Push: cloud first (runs even with the SSD unplugged), SSD when mounted ---
if [[ -n "$CLOUD_REPO" ]]; then
  backup_repo "cloud/R2" "$CLOUD_REPO"
else
  echo "[backup] cloud repo not configured (R2_* unset in ~/.secrets); skipping cloud."
fi

if mountpoint -q /mnt/backup-ssd; then
  backup_repo "ssd" "$SSD_REPO"
else
  echo "[backup] /mnt/backup-ssd not mounted; skipping SSD layer (cloud already covered)."
fi

if [[ $RUNNER_FAILED -ne 0 ]]; then
  echo "[backup] DONE WITH ERRORS -- at least one repo failed (see above)." >&2
  exit 1
fi
echo "[backup] DONE -- all configured repos succeeded."
RUNNER_EOF
chmod +x "$BACKUP_SCRIPT"

# --- Cron entry (03:00 daily; idempotent re-install) ---
echo "--- install cron entry at 03:00 daily ---"
mkdir -p "$HOME/logs"
CRON_LINE="0 3 * * * $BACKUP_SCRIPT > $HOME/logs/backup-personal-\$(date +\\%Y\\%m\\%d).log 2>&1"
# New crontab = existing entries minus any prior line for THIS runner, plus ours.
# The `|| true` is load-bearing: with no crontab yet `crontab -l` exits 1, and
# `grep -v` exits 1 when it filters everything -- either would trip set -e/pipefail
# and abort before the entry (and the summary) were written. -F: treat the path
# as a fixed string, not a regex.
{
  crontab -l 2>/dev/null | grep -v -F "$BACKUP_SCRIPT" || true
  echo "$CRON_LINE"
} | crontab -
echo "cron entry now installed:"
crontab -l | grep -F "$BACKUP_SCRIPT" || echo "WARNING: cron entry not found after install -- investigate."

# --- Summary ---
echo ""
echo "=========================================="
echo "DONE: section-20-backups.sh"
echo "=========================================="
echo ""
[[ "$CLOUD_AVAILABLE" == true ]] && echo "Cloud repo (R2): $CLOUD_REPO"
[[ "$SSD_AVAILABLE" == true  ]] && echo "SSD repo:        $SSD_REPO"
[[ "$SSD_AVAILABLE" == false ]] && echo "SSD repo:        (skipped -- not mounted; re-run when home to add it)"
echo "Password file:   $RESTIC_PW_FILE (mode 600)"
echo "Nightly runner:  $BACKUP_SCRIPT"
echo "Cron schedule:   daily at 03:00 (-> ~/logs/backup-personal-YYYYMMDD.log)"
echo ""
echo "Run one backup NOW to verify the whole chain:"
echo "  bash $BACKUP_SCRIPT"
echo ""
echo "Inspect snapshots:"
[[ "$CLOUD_AVAILABLE" == true ]] && echo "  restic -r '$CLOUD_REPO' snapshots --password-file $RESTIC_PW_FILE"
[[ "$SSD_AVAILABLE" == true  ]] && echo "  restic -r '$SSD_REPO' snapshots --password-file $RESTIC_PW_FILE"
echo ""
REPO_FOR_TEST="$([[ "$CLOUD_AVAILABLE" == true ]] && echo "$CLOUD_REPO" || echo "$SSD_REPO")"
echo "Restore test (run once now, then quarterly) -- full procedure in the CRR runbook. Quick form:"
echo "  restic -r '$REPO_FOR_TEST' restore latest --target /tmp/restore-test --password-file $RESTIC_PW_FILE"
echo "  find /tmp/restore-test -name 'traversal_discovery-*.dump' -print   # the recovered dump"
echo "  rm -rf /tmp/restore-test"
echo ""
echo "CRITICAL: confirm RESTIC_PASSWORD is in your password manager. Losing it makes"
echo "          BOTH repos unrecoverable forever."
echo ""
echo "Log: $LOGFILE"
