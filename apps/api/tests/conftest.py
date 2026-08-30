"""Pytest configuration and plugins.

- Redirects ALL database connections to the test database for safety.
- Backs up the production DB before each test session.
- Generates a human-readable test summary table at tests/test_summary.txt.
"""

import subprocess
import time
from pathlib import Path

import pytest

# Output path for the summary table
SUMMARY_PATH = Path(__file__).parent / "test_summary.txt"

# Path to the backup script (relative to project root)
_PROJECT_ROOT = Path(__file__).resolve().parent.parent
_BACKUP_SCRIPT = _PROJECT_ROOT / "scripts" / "backup_db.sh"


# ── Test database isolation ──────────────────────────────────────────────


def _test_db_exists() -> bool:
    """Check if the test database is reachable."""
    try:
        from backend.config.settings import settings
        import psycopg2

        conn = psycopg2.connect(settings.test_database_url)
        conn.close()
        return True
    except Exception:
        return False


@pytest.fixture(scope="session", autouse=True)
def _use_test_database():
    """Redirect ALL database connections to the test DB for the entire session.

    This is the primary safety mechanism. Every call to get_conn() during
    the test session will connect to traversal_discovery_test instead of
    traversal_discovery.
    """
    # Back up production DB before anything else
    if _BACKUP_SCRIPT.exists():
        subprocess.run(
            ["bash", str(_BACKUP_SCRIPT), "pre_test"],
            capture_output=True,
        )

    if not _test_db_exists():
        pytest.exit(
            "\n\nTest database not found. Run:\n"
            "    python scripts/init_test_db.py\n"
            "to create it before running tests.\n",
            returncode=1,
        )

    from backend.config.settings import settings
    from backend.db.connection import close_pool, set_dsn_override
    from backend.db.migrate import run_migrations

    set_dsn_override(settings.test_database_url)
    run_migrations()

    yield

    close_pool()
    set_dsn_override(None)


@pytest.fixture(autouse=True)
def _verify_not_production_db():
    """Paranoia check — verify we are NOT connected to the production DB.

    Runs before every single test. If somehow the DSN override was
    bypassed, this catches it and aborts before any damage.
    """
    try:
        from backend.db.connection import get_conn

        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT current_database()")
                db_name = cur.fetchone()[0]
        if db_name == "traversal_discovery":
            pytest.fail(
                f"SAFETY: Connected to production DB '{db_name}'! " "Aborting to prevent data loss."
            )
    except Exception:
        pass  # DB might not be available (non-DB tests); that's fine


def pytest_configure(config):
    """Register custom markers and initialize results storage."""
    config._test_results = []
    config._suite_start = time.time()


def pytest_runtest_makereport(item, call):
    """Collect per-test results after the call phase."""
    if call.when == "call":
        # Extract class name (or "(module)" if top-level)
        cls = item.cls.__name__ if item.cls else "(module)"
        item.config._test_results.append(
            {
                "class": cls,
                "name": item.name,
                "status": "PASS" if call.excinfo is None else "FAIL",
                "duration": f"{call.duration:.3f}s",
            }
        )


def pytest_sessionfinish(session, exitstatus):
    """Write the summary table after all tests complete."""
    results = session.config._test_results
    if not results:
        return

    elapsed = time.time() - session.config._suite_start

    # Column widths
    cls_w = max(len(r["class"]) for r in results)
    name_w = max(len(r["name"]) for r in results)
    stat_w = 6  # "STATUS"
    dur_w = 10  # "DURATION"

    header = f"{'CLASS':<{cls_w}}  {'TEST':<{name_w}}  {'STATUS':<{stat_w}}  {'DURATION':>{dur_w}}"
    sep = "-" * len(header)

    lines = [
        f"Test Summary — {len(results)} tests, "
        f"{sum(1 for r in results if r['status'] == 'PASS')} passed, "
        f"{sum(1 for r in results if r['status'] == 'FAIL')} failed "
        f"({elapsed:.2f}s total)",
        "",
        header,
        sep,
    ]

    for r in results:
        lines.append(
            f"{r['class']:<{cls_w}}  {r['name']:<{name_w}}  {r['status']:<{stat_w}}  {r['duration']:>{dur_w}}"
        )

    lines.append(sep)
    lines.append("")

    SUMMARY_PATH.parent.mkdir(parents=True, exist_ok=True)
    SUMMARY_PATH.write_text("\n".join(lines))
