"""Tests for backend.services.chat_importer.verifier."""
from __future__ import annotations

from datetime import datetime, timezone

import pytest

from backend.services.chat_importer.schema import ChatClaim
from backend.services.chat_importer.verifier import (
    DEFAULT_DOMAIN_ALLOWLIST,
    extract_host,
    verify_claims,
)
from backend.utils.url_normalize import normalize_url

_TEST_DATE = datetime(2026, 1, 1, tzinfo=timezone.utc)


class FakeURLLookup:
    """In-memory URLLookup for testing the cascade without a DB."""

    def __init__(
        self,
        known_normalized_urls: set[str] | None = None,
        known_domains: set[str] | None = None,
    ):
        self._urls = known_normalized_urls or set()
        self._domains = known_domains or set()
        self.url_query_count = 0
        self.domain_query_count = 0

    def known_urls(self, normalized_urls: set[str]) -> set[str]:
        self.url_query_count += 1
        return normalized_urls & self._urls

    def known_domains(self, domains: set[str]) -> set[str]:
        self.domain_query_count += 1
        return domains & self._domains


class FakeHEADChecker:
    """In-memory HEAD checker; returns True for URLs in `resolves`."""

    def __init__(self, resolves: set[str]):
        self.resolves = resolves
        self.calls: list[str] = []

    def url_resolves(self, url: str) -> bool:
        self.calls.append(url)
        return url in self.resolves


def _claim(url: str, message_id: str = "msg-1", paragraph_idx: int = 0) -> ChatClaim:
    return ChatClaim(
        conversation_id="c1",
        chat_title="t",
        chat_create_time=_TEST_DATE,
        message_id=message_id,
        message_role="assistant",
        paragraph_idx=paragraph_idx,
        claim_text=f"see {url}",
        citation_url=url,
    )


# ── extract_host ─────────────────────────────────────────────────────────


def test_extract_host_basic():
    assert extract_host("https://example.com/path") == "example.com"


def test_extract_host_strips_www():
    assert extract_host("https://www.example.com/path") == "example.com"


def test_extract_host_lowercases():
    assert extract_host("https://Example.COM/Path") == "example.com"


def test_extract_host_drops_port():
    assert extract_host("https://example.com:8080/path") == "example.com"


def test_extract_host_empty_for_invalid():
    assert extract_host("not-a-url") == ""
    assert extract_host("") == ""


def test_extract_host_subdomain_kept():
    """v1: full host (subdomain not collapsed to registered domain)."""
    assert extract_host("https://docs.python.org/3/") == "docs.python.org"


# ── verify_claims: empty / no hits ─────────────────────────────────────────


def test_empty_claims_returns_empty():
    assert verify_claims([], FakeURLLookup()) == []


def test_no_hits_drops_all_claims():
    claims = [_claim("https://random-unknown.example/page")]
    lookup = FakeURLLookup()  # nothing known
    assert verify_claims(claims, lookup) == []


# ── L3: exact URL match ──────────────────────────────────────────────────


def test_l3_hit_marks_high_trust():
    url = "https://example.com/article"
    lookup = FakeURLLookup(known_normalized_urls={normalize_url(url)})
    claims = [_claim(url)]

    result = verify_claims(claims, lookup)

    assert len(result) == 1
    assert result[0].verification_level == "L3"
    assert result[0].trust_tier == "high"
    assert result[0].normalized_citation_url == normalize_url(url)


def test_l3_hit_uses_normalized_form():
    """Tracking params and fragments don't break L3 join."""
    cited = "https://example.com/article?utm_source=chatgpt#fragment"
    user_visited_normalized = normalize_url("https://example.com/article")
    lookup = FakeURLLookup(known_normalized_urls={user_visited_normalized})

    result = verify_claims([_claim(cited)], lookup)

    assert len(result) == 1
    assert result[0].verification_level == "L3"


# ── L2: domain match ─────────────────────────────────────────────────────


def test_l2_hit_via_history_marks_medium_trust():
    """URL not in history but its domain is."""
    lookup = FakeURLLookup(known_domains={"example.com"})
    claims = [_claim("https://example.com/never-visited-page")]

    result = verify_claims(claims, lookup)

    assert len(result) == 1
    assert result[0].verification_level == "L2"
    assert result[0].trust_tier == "medium"


def test_l2_hit_via_allowlist_no_history():
    """Allowlisted domain validates even when not in user's history."""
    allowlist_domain = next(iter(DEFAULT_DOMAIN_ALLOWLIST))
    url = f"https://{allowlist_domain}/some/path"
    lookup = FakeURLLookup()  # nothing in history

    result = verify_claims([_claim(url)], lookup)

    assert len(result) == 1
    assert result[0].verification_level == "L2"


