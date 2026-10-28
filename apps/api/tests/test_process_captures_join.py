"""update_pages_from_response pairs DB rows with results by page identity.

``insert_pages`` collapses consecutive duplicate visits, so a capture can have
fewer DB rows than request pages; pairing by position then wrote each later
page the content of its neighbour. These tests pin identity-based pairing.
"""

import logging
from types import SimpleNamespace
from unittest.mock import patch

from backend import process_captures
from backend.models.capture import PageProcessingResult

URLS = [f"https://example.test/p{i}" for i in range(1, 5)]


def _result(url):
    return PageProcessingResult(url=url, status="success", content_summary=f"summary of {url}")


def _row(pid, url, normalized=True):
    from backend.utils.url_normalize import normalize_url

    row = {"id": pid, "url": url}
    if normalized:
        row["normalized_url"] = normalize_url(url)
    return row


def _run(rows, results, archived=None):
    """Run update_pages_from_response; return {page_id: result.url} persisted.

    Pass a dict as ``archived`` to collect {page_id: reason} from archive_page.
    """
    response = SimpleNamespace(
        capture_id="cap_x", results=results, capture_title="t", mini_summary="s"
    )
    persisted = {}
    archived = {} if archived is None else archived

    def fake_persist(page_row, result, _response):
        persisted[page_row["id"]] = result.url

    def fake_archive(page_id, reason):
        archived[page_id] = reason

    with (
        patch.object(process_captures.page_repo, "get_pages_for_capture", return_value=rows),
        patch.object(process_captures.page_repo, "archive_page", side_effect=fake_archive),
        patch.object(process_captures, "_persist_single_page", side_effect=fake_persist),
        patch.object(process_captures.capture_repo, "update_capture"),
    ):
        errors = process_captures.update_pages_from_response(1, response)
    return persisted, errors


def test_collapsed_rows_get_their_own_url():
    # Request had 4 pages; pages 2 and 3 (same URL) were collapsed into one row.
    request = [URLS[0], URLS[1], URLS[1], URLS[2]]
    rows = [_row(10, URLS[0]), _row(11, URLS[1]), _row(12, URLS[2])]
    persisted, errors = _run(rows, [_result(u) for u in request])
    assert persisted == {10: URLS[0], 11: URLS[1], 12: URLS[2]}
    assert errors == 0


def test_row_order_differs_from_result_order():
    rows = [_row(10, URLS[2]), _row(11, URLS[0]), _row(12, URLS[1])]
    persisted, _ = _run(rows, [_result(u) for u in URLS[:3]])
    assert persisted == {10: URLS[2], 11: URLS[0], 12: URLS[1]}


def test_unmatched_result_skipped_and_logged(caplog):
    rows = [_row(10, URLS[0])]
    with caplog.at_level(logging.INFO, logger="backend.process_captures"):
        persisted, errors = _run(rows, [_result(URLS[0]), _result(URLS[3])])
    assert persisted == {10: URLS[0]}
    assert errors == 0
    assert any(URLS[3] in r.getMessage() and r.levelno == logging.INFO for r in caplog.records)


def test_unmatched_row_archived_not_written_and_warned(caplog):
    # A row with no result would get no result on any retry either; leaving it
    # pending made the hourly sweep re-process its whole capture forever.
    rows = [_row(10, URLS[0]), _row(11, URLS[1])]
    archived = {}
    with caplog.at_level(logging.INFO, logger="backend.process_captures"):
        persisted, errors = _run(rows, [_result(URLS[0])], archived=archived)
    assert persisted == {10: URLS[0]}
    assert archived == {11: "no_pipeline_result"}
    assert errors == 1
    assert any(r.levelno == logging.WARNING and "id=11" in r.getMessage() for r in caplog.records)


def test_archive_failure_for_unmatched_row_does_not_abort(caplog):
    rows = [_row(10, URLS[0]), _row(11, URLS[1])]
    response = SimpleNamespace(
        capture_id="cap_x", results=[_result(URLS[0])], capture_title="t", mini_summary="s"
    )
    persisted = {}
    with (
        patch.object(process_captures.page_repo, "get_pages_for_capture", return_value=rows),
        patch.object(
            process_captures.page_repo, "archive_page", side_effect=RuntimeError("db down")
        ),
        patch.object(
            process_captures,
            "_persist_single_page",
            side_effect=lambda row, res, _r: persisted.update({row["id"]: res.url}),
        ),
        patch.object(process_captures.capture_repo, "update_capture"),
    ):
        errors = process_captures.update_pages_from_response(1, response)
    assert persisted == {10: URLS[0]}
    assert errors == 1


def test_revisit_rows_share_last_result_and_pair_in_order():
    # Two rows for one URL (revisit outside the collapse window), one result.
    rows = [_row(10, URLS[0]), _row(11, URLS[1]), _row(12, URLS[0])]
    persisted, errors = _run(rows, [_result(URLS[0]), _result(URLS[1])])
    assert persisted == {10: URLS[0], 11: URLS[1], 12: URLS[0]}
    assert errors == 0


def test_missing_normalized_url_falls_back_to_url():
    rows = [_row(10, URLS[1] + "#frag", normalized=False), _row(11, URLS[0], normalized=False)]
    persisted, _ = _run(rows, [_result(URLS[0]), _result(URLS[1])])
    assert persisted == {10: URLS[1], 11: URLS[0]}


def test_one_to_one_happy_path_unchanged():
    rows = [_row(10 + i, u) for i, u in enumerate(URLS)]
    persisted, errors = _run(rows, [_result(u) for u in URLS])
    assert persisted == {10 + i: u for i, u in enumerate(URLS)}
    assert errors == 0


def test_persist_failure_counts_as_error():
    rows = [_row(10, URLS[0])]
    response = SimpleNamespace(
        capture_id="c", results=[_result(URLS[0])], capture_title=None, mini_summary=None
    )
    with (
        patch.object(process_captures.page_repo, "get_pages_for_capture", return_value=rows),
        patch.object(process_captures, "_persist_single_page", side_effect=RuntimeError("x")),
        patch.object(process_captures, "_log_page_error"),
        patch.object(process_captures.capture_repo, "update_capture"),
    ):
        assert process_captures.update_pages_from_response(1, response) == 1


def test_stale_stored_normalized_url_still_pairs():
    # A row's stored normalized_url can predate a normalizer change (here the
    # old rules kept github's ?tab= param). Keying rows by that stale column
    # while results are keyed by today's normalize_url left the row unmatched
    # and pending forever, so the hourly sweep re-processed its capture.
    url = "https://github.com/example-user?tab=repositories"
    row = {"id": 10, "url": url, "normalized_url": url}
    persisted, errors = _run([row], [_result(url)])
    assert persisted == {10: url}
    assert errors == 0
