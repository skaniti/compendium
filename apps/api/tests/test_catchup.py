# tests/test_catchup.py
import asyncio
from unittest.mock import patch, MagicMock
import backend.services.catchup as catchup


def test_run_catchup_backfills_chunks_targets_and_classifies():
    targets = [(10, "https://en.wikipedia.org/wiki/X", {"text": "body"})]
    with (
        patch.object(catchup, "fetch_targets", return_value=targets),
        patch.object(catchup, "get_sbert_model", return_value=MagicMock()),
        patch.object(catchup, "_detect_chunker", return_value=(lambda url, fc: [{"content": "c", "section_title": None, "token_count": 1}])),
        patch.object(catchup, "write_page", return_value=1) as wp,
        patch.object(catchup, "_classify_learning", new=_async_true),
    ):
        out = asyncio.run(catchup.run_catchup_backfills(user_id=152))
    assert out["chunked_pages"] == 1
    assert out["classified_done"] is True
    assert wp.called


def test_run_catchup_backfills_isolates_chunk_failure():
    with (
        patch.object(catchup, "fetch_targets", side_effect=RuntimeError("db down")),
        patch.object(catchup, "_classify_learning", new=_async_true),
    ):
        out = asyncio.run(catchup.run_catchup_backfills(user_id=152))
    assert out["chunked_pages"] == 0
    assert out["classified_done"] is True  # learning pass still ran


async def _async_true(user_id):
    return True
