"""ChatClaim verification cascade: L3 -> L2 -> L1.

L3: cited URL is in the user's browsing history (pages.normalized_url).
L2: cited URL's host is in browsing history (pages.domain) OR in the allowlist.
L1: cited URL resolves via HEAD request (off by default; opt in per call).

L3 queries `pages` (raw visit log) rather than `page_content` (post-skip_gate
canonical content) because skip_gate currently filters out the very URLs the
chat-import was motivated by (product pages, icon libraries).

No LLM-based semantic verification (avoids prompt-injection-via-cited-content).
"""
from __future__ import annotations

from typing import Optional, Protocol
from urllib.parse import urlsplit

from backend.services.chat_importer.schema import (
    ChatClaim,
    TrustTier,
    VerificationLevel,
)
from backend.utils.url_normalize import normalize_url

LEVEL_TO_TIER: dict[VerificationLevel, TrustTier] = {
    "L3": "high",
    "L2": "medium",
    "L1": "low",
}

# Curated list of well-known reference domains. Citations to these are L2 even
# if the user hasn't personally visited them. Intentionally small -- promotion
# to allowlist requires explicit decision.
DEFAULT_DOMAIN_ALLOWLIST: frozenset[str] = frozenset({
    "docs.python.org",
    "developer.mozilla.org",
    "en.wikipedia.org",
    "github.com",
    "stackoverflow.com",
    "pypi.org",
    "npmjs.com",
})


class URLLookup(Protocol):
    """Read-side view of the user's browsing history for verification."""

    def known_urls(self, normalized_urls: set[str]) -> set[str]:
        """Subset of `normalized_urls` present in `pages.normalized_url` (visit log)."""
        ...

    def known_domains(self, domains: set[str]) -> set[str]:
        """Subset of `domains` present in `pages.domain` (full host match, no www)."""
        ...


class HEADChecker(Protocol):
    """Optional L1 fallback: HEAD-request a URL to confirm it resolves."""

    def url_resolves(self, url: str) -> bool:
        ...


def extract_host(url: str) -> str:
    """Lowercase host without www prefix; empty string on parse failure."""
    if not url:
        return ""
    try:
        host = urlsplit(url).hostname or ""
    except ValueError:
        return ""
    host = host.lower()
    return host[4:] if host.startswith("www.") else host


def verify_claims(
    claims: list[ChatClaim],
    lookup: URLLookup,
    *,
    domain_allowlist: frozenset[str] = DEFAULT_DOMAIN_ALLOWLIST,
    enable_l1: bool = False,
    head_checker: Optional[HEADChecker] = None,
) -> list[ChatClaim]:
    """Apply L3 -> L2 -> L1 cascade. Drops claims that fail all tiers.

    Returns NEW ChatClaim instances with verification fields populated.
    Originals are frozen and untouched.
    """
    if not claims:
        return []

    raw_urls = {c.citation_url for c in claims}
    norm_map = {u: normalize_url(u) for u in raw_urls}

    # L3: exact URL match
    l3_hits = lookup.known_urls(set(norm_map.values()))

    # L2: domain match for URLs that didn't hit L3
    not_l3 = {u for u, n in norm_map.items() if n not in l3_hits}
    domains_to_check = {extract_host(u) for u in not_l3}
    domains_to_check.discard("")
    in_allowlist = domains_to_check & domain_allowlist
    domains_for_db = domains_to_check - in_allowlist
    domains_in_history = lookup.known_domains(domains_for_db) if domains_for_db else set()
    l2_domains = in_allowlist | domains_in_history

    # Per-URL verdict
    verdict: dict[str, VerificationLevel] = {}
    for raw, norm in norm_map.items():
        if norm in l3_hits:
            verdict[raw] = "L3"
        elif extract_host(raw) in l2_domains:
            verdict[raw] = "L2"
        elif enable_l1 and head_checker and head_checker.url_resolves(raw):
            verdict[raw] = "L1"

    verified: list[ChatClaim] = []
    for c in claims:
        level = verdict.get(c.citation_url)
        if level is None:
            continue
        verified.append(c.model_copy(update={
            "verification_level": level,
            "trust_tier": LEVEL_TO_TIER[level],
            "normalized_citation_url": norm_map.get(c.citation_url),
        }))
    return verified
