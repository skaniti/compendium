"""Repo tests for period-scoped pipeline queries (fixed ``now``, synthetic rows)."""

from datetime import UTC, datetime, timedelta
from itertools import pairwise

import pytest


def _pg_reachable() -> bool:
    try:
        from psycopg2 import connect

        from backend.config.settings import settings

        connect(settings.test_database_url).close()
        return True
    except Exception:  # noqa: BLE001
        return False


pytestmark = pytest.mark.skipif(not _pg_reachable(), reason="Test PostgreSQL not reachable")

from backend.db import capture_repo, page_repo, pipeline_repo, user_repo
from backend.db.connection import get_conn

NOW = datetime(2026, 11, 3, 15, 0, tzinfo=UTC)  # Tue 10:00 EST, after the 2026-11-01 DST end
NY = "America/New_York"


@pytest.fixture(autouse=True)
def _clean_tables():
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "TRUNCATE graph_cache, cluster_edges, page_clusters, clusters, recluster_runs, "
            "pages, page_content, captures, users CASCADE"
        )
    yield


@pytest.fixture
def uid():
    return user_repo.create_user("repo@example.com", name="Repo User")["id"]


def _add(user_id, specs):
    """specs: dicts with visited_at + optional domain/status/depth/reason/category."""
    cap = capture_repo.save_capture(
        user_id=user_id,
        capture_id=f"cap_{user_id}_{abs(hash(str(specs)))}",
        source="desktop_active",
        started_at=NOW - timedelta(days=400),
        ended_at=NOW - timedelta(days=399),
    )
    ids = page_repo.insert_pages(
        cap["id"],
        [
            {
                "url": f"https://{s.get('domain', 'example.org')}/p{i}",
                "title": f"T{i}",
                "domain": s.get("domain", "example.org"),
                "visited_at": s.get("visited_at"),
            }
            for i, s in enumerate(specs)
        ],
    )
    with get_conn() as conn, conn.cursor() as cur:
        for pid, s in zip(ids, specs):
            cur.execute(
                "UPDATE pages SET status=%s, processing_depth=%s, archive_reason=%s, "
                "skip_category=%s, skip_reasoning=%s, user_id=%s WHERE id=%s",
                (
                    s.get("status", "active"),
                    s.get("depth"),
                    s.get("reason"),
                    s.get("category"),
                    s.get("skip_reasoning"),
                    user_id,
                    pid,
                ),
            )
    return ids


def _skip(visited_at, category=None, domain="example.org"):
    return {
        "visited_at": visited_at,
        "domain": domain,
        "status": "archived",
        "depth": "skipped",
        "reason": "skip_gate",
        "category": category,
    }


