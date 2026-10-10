"""Daily refresh-token sweep (demo-one-click-entry, Task 4)."""
import asyncio

import pytest


def test_cleanup_tokens_once_returns_the_count(monkeypatch):
    from backend.api import main
    from backend.db import auth_repo

    monkeypatch.setattr(auth_repo, "cleanup_expired_only", lambda: 7)
    assert main.cleanup_tokens_once() == 7


def test_cleanup_tokens_once_swallows_errors(monkeypatch):
    from backend.api import main
    from backend.db import auth_repo

    def boom():
        raise RuntimeError("db down")

    monkeypatch.setattr(auth_repo, "cleanup_expired_only", boom)
    assert main.cleanup_tokens_once() == 0


def test_loop_calls_cleanup_on_each_tick(monkeypatch):
    from backend.api import main

    calls = []
    monkeypatch.setattr(main, "cleanup_tokens_once", lambda: calls.append(1) or 1)
    sleeps = []

    async def fake_sleep(seconds):
        sleeps.append(seconds)
        if len(sleeps) >= 3:
            raise asyncio.CancelledError

    monkeypatch.setattr(main.asyncio, "sleep", fake_sleep)
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(main._token_cleanup_loop(interval_hours=24, initial_delay_seconds=1))
    assert calls == [1, 1]
    assert sleeps == [1, 24 * 3600, 24 * 3600]
