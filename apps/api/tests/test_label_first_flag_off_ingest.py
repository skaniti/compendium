"""Flag-off proof: without ``label_first_enabled`` the ingest path never touches the labeller.

The labeller is imported lazily inside the flag branch of
``process_captures.update_pages_from_response``. A ``None`` entry in
``sys.modules`` makes any import of it raise, so a flag-off run that completes
proves it was never imported; a recording stand-in module proves the flag-on
path does reach it and stays fail-open.
"""

import sys
from types import ModuleType, SimpleNamespace
from unittest.mock import patch

import pytest

from backend import process_captures
from backend.config.settings import settings
from backend.models.capture import PageProcessingResult

LABELLER = "backend.services.page_labeller"
SHELF = "backend.services.shelf_service"


def _install_shelf(monkeypatch, module):
    """Make ``from backend.services import shelf_service`` resolve to ``module``.

    ``from package import submodule`` reads the attribute on the package before
    ``sys.modules``, so once the real module has been imported anywhere in the
    process a ``sys.modules`` patch alone is ignored. Patch both. ``None``
    makes the import fail, as if the module were absent.
    """
    import backend.services as services_pkg

    monkeypatch.setitem(sys.modules, SHELF, module)
    if module is None:
        monkeypatch.delattr(services_pkg, "shelf_service", raising=False)
    else:
        monkeypatch.setattr(services_pkg, "shelf_service", module, raising=False)


@pytest.fixture(autouse=True)
def _no_real_shelf_service(monkeypatch):
    """Default: a no-op shelf service, so no test reaches the real one (and its DB)."""
    stub = ModuleType(SHELF)
    stub.assign_new_labels = lambda user_id, ids: {}
    _install_shelf(monkeypatch, stub)


def _result(url, content_id=None, **kw):
    r = PageProcessingResult(url=url, status="success", content_summary=f"summary of {url}", **kw)
    r._cid = content_id
    return r


def _row(pid, url):
    from backend.utils.url_normalize import normalize_url

    return {"id": pid, "url": url, "normalized_url": normalize_url(url)}


def _run(results, rows, monkeypatch):
    response = SimpleNamespace(
        capture_id="cap_x", results=results, capture_title="t", mini_summary="s"
    )

    def fake_persist(page_row, result, _response):
        if getattr(result, "_cid", None) is not None:
            result.page_content_id = result._cid

    with (
        patch.object(process_captures.page_repo, "get_pages_for_capture", return_value=rows),
        patch.object(process_captures, "_persist_single_page", side_effect=fake_persist),
        patch.object(process_captures.capture_repo, "update_capture"),
        patch.object(process_captures.capture_repo, "get_capture", return_value={"user_id": 7}),
    ):
        return process_captures.update_pages_from_response(1, response)


URLS = [f"https://example.test/p{i}" for i in range(1, 5)]


def test_flag_defaults_off():
    assert settings.label_first_enabled is False


def test_flag_off_never_imports_or_calls_labeller(monkeypatch):
    monkeypatch.setattr(settings, "label_first_enabled", False)
    # Any import of these raises (ImportError) -- a flag-off run must not try.
    monkeypatch.setitem(sys.modules, LABELLER, None)
    _install_shelf(monkeypatch, None)
    results = [_result(u, content_id=100 + i) for i, u in enumerate(URLS[:3])]
    rows = [_row(10 + i, u) for i, u in enumerate(URLS[:3])]
    assert _run(results, rows, monkeypatch) == 0


def test_flag_off_does_not_load_labeller_module_fresh(monkeypatch):
    monkeypatch.setattr(settings, "label_first_enabled", False)
    monkeypatch.delitem(sys.modules, LABELLER, raising=False)
    _run([_result(URLS[0], 100)], [_row(10, URLS[0])], monkeypatch)
    assert LABELLER not in sys.modules


def _fake_labeller(calls, raises=None):
    mod = ModuleType(LABELLER)

    async def label_content_ids(content_ids, *, user_id):
        calls.append((list(content_ids), user_id))
        if raises:
            raise raises
        return SimpleNamespace()

    import backend.services.page_labeller as real

    mod.label_content_ids = label_content_ids
    mod.run_coro_blocking = real.run_coro_blocking
    return mod


