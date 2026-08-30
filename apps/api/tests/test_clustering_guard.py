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
