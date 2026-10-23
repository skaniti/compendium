import asyncio
from unittest.mock import patch, MagicMock
import backend.services.nightly_maintenance as nm


def test_nightly_runs_maintenance_even_with_no_new_pages():
    calls = []
    async def _sweep(uid=None):
        calls.append("sweep"); return {"processed": 0, "failed": 0, "captures_seen": 0, "cost_usd": 0.0}
    async def _catchup(uid):
        calls.append("catchup"); return {"chunked_pages": 0, "classified_done": True, "cost_usd": 0.0}
    with (
        patch.object(nm, "_default_user_id", return_value=152),
        patch.object(nm, "_last_successful_recluster_at", return_value=__import__("datetime").datetime(2026, 6, 18)),
        patch.object(nm, "_pages_added_since", return_value=0),  # NO new pages
        patch("backend.db.recluster_repo.reap_stale_runs", return_value=0),
        patch("backend.db.dq_runs_repo.reap_stale_runs", return_value=0),
        patch("backend.api.main.sweep_pending_once", new=_sweep),
        patch("backend.services.catchup.run_catchup_backfills", new=_catchup),
        patch("backend.db.page_repo.get_page_status_counts", return_value={"active": 5, "pending": 0, "archived": 1}),
        patch("backend.db.trends_repo.get_total_cost_usd", return_value=1.23),
        patch("backend.db.trends_repo.insert_status_snapshot") as snap,
        patch.object(nm.content_join_check, "check_content_joins", return_value={"count": 0, "by_user": {}}),
    ):
        notes = asyncio.run(nm.run_nightly_maintenance())
    assert "sweep" in calls and "catchup" in calls       # maintenance ran despite no new pages
    assert "recluster_skipped" in notes                   # recluster correctly short-circuited
    assert snap.called                                    # snapshot always written


def test_nightly_reclusters_when_new_pages():
    async def _sweep(uid=None):
        return {"processed": 2, "failed": 0, "captures_seen": 2, "cost_usd": 0.0}
    async def _catchup(uid):
        return {"chunked_pages": 1, "classified_done": True, "cost_usd": 0.0}
    async def _recluster(batch_mode=False):
        return {"naming_cost": 0.05, "cluster_count": 7, "noise_count": 2, "elapsed_seconds": 3.0}
    fake_svc = MagicMock(); fake_svc.recluster_all = _recluster
    with (
        patch.object(nm, "_default_user_id", return_value=152),
        patch.object(nm, "_last_successful_recluster_at", return_value=None),
        patch.object(nm, "_pages_added_since", return_value=60),
        patch("backend.db.recluster_repo.reap_stale_runs", return_value=0),
        patch("backend.db.dq_runs_repo.reap_stale_runs", return_value=0),
        patch("backend.api.main.sweep_pending_once", new=_sweep),
        patch("backend.services.clustering_service.ClusteringService", return_value=fake_svc),
        patch("backend.services.catchup.run_catchup_backfills", new=_catchup),
        patch("backend.db.page_repo.get_page_status_counts", return_value={"active": 60, "pending": 0, "archived": 0}),
        patch("backend.db.trends_repo.get_total_cost_usd", return_value=2.0),
        patch("backend.db.trends_repo.insert_status_snapshot") as snap,
        patch.object(nm.content_join_check, "check_content_joins", return_value={"count": 0, "by_user": {}}),
    ):
        notes = asyncio.run(nm.run_nightly_maintenance())
    assert notes["cluster_count"] == 7
    assert round(notes["cost_usd"], 4) == 0.05
    snap.assert_called_once()



# --- content join check step -------------------------------------------------

import contextlib
import logging
from datetime import UTC, datetime

import pytest


def _run_nightly(check, calls=None):
    """Run the whole nightly with every other step stubbed; ``check`` stands in for the join check."""
    calls = calls if calls is not None else []

    async def _sweep(uid=None):
        calls.append("sweep")
        return {"processed": 0, "failed": 0, "captures_seen": 0, "cost_usd": 0.0}

    async def _catchup(uid):
        calls.append("catchup")
        return {"chunked_pages": 0, "classified_done": True, "cost_usd": 0.0}

    async def _recluster(batch_mode=False):
        calls.append("recluster")
        return {"naming_cost": 0.0, "cluster_count": 1, "noise_count": 0}

    fake_svc = MagicMock()
    fake_svc.recluster_all = _recluster
    with (
        patch.object(nm, "_default_user_id", return_value=152),
        patch.object(nm, "_last_successful_recluster_at", return_value=None),  # forces a recluster
        patch.object(nm, "_pages_added_since", return_value=0),
        patch("backend.db.recluster_repo.reap_stale_runs", return_value=0),
        patch("backend.db.dq_runs_repo.reap_stale_runs", return_value=0),
        patch("backend.api.main.sweep_pending_once", new=_sweep),
        patch("backend.services.clustering_service.ClusteringService", return_value=fake_svc),
        patch("backend.services.catchup.run_catchup_backfills", new=_catchup),
        patch("backend.db.page_repo.get_page_status_counts", return_value={"active": 1, "pending": 0, "archived": 0}),
        patch("backend.db.trends_repo.get_total_cost_usd", return_value=0.0),
        patch("backend.db.trends_repo.insert_status_snapshot", side_effect=lambda **kw: calls.append("snapshot")),
        check,
    ):
        return asyncio.run(nm.run_nightly_maintenance()), calls