class TestTimeline:
    def test_30d_daily_buckets_with_zeros(self, uid):
        _add(uid, [{"visited_at": NOW - timedelta(days=2), "depth": "processed"}])
        t = pipeline_repo.get_timeline(uid, "30d", "UTC", now=NOW)
        assert t["granularity"] == "day" and t["range"] == "30d"
        assert 30 <= len(t["buckets"]) <= 31
        assert t["buckets"][-1]["start"] == "2026-11-03T00:00:00+00:00"
        assert sum(b["kept"] for b in t["buckets"]) == 1
        assert sum(1 for b in t["buckets"] if b["kept"] == 0) == len(t["buckets"]) - 1
        assert all(b["label_key"] == "day" for b in t["buckets"])

    def test_7d_six_hour_blocks_across_dst_end(self, uid):
        _add(
            uid,
            [
                {"visited_at": datetime(2026, 11, 1, 4, 30, tzinfo=UTC)},  # 00:30 EDT
                {"visited_at": datetime(2026, 11, 1, 6, 30, tzinfo=UTC)},  # 01:30 EST (repeat hour)
                {"visited_at": datetime(2026, 11, 1, 11, 30, tzinfo=UTC)},  # 06:30 EST
            ],
        )
        t = pipeline_repo.get_timeline(uid, "7d", NY, now=NOW)
        assert t["granularity"] == "6h"
        starts = [b["start"] for b in t["buckets"]]
        assert len(starts) == len(set(starts)) == 29
        locals_ = [s[:19] for s in starts]
        assert locals_[0] == "2026-10-27T06:00:00" and locals_[-1] == "2026-11-03T06:00:00"
        parsed = [datetime.fromisoformat(s[:19]) for s in starts]
        assert all(b - a == timedelta(hours=6) for a, b in pairwise(parsed))
        assert all(p.hour % 6 == 0 for p in parsed)
        by = {s[:19]: b for s, b in zip(starts, t["buckets"])}
        assert by["2026-11-01T00:00:00"]["kept"] == 2  # 00:30 EDT and 01:30 EST share the block
        assert by["2026-11-01T06:00:00"]["kept"] == 1
        assert by["2026-11-01T00:00:00"]["start"].endswith("-04:00")
        assert by["2026-11-01T06:00:00"]["start"].endswith("-05:00")
        assert sum(b["kept"] for b in t["buckets"]) == 3

    def test_7d_six_hour_blocks_across_dst_start(self, uid):
        now = datetime(2026, 3, 10, 15, 0, tzinfo=UTC)  # 11:00 EDT
        t = pipeline_repo.get_timeline(uid, "7d", NY, now=now)
        starts = [b["start"] for b in t["buckets"]]
        assert len(starts) == len(set(starts)) == 29
        parsed = [datetime.fromisoformat(s[:19]) for s in starts]
        assert all(b - a == timedelta(hours=6) for a, b in pairwise(parsed))
        assert all(p.hour % 6 == 0 for p in parsed)
        by = {s[:19]: s for s in starts}
        assert by["2026-03-08T00:00:00"].endswith("-05:00")
        assert by["2026-03-08T06:00:00"].endswith("-04:00")
        assert starts[0].endswith("-05:00") and starts[-1].endswith("-04:00")

    def test_future_dated_visit_excluded_from_timeline(self, uid):
        _add(uid, [{"visited_at": NOW + timedelta(days=2)}])
        for rng in ("7d", "30d", "90d", "all"):
            t = pipeline_repo.get_timeline(uid, rng, "UTC", now=NOW)
            assert sum(b["kept"] for b in t["buckets"]) == 0
            assert t["buckets"], rng  # never empty: series is anchored at now

    def test_90d_weekly_monday_starts(self, uid):
        _add(uid, [{"visited_at": NOW - timedelta(days=10)}])
        t = pipeline_repo.get_timeline(uid, "90d", "UTC", now=NOW)
        assert t["granularity"] == "week"
        days = [datetime.fromisoformat(b["start"]) for b in t["buckets"]]
        assert all(d.weekday() == 0 for d in days)
        assert all(b - a == timedelta(weeks=1) for a, b in pairwise(days))
        assert 13 <= len(days) <= 14

    def test_all_monthly_from_first_month(self, uid):
        _add(
            uid,
            [
                {"visited_at": datetime(2026, 7, 15, 12, tzinfo=UTC)},
                {"visited_at": datetime(2026, 9, 2, 12, tzinfo=UTC)},
                {"visited_at": None},  # NULL visited_at is outside every bucket
            ],
        )
        t = pipeline_repo.get_timeline(uid, "all", "UTC", now=NOW)
        assert t["granularity"] == "month"
        assert [b["start"][:10] for b in t["buckets"]] == [
            "2026-07-01",
            "2026-08-01",
            "2026-09-01",
            "2026-10-01",
            "2026-11-01",
        ]
        assert [b["kept"] for b in t["buckets"]] == [1, 0, 1, 0, 0]

    def test_bucket_fields_and_categories(self, uid):
        ts = NOW - timedelta(hours=1)
        _add(
            uid,
            [
                {"visited_at": ts, "depth": "processed"},
                _skip(ts, "login_wall"),
                _skip(ts, "login_wall"),
                _skip(ts, None),
                {"visited_at": ts},  # pending/active without depth: kept, not evaluated
            ],
        )
        last = pipeline_repo.get_timeline(uid, "7d", "UTC", now=NOW)["buckets"][-1]
        assert last["kept"] == 2 and last["archived"] == 3
        assert last["evaluated"] == 4 and last["skipped"] == 3
        assert last["categories"] == {"login_wall": 2, "uncategorized": 1}

    def test_other_users_excluded(self, uid):
        other = user_repo.create_user("o@example.com", name="O")["id"]
        _add(other, [{"visited_at": NOW - timedelta(hours=1)}])
        t = pipeline_repo.get_timeline(uid, "7d", "UTC", now=NOW)
        assert sum(b["kept"] for b in t["buckets"]) == 0

    def test_invalid_tz_raises(self, uid):
        with pytest.raises(ValueError):
            pipeline_repo.get_timeline(uid, "7d", "Not/AZone", now=NOW)


