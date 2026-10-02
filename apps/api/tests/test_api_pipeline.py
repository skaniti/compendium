"""HTTP tests for the Pipeline dev view routes (apps/api replaces the Dash
in-process reads of frontend/dash/callbacks/pipeline_monitor.py and
trends.py's skip charts). Postgres-backed; mirrors tests/test_api_diary.py."""

from datetime import UTC, datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient


def _pg_reachable() -> bool:
    try:
        from psycopg2 import connect

        from backend.config.settings import settings

        connect(settings.test_database_url).close()
        return True
    except Exception:  # noqa: BLE001
        return False


pytestmark = pytest.mark.skipif(not _pg_reachable(), reason="Test PostgreSQL not reachable")

from backend.db import capture_repo, page_repo, user_repo
from backend.db.connection import get_conn

NOW = datetime(2026, 9, 20, 12, 0, tzinfo=UTC)


@pytest.fixture(autouse=True)
def _clean_tables():
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "TRUNCATE graph_cache, cluster_edges, page_clusters, clusters, recluster_runs, "
            "pages, page_content, captures, users CASCADE"
        )
    yield


def _user(email):
    return user_repo.create_user(email, name="Pipeline User")


def _capture(user_id, cid, started=NOW):
    return capture_repo.save_capture(
        user_id=user_id,
        capture_id=cid,
        source="desktop_active",
        started_at=started,
        ended_at=started + timedelta(hours=1),
    )


def _set(page_id, **cols):
    sets = ", ".join(f"{k} = %s" for k in cols)
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(f"UPDATE pages SET {sets} WHERE id = %s", (*cols.values(), page_id))


def _seed_mix(user_id):
    """3 captures over 3 days; 6 pages: 2 processed/active, 1 skipped gate,
    1 domain_skip archived, 1 pending (NULL depth), 1 trivial_capture NULL depth."""
    caps = [_capture(user_id, f"cap_{i}", NOW - timedelta(days=i)) for i in range(3)]
    ids = []
    for i, cap in enumerate(caps):
        ids += page_repo.insert_pages(
            cap["id"],
            [
                {
                    "url": f"https://example.org/a{i}",
                    "title": f"Alpha {i}",
                    "domain": "example.org",
                    "visited_at": NOW - timedelta(days=i, minutes=5),
                },
                {
                    "url": f"https://shop.example.com/b{i}",
                    "title": f"Beta {i}",
                    "domain": "shop.example.com",
                    "visited_at": NOW - timedelta(days=i, minutes=3),
                },
            ],
        )
    _set(ids[0], status="active", processing_depth="processed", user_id=user_id)
    _set(
        ids[1],
        status="archived",
        processing_depth="skipped",
        archive_reason="skip_gate",
        skip_reasoning="login wall",
        user_id=user_id,
    )
    _set(ids[2], status="active", processing_depth="processed", user_id=user_id)
    _set(
        ids[3],
        status="archived",
        archive_reason="domain_skip",
        processing_depth="skipped",
        skip_reasoning="Domain skipped",
        user_id=user_id,
    )
    _set(ids[4], status="pending", user_id=user_id)
    _set(ids[5], status="archived", archive_reason="trivial_capture", user_id=user_id)
    return ids


@pytest.fixture
def client():
    from backend.api.main import app, verify_api_key

    user = _user("pipe@example.com")
    app.dependency_overrides[verify_api_key] = lambda: user["id"]
    yield TestClient(app), user
    app.dependency_overrides.pop(verify_api_key, None)


