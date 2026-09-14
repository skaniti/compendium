"""Stage-0 claude.ai app-chrome denylist + placeholder-persist policy.

Covers the RC-A (claude.ai chrome junk) and RC-D (placeholder purge) fixes
from the 2026-07-17 dq-queue-executive-triage plan (private):
- backend/api/main.py: `_is_skip_url` gains a claude.ai chrome-path denylist
  (Stage-0, pre-LLM). `/chat/<uuid>` transcripts must stay capturable.
- backend/process_captures.py: `_persist_single_page` archives results whose
  content_summary is the untracked-domain catchall placeholder ("Page
  browsed outside API tool scope for N seconds") instead of persisting them
  active.
"""

from types import SimpleNamespace
from unittest.mock import patch

import backend.api.main as main
from backend import process_captures

# ── _is_skip_url: claude.ai app chrome ──────────────────────────────────


def test_claude_ai_root_is_skipped():
    assert main._is_skip_url("claude.ai", "https://claude.ai/")
    assert main._is_skip_url("claude.ai", "https://claude.ai")


def test_claude_ai_chrome_paths_are_skipped():
    chrome_paths = [
        "/new",
        "/recents",
        "/settings",
        "/projects",
        "/downloads",
        "/login",
        "/logout",
        "/oauth",
        "/magic-link",
    ]
    for path in chrome_paths:
        url = f"https://claude.ai{path}"
        assert main._is_skip_url("claude.ai", url), f"expected skip for {url}"


def test_claude_ai_chrome_path_prefixes_are_skipped():
    # Prefix semantics: sub-paths under a chrome path are also chrome.
    assert main._is_skip_url("claude.ai", "https://claude.ai/settings/appearance")
    assert main._is_skip_url("claude.ai", "https://claude.ai/projects/abc-123")


def test_claude_ai_www_hostname_is_covered():
    assert main._is_skip_url("www.claude.ai", "https://www.claude.ai/new")
    assert main._is_skip_url("www.claude.ai", "https://www.claude.ai/settings")


def test_claude_ai_chat_transcripts_are_not_skipped():
    assert not main._is_skip_url("claude.ai", "https://claude.ai/chat/abc-123")
    assert not main._is_skip_url("www.claude.ai", "https://www.claude.ai/chat/abc-123")


def test_claude_ai_lookalike_paths_are_not_falsely_prefix_matched():
    # "/new" must not swallow paths that merely start with the same letters.
    assert not main._is_skip_url("claude.ai", "https://claude.ai/newsletter")


def test_chrome_like_paths_on_other_domains_are_not_skipped():
    assert not main._is_skip_url("example.com", "https://example.com/settings")
    assert not main._is_skip_url("chat.openai.com", "https://chat.openai.com/new")


# ── _is_skip_url: pre-existing SKIP_URL_PATTERNS regression ─────────────


def test_google_maps_still_skipped():
    assert main._is_skip_url("www.google.com", "https://www.google.com/maps/place/x")


def test_reddit_listing_still_skipped_but_comments_not():
    assert main._is_skip_url("www.reddit.com", "https://www.reddit.com/r/python/")
    assert not main._is_skip_url(
        "www.reddit.com", "https://www.reddit.com/r/python/comments/abc123/title/"
    )


def test_github_blob_still_skipped():
    assert main._is_skip_url("github.com", "https://github.com/org/repo/blob/main/x.py")


# ── _persist_single_page: placeholder persist policy ─────────────────────


def _result(status, processing_depth, summary, reasoning=None):
    return SimpleNamespace(
        url="https://example.com/x",
        status=status,
        processing_depth=processing_depth,
        processing_depth_reasoning=reasoning,
        content_summary=summary,
        tool_selected=None,
        cost_usd=None,
        input_tokens=None,
        output_tokens=None,
        latency_ms=None,
        is_learning=None,
        page_content_id=None,
    )


def _response(url="https://example.com/x"):
    return SimpleNamespace(fetched_contents={}, raw_html_artifacts={})


def _run_persist(result):
    page_row = {"id": 7, "url": result.url, "extracted_text": None}
    with (
        patch.object(process_captures.page_repo, "update_page_status") as upd,
        patch.object(process_captures.page_repo, "redact_page_extracted_text") as redact,
        patch.object(process_captures.content_repo, "get_or_create_content") as goc,
    ):
        goc.return_value = {"id": 99}
        process_captures._persist_single_page(page_row, result, _response())
    return upd, redact, goc


def test_placeholder_summary_persists_as_archived():
    result = _result(
        "catchall",
        "processed",
        "Page browsed outside API tool scope for 42 seconds",
    )
    upd, redact, goc = _run_persist(result)
    kwargs = upd.call_args.kwargs
    assert upd.call_args.args[1] == "archived"
    assert kwargs["archive_reason"] == "placeholder_no_content"
    redact.assert_not_called()  # placeholder purge is not the sensitive-skip path


def test_normal_catchall_summary_persists_as_active():
    result = _result("catchall", "processed", "A real page about topic X")
    upd, redact, goc = _run_persist(result)
    kwargs = upd.call_args.kwargs
    assert upd.call_args.args[1] == "active"
    assert kwargs["archive_reason"] is None


def test_stage0_domain_skip_still_archives_with_domain_skip_reason():
    result = _result(
        "skipped",
        "skipped",
        "Domain skipped: localhost",
    )
    upd, redact, goc = _run_persist(result)
    kwargs = upd.call_args.kwargs
    assert upd.call_args.args[1] == "archived"
    assert kwargs["archive_reason"] == "domain_skip"
