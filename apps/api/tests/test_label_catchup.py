"""Nightly label catch-up: flag off does nothing; flag on labels a bounded batch, fail-open."""

from types import SimpleNamespace

from backend.services import page_labeller
from tests.test_shelf_weekly_flag_off import _run_nightly, boom


def _cfg(**over):
    base = dict(label_first_enabled=True, label_catchup_limit=5, label_batch_size=8)
    base.update(over)
    return SimpleNamespace(**base)


def _patch_labeller(monkeypatch, ids, runs):
    seen = {"unlabelled_args": None, "labelled_chunks": []}

    def unlabelled(version, user_id=None, limit=None, only_active=True):
        seen["unlabelled_args"] = (version, user_id, limit, only_active)
        return list(ids)

    async def label(content_ids, *, user_id):
        seen["labelled_chunks"].append((list(content_ids), user_id))
        return runs.pop(0)

    monkeypatch.setattr("backend.db.page_label_repo.get_unlabelled_content_ids", unlabelled)
    monkeypatch.setattr(page_labeller, "label_content_ids", label)
    monkeypatch.setattr(page_labeller, "labeller_version", lambda: "m@k+abc")
    return seen


def _run_obj(n=0, cost=0.0, failed=0, error=None):
    return SimpleNamespace(
        labels={i: {} for i in range(n)}, cost_usd=cost, failed_requests=failed, error=error
    )


def test_flag_off_never_labels(monkeypatch):
    monkeypatch.setattr("backend.db.page_label_repo.get_unlabelled_content_ids", boom)
    monkeypatch.setattr(page_labeller, "label_content_ids", boom)
    for cfg in (
        SimpleNamespace(),
        SimpleNamespace(label_first_enabled=False, label_catchup_limit=9),
    ):
        assert "label_catchup" not in _run_nightly(cfg, 0)


def test_flag_on_with_limit_zero_does_nothing(monkeypatch):
    monkeypatch.setattr("backend.db.page_label_repo.get_unlabelled_content_ids", boom)
    monkeypatch.setattr(page_labeller, "label_content_ids", boom)
    assert "label_catchup" not in _run_nightly(_cfg(label_catchup_limit=0), 0)


def test_flag_on_labels_a_bounded_batch_and_sums_cost(monkeypatch):
    seen = _patch_labeller(monkeypatch, [1, 2, 3], [_run_obj(3, 0.0004)])
    notes = _run_nightly(_cfg(), 0)
    assert seen["unlabelled_args"] == ("m@k+abc", 152, 5, True)
    assert seen["labelled_chunks"] == [([1, 2, 3], 152)]
    assert notes["label_catchup"] == {
        "requested": 3,
        "labelled": 3,
        "failed_requests": 0,
        "cost_usd": 0.0004,
    }
    assert notes["cost_usd"] == 0.0004


def test_nothing_unlabelled_adds_no_note(monkeypatch):
    seen = _patch_labeller(monkeypatch, [], [])
    assert "label_catchup" not in _run_nightly(_cfg(), 0)
    assert seen["labelled_chunks"] == []


def test_large_batches_are_chunked(monkeypatch):
    ids = list(range(1, 200))
    seen = _patch_labeller(monkeypatch, ids, [_run_obj(80), _run_obj(80), _run_obj(39)])
    notes = _run_nightly(_cfg(label_catchup_limit=500), 0)
    assert [len(c) for c, _ in seen["labelled_chunks"]] == [80, 80, 39]
    assert notes["label_catchup"]["labelled"] == 199


def test_labeller_error_is_reported_and_the_run_continues(monkeypatch):
    _patch_labeller(monkeypatch, list(range(1, 200)), [_run_obj(0, error="LabellerPromptError: x")])
    notes = _run_nightly(_cfg(label_catchup_limit=500), 0)
    assert notes["label_catchup"]["error"] == "LabellerPromptError: x"
    assert "cost_usd" in notes  # the rest of the nightly still ran


def test_unexpected_exception_is_contained(monkeypatch):
    def kaboom(*a, **k):
        raise RuntimeError("db down")

    monkeypatch.setattr("backend.db.page_label_repo.get_unlabelled_content_ids", kaboom)
    monkeypatch.setattr(page_labeller, "labeller_version", lambda: "v")
    notes = _run_nightly(_cfg(), 0)
    assert "RuntimeError" in notes["label_catchup"]["error"] and "cost_usd" in notes


def test_catchup_waits_for_ingest_hooks_queued_by_the_sweep(monkeypatch):
    """The sweep's hooks label the same pages; the catch-up must not race them."""
    import asyncio
    import threading

    from backend import process_captures
    from backend.services import nightly_maintenance as nm

    order = []
    release = threading.Event()
    monkeypatch.setattr(nm, "settings", _cfg())

    def unlabelled(version, user_id=None, limit=None, only_active=True):
        order.append("catchup_query")
        return []

    monkeypatch.setattr("backend.db.page_label_repo.get_unlabelled_content_ids", unlabelled)
    monkeypatch.setattr(page_labeller, "labeller_version", lambda: "v")

    async def go():
        loop = asyncio.get_running_loop()

        def hook():
            release.wait(5)
            order.append("hook_done")

        fut = loop.run_in_executor(None, hook)
        process_captures._label_futures.add(fut)
        fut.add_done_callback(process_captures._label_futures.discard)
        task = asyncio.create_task(nm._maybe_label_catchup(152))
        await asyncio.sleep(0.1)
        assert order == []  # still waiting on the hook
        release.set()
        await task

    asyncio.run(go())
    assert order == ["hook_done", "catchup_query"]


def test_catchup_drain_is_bounded(monkeypatch):
    import asyncio

    from backend.services import nightly_maintenance as nm

    monkeypatch.setattr(nm, "settings", _cfg())
    monkeypatch.setattr(nm, "LABEL_HOOK_DRAIN_TIMEOUT_S", 0.05)

    async def stuck():
        await asyncio.sleep(10)

    monkeypatch.setattr("backend.process_captures.drain_label_hooks", stuck)
    seen = _patch_labeller(monkeypatch, [], [])
    assert asyncio.run(nm._maybe_label_catchup(152)) == {}
    assert seen["unlabelled_args"] is not None  # continued after the timeout
