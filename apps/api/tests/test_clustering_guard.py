"""Tests for the idle-guard wired into ClusteringService.recluster_all().

Guards against concurrent in-flight recluster runs by replacing start_run
with start_run_if_idle (Task B2). When the guard returns None (run already
in flight), recluster_all must early-return without doing real clustering work.

Also covers the too-few-pages early-return path (fix: close the run so it
does not leak a 'running' row that would block future reclusters).
"""
import asyncio
from unittest.mock import patch
from backend.services.clustering_service import ClusteringService


def test_recluster_all_skips_when_guard_returns_none():
    svc = ClusteringService(user_id=152)
    with patch("backend.services.clustering_service.recluster_repo.start_run_if_idle", return_value=None):
        result = asyncio.run(svc.recluster_all())
    assert result.get("skipped") == "already_running"


def test_recluster_all_closes_run_on_too_few_pages():
    """Too-few-pages path must call complete_run so the run record is not left
    in 'running' state and blocking all future reclusters for the user."""
    svc = ClusteringService(user_id=152)
    with (
        patch(
            "backend.services.clustering_service.recluster_repo.start_run_if_idle",
            return_value=999,
        ),
        patch(
            "backend.services.clustering_service.page_repo.get_active_pages",
            return_value=[],
        ),
        patch(
            "backend.services.clustering_service.recluster_repo.complete_run"
        ) as mock_complete,
    ):
        result = asyncio.run(svc.recluster_all())

    assert result.get("cluster_count") == 0
    mock_complete.assert_called_once()
    call_kwargs = mock_complete.call_args
    # First positional arg must be the sentinel run_id
    assert call_kwargs.args[0] == 999


def test_recluster_all_fails_the_run_when_page_loading_raises():
    """An exception before the main try (loading/filtering pages) must still
    mark the run failed, otherwise the row stays 'running' and every later
    recluster is skipped as already running until the stale window passes."""
    import pytest

    svc = ClusteringService(user_id=7)
    boom = RuntimeError("db error in get_active_pages")
    with (
        patch("backend.services.clustering_service.settings.label_first_enabled", False),
        patch(
            "backend.services.clustering_service.recluster_repo.start_run_if_idle",
            return_value=999,
        ),
        patch.object(ClusteringService, "_load_all_pages", side_effect=boom),
        patch("backend.services.clustering_service.recluster_repo.fail_run") as mock_fail,
    ):
        with pytest.raises(RuntimeError, match="get_active_pages"):
            asyncio.run(svc.recluster_all())

    mock_fail.assert_called_once_with(999)


def test_recluster_all_after_a_page_loading_failure_is_not_skipped():
    """Real test database: the failed run no longer blocks the next recluster."""
    import pytest

    from backend.db import recluster_repo, user_repo
    from backend.db.connection import get_conn

    try:
        from psycopg2 import connect

        from backend.config.settings import settings

        connect(settings.test_database_url).close()
    except Exception:
        pytest.skip("Test PostgreSQL not reachable")

    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("TRUNCATE recluster_runs, users CASCADE")
    user = user_repo.create_user("guard-fail@example.com", name="Guard Fail")
    svc = ClusteringService(user_id=user["id"])

    with (
        patch("backend.services.clustering_service.settings.label_first_enabled", False),
        patch.object(ClusteringService, "_load_all_pages", side_effect=RuntimeError("boom")),
    ):
        with pytest.raises(RuntimeError):
            asyncio.run(svc.recluster_all())

    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT status FROM recluster_runs WHERE user_id = %s", (user["id"],))
        assert [r[0] for r in cur.fetchall()] == ["failed"]

    # a second recluster starts a new run instead of returning "already_running"
    with patch("backend.services.clustering_service.settings.label_first_enabled", False):
        result = asyncio.run(svc.recluster_all())  # no pages -> too-few-pages path completes it
    assert "skipped" not in result
    assert recluster_repo.get_latest_run(user["id"]) is not None