def test_join_check_result_is_recorded_in_notes_and_runs_after_the_sweep():
    result = {"count": 2, "by_user": {"152": {"count": 2, "page_ids": [7, 9]}}}
    order = []

    def _check(**kw):
        order.append("check")
        return result

    notes, calls = _run_nightly(
        patch.object(nm.content_join_check, "check_content_joins", side_effect=_check), calls=order
    )
    assert notes["content_join_mismatches"] == result
    assert order.index("sweep") < order.index("check") < order.index("recluster")


def test_clean_join_check_is_recorded_as_count_zero():
    clean = {"count": 0, "by_user": {}}
    notes, _ = _run_nightly(patch.object(nm.content_join_check, "check_content_joins", return_value=clean))
    assert notes["content_join_mismatches"] == {"count": 0, "by_user": {}}


def test_nonzero_join_check_logs_one_warning_with_count_and_capped_ids(caplog):
    result = {"count": 25, "by_user": {"152": {"count": 25, "page_ids": list(range(1, 21))}}}
    with caplog.at_level(logging.INFO, logger=nm.logger.name):
        _run_nightly(patch.object(nm.content_join_check, "check_content_joins", return_value=result))
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING and "join" in r.getMessage()]
    assert len(warnings) == 1
    msg = warnings[0].getMessage()
    assert "25" in msg and "152" in msg and "20" in msg


def test_clean_join_check_logs_no_warning(caplog):
    with caplog.at_level(logging.INFO, logger=nm.logger.name):
        _run_nightly(
            patch.object(nm.content_join_check, "check_content_joins", return_value={"count": 0, "by_user": {}})
        )
    assert not [r for r in caplog.records if r.levelno >= logging.WARNING]


def test_join_check_failure_is_recorded_and_later_steps_still_run():
    boom = patch.object(nm.content_join_check, "check_content_joins", side_effect=RuntimeError("db went away"))
    notes, calls = _run_nightly(boom)
    assert notes["content_join_mismatches"] == {"error": "db went away"}
    assert "error" not in notes  # the run itself did not fail
    for step in ("sweep", "recluster", "catchup", "snapshot"):
        assert step in calls


def _pg_reachable() -> bool:
    try:
        from psycopg2 import connect

        from backend.config.settings import settings

        connect(settings.test_database_url).close()
        return True
    except Exception:
        return False


@pytest.mark.skipif(not _pg_reachable(), reason="Test PostgreSQL not reachable")
def test_nightly_finds_a_real_mismatched_page_in_the_database():
    from backend.db import capture_repo, content_repo, page_repo, user_repo
    from backend.db.connection import get_conn

    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "TRUNCATE graph_cache, cluster_edges, page_clusters, clusters, recluster_runs,"
            " pages, page_content, captures, users CASCADE"
        )
    user = user_repo.create_user("nightly-join@example.test", name="Nightly Join")
    t0 = datetime(2026, 3, 15, 10, 0, tzinfo=UTC)
    cap = capture_repo.save_capture(
        user_id=user["id"], capture_id="cap_nightly_join", source="desktop_active",
        started_at=t0, ended_at=t0.replace(hour=11),
    )
    ids = [
        page_repo.insert_pages(cap["id"], [{
            "url": f"https://{n}.example.test/page", "title": n, "domain": f"{n}.example.test",
            "visited_at": t0.replace(minute=i),
        }])[0]
        for i, n in enumerate(["wrong", "right"])
    ]
    other = content_repo.get_or_create_content("https://other.example.test/page", extracted_text="t")["id"]
    own = content_repo.get_or_create_content("https://right.example.test/page", extracted_text="t")["id"]
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("UPDATE pages SET page_content_id=%s WHERE id=%s", (other, ids[0]))
        cur.execute("UPDATE pages SET page_content_id=%s WHERE id=%s", (own, ids[1]))

    notes, _ = _run_nightly(contextlib.nullcontext())
    assert notes["content_join_mismatches"] == {
        "count": 1,
        "by_user": {str(user["id"]): {"count": 1, "page_ids": [ids[0]]}},
    }
