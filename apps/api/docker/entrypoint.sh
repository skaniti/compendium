#!/usr/bin/env bash
# Container entrypoint for the apps/api production image (apps/api/Dockerfile).
# Order: wait for the database -> run migrations (fresh-DB shape) -> optional
# demo/primary user bootstrap -> exec uvicorn.
#
# Env switches (see root docker-compose.yml for the compose-level defaults):
#   RUN_MIGRATIONS=1   (default) run `python -m backend.db.migrate --skip-backfill`
#                       on every boot. Idempotent (schema_migrations tracks
#                       what's applied) — safe to leave on for a throwaway
#                       compose stack. --skip-backfill because the two
#                       registered post-migrate hooks (015/016) only backfill
#                       EXISTING raw_html rows; a fresh DB has none, so the
#                       hooks would spawn detached background processes that
#                       find nothing to do.
#   SEED_DEMO=1         run `python -m backend.scripts.bootstrap_user`, which
#                       idempotently creates the primary user (BOOTSTRAP_EMAIL/
#                       BOOTSTRAP_PASSWORD) and the demo user (role 'demo').
#                       This is KEYLESS and always safe to run — it does not
#                       populate the demo account with any captures/pages, it
#                       only creates the login. See README "Demo notes" for
#                       why: the actual curated demo dataset is materialized
#                       by running the live capture pipeline (LLM calls), and
#                       that pipeline was never exported as a portable seed
#                       here — see apps/api/scripts/demo/README (if present)
#                       or the batch-07 Task 4 results for the full story.
set -euo pipefail

echo "[entrypoint] waiting for database..."
python - <<'PYEOF'
import sys
import time

from backend.db.connection import get_conn

for attempt in range(1, 31):
    try:
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT 1")
        print("[entrypoint] database reachable")
        break
    except Exception as exc:  # noqa: BLE001 — retry loop, any failure means "not ready yet"
        print(f"[entrypoint] db not ready ({exc!r}); retry {attempt}/30")
        time.sleep(2)
else:
    print("[entrypoint] database never became reachable; giving up")
    sys.exit(1)
PYEOF

if [ "${RUN_MIGRATIONS:-1}" = "1" ]; then
  echo "[entrypoint] running migrations (--skip-backfill: fresh DB, nothing to backfill)..."
  python -m backend.db.migrate --skip-backfill
else
  echo "[entrypoint] RUN_MIGRATIONS=0 — skipping migrations"
fi

if [ "${SEED_DEMO:-0}" = "1" ]; then
  echo "[entrypoint] SEED_DEMO=1 — bootstrapping primary + demo user logins (keyless; no content)..."
  python -m backend.scripts.bootstrap_user || echo "[entrypoint] bootstrap_user failed (non-fatal, continuing)"
else
  echo "[entrypoint] SEED_DEMO=0 — skipping user bootstrap"
fi

echo "[entrypoint] starting uvicorn on ${API_HOST:-0.0.0.0}:${API_PORT:-8000}..."
exec uvicorn backend.api.main:app --host "${API_HOST:-0.0.0.0}" --port "${API_PORT:-8000}"