class TestSummary:
    def test_empty_user(self, client):
        tc, _ = client
        body = tc.get("/api/pipeline/summary").json()
        assert body["range"] == "all"
        assert body["status_counts"] == {"active": 0, "pending": 0, "archived": 0}
        assert body["total_pages"] == 0 and body["archive_ratio"] == 0.0
        assert body["decisions"] == []
        assert body["archive_reasons"] == [] and body["skip_categories"] == []
        cfg = body["skip_gate_config"]
        assert cfg["prompt_name"] == "skip_gate_v2_3"
        assert {c["id"] for c in cfg["categories"]} >= {"login_wall", "web_app", "other"}
        assert set(cfg["categories"][0]) == {"id", "label", "description"}

    def test_seeded_mix(self, client):
        tc, user = client
        _seed_mix(user["id"])
        body = tc.get("/api/pipeline/summary").json()
        assert body["status_counts"] == {"active": 2, "pending": 1, "archived": 3}
        assert body["total_pages"] == 6 and body["archive_ratio"] == 0.5
        keys = {r["key"]: r for r in body["decisions"]}
        assert keys["processed"]["count"] == 2 and keys["processed"]["evaluated"] is True
        assert keys["skipped"]["count"] == 2
        assert keys["pending"] == {
            "key": "pending",
            "label": "Pending",
            "count": 1,
            "evaluated": False,
        }
        assert keys["trivial_capture"]["count"] == 1
        assert {r["key"]: r["label"] for r in body["archive_reasons"]} == {
            "skip_gate": "LLM Skip Gate",
            "domain_skip": "Domain Filter",
            "trivial_capture": "Trivial Capture",
        }
        (cat,) = body["skip_categories"]
        assert cat == {
            "key": "uncategorized",
            "label": "Uncategorized",
            "count": 1,
            "top_domains": [{"domain": "shop.example.com", "count": 1}],
        }

    def test_range_windows_and_unknown_range(self, client):
        tc, user = client
        ids = _seed_mix(user["id"])
        with get_conn() as conn, conn.cursor() as cur:
            cur.execute(
                "UPDATE pages SET visited_at = NOW() - interval '200 days' WHERE id = %s",
                (ids[1],),
            )
        assert tc.get("/api/pipeline/summary?range=90d").json()["total_pages"] == 5
        assert tc.get("/api/pipeline/summary?range=all").json()["total_pages"] == 6
        body = tc.get("/api/pipeline/summary?range=bogus").json()
        assert body["range"] == "all" and body["total_pages"] == 6

    def test_invalid_tz_is_422(self, client):
        tc, _ = client
        for tz in ("Not/AZone", "x" * 300, "'; DROP TABLE pages;--"):
            assert tc.get("/api/pipeline/summary", params={"tz": tz}).status_code == 422


class TestTimeline:
    def test_shape_and_ranges(self, client):
        tc, user = client
        _seed_mix(user["id"])
        for rng, gran in (("7d", "6h"), ("30d", "day"), ("90d", "week"), ("all", "month")):
            body = tc.get(f"/api/pipeline/timeline?range={rng}&tz=America/New_York").json()
            assert body["range"] == rng and body["granularity"] == gran
            b = body["buckets"][0]
            assert set(b) == {
                "start",
                "label_key",
                "kept",
                "archived",
                "evaluated",
                "skipped",
                "categories",
            }
            assert b["start"][-6] in "+-" and b["start"][-3] == ":"  # local offset present
        body = tc.get("/api/pipeline/timeline?range=zzz").json()
        assert body["range"] == "all" and body["granularity"] == "month"

    def test_invalid_tz_is_422(self, client):
        tc, _ = client
        assert tc.get("/api/pipeline/timeline?tz=Mars/Base").status_code == 422


class TestPages:
    def test_pagination_and_shape(self, client):
        tc, user = client
        _seed_mix(user["id"])
        first = tc.get("/api/pipeline/pages?limit=4&offset=0").json()
        assert first["total"] == 6 and first["limit"] == 4 and first["offset"] == 0
        assert len(first["rows"]) == 4
        row = first["rows"][0]
        assert set(row) == {
            "id",
            "title",
            "domain",
            "status",
            "processing_depth",
            "archive_reason",
            "skip_reasoning",
            "visited_at",
            "created_at",
        }
        assert row["visited_at"].endswith("+00:00") or row["visited_at"].endswith("Z")
        second = tc.get("/api/pipeline/pages?limit=4&offset=4").json()
        assert len(second["rows"]) == 2
        assert {r["id"] for r in first["rows"]}.isdisjoint({r["id"] for r in second["rows"]})

    def test_limit_bounds(self, client):
        tc, _ = client
        assert tc.get("/api/pipeline/pages?limit=0").status_code == 422
        assert tc.get("/api/pipeline/pages?limit=201").status_code == 422
        assert tc.get("/api/pipeline/pages?offset=-1").status_code == 422

    def test_default_sort_is_created_at_desc_and_echoed(self, client):
        tc, user = client
        _seed_mix(user["id"])
        body = tc.get("/api/pipeline/pages").json()
        assert body["sort"] == "created_at" and body["dir"] == "desc"
        created = [r["created_at"] for r in body["rows"]]
        assert created == sorted(created, reverse=True)

    @pytest.mark.parametrize(
        "col", ["title", "domain", "status", "processing_depth", "visited_at", "created_at"]
    )
    def test_sort_each_column_both_directions_nulls_last(self, client, col):
        tc, user = client
        _seed_mix(user["id"])
        for direction, reverse in (("asc", False), ("desc", True)):
            rows = tc.get(f"/api/pipeline/pages?sort={col}&dir={direction}").json()["rows"]
            vals = [r[col] for r in rows]
            non_null = [v for v in vals if v is not None]
            assert vals[: len(non_null)] == non_null  # NULLs trail in both directions
            assert non_null == sorted(non_null, reverse=reverse)

    def test_sort_tiebreak_is_stable_across_pages(self, client):
        tc, user = client
        _seed_mix(user["id"])  # status has only three distinct values -> ties
        a = tc.get("/api/pipeline/pages?sort=status&dir=asc&limit=3&offset=0").json()["rows"]
        b = tc.get("/api/pipeline/pages?sort=status&dir=asc&limit=3&offset=3").json()["rows"]
        assert {r["id"] for r in a}.isdisjoint({r["id"] for r in b})
        assert len(a) + len(b) == 6

    def test_range_window_and_invalid_tz(self, client):
        tc, user = client
        ids = _seed_mix(user["id"])
        with get_conn() as conn, conn.cursor() as cur:
            cur.execute(
                "UPDATE pages SET visited_at = NOW() - interval '200 days' WHERE id = %s",
                (ids[0],),
            )
        assert tc.get("/api/pipeline/pages?range=90d").json()["total"] == 5
        assert tc.get("/api/pipeline/pages?range=bogus&tz=UTC").json()["total"] == 6
        assert tc.get("/api/pipeline/pages?tz=Nope/Zone").status_code == 422

    def test_disallowed_sort_or_dir_is_422(self, client):
        tc, _ = client
        assert tc.get("/api/pipeline/pages?sort=id").status_code == 422
        assert tc.get("/api/pipeline/pages?sort=title;drop").status_code == 422
        assert tc.get("/api/pipeline/pages?dir=sideways").status_code == 422