def test_recluster_all_fails_the_run_when_the_label_first_import_breaks():
    """The label-first branch's import runs before its own handler: an import
    error must still fail the run rather than leave it 'running'."""
    import sys

    import pytest

    svc = ClusteringService(user_id=7)
    with (
        patch("backend.services.clustering_service.settings.label_first_enabled", True),
        patch(
            "backend.services.clustering_service.recluster_repo.start_run_if_idle",
            return_value=999,
        ),
        patch("backend.services.clustering_service.recluster_repo.fail_run") as mock_fail,
        patch.dict(sys.modules, {"backend.services.label_first_clustering": None}),
    ):
        with pytest.raises(ImportError):
            asyncio.run(svc.recluster_all())
    mock_fail.assert_called_once_with(999)


def test_recluster_all_awaits_the_proposal_call_before_completing_the_run(monkeypatch):
    """Behavioural: with the clustering internals faked, the proposal call is
    awaited with the run id and happens before complete_run."""
    import numpy as np

    from backend.services import clustering_service as cs

    events = []
    monkeypatch.setattr(cs.settings, "label_first_enabled", False)
    monkeypatch.setattr(cs.settings, "cluster_identity_enabled", False)
    monkeypatch.setattr(cs.settings, "supercluster_mode", "keywords")
    monkeypatch.setenv("DQ_OVERRIDES_DISABLED", "1")
    monkeypatch.setattr(cs.recluster_repo, "start_run_if_idle", lambda uid: 321)
    monkeypatch.setattr(
        cs.recluster_repo, "complete_run", lambda run_id, **kw: events.append(("complete", run_id))
    )
    monkeypatch.setattr(cs.recluster_repo, "cleanup_old_runs", lambda *a, **k: None)
    monkeypatch.setattr("backend.db.auth_repo.get_preferences", lambda uid: {})

    pages = [{"db_id": i, "page_content_id": i} for i in range(12)]
    monkeypatch.setattr(ClusteringService, "_load_all_pages", lambda self, uid: pages)
    monkeypatch.setattr(ClusteringService, "_filter_clusterable_pages", lambda self, p: (p, {}))
    monkeypatch.setattr(ClusteringService, "_compute_embeddings", lambda self, p: np.zeros((12, 4)))
    monkeypatch.setattr(
        ClusteringService, "_run_hdbscan",
        lambda self, e: (np.array([0] * 6 + [1] * 6), np.zeros(12), None),
    )
    monkeypatch.setattr(ClusteringService, "_select_featured_singletons", lambda self, *a, **k: [])

    async def names(self, *a, **k):
        return {0: "Alpha Cluster", 1: "Beta Cluster"}, 0.0

    monkeypatch.setattr(ClusteringService, "_name_clusters", names)
    monkeypatch.setattr(ClusteringService, "_name_clusters_batch", names)
    monkeypatch.setattr(
        ClusteringService, "_write_clusters_to_db",
        lambda self, *a, **k: {"slug_to_db_id": {"alpha_cluster": 1, "beta_cluster": 2}, "stable_ids": {}},
    )
    monkeypatch.setattr(ClusteringService, "_write_featured_singletons_to_db", lambda self, *a, **k: None)

    async def fake_store(user_id, run_id):
        events.append(("proposals", user_id, run_id))
        return {"proposed": 0}

    monkeypatch.setattr("backend.services.topic_proposals.store_proposals_for_run", fake_store)
    # everything after the run is completed is best-effort; keep it off the network/DB
    monkeypatch.setattr("backend.services.graph_builder.build_graph_from_db", lambda uid: None)
    monkeypatch.setattr("backend.services.graph_service.save_graph", lambda g, uid: None)

    asyncio.run(ClusteringService(user_id=7).recluster_all())

    assert ("proposals", 7, 321) in events
    assert events.index(("proposals", 7, 321)) < events.index(("complete", 321))
