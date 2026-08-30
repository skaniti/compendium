"""Run SQL migration files in order against PostgreSQL.

Usage::

    python -m backend.db.migrate                 # apply + run data hooks
    python -m backend.db.migrate --skip-backfill # apply only, no hooks

Post-migrate hooks let a migration that adds nullable columns (and
therefore can't populate them itself) trigger a companion data-backfill
script after the SQL runs. Hooks are spawned as *detached background
processes* — the migrate CLI returns immediately and the user tails a
log file to watch progress. Backfills are designed to be resumable so a
Ctrl-C or host restart is safe.
"""

import argparse
import logging
import os
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path

from backend.db.connection import get_conn

logger = logging.getLogger(__name__)

MIGRATIONS_DIR = Path(__file__).parent / "migrations"
_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
_LOG_DIR = _PROJECT_ROOT / "data" / "logs"


def _spawn_backfill(script_module: str, log_filename: str) -> str:
    """Spawn a backfill script as a detached background process.

    Returns the log file path so the migrate CLI can print a tail hint.
    ``start_new_session=True`` detaches from the migrate shell so the
    backfill keeps running if the user closes the terminal.
    """
    _LOG_DIR.mkdir(parents=True, exist_ok=True)
    log_path = _LOG_DIR / log_filename
    log_fd = open(log_path, "a", buffering=1, encoding="utf-8")
    log_fd.write(
        f"\n=== {script_module} spawn from migrate @ "
        f"{__import__('datetime').datetime.now().isoformat()} ===\n"
    )
    log_fd.flush()
    subprocess.Popen(
        [sys.executable, "-m", script_module],
        cwd=str(_PROJECT_ROOT),
        stdout=log_fd,
        stderr=subprocess.STDOUT,
        start_new_session=True,
        env={**os.environ, "PYTHONUNBUFFERED": "1"},
    )
    return str(log_path)


def _raw_html_backfill_hook() -> str:
    return _spawn_backfill(
        "scripts.migrations.backfill_raw_html",
        "backfill_raw_html.log",
    )


def _raw_html_usable_hook() -> str:
    """Re-evaluate usability for rows with raw_html already populated.

    Cheap (no network — just gunzips + runs trafilatura against stored
    bytes) so could run synchronously, but keeping the detached-bg
    pattern consistent with the 015 hook.
    """
    return _spawn_backfill(
        "scripts.migrations.backfill_raw_html_usable",
        "backfill_raw_html_usable.log",
    )


# Registry: migration version (filename stem) → callable that spawns a
# post-apply data step. Keep this small; reserve for columns-plus-data
# migrations where the SQL alone leaves rows incomplete.
POST_MIGRATE_HOOKS: dict[str, Callable[[], str]] = {
    "015_raw_html_archival": _raw_html_backfill_hook,
    "016_raw_html_usable": _raw_html_usable_hook,
}


def _ensure_migration_table(conn) -> None:
    """Create the schema_migrations tracking table if it doesn't exist."""
    with conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version TEXT PRIMARY KEY,
                applied_at TIMESTAMPTZ DEFAULT NOW()
            )
        """)
    conn.commit()


def _applied_versions(conn) -> set[str]:
    """Return the set of already-applied migration versions."""
    with conn.cursor() as cur:
        cur.execute("SELECT version FROM schema_migrations ORDER BY version")
        return {row[0] for row in cur.fetchall()}


def run_migrations() -> list[str]:
    """Apply all unapplied migrations in filename order.

    Returns list of newly applied migration filenames.
    """
    sql_files = sorted(MIGRATIONS_DIR.glob("*.sql"))
    if not sql_files:
        logger.warning("No migration files found in %s", MIGRATIONS_DIR)
        return []

    applied: list[str] = []

    with get_conn() as conn:
        _ensure_migration_table(conn)
        already = _applied_versions(conn)

        for sql_file in sql_files:
            version = sql_file.stem  # e.g. "001_initial_schema"
            if version in already:
                logger.debug("Skipping already-applied migration: %s", version)
                continue

            logger.info("Applying migration: %s", sql_file.name)
            sql = sql_file.read_text(encoding="utf-8")

            with conn.cursor() as cur:
                cur.execute(sql)
                cur.execute(
                    "INSERT INTO schema_migrations (version) VALUES (%s)",
                    (version,),
                )
            conn.commit()
            applied.append(sql_file.name)
            logger.info("Applied migration: %s", sql_file.name)

    return applied


def run_post_migrate_hooks(applied: list[str]) -> list[tuple[str, str]]:
    """Invoke registered post-migrate hooks for each newly applied migration.

    Returns a list of (migration_filename, hook_result) tuples. Hook result
    is currently a log-file path for backfill hooks.
    """
    results: list[tuple[str, str]] = []
    for filename in applied:
        version = Path(filename).stem
        hook = POST_MIGRATE_HOOKS.get(version)
        if hook is None:
            continue
        try:
            result = hook()
            results.append((filename, result))
            logger.info("Post-migrate hook for %s → %s", version, result)
        except Exception:
            logger.exception("Post-migrate hook failed for %s", version)
    return results


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--skip-backfill",
        action="store_true",
        help="Apply SQL migrations only; don't spawn post-migrate "
        "data-backfill hooks. Useful for CI or when running the "
        "backfill script by hand.",
    )
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    results = run_migrations()
    if results:
        print(f"Applied {len(results)} migration(s): {', '.join(results)}")
    else:
        print("No new migrations to apply.")

    if results and not args.skip_backfill:
        hook_results = run_post_migrate_hooks(results)
        for filename, log_path in hook_results:
            print(f"  Spawned background backfill for {filename}")
            print(f"  Log: {log_path}")
            print(f"  Watch:  tail -f {log_path}")
