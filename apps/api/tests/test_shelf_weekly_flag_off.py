"""Flag-off sentinels for the weekly shelf hook, plus the flag-on weekday gate."""

import asyncio
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import backend.services.nightly_maintenance as nm
from backend.services import shelf_service as ss


def boom(*a, **k):
    raise AssertionError("must not run with label_first_enabled off")


def test_weekly_maintenance_flag_off_touches_nothing(monkeypatch):
    for target in (
        "backend.db.shelf_repo.get_shelves",
        "backend.db.shelf_repo.recount_shelves",
        "backend.db.embedding_repo.get_clustering_embeddings",
        "backend.services.text_embedder.embed_texts",
    ):
        monkeypatch.setattr(target, boom)
    monkeypatch.setattr(ss, "_complete_blocking", boom)
    monkeypatch.setattr(ss, "DbShelfStore", boom)
    assert ss.weekly_maintenance(1, page_vectors=boom) == {}


def _run_nightly(settings_ns, weekday_today):
    async def _sweep(uid=None):
        return {"processed": 0, "failed": 0, "captures_seen": 0, "cost_usd": 0.0}

    async def _catchup(uid):
        return {"chunked_pages": 0, "classified_done": True, "cost_usd": 0.0}

    class FakeDT(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2026, 3, 16 + weekday_today)  # 2026-03-16 is a Monday

    with (
        patch.object(nm, "_default_user_id", return_value=152),
        patch.object(nm, "_last_successful_recluster_at", return_value=datetime(2026, 6, 18)),
        patch.object(nm, "_pages_added_since", return_value=0),
        patch.object(nm, "datetime", FakeDT),
        patch.object(nm, "settings", settings_ns),
        patch("backend.db.recluster_repo.reap_stale_runs", return_value=0),
        patch("backend.db.dq_runs_repo.reap_stale_runs", return_value=0),
        patch("backend.api.main.sweep_pending_once", new=_sweep),
        patch("backend.services.catchup.run_catchup_backfills", new=_catchup),
        patch("backend.db.page_repo.get_page_status_counts", return_value={}),
        patch("backend.db.trends_repo.get_total_cost_usd", return_value=0.0),
        patch("backend.db.trends_repo.insert_status_snapshot"),
        patch.object(nm.content_join_check, "check_content_joins", return_value={"count": 0, "by_user": {}}),
    ):
        return asyncio.run(nm.run_nightly_maintenance())


def test_nightly_flag_off_never_calls_weekly(monkeypatch):
    monkeypatch.setattr(ss, "weekly_maintenance", boom)
    notes = _run_nightly(SimpleNamespace(), 6)  # no flag attribute at all == default off
    assert "shelf_maintenance" not in notes
    notes = _run_nightly(SimpleNamespace(label_first_enabled=False), 6)
    assert "shelf_maintenance" not in notes


def test_nightly_flag_on_runs_only_on_configured_weekday(monkeypatch):
    mock = MagicMock(return_value={"merged": 1, "split": 0, "asked": 1, "cost_usd": 0.25})
    monkeypatch.setattr(ss, "weekly_maintenance", mock)
    cfg = SimpleNamespace(label_first_enabled=True, shelf_maintenance_weekday=6)
    notes = _run_nightly(cfg, 3)
    assert "shelf_maintenance" not in notes and not mock.called
    notes = _run_nightly(cfg, 6)
    mock.assert_called_once_with(152)
    assert notes["shelf_maintenance"]["merged"] == 1
    assert round(notes["cost_usd"], 2) == 0.25


def test_nightly_default_weekday_is_sunday_and_failure_is_contained(monkeypatch):
    mock = MagicMock(side_effect=RuntimeError("x"))
    monkeypatch.setattr(ss, "weekly_maintenance", mock)
    notes = _run_nightly(SimpleNamespace(label_first_enabled=True), 6)
    assert mock.called and "error" in notes["shelf_maintenance"]
