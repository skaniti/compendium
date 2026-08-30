"""Tests for backend.services.chat_importer.extractor."""
from __future__ import annotations

from datetime import datetime, timezone

from backend.services.chat_importer.extractor import (
    extract_claims_from_conversation,
    extract_claims_from_message,
)
from backend.services.chat_importer.schema import (
    NormalizedConversation,
    NormalizedMessage,
)

_TEST_DATE = datetime(2026, 1, 1, tzinfo=timezone.utc)


def _msg(text: str, role: str = "assistant", message_id: str = "msg-1") -> NormalizedMessage:
    return NormalizedMessage(
        message_id=message_id,
        conversation_id="conv-1",
        role=role,  # type: ignore[arg-type]
        text=text,
    )


def _claims(text: str, role: str = "assistant"):
    return extract_claims_from_message(_msg(text, role=role), "Test", _TEST_DATE)


def test_url_in_paragraph_extracted():
    claims = _claims("Check out https://example.com for details.")
    assert len(claims) == 1
    assert claims[0].citation_url == "https://example.com"
    assert "details" in claims[0].claim_text


def test_url_in_code_block_excluded():
    text = (
        "Here's a snippet:\n"
        "```python\n"
        "requests.get('https://api.example.com')\n"
        "```\n"
        "That's it."
    )
    claims = _claims(text)
    urls = [c.citation_url for c in claims]
    assert "https://api.example.com" not in urls


def test_url_outside_code_block_kept():
    text = (
        "See https://before.com for context.\n\n"
        "```\nirrelevant code\n```\n\n"
        "Then https://after.com explains it."
    )
    claims = _claims(text)
    urls = [c.citation_url for c in claims]
    assert "https://before.com" in urls
    assert "https://after.com" in urls


def test_markdown_link_format():
    claims = _claims("See the [Python docs](https://docs.python.org/3/) for more.")
    assert len(claims) == 1
    assert claims[0].citation_url == "https://docs.python.org/3/"


def test_multiple_urls_per_paragraph():
    claims = _claims("Compare https://foo.com and https://bar.com.")
    urls = [c.citation_url for c in claims]
    assert urls == ["https://foo.com", "https://bar.com"]
    assert claims[0].paragraph_idx == claims[1].paragraph_idx


def test_paragraph_idx_increments():
    text = (
        "First para has https://a.com.\n\n"
        "Second para has https://b.com.\n\n"
        "Third para has https://c.com."
    )
    claims = _claims(text)
    assert [c.citation_url for c in claims] == [
        "https://a.com",
        "https://b.com",
        "https://c.com",
    ]
    assert [c.paragraph_idx for c in claims] == [0, 1, 2]


def test_trailing_punctuation_stripped():
    claims = _claims("See https://example.com.")
    assert claims[0].citation_url == "https://example.com"


def test_url_inside_parens_stripped():
    """Parens-wrapped URL ends at )."""
    claims = _claims("Reference (https://example.com) is interesting.")
    assert claims[0].citation_url == "https://example.com"


def test_dedup_within_paragraph():
    """Same URL repeated within one paragraph yields one claim."""
    claims = _claims("See https://x.com and again https://x.com.")
    assert len(claims) == 1


def test_dedup_across_paragraphs_keeps_both():
    """Same URL in different paragraphs yields one claim per paragraph."""
    text = "Para 1 with https://x.com.\n\nPara 2 also https://x.com."
    claims = _claims(text)
    assert len(claims) == 2
    assert {c.paragraph_idx for c in claims} == {0, 1}


def test_role_filter_skips_system():
    assert _claims("Has https://example.com.", role="system") == []


def test_role_filter_skips_tool():
    assert _claims("Has https://example.com.", role="tool") == []


def test_role_filter_includes_user():
    """User messages with URLs ARE extracted (with role=user for trust weighting)."""
    claims = _claims("Check this out: https://example.com", role="user")
    assert len(claims) == 1
    assert claims[0].message_role == "user"


def test_extract_from_conversation_walks_messages():
    msgs = [
        _msg("User msg with https://q.com", role="user", message_id="m1"),
        _msg("Assistant msg with https://a.com", role="assistant", message_id="m2"),
        _msg("System msg with https://skip.com", role="system", message_id="m3"),
    ]
    conv = NormalizedConversation(
        conversation_id="c1",
        title="t",
        create_time=_TEST_DATE,
        messages=msgs,
    )
    claims = extract_claims_from_conversation(conv)
    assert {c.message_id for c in claims} == {"m1", "m2"}


def test_no_url_no_claims():
    assert _claims("Pure thinking with no URLs.") == []


def test_provenance_fields_set():
    msg = NormalizedMessage(
        message_id="msg-x",
        conversation_id="conv-y",
        role="assistant",
        text="See https://example.com.",
        model_slug="gpt-5-thinking",
    )
    claims = extract_claims_from_message(msg, "Custom Title", _TEST_DATE)
    assert claims[0].chat_title == "Custom Title"
    assert claims[0].chat_create_time == _TEST_DATE
    assert claims[0].model_slug == "gpt-5-thinking"
    assert claims[0].message_role == "assistant"
    assert claims[0].conversation_id == "conv-y"
    assert claims[0].message_id == "msg-x"


def test_unverified_fields_default_to_none():
    """Pre-verification: verification_level, trust_tier, normalized_citation_url are None."""
    claims = _claims("See https://example.com.")
    assert claims[0].verification_level is None
    assert claims[0].trust_tier is None
    assert claims[0].normalized_citation_url is None


def test_url_at_end_of_string_no_punct():
    """URL with no surrounding text extracts cleanly."""
    claims = _claims("Just https://example.com")
    assert claims[0].citation_url == "https://example.com"


def test_http_scheme_supported():
    """http:// URLs (not just https://) are extracted."""
    claims = _claims("Old link: http://example.org/page")
    assert claims[0].citation_url == "http://example.org/page"
