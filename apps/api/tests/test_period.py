"""Shared dev-view period machinery (moved out of pipeline_repo)."""

from datetime import UTC, datetime, timedelta
from itertools import pairwise

import pytest

from backend.db import period

NOW = datetime(2026, 9, 20, 12, 0, tzinfo=UTC)


def test_normalize_range():
    assert [period.normalize_range(k) for k in ("7d", "30d", "90d", "all")] == [
        "7d",
        "30d",
        "90d",
        "all",
    ]
    assert period.normalize_range(None) == "all"
    assert period.normalize_range("365") == "all"


def test_validate_tz():
    assert str(period.validate_tz("Asia/Kolkata")) == "Asia/Kolkata"
    with pytest.raises(ValueError):
        period.validate_tz("Not/AZone")


def test_since_for():
    assert period.since_for("7d", NOW) == NOW - timedelta(days=7)
    assert period.since_for("all", NOW) is None


def test_window_defaults_are_pipelines():
    assert period.window(None, NOW) == (" AND (p.visited_at IS NULL OR p.visited_at <= %s)", [NOW])
    since = NOW - timedelta(days=7)
    assert period.window(since, NOW) == (
        " AND p.visited_at >= %s AND p.visited_at <= %s",
        [since, NOW],
    )


def test_window_other_column_without_nulls():
    assert period.window(None, NOW, col="c.started_at", include_null=False) == (
        " AND c.started_at <= %s",
        [NOW],
    )
    since = NOW - timedelta(days=30)
    assert period.window(since, NOW, col="e.created_at", include_null=False) == (
        " AND e.created_at >= %s AND e.created_at <= %s",
        [since, NOW],
    )


def test_pipeline_repo_keeps_its_names():
    from backend.db import pipeline_repo

    assert pipeline_repo.normalize_range is period.normalize_range
    assert pipeline_repo.validate_tz is period.validate_tz
    assert pipeline_repo.since_for is period.since_for
    assert pipeline_repo.RANGE_DAYS is period.RANGE_DAYS
    assert pipeline_repo._window(None, NOW) == period.window(None, NOW)


def _pg_reachable() -> bool:
    try:
        from psycopg2 import connect

        from backend.config.settings import settings

        connect(settings.test_database_url).close()
        return True
    except Exception:  # noqa: BLE001
        return False


@pytest.mark.skipif(not _pg_reachable(), reason="Test PostgreSQL not reachable")
def test_bucket_starts_cross_dst_without_duplicates():
    from backend.db.connection import get_conn

    now = datetime(2026, 11, 3, 12, 0, tzinfo=UTC)  # US DST ended 2026-11-01
    with get_conn() as conn, conn.cursor() as cur:
        starts = period.bucket_starts(cur, now - timedelta(days=7), now, "7d", "America/New_York")
    assert len(starts) == 29
    assert all(a < b for a, b in pairwise(starts))
    assert all(s.hour in (0, 6, 12, 18) and s.tzinfo is None for s in starts)


@pytest.mark.skipif(not _pg_reachable(), reason="Test PostgreSQL not reachable")
def test_bucket_starts_months_for_all():
    from backend.db.connection import get_conn

    with get_conn() as conn, conn.cursor() as cur:
        starts = period.bucket_starts(cur, datetime(2026, 3, 21, tzinfo=UTC), NOW, "all", "UTC")
    assert [(s.year, s.month, s.day) for s in starts] == [(2026, m, 1) for m in range(3, 10)]