def test_l2_does_not_query_db_for_allowlisted_domain():
    """Allowlist short-circuits the domain DB query for that domain."""
    allowlist_domain = next(iter(DEFAULT_DOMAIN_ALLOWLIST))
    url = f"https://{allowlist_domain}/some/path"
    lookup = FakeURLLookup()

    verify_claims([_claim(url)], lookup)

    # known_domains should NOT have been called for the allowlisted domain alone
    assert lookup.domain_query_count == 0


def test_l3_takes_precedence_over_l2():
    """If both L3 and L2 would match, L3 wins."""
    url = "https://example.com/article"
    lookup = FakeURLLookup(
        known_normalized_urls={normalize_url(url)},
        known_domains={"example.com"},
    )
    result = verify_claims([_claim(url)], lookup)
    assert result[0].verification_level == "L3"


# ── L1: HEAD check (opt-in only) ─────────────────────────────────────────


def test_l1_disabled_by_default():
    """Even with a HEAD checker, L1 is off unless enable_l1=True."""
    head = FakeHEADChecker(resolves={"https://reachable-but-unknown.example/"})
    claims = [_claim("https://reachable-but-unknown.example/")]

    result = verify_claims(claims, FakeURLLookup(), head_checker=head)

    assert result == []
    assert head.calls == []


def test_l1_enabled_marks_low_trust():
    head = FakeHEADChecker(resolves={"https://reachable-but-unknown.example/"})
    claims = [_claim("https://reachable-but-unknown.example/")]

    result = verify_claims(
        claims, FakeURLLookup(), enable_l1=True, head_checker=head,
    )

    assert len(result) == 1
    assert result[0].verification_level == "L1"
    assert result[0].trust_tier == "low"


def test_l1_only_called_for_unverified_urls():
    """L3/L2 hits do NOT incur HEAD requests."""
    url_l3 = "https://example.com/article"
    url_l1 = "https://needs-l1.example/"
    head = FakeHEADChecker(resolves={url_l1})
    lookup = FakeURLLookup(known_normalized_urls={normalize_url(url_l3)})

    verify_claims(
        [_claim(url_l3, message_id="m1"), _claim(url_l1, message_id="m2")],
        lookup, enable_l1=True, head_checker=head,
    )

    # L3 URL should NOT have been HEAD-checked
    assert url_l3 not in head.calls
    assert url_l1 in head.calls


# ── Mixed / batched behavior ─────────────────────────────────────────────


def test_mixed_cascade_results():
    url_l3 = "https://known.example/article"
    url_l2 = "https://known-domain.example/never-visited"
    url_drop = "https://totally-unknown.example/page"

    lookup = FakeURLLookup(
        known_normalized_urls={normalize_url(url_l3)},
        known_domains={"known-domain.example"},
    )
    claims = [
        _claim(url_l3, message_id="m1"),
        _claim(url_l2, message_id="m2"),
        _claim(url_drop, message_id="m3"),
    ]

    result = verify_claims(claims, lookup)

    by_msg = {c.message_id: c for c in result}
    assert by_msg["m1"].verification_level == "L3"
    assert by_msg["m2"].verification_level == "L2"
    assert "m3" not in by_msg  # dropped


def test_batched_queries_run_once_each():
    """Whole-batch L3 and L2 queries fire once apiece, not per-claim."""
    lookup = FakeURLLookup(known_domains={"a.example", "b.example"})
    claims = [
        _claim(f"https://{host}/page-{i}")
        for host in ("a.example", "b.example", "c.example")
        for i in range(5)
    ]

    verify_claims(claims, lookup)

    assert lookup.url_query_count == 1
    assert lookup.domain_query_count == 1


def test_originals_unchanged_after_verify():
    """ChatClaim is frozen; verify_claims returns new instances and never mutates."""
    url = "https://example.com/article"
    lookup = FakeURLLookup(known_normalized_urls={normalize_url(url)})
    original = _claim(url)

    verify_claims([original], lookup)

    assert original.verification_level is None
    assert original.trust_tier is None
    assert original.normalized_citation_url is None


def test_multiple_claims_same_url_get_same_verdict():
    """Same URL across multiple paragraphs: all verified together."""
    url = "https://example.com/article"
    lookup = FakeURLLookup(known_normalized_urls={normalize_url(url)})
    claims = [_claim(url, paragraph_idx=i) for i in range(3)]

    result = verify_claims(claims, lookup)

    assert len(result) == 3
    assert all(c.verification_level == "L3" for c in result)


def test_frozen_chatclaim_cannot_be_mutated():
    """Confirms the frozen=True invariant the verifier relies on."""
    claim = _claim("https://example.com/")
    with pytest.raises(Exception):  # ValidationError or similar from Pydantic
        claim.verification_level = "L3"  # type: ignore[misc]
