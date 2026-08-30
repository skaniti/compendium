import asyncio
import os
from unittest.mock import patch
import backend.api.main as main


def test_pending_sweep_loop_noop_when_interval_unset():
    called = {"n": 0}
    async def _fake_sweep(uid=None):
        called["n"] += 1
        return {"processed": 0, "failed": 0, "captures_seen": 0, "cost_usd": 0.0}
    with (
        patch.dict(os.environ, {}, clear=False),
        patch.object(main, "sweep_pending_once", new=_fake_sweep),
    ):
        os.environ.pop("PENDING_SWEEP_INTERVAL_SECONDS", None)
        asyncio.run(asyncio.wait_for(main._pending_sweep_loop(), timeout=1.0))
    assert called["n"] == 0  # returned immediately, never swept


def test_pending_sweep_loop_invalid_interval_is_noop():
    with patch.dict(os.environ, {"PENDING_SWEEP_INTERVAL_SECONDS": "not-a-number"}):
        asyncio.run(asyncio.wait_for(main._pending_sweep_loop(), timeout=1.0))
    # no exception, returns cleanly