class TestDbRejectedTz:
    @pytest.mark.parametrize(
        ("path", "attr"),
        [
            ("/api/pipeline/summary", "get_summary_counts"),
            ("/api/pipeline/timeline", "get_timeline"),
            ("/api/pipeline/pages", "get_windowed_pages"),
        ],
    )
    @pytest.mark.parametrize("exc_name", ["InvalidParameterValue", "DataError"])
    def test_db_unknown_zone_is_422(self, client, monkeypatch, path, attr, exc_name):
        import psycopg2
        import psycopg2.errors

        from backend.db import pipeline_repo

        exc = getattr(psycopg2.errors, exc_name, None) or psycopg2.DataError

        def boom(*a, **k):
            raise exc("time zone not recognized")

        monkeypatch.setattr(pipeline_repo, attr, boom)
        tc, _ = client
        assert tc.get(path, params={"tz": "UTC"}).status_code == 422


class TestRemoved:
    def test_skip_trends_is_gone(self, client):
        tc, _ = client
        assert tc.get("/api/pipeline/skip-trends").status_code == 404


class TestAuth:
    def test_unauthenticated_in_prod_mode_is_401(self, monkeypatch):
        from backend.api.main import app
        from backend.config.settings import settings

        monkeypatch.setattr(settings, "environment", "production")
        tc = TestClient(app)
        for path in (
            "/api/pipeline/summary",
            "/api/pipeline/timeline",
            "/api/pipeline/pages",
        ):
            assert tc.get(path).status_code == 401, path

    def test_demo_user_sees_only_own_rows(self, monkeypatch):
        """Plain demo is allowed (read-only surface); isolation is by user_id."""
        from backend.api.main import app, verify_api_key
        from backend.db import auth_repo

        owner = _user("owner@example.com")
        demo = _user("demo@example.com")
        auth_repo.set_role(demo["id"], "demo")
        _seed_mix(owner["id"])
        cap = _capture(demo["id"], "cap_demo")
        (demo_pid,) = page_repo.insert_pages(
            cap["id"],
            [
                {
                    "url": "https://docs.example.net/x",
                    "title": "Demo only",
                    "domain": "docs.example.net",
                    "visited_at": NOW,
                }
            ],
        )
        _set(
            demo_pid,
            status="archived",
            processing_depth="skipped",
            archive_reason="skip_gate",
            skip_category="web_app",
            user_id=demo["id"],
        )
        app.dependency_overrides[verify_api_key] = lambda: demo["id"]
        try:
            tc = TestClient(app)
            pages = tc.get("/api/pipeline/pages").json()
            assert pages["total"] == 1 and pages["rows"][0]["title"] == "Demo only"
            summary = tc.get("/api/pipeline/summary").json()
            assert summary["total_pages"] == 1
            assert [(g["key"], g["count"]) for g in summary["archive_reasons"]] == [
                ("skip_gate", 1)
            ]
            assert [(g["key"], g["count"]) for g in summary["skip_categories"]] == [("web_app", 1)]
            assert summary["skip_categories"][0]["top_domains"] == [
                {"domain": "docs.example.net", "count": 1}
            ]
            tl = tc.get("/api/pipeline/timeline?range=all").json()["buckets"]
            assert sum(b["kept"] + b["archived"] for b in tl) == 1
            assert sum(b["skipped"] for b in tl) == 1
            assert [b["categories"] for b in tl if b["categories"]] == [{"web_app": 1}]
        finally:
            app.dependency_overrides.pop(verify_api_key, None)
