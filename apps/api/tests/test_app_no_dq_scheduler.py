"""The app no longer owns a DQ scheduler -- the worker does."""

import backend.api.main as main


def test_main_does_not_reference_start_dq_scheduler():
    import inspect

    src = inspect.getsource(main)
    assert "start_dq_scheduler" not in src, (
        "app lifespan must not start the DQ scheduler; the dq_worker owns it now"
    )
