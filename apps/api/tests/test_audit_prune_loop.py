"""Daily audit_events prune loop and its retention setting (backlog #90)."""

import asyncio

import pytest


def test_retention_setting_defaults_to_90_days():
    from backend.config.settings import Settings

    assert Settings.model_fields["audit_anonymous_retention_days"].default == 90


def test_retention_setting_reads_env(monkeypatch):
    from backend.config.settings import Settings

    monkeypatch.setenv("AUDIT_ANONYMOUS_RETENTION_DAYS", "30")
    assert Settings().audit_anonymous_retention_days == 30


def _run_loop(main, monkeypatch, *, ticks, **loop_kwargs):
    sleeps = []

    async def fake_sleep(seconds):
        sleeps.append(seconds)
        if len(sleeps) > ticks:
            raise asyncio.CancelledError

    monkeypatch.setattr(main.asyncio, "sleep", fake_sleep)
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(main._prune_audit_events_loop(**loop_kwargs))
    return sleeps


def test_loop_prunes_each_tick_with_the_settings_window(monkeypatch):
    from backend.api import main
    from backend.config.settings import settings
    from backend.db import audit_repo

    calls = []
    monkeypatch.setattr(audit_repo, "prune_older_than", lambda days: calls.append(days) or 3)
    monkeypatch.setattr(settings, "audit_anonymous_retention_days", 45)
    sleeps = _run_loop(main, monkeypatch, ticks=2)
    assert calls == [45, 45]
    # startup grace, then one interval after each prune
    assert sleeps == [60, 24 * 3600, 24 * 3600]


def test_loop_explicit_window_overrides_setting(monkeypatch):
    from backend.api import main
    from backend.db import audit_repo

    calls = []
    monkeypatch.setattr(audit_repo, "prune_older_than", lambda days: calls.append(days) or 0)
    _run_loop(main, monkeypatch, ticks=1, retention_days=7, interval_hours=1)
    assert calls == [7]


def test_loop_survives_a_failing_prune(monkeypatch, caplog):
    from backend.api import main
    from backend.db import audit_repo

    calls = []

    def boom(days):
        calls.append(days)
        raise RuntimeError("db down")

    monkeypatch.setattr(audit_repo, "prune_older_than", boom)
    with caplog.at_level("ERROR"):
        sleeps = _run_loop(main, monkeypatch, ticks=2)
    assert len(calls) == 2  # kept ticking after the first failure
    assert sleeps == [60, 24 * 3600, 24 * 3600]
    assert any("audit_events prune failed" in r.getMessage() for r in caplog.records)


def test_lifespan_source_starts_the_loop():
    # the loop only matters if lifespan schedules it (same app.state pattern as the token sweep)
    import inspect

    from backend.api import main

    assert "_prune_audit_events_loop()" in inspect.getsource(main.lifespan)
