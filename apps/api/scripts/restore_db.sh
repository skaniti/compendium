#!/usr/bin/env bash
# restore_db.sh — Restore production database from a backup file.
#
# Usage:
#   bash scripts/restore_db.sh data/backups/traversal_discovery_2026-03-21_120000.sql.gz

set -euo pipefail

if [ $# -eq 0 ]; then
    echo "Usage: $0 <backup_file.sql.gz>"
    echo ""
    echo "Available backups:"
    ls -lh data/backups/*.sql.gz 2>/dev/null || echo "  (none found)"
    exit 1
fi

BACKUP_FILE="$1"
DB_NAME="traversal_discovery"
DB_USER="tbd"
DB_HOST="localhost"
DB_PORT="5432"

if [ ! -f "$BACKUP_FILE" ]; then
    echo "Error: file not found: $BACKUP_FILE"
    exit 1
fi

echo "WARNING: This will overwrite all data in '${DB_NAME}'"
read -p "Type 'restore' to confirm: " CONFIRM
if [ "$CONFIRM" != "restore" ]; then
    echo "Aborted."
    exit 1
fi

echo "Restoring ${DB_NAME} from ${BACKUP_FILE}..."
# ── Restore: host psql (dev) or via the Postgres container (server) ───────
# Mirrors backup_db.sh: the server host has no psql, and its credentials live
# in the container env. Prefer a host psql when present; otherwise pipe the dump
# into the running Postgres container using ITS OWN $POSTGRES_PASSWORD.
if command -v psql >/dev/null 2>&1; then
    gunzip -c "$BACKUP_FILE" | PGPASSWORD=tbd_local psql \
        -h "$DB_HOST" \
        -p "$DB_PORT" \
        -U "$DB_USER" \
        -d "$DB_NAME" \
        --single-transaction \
        -q
else
    PG_CONTAINER="${PG_CONTAINER:-}"
    if [ -z "$PG_CONTAINER" ]; then
        PG_CONTAINER=$(docker ps --filter "ancestor=pgvector/pgvector:pg16" --format '{{.Names}}' 2>/dev/null | head -1 || true)
    fi
    if [ -z "$PG_CONTAINER" ]; then
        PG_CONTAINER=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -i postgres | head -1 || true)
    fi
    if [ -z "$PG_CONTAINER" ]; then
        echo "ERROR: no host psql and no running Postgres container found." >&2
        echo "       Install postgresql-client, or set PG_CONTAINER=<name>." >&2
        exit 1
    fi
    echo "Host psql not found; restoring via container '${PG_CONTAINER}'."
    # -i streams the gunzipped SQL into the container on stdin; $POSTGRES_PASSWORD
    # is evaluated inside the container so the secret never hits the host CLI.
    gunzip -c "$BACKUP_FILE" | docker exec -i "$PG_CONTAINER" sh -c \
        "PGPASSWORD=\"\$POSTGRES_PASSWORD\" psql -U $DB_USER -d $DB_NAME --single-transaction -q"
fi

echo "Restore complete."
