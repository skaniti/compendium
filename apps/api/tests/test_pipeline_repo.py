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
    """specs: dicts with visited_at + optional domain/status/depth/reason/category/human_status/content_summary."""
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
                "skip_category=%s, skip_reasoning=%s, human_status=%s, content_summary=%s, "
                "user_id=%s WHERE id=%s",
                (
                    s.get("status", "active"),
                    s.get("depth"),
                    s.get("reason"),
                    s.get("category"),
                    s.get("skip_reasoning"),
                    s.get("human_status"),
                    s.get("content_summary"),
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
        assert sum(b["total"] for b in t["buckets"]) == 1
        assert sum(1 for b in t["buckets"] if b["total"] == 0) == len(t["buckets"]) - 1
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
        assert by["2026-11-01T00:00:00"]["total"] == 2  # 00:30 EDT and 01:30 EST share the block
        assert by["2026-11-01T06:00:00"]["total"] == 1
        assert by["2026-11-01T00:00:00"]["start"].endswith("-04:00")
        assert by["2026-11-01T06:00:00"]["start"].endswith("-05:00")
        assert sum(b["total"] for b in t["buckets"]) == 3

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
            assert sum(b["total"] for b in t["buckets"]) == 0
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
        assert [b["total"] for b in t["buckets"]] == [1, 0, 1, 0, 0]

    def test_bucket_fields_and_categories(self, uid):
        ts = NOW - timedelta(hours=1)
        _add(
            uid,
            [
                {"visited_at": ts, "depth": "processed"},
                _skip(ts, "login_wall"),
                _skip(ts, "login_wall"),
                _skip(ts, None),
                {"visited_at": ts},  # legacy NULL-depth active: processed, not reached_gate
                {"visited_at": ts, "status": "pending"},
            ],
        )
        last = pipeline_repo.get_timeline(uid, "7d", "UTC", now=NOW)["buckets"][-1]
        assert set(last) == {
            "start",
            "label_key",
            "total",
            "archived",
            "outcomes",
            "reached_gate",
            "categories",
        }
        assert last["total"] == 6 and last["archived"] == 3
        assert last["outcomes"] == {
            "before_gate": 0,
            "rule_filter": 0,
            "gate": 3,
            "processed": 2,
            "pending": 1,
        }
        assert last["reached_gate"] == 4
        assert last["categories"] == {"login_wall": 2, "uncategorized": 1}

    def test_other_users_excluded(self, uid):
        other = user_repo.create_user("o@example.com", name="O")["id"]
        _add(other, [{"visited_at": NOW - timedelta(hours=1)}])
        t = pipeline_repo.get_timeline(uid, "7d", "UTC", now=NOW)
        assert sum(b["total"] for b in t["buckets"]) == 0

    def test_invalid_tz_raises(self, uid):
        with pytest.raises(ValueError):
            pipeline_repo.get_timeline(uid, "7d", "Not/AZone", now=NOW)


class TestFutureDatedExcluded:
    def test_future_page_excluded_everywhere(self, uid):
        ts = NOW - timedelta(days=1)
        fut = NOW + timedelta(days=2)
        _add(uid, [_skip(ts, "login_wall"), _skip(fut, "login_wall", "future.example")])
        for rng in ("7d", "30d", "90d", "all"):
            f = _flow(uid, rng)
            assert f["total"] == 1, rng
            assert [d["count"] for d in f["details"]] == [1], rng
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


def _flow(uid, range_key="all"):
    from backend.services import pipeline_summary as ps

    c = pipeline_repo.get_flow_counts(uid, range_key, now=NOW)
    return ps.build_flow(c["cells"], c["outcome_domains"], c["detail_domains"])


def _details(f):
    return {(d["outcome"], d["key"]): d["count"] for d in f["details"]}


_URL_PATTERN_SUMMARY = "URL pattern skipped: a.example (4s)"


def _url_skip(ts, domain="example.org"):
    return {
        "visited_at": ts,
        "domain": domain,
        "status": "archived",
        "depth": "skipped",
        "reason": "skip_gate",
        "content_summary": _URL_PATTERN_SUMMARY,
    }


def test_classification_paths(uid):
    t = NOW - timedelta(days=2)
    _add(
        uid,
        [
            {"visited_at": t, "status": "pending"},
            {
                "visited_at": t,
                "status": "archived",
                "depth": "skipped",
                "reason": "domain_skip",
                "content_summary": "Domain skipped (no extractable content): a (3s)",
            },
            {
                "visited_at": t,
                "status": "archived",
                "depth": "skipped",
                "reason": "skip_gate",
                "content_summary": "URL pattern skipped: b (4s)",
            },
            {
                "visited_at": t,
                "status": "archived",
                "depth": "skipped",
                "reason": "skip_gate",
                "category": "login_wall",
                "skip_reasoning": "login",
            },
            {"visited_at": t, "status": "archived", "depth": "skipped", "reason": "skip_gate"},
            {"visited_at": t, "status": "active", "depth": "processed"},
            {"visited_at": t, "status": "active", "depth": None},  # legacy NULL-depth active
            {"visited_at": t, "status": "archived", "depth": "processed", "reason": "dedupe_fold"},
            {
                "visited_at": t,
                "status": "archived",
                "depth": "processed",
                "human_status": "archived",
            },
            {
                "visited_at": t,
                "status": "archived",
                "depth": None,
                "reason": "placeholder_no_content",
            },
            {"visited_at": t, "status": "archived", "depth": None, "human_status": "archived"},
            {"visited_at": t, "status": "archived", "depth": None, "reason": "app_chrome_junk"},
            {"visited_at": t, "status": "archived", "depth": None, "reason": "dedup"},
            {"visited_at": t, "status": "archived", "depth": None, "reason": "trivial_capture"},
        ],
    )
    f = _flow(uid)
    assert _details(f) == {
        ("pending", "waiting"): 1,
        ("rule_filter", "domain"): 1,
        ("rule_filter", "url_pattern"): 1,
        ("gate", "login_wall"): 1,
        ("gate", "uncategorized"): 1,
        ("processed", "active"): 2,
        ("processed", "later_duplicate"): 1,
        ("processed", "later_manual"): 1,
        ("before_gate", "placeholder"): 1,
        ("before_gate", "manual"): 1,
        ("before_gate", "chrome"): 1,
        ("before_gate", "duplicate"): 1,
        ("before_gate", "other"): 1,
    }
    assert [o["key"] for o in f["outcomes"]] == [
        "before_gate",
        "rule_filter",
        "gate",
        "processed",
        "pending",
    ]


def test_flow_reconciles_all_ranges(uid):
    shapes = [
        {"status": "pending"},
        {"status": "archived", "depth": "skipped", "reason": "domain_skip"},
        {"status": "archived", "depth": "skipped", "reason": "skip_gate", "category": "web_app"},
        {"status": "archived", "depth": "skipped", "reason": "skip_gate"},
        {
            "status": "archived",
            "depth": "skipped",
            "reason": "skip_gate",
            "content_summary": _URL_PATTERN_SUMMARY,
        },
        {"status": "active", "depth": "processed"},
        {"status": "active", "depth": "skipped", "reason": "skip_gate", "human_status": "active"},
        {"status": "archived", "depth": "processed", "reason": "dedup"},
        {"status": "archived", "depth": None, "reason": "trivial_capture"},
        {"status": "archived", "depth": None, "human_status": "archived"},
    ]
    specs = []
    for i in range(30):
        specs.append(
            {
                **shapes[i % len(shapes)],
                "visited_at": None if i == 29 else NOW - timedelta(days=i * 14 + 1),
                "domain": f"d{i % 4}.example",
            }
        )
    _add(uid, specs)
    for rng in ("7d", "30d", "90d", "all"):
        f = _flow(uid, rng)
        assert sum(o["count"] for o in f["outcomes"]) == f["total"], rng
        assert sum(x["count"] for x in f["fates"]) == f["total"], rng
        for o in f["outcomes"]:
            assert sum(d["count"] for d in f["details"] if d["outcome"] == o["key"]) == o["count"]
        for d in f["details"]:
            assert sum(d["fates"].values()) == d["count"], (rng, d["key"])
        t = pipeline_repo.get_timeline(uid, rng, "UTC", now=NOW)
        assert sum(b["total"] for b in t["buckets"]) == f["total"] - (1 if rng == "all" else 0)
        for b in t["buckets"]:
            assert sum(b["outcomes"].values()) == b["total"]
    assert _flow(uid, "all")["total"] == 30


def test_url_pattern_skip_is_rule_filter_everywhere(uid):
    ts = NOW - timedelta(hours=2)
    _add(uid, [_url_skip(ts), _skip(ts, "login_wall")])
    f = _flow(uid, "7d")
    assert _details(f) == {("rule_filter", "url_pattern"): 1, ("gate", "login_wall"): 1}
    last = pipeline_repo.get_timeline(uid, "7d", "UTC", now=NOW)["buckets"][-1]
    assert last["categories"] == {"login_wall": 1}
    assert last["outcomes"]["rule_filter"] == 1 and last["outcomes"]["gate"] == 1
    assert last["reached_gate"] == 1
    rows, _ = pipeline_repo.get_windowed_pages(uid, "7d", now=NOW)
    by = {r["detail"]: r for r in rows}
    assert by["url_pattern"]["outcome"] == "rule_filter"
    assert by["login_wall"]["outcome"] == "gate"


def test_human_override_fate(uid):
    ts = NOW - timedelta(hours=1)
    _add(uid, [{**_skip(ts, "login_wall"), "human_status": "active"}])
    f = _flow(uid, "7d")
    (d,) = f["details"]
    assert (d["outcome"], d["key"]) == ("gate", "login_wall")
    assert d["fates"] == {"archived": 0, "active": 1, "pending": 0}
    assert {x["key"]: x["count"] for x in f["fates"]} == {"archived": 0, "active": 1, "pending": 0}
    rows, _ = pipeline_repo.get_windowed_pages(uid, "7d", now=NOW)
    assert rows[0]["fate"] == "active" and rows[0]["outcome"] == "gate"
    last = pipeline_repo.get_timeline(uid, "7d", "UTC", now=NOW)["buckets"][-1]
    assert last["archived"] == 0 and last["outcomes"]["gate"] == 1


def test_timeline_outcomes_sum_to_total(uid):
    ts = NOW - timedelta(hours=1)
    _add(
        uid,
        [
            _skip(ts, "login_wall"),
            _url_skip(ts),
            {"visited_at": ts, "status": "pending"},
            {"visited_at": ts, "status": "active", "depth": "processed"},
            {"visited_at": ts, "status": "active"},
            {"visited_at": ts, "status": "archived", "reason": "dedup"},
        ],
    )
    t = pipeline_repo.get_timeline(uid, "7d", "UTC", now=NOW)
    for b in t["buckets"]:
        assert sum(b["outcomes"].values()) == b["total"]
    last = t["buckets"][-1]
    assert last["total"] == 6 and last["archived"] == 3
    assert last["reached_gate"] == 2  # gate + processed-with-depth; NULL-depth active excluded


def test_details_display_order(uid):
    ts = NOW - timedelta(days=1)
    bg = [
        ("other", {}),
        ("duplicate", {"reason": "dedup"}),
        ("chrome", {"reason": "app_chrome_junk"}),
        ("manual", {"human_status": "archived"}),
        ("placeholder", {"reason": "placeholder_no_content"}),
    ]
    specs = [{"visited_at": ts, "status": "archived", **extra} for _, extra in bg]
    specs += [_skip(ts, "web_app")] * 1 + [_skip(ts, "login_wall")] * 2 + [_skip(ts, None)] * 5
    specs += [{"visited_at": ts, "status": "active", "depth": "processed"}]
    specs += [
        {"visited_at": ts, "status": "archived", "depth": "processed", "reason": r}
        for r in ("dedup", "app_chrome_junk")
    ]
    specs += [
        {"visited_at": ts, "status": "archived", "depth": "processed", "human_status": "archived"},
        {"visited_at": ts, "status": "archived", "depth": "processed"},
    ]
    _add(uid, specs)
    order = [(d["outcome"], d["key"]) for d in _flow(uid, "7d")["details"]]
    assert order == [
        ("before_gate", "placeholder"),
        ("before_gate", "manual"),
        ("before_gate", "chrome"),
        ("before_gate", "duplicate"),
        ("before_gate", "other"),
        ("gate", "login_wall"),
        ("gate", "web_app"),
        ("gate", "uncategorized"),
        ("processed", "later_manual"),
        ("processed", "later_duplicate"),
        ("processed", "later_chrome"),
        ("processed", "later_other"),
        ("processed", "active"),
    ]


def test_top_domains_per_outcome_and_detail(uid):
    ts = NOW - timedelta(days=1)
    specs = []
    for dom, n in (("a.example", 4), ("b.example", 3), ("c.example", 3), ("d.example", 1)):
        specs += [_skip(ts, "login_wall", dom) for _ in range(n)]
    _add(uid, specs)
    f = _flow(uid, "7d")
    expect = [
        {"domain": "a.example", "count": 4},
        {"domain": "b.example", "count": 3},
        {"domain": "c.example", "count": 3},
    ]
    gate = next(o for o in f["outcomes"] if o["key"] == "gate")
    assert gate["count"] == 11 and gate["top_domains"] == expect
    assert f["details"][0]["top_domains"] == expect
    assert next(o for o in f["outcomes"] if o["key"] == "pending")["top_domains"] == []


def test_windowed_pages_carry_flow_columns(uid):
    _add(uid, [{"visited_at": NOW - timedelta(days=1), "status": "pending"}])
    (row,), _ = pipeline_repo.get_windowed_pages(uid, "7d", now=NOW)
    assert (row["outcome"], row["detail"], row["fate"]) == ("pending", "waiting", "pending")
