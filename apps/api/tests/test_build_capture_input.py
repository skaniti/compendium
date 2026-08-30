"""build_capture_input_from_db: defensive truncation of oversize fields.

Legacy / passive-mobile rows can carry a page title far longer than the
PageVisit.title max_length (500). Reprocessing such a capture must not abort
on validation -- the title is clamped, mirroring the existing extracted_text
truncation in the same function.
"""
import datetime as dt
from unittest.mock import patch

from backend import process_captures


def _cap() -> dict:
    return {
        "id": 1,
        "capture_id": "c1",
        "started_at": dt.datetime(2026, 6, 20, 12, 0, 0),
        "ended_at": dt.datetime(2026, 6, 20, 12, 5, 0),
    }


def _page(**over) -> dict:
    p = {
        "url": "https://example.test/a",
        "visited_at": None,
        "dwell_time_seconds": None,
        "title": "Short title",
        "is_tracked_domain": True,
        "transition_type": None,
        "transition_qualifiers": None,
        "extracted_text": None,
    }
    p.update(over)
    return p


def test_oversize_title_is_truncated_to_500():
    page = _page(title="x" * 600)
    with patch.object(process_captures.page_repo, "get_pages_for_capture", return_value=[page]):
        ci = process_captures.build_capture_input_from_db(_cap())
    assert len(ci.pages[0].title) == 500


def test_normal_title_is_unchanged():
    page = _page(title="A perfectly normal page title")
    with patch.object(process_captures.page_repo, "get_pages_for_capture", return_value=[page]):
        ci = process_captures.build_capture_input_from_db(_cap())
    assert ci.pages[0].title == "A perfectly normal page title"