def test_flag_on_labels_deduped_persisted_content_only(monkeypatch):
    monkeypatch.setattr(settings, "label_first_enabled", True)
    _install_shelf(monkeypatch, None)  # shelf branch absent: tolerated
    calls = []
    monkeypatch.setattr(
        "backend.services.page_labeller.label_content_ids", _fake_labeller(calls).label_content_ids
    )
    results = [
        _result(URLS[0], 100),
        _result(URLS[1], 100),  # same content row
        _result(URLS[2], None),  # redacted / no content row
        _result(URLS[3], 103, processing_depth="skipped"),  # skip-gate archive
    ]
    rows = [_row(10 + i, u) for i, u in enumerate(URLS)]
    assert _run(results, rows, monkeypatch) == 0
    assert calls == [([100], 7)]


def test_flag_on_is_fail_open(monkeypatch, caplog):
    monkeypatch.setattr(settings, "label_first_enabled", True)
    calls = []

    async def boom(content_ids, *, user_id):
        calls.append(1)
        raise RuntimeError("model down")

    monkeypatch.setattr("backend.services.page_labeller.label_content_ids", boom)
    with caplog.at_level("ERROR"):
        errors = _run([_result(URLS[0], 100)], [_row(10, URLS[0])], monkeypatch)
    assert errors == 0 and calls == [1]


def test_flag_on_inside_running_loop_runs_off_the_loop_thread(monkeypatch):
    """The hook is sync but main.py calls it from async code: it must not block that loop."""
    import asyncio
    import threading

    monkeypatch.setattr(settings, "label_first_enabled", True)
    seen = {}
    release = threading.Event()

    async def label(content_ids, *, user_id):
        seen["label_thread"] = threading.get_ident()
        seen["label_started"] = True
        release.wait(5)  # a slow model call: the caller must not be waiting for it
        seen["calls"] = (list(content_ids), user_id)
        return SimpleNamespace()

    monkeypatch.setattr("backend.services.page_labeller.label_content_ids", label)
    shelf = ModuleType(SHELF)

    def assign(user_id, ids):
        seen["shelf_thread"] = threading.get_ident()
        return {}

    shelf.assign_new_labels = assign
    _install_shelf(monkeypatch, shelf)

    async def go():
        loop_thread = threading.get_ident()
        errors = _run([_result(URLS[0], 100)], [_row(10, URLS[0])], monkeypatch)
        returned_before_labelling_finished = "calls" not in seen
        release.set()
        await process_captures.drain_label_hooks()
        return loop_thread, errors, returned_before_labelling_finished

    loop_thread, errors, returned_early = asyncio.run(go())
    assert errors == 0 and returned_early
    assert seen["calls"] == ([100], 7)
    assert seen["label_thread"] != loop_thread and seen["shelf_thread"] != loop_thread


def test_flag_on_without_a_loop_runs_inline(monkeypatch):
    monkeypatch.setattr(settings, "label_first_enabled", True)
    calls = []
    monkeypatch.setattr(
        "backend.services.page_labeller.label_content_ids", _fake_labeller(calls).label_content_ids
    )
    assert _run([_result(URLS[0], 100)], [_row(10, URLS[0])], monkeypatch) == 0
    assert calls == [([100], 7)]


def test_flag_on_calls_shelf_service_when_present(monkeypatch):
    monkeypatch.setattr(settings, "label_first_enabled", True)
    monkeypatch.setattr(
        "backend.services.page_labeller.label_content_ids", _fake_labeller([]).label_content_ids
    )
    seen = []
    shelf = ModuleType(SHELF)
    shelf.assign_new_labels = lambda user_id, ids: seen.append((user_id, ids)) or {}
    _install_shelf(monkeypatch, shelf)
    _run([_result(URLS[0], 100)], [_row(10, URLS[0])], monkeypatch)
    assert seen == [(7, [100])]


def test_no_labeller_attribute_on_process_captures():
    """Lazy import: process_captures holds no module-level reference to the labeller."""
    assert not hasattr(process_captures, "page_labeller")


def test_hook_has_no_whole_hook_timeout(monkeypatch):
    """A slow labelling call is not cancelled (that would drop finished requests' labels)."""
    import asyncio

    assert not hasattr(process_captures, "_LABEL_HOOK_TIMEOUT_S")
    monkeypatch.setattr(settings, "label_first_enabled", True)
    done = []

    async def label(content_ids, *, user_id):
        await asyncio.sleep(0.2)
        done.append(list(content_ids))
        return SimpleNamespace()

    monkeypatch.setattr("backend.services.page_labeller.label_content_ids", label)
    assert _run([_result(URLS[0], 100)], [_row(10, URLS[0])], monkeypatch) == 0
    assert done == [[100]]
