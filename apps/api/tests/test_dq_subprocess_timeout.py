"""Watchdog enforcement for the DQ subprocess timeout (Task F1).

`DQ_SUBPROCESS_TIMEOUT_SEC` was defined but never enforced: `_run_single_pass`
streamed the `claude -p` subprocess stdout line-by-line with no overall
deadline (the only wait was `proc.wait(timeout=30)` AFTER stdout closed). A
child that hangs with stdout open/idle blocked the readline loop forever,
leaving the DQ run stuck in 'running'. A `threading.Timer` watchdog now kills
the subprocess at the deadline.

Test seam: `_run_single_pass(cmd, prompt, on_event, on_subprocess_start)`
already takes `cmd` as a parameter, so no extraction is needed -- the test
drives the real method directly with a hung command and `on_event=None`,
bypassing the file-reading `__init__` via `__new__`.

Behavioral contract: a hung subprocess is killed well under its own sleep
time, returns non-zero, and `saw_result` is False.
"""

import sys
import time

import backend.services.dq_agent as dq


def test_run_single_pass_kills_hung_subprocess(monkeypatch):
    # Shrink the deadline so the test is fast and deterministic.
    monkeypatch.setattr(dq, "DQ_SUBPROCESS_TIMEOUT_SEC", 1)

    # Bypass the file-reading __init__; _run_single_pass only touches `self`
    # through the on_subprocess_start/on_event callbacks, both passed as None.
    agent = dq.DQAgent.__new__(dq.DQAgent)

    # A child that sleeps far longer than the timeout and never writes to /
    # closes stdout: without the watchdog the readline loop blocks for ~30s.
    hung_cmd = [sys.executable, "-c", "import time; time.sleep(30)"]

    t0 = time.perf_counter()
    result = agent._run_single_pass(
        hung_cmd,
        prompt="x",
        on_event=None,
        on_subprocess_start=None,
    )
    elapsed = time.perf_counter() - t0

    # Killed promptly at the ~1s deadline, not after the child's 30s sleep.
    assert elapsed < 10, f"call took {elapsed:.1f}s; watchdog did not kill the child"
    assert result["returncode"] != 0
    assert result["saw_result"] is False
