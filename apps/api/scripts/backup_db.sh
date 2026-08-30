#!/usr/bin/env bash
# backup_db.sh — pg_dump the production database to a timestamped file.
#
# Usage:
#   bash scripts/backup_db.sh              # plain backup
#   bash scripts/backup_db.sh pre_test     # labeled backup
#   bash scripts/backup_db.sh app_start    # labeled backup
#
# Output: data/backups/traversal_discovery_YYYY-MM-DD_HHMMSS[_label].sql.gz
# Retention: keeps last 50 snapshots, prunes older ones.
# Dedup: skips if the most recent backup is less than 5 minutes old.

set -euo pipefail

# ── Production guard ───────────────────────────────────────────────────
# This script targets the local docker-compose Postgres (hardcoded
# host=localhost, user=tbd, password=tbd_local). Those credentials don't
# apply to the production deploy -- the pg_dump would just hang on a doomed
# connection and fail silently (caller in app.py runs it fire-and-forget
# with stdout/stderr DEVNULL'd). Skip cleanly so we don't waste subprocess
# spawn + connection-attempt cycles on every Dash app start.
if [ "${ENVIRONMENT:-}" = "production" ]; then
    exit 0
fi

DB_NAME="traversal_discovery"
DB_USER="tbd"
DB_HOST="localhost"
DB_PORT="5432"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKUP_DIR="${SCRIPT_DIR}/../data/backups"
mkdir -p "$BACKUP_DIR"

# ── Dedup guard: skip if last backup < 5 minutes old ──────────────────
LATEST=$(find "$BACKUP_DIR" -maxdepth 1 -name "*.sql.gz" -printf '%T@\t%p\n' 2>/dev/null | sort -rn | head -1 | cut -f2)
if [ -n "$LATEST" ]; then
    NOW=$(date +%s)
    # stat -c works on Linux/WSL; fall back to Python if needed
    LAST_MOD=$(stat -c %Y "$LATEST" 2>/dev/null || python3 -c "import os; print(int(os.path.getmtime('$LATEST')))")
    AGE=$(( NOW - LAST_MOD ))
    if [ "$AGE" -lt 300 ]; then
        echo "Recent backup exists (${AGE}s ago), skipping."
        exit 0
    fi
fi

# ── Build filename ────────────────────────────────────────────────────
TIMESTAMP=$(date +%Y-%m-%d_%H%M%S)
SUFFIX="${1:-}"
FILENAME="${DB_NAME}_${TIMESTAMP}${SUFFIX:+_$SUFFIX}.sql.gz"
FILEPATH="${BACKUP_DIR}/${FILENAME}"

echo "Backing up ${DB_NAME} → ${FILEPATH}"

# ── Dump: host pg_dump (dev) or via the Postgres container (server) ───────
# The server host has no pg_dump -- Postgres runs only in a container, and the
# server's credentials live in that container's env, not tbd_local. Prefer a
# host pg_dump when present (dev/test/startup path, unchanged); otherwise dump
# through the running Postgres container using ITS OWN $POSTGRES_PASSWORD (which
# is correct for both the dev container and the server container).
if command -v pg_dump >/dev/null 2>&1; then
    PGPASSWORD=tbd_local pg_dump \
        -h "$DB_HOST" \
        -p "$DB_PORT" \
        -U "$DB_USER" \
        -d "$DB_NAME" \
        --no-owner \
        --no-privileges \
        | gzip > "$FILEPATH"
else
    # Locate the Postgres container (override with PG_CONTAINER=<name>).
    PG_CONTAINER="${PG_CONTAINER:-}"
    if [ -z "$PG_CONTAINER" ]; then
        PG_CONTAINER=$(docker ps --filter "ancestor=pgvector/pgvector:pg16" --format '{{.Names}}' 2>/dev/null | head -1 || true)
    fi
    if [ -z "$PG_CONTAINER" ]; then
        PG_CONTAINER=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -i postgres | head -1 || true)
    fi
    if [ -z "$PG_CONTAINER" ]; then
        echo "ERROR: no host pg_dump and no running Postgres container found." >&2
        echo "       Install postgresql-client, or set PG_CONTAINER=<name>." >&2
        exit 1
    fi
    echo "Host pg_dump not found; dumping via container '${PG_CONTAINER}'."
    # $POSTGRES_PASSWORD is evaluated INSIDE the container (escaped here), so the
    # secret never appears on the host command line.
    docker exec "$PG_CONTAINER" sh -c \
        "PGPASSWORD=\"\$POSTGRES_PASSWORD\" pg_dump -U $DB_USER -d $DB_NAME --no-owner --no-privileges" \
        | gzip > "$FILEPATH"
fi

SIZE=$(du -h "$FILEPATH" | cut -f1)
echo "Done — ${SIZE} written to ${FILEPATH}"

# ── Prune: keep last 50 backups ──────────────────────────────────────
find "$BACKUP_DIR" -maxdepth 1 -name "*.sql.gz" -printf '%T@\t%p\n' \
    | sort -rn | tail -n +51 | cut -f2 | xargs -r rm
KEPT=$(find "$BACKUP_DIR" -maxdepth 1 -name "*.sql.gz" | wc -l)
echo "Retained ${KEPT} backup(s)"
