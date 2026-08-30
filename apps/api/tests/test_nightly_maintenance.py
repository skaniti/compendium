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
    ):
        notes = asyncio.run(nm.run_nightly_maintenance())
    assert notes["cluster_count"] == 7
    assert round(notes["cost_usd"], 4) == 0.05
    snap.assert_called_once()
