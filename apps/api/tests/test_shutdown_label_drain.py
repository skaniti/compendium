"""Shutdown waits (bounded) for queued label hooks before the pool closes."""

import asyncio
import sys

from backend import process_captures
from backend.api import main


def test_nothing_queued_returns_immediately(monkeypatch):
    monkeypatch.setattr(process_captures, "_label_futures", set())
    asyncio.run(main._drain_label_hooks_on_shutdown())


def test_waits_for_a_queued_hook(monkeypatch):
    monkeypatch.setattr(process_captures, "_label_futures", set())
    done = []

    async def go():
        loop = asyncio.get_running_loop()

        def hook():
            import time

            time.sleep(0.2)
            done.append(1)

        fut = loop.run_in_executor(None, hook)
        process_captures._label_futures.add(fut)
        fut.add_done_callback(process_captures._label_futures.discard)
        await main._drain_label_hooks_on_shutdown()
        return list(done)

    assert asyncio.run(go()) == [1]


def test_gives_up_after_the_timeout_and_never_raises(monkeypatch, caplog):
    monkeypatch.setattr(process_captures, "_label_futures", {object()})
    monkeypatch.setattr(main, "SHUTDOWN_LABEL_DRAIN_TIMEOUT_S", 0.05)

    async def stuck():
        await asyncio.sleep(10)

    monkeypatch.setattr(process_captures, "drain_label_hooks", stuck)
    with caplog.at_level("WARNING"):
        asyncio.run(main._drain_label_hooks_on_shutdown())
    assert "still running" in caplog.text


def test_unloaded_ingest_module_is_a_no_op(monkeypatch):
    monkeypatch.delitem(sys.modules, "backend.process_captures")
    asyncio.run(main._drain_label_hooks_on_shutdown())
