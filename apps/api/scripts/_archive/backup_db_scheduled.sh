#!/usr/bin/env bash
# C2: nightly backup wrapper -- invoked by Windows Task Scheduler via wsl.exe bash.
set -u
# REPO_DIR must be set to this repo's absolute path on the host running the
# scheduled task -- there is no safe default for a cron-invoked script.
PROJECT_DIR="${REPO_DIR:?Set REPO_DIR to the repo's absolute path before running this script}"
cd "$PROJECT_DIR"
mkdir -p data/backups
LOG="data/backups/cron.log"

{
  echo ""
  echo "=== Scheduled backup: $(date '+%Y-%m-%d %H:%M:%S') ==="
  if command -v pg_isready >/dev/null 2>&1; then
    if ! pg_isready -h localhost -p 5432 -U tbd -d traversal_discovery -t 5 >/dev/null 2>&1; then
      echo "SKIP: PostgreSQL not reachable (DB not running)."
      exit 0
    fi
  else
    echo "NOTE: pg_isready missing; install with: sudo apt install postgresql-client"
  fi
  if [[ -f ~/.venvs/compendium-explorer/bin/activate ]]; then
    source ~/.venvs/compendium-explorer/bin/activate
  fi
  bash scripts/backup_db.sh nightly
  echo "exit=$?"
} >> "$LOG" 2>&1
