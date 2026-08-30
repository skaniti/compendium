"""Sensitive-skip retention carve-out + boilerplate-aware snippet builder.

Covers backend/utils/skip_retention.py and its wiring into
process_captures._persist_single_page (retain-skipped-pages plan; Finding 1).
"""

from types import SimpleNamespace
from unittest.mock import patch

from backend import process_captures
from backend.utils.skip_retention import build_row_snippet, should_redact_snippet

# ── should_redact_snippet ────────────────────────────────────────────────


def test_redacts_on_sensitive_reason_text():
    assert should_redact_snippet("banking dashboard behind login")
    assert should_redact_snippet("Personal medical records page")
    assert should_redact_snippet("private conversation thread")
    assert should_redact_snippet("email account inbox view")


def test_keeps_on_shape_only_reasons():
    assert not should_redact_snippet("disambiguation page")
    assert not should_redact_snippet("login wall")  # shape, not content
    assert not should_redact_snippet("content-free stub")
    assert not should_redact_snippet(None)
    assert not should_redact_snippet("")


def test_threat_category_wins_over_reason():
    # Future gate versions: explicit category takes precedence both ways.
    assert should_redact_snippet("disambiguation page", threat_category="sensitive_content")
    assert should_redact_snippet(None, threat_category="borderline_sensitive")
    assert not should_redact_snippet("banking dashboard", threat_category="empty_page")


# ── build_row_snippet (Finding 1) ────────────────────────────────────────

_BOILERPLATE = "Page browsed outside API tool scope for 42 seconds"


def test_boilerplate_summary_does_not_mask_extracted_text():
    page = {
        "content_summary": _BOILERPLATE,
        "content_extracted_text": "actual conversation content " * 10,
    }
    snip = build_row_snippet(page)
    assert snip.startswith("actual conversation content")


def test_real_summary_is_preferred():
    page = {
        "content_summary": "A real summary of the page",
        "content_extracted_text": "longer body",
    }
    assert build_row_snippet(page) == "A real summary of the page"


def test_boilerplate_only_yields_empty():
    assert build_row_snippet({"content_summary": _BOILERPLATE}) == ""


def test_snippet_truncates():
    page = {"content_extracted_text": "x" * 2000}
    assert len(build_row_snippet(page, max_len=500)) == 500


# ── _persist_single_page wiring ──────────────────────────────────────────


def _result(reason, summary="some summary"):
    return SimpleNamespace(
        url="https://example.com/x",
        status="success",
        processing_depth="skipped",
        processing_depth_reasoning=reason,
        content_summary=summary,
        tool_selected="web_fetch",
        cost_usd=None,
        input_tokens=None,
        output_tokens=None,
        latency_ms=None,
        is_learning=None,
        page_content_id=None,
    )


def _response(url="https://example.com/x"):
    return SimpleNamespace(
        fetched_contents={url: {"full_text": "fetched body text " * 5}},
        raw_html_artifacts={},
    )


def _run_persist(result):
    page_row = {"id": 7, "url": result.url, "extracted_text": "ext text"}
    with (
        patch.object(process_captures.page_repo, "update_page_status") as upd,
        patch.object(process_captures.page_repo, "redact_page_extracted_text") as redact,
        patch.object(process_captures.content_repo, "get_or_create_content") as goc,
    ):
        goc.return_value = {"id": 99}
        process_captures._persist_single_page(page_row, result, _response())
    return upd, redact, goc


def test_sensitive_skip_is_redacted():
    upd, redact, goc = _run_persist(_result("banking dashboard behind a login"))
    goc.assert_not_called()  # no page_content row for sensitive skips
    redact.assert_called_once_with(7)
    kwargs = upd.call_args.kwargs
    assert kwargs["content_summary"] == "[redacted: sensitive-skip retention carve-out]"
    assert kwargs["page_content_id"] is None
    assert kwargs["skip_reasoning"] == "banking dashboard behind a login"  # verdict survives


def test_shape_skip_retains_content():
    upd, redact, goc = _run_persist(_result("disambiguation page"))
    goc.assert_called_once()  # content retained for non-sensitive skips
    redact.assert_not_called()
    kwargs = upd.call_args.kwargs
    assert kwargs["content_summary"] == "some summary"
    assert kwargs["page_content_id"] == 99
