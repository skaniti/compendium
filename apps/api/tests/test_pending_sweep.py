import asyncio
from unittest.mock import patch, MagicMock
import backend.api.main as main


def test_sweep_pending_once_processes_each_capture_and_counts():
    caps = [{"id": 1, "capture_id": "a"}, {"id": 2, "capture_id": "b"}]
    fake_resp = MagicMock(total_llm_cost_usd=0.01)
    with (
        patch.object(main, "get_pending_captures", return_value=caps),
        patch.object(main, "build_capture_input_from_db", side_effect=lambda c: c),
        patch.object(main, "process_capture", new=lambda ci: _async(fake_resp)),
        patch.object(main, "update_pages_from_response", return_value=0),
    ):
        out = asyncio.run(main.sweep_pending_once(user_id=152))
    assert out["captures_seen"] == 2
    assert out["processed"] == 2
    assert out["failed"] == 0
    assert round(out["cost_usd"], 4) == 0.02


def test_sweep_pending_once_counts_failures_without_raising():
    caps = [{"id": 1, "capture_id": "a"}]
    def _boom(_):
        raise RuntimeError("processing blew up")
    with (
        patch.object(main, "get_pending_captures", return_value=caps),
        patch.object(main, "build_capture_input_from_db", side_effect=lambda c: c),
        patch.object(main, "process_capture", new=lambda ci: _boom(ci)),
    ):
        out = asyncio.run(main.sweep_pending_once(user_id=152))
    assert out["failed"] == 1 and out["processed"] == 0


def test_sweep_pending_once_lazy_import_branch():
    """Exercises the if-sentinel-is-None import branch at sweep_pending_once entry.

    The branch runs before the pending-captures loop, so an empty get_pending_captures
    return is enough to reach it. We null the module-level sentinels, call the
    function, and assert they are now populated from the real module.
    """
    # Save originals so we can restore regardless of outcome
    orig_bicfdb = main.build_capture_input_from_db
    orig_upfr = main.update_pages_from_response
    try:
        main.build_capture_input_from_db = None  # type: ignore[assignment]
        main.update_pages_from_response = None  # type: ignore[assignment]

        with patch.object(main, "get_pending_captures", return_value=[]):
            # get_default_user_id is called when user_id=None; skip DB by passing explicit id
            out = asyncio.run(main.sweep_pending_once(user_id=152))

        # Branch must have run: sentinels replaced with real callables
        assert main.build_capture_input_from_db is not None, (
            "lazy-import branch did not populate build_capture_input_from_db"
        )
        assert main.update_pages_from_response is not None, (
            "lazy-import branch did not populate update_pages_from_response"
        )
        # Sanity: empty pending list -> zero counts
        assert out["captures_seen"] == 0
        assert out["processed"] == 0
    finally:
        main.build_capture_input_from_db = orig_bicfdb
        main.update_pages_from_response = orig_upfr


def test_sweep_pending_once_skips_the_demo_account():
    fetch = MagicMock()
    with (
        patch("backend.db.auth_repo.get_role", return_value="demo"),
        patch.object(main, "get_pending_captures", new=fetch),
    ):
        out = asyncio.run(main.sweep_pending_once(user_id=152))
    fetch.assert_not_called()
    assert out["skipped"] == "demo"
    assert out["captures_seen"] == out["processed"] == out["failed"] == 0


def _run_startup_sweep(role):
    recluster = MagicMock(side_effect=lambda uid: _async(None))
    real_sleep = asyncio.sleep

    async def _fast_sleep(_):
        await real_sleep(0)

    with (
        patch("backend.db.auth_repo.get_role", return_value=role),
        patch.object(main, "get_default_user_id", return_value=152),
        patch.object(main, "get_pending_captures", return_value=[]),
        patch.object(main, "_maybe_recluster", new=recluster),
        patch.object(main.asyncio, "sleep", new=_fast_sleep),
    ):
        asyncio.run(main._sweep_pending_captures())
    return recluster


def test_startup_sweep_does_not_recluster_the_demo_account():
    _run_startup_sweep("demo").assert_not_called()


def test_startup_sweep_still_reclusters_a_regular_user():
    # (c) the non-demo path; the three tests above also run it end to end
    # (a missing user row reads as role "user").
    _run_startup_sweep("user").assert_called_once_with(152)


async def _async(v):
    return v
