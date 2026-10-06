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
#   SEED_DEMO=1         run `python -m backend.scripts.bootstrap_user` (creates
#                       the primary user from BOOTSTRAP_EMAIL/BOOTSTRAP_PASSWORD
#                       and the demo user, role 'demo'), then
#                       `scripts/demo/load_demo_seed.py`, which loads the
#                       reviewed demo corpus (apps/api/data/demo-seed/) into
#                       the demo user's account — graph, diary, and topic
#                       detail are populated from first boot, no LLM API keys
#                       involved. Both steps are KEYLESS and idempotent (the
#                       loader logs "already seeded" and exits 0 on repeat
#                       boots) — safe to leave on for every compose `up`.
#                       See apps/api/data/demo-seed/README.md for what the
#                       seed contains and its one known gap (preview images).
#   DEMO_SEED_ARGS     extra loader flags. The public demo stack
#                       (docker-compose.demo.yml) sets "--replace", so every
#                       boot swaps in a changed seed and no-ops otherwise.
#                       Unset (root quickstart) keeps the load-once behaviour.
#   BOOTSTRAP_DEMO_ONLY=1  bootstrap creates only the demo user (no admin).
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
  echo "[entrypoint] SEED_DEMO=1 — bootstrapping user logins (keyless; demo only when BOOTSTRAP_DEMO_ONLY=1)..."
  python -m backend.scripts.bootstrap_user || echo "[entrypoint] bootstrap_user failed (non-fatal, continuing)"
  echo "[entrypoint] loading demo seed data into the demo account (idempotent)..."
  python scripts/demo/load_demo_seed.py ${DEMO_SEED_ARGS:-} || echo "[entrypoint] load_demo_seed failed (non-fatal, continuing — demo account may be empty or stale)"
else
  echo "[entrypoint] SEED_DEMO=0 — skipping user bootstrap + demo seed load"
fi

echo "[entrypoint] starting uvicorn on ${API_HOST:-0.0.0.0}:${API_PORT:-8000}..."
exec uvicorn backend.api.main:app --host "${API_HOST:-0.0.0.0}" --port "${API_PORT:-8000}"