class TestSummaryCounts:
    def test_window_excludes_old_and_null_visited_only_in_all(self, uid):
        _add(
            uid,
            [
                {"visited_at": NOW - timedelta(days=1), "depth": "processed"},
                {"visited_at": NOW - timedelta(days=40), "depth": "processed"},
                {"visited_at": None, "depth": "processed"},
            ],
        )
        assert pipeline_repo.get_summary_counts(uid, "7d", now=NOW)["status_counts"] == {
            "active": 1
        }
        assert pipeline_repo.get_summary_counts(uid, "30d", now=NOW)["status_counts"] == {
            "active": 1
        }
        assert pipeline_repo.get_summary_counts(uid, "90d", now=NOW)["status_counts"] == {
            "active": 2
        }
        assert pipeline_repo.get_summary_counts(uid, "all", now=NOW)["status_counts"] == {
            "active": 3
        }

    def test_top_domains_ordered_and_limited_to_three(self, uid):
        ts = NOW - timedelta(days=1)
        specs = []
        for dom, n in (("a.example", 4), ("b.example", 3), ("c.example", 2), ("d.example", 1)):
            specs += [_skip(ts, "login_wall", dom) for _ in range(n)]
        _add(uid, specs)
        (grp,) = pipeline_repo.get_summary_counts(uid, "7d", now=NOW)["skip_categories"]
        assert grp["key"] == "login_wall" and grp["count"] == 10
        assert grp["top_domains"] == [
            {"domain": "a.example", "count": 4},
            {"domain": "b.example", "count": 3},
            {"domain": "c.example", "count": 2},
        ]

    def test_uncategorized_and_archive_reason_grouping(self, uid):
        ts = NOW - timedelta(days=1)
        _add(
            uid,
            [
                _skip(ts, None),
                _skip(ts, "web_app"),
                {
                    "visited_at": ts,
                    "status": "archived",
                    "reason": "domain_skip",
                    "depth": "skipped",
                },
                {"visited_at": ts, "status": "archived", "reason": None},
                {"visited_at": ts, "status": "active", "depth": "processed"},
            ],
        )
        c = pipeline_repo.get_summary_counts(uid, "7d", now=NOW)
        assert {g["key"]: g["count"] for g in c["skip_categories"]} == {
            "uncategorized": 1,
            "web_app": 1,
        }
        assert {g["key"]: g["count"] for g in c["archive_reasons"]} == {
            "skip_gate": 2,
            "domain_skip": 1,
            "other": 1,
        }

    def test_empty(self, uid):
        c = pipeline_repo.get_summary_counts(uid, "7d", now=NOW)
        assert c["status_counts"] == {} and c["depth_counts"] == {}
        assert c["archive_reasons"] == [] and c["skip_categories"] == []


class TestFutureDatedExcluded:
    def test_future_page_excluded_everywhere(self, uid):
        ts = NOW - timedelta(days=1)
        fut = NOW + timedelta(days=2)
        _add(uid, [_skip(ts, "login_wall"), _skip(fut, "login_wall", "future.example")])
        for rng in ("7d", "30d", "90d", "all"):
            c = pipeline_repo.get_summary_counts(uid, rng, now=NOW)
            assert c["status_counts"] == {"archived": 1}, rng
            assert [g["count"] for g in c["skip_categories"]] == [1], rng
            assert [g["count"] for g in c["archive_reasons"]] == [1], rng
            assert pipeline_repo.get_windowed_pages(uid, rng, now=NOW)[1] == 1, rng
            t = pipeline_repo.get_timeline(uid, rng, "UTC", now=NOW)
            assert sum(b["archived"] for b in t["buckets"]) == 1, rng


class TestWindowedPages:
    def test_window_and_total(self, uid):
        _add(
            uid,
            [
                {"visited_at": NOW - timedelta(days=1)},
                {"visited_at": NOW - timedelta(days=20)},
                {"visited_at": None},
            ],
        )
        rows, total = pipeline_repo.get_windowed_pages(uid, "7d", now=NOW)
        assert total == 1 and len(rows) == 1
        assert pipeline_repo.get_windowed_pages(uid, "30d", now=NOW)[1] == 2
        assert pipeline_repo.get_windowed_pages(uid, "all", now=NOW)[1] == 3

    def test_sort_allow_list(self, uid):
        with pytest.raises(ValueError):
            pipeline_repo.get_windowed_pages(uid, "all", sort="id;drop", now=NOW)
        with pytest.raises(ValueError):
            pipeline_repo.get_windowed_pages(uid, "all", direction="sideways", now=NOW)
