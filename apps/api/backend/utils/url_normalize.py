"""Canonical URL normalization for dedup comparison.

This module is the authoritative normalizer for the backend. It must produce
output that matches ``extension/modules/utils.js::normalizeUrlForDedup`` on
any URL both normalizers accept — see ``tests/test_url_normalize.py`` for the
parity fixture list. This parity requirement covers both the global rules
below AND the per-domain DOMAIN_RULES table — any row added to one side must
be added to the other, verbatim, in the same conversation/commit.

Why we normalize:
    Raw browser URLs contain variation that is irrelevant for dedup purposes
    (tracking params, fragments, host casing, query-param ordering, trailing
    slashes). Two visits to the "same" page can serialize to different strings,
    bypassing unique indexes and inflating row counts. This function collapses
    all such variations into a canonical string.

Rules (in order):
    1. Strip #fragment.
    2. Lowercase host only (not path — case-sensitive paths like GitHub URLs
       must be preserved).
    3. Strip trailing slash from path, except when the path is exactly "/".
    4. Apply per-domain path folds (see DOMAIN_RULES) — collapses structural
       sub-paths (comment/file/post-number tabs) that address the same
       underlying resource down to a canonical path.
    5. Drop known tracking query parameters (see TRACKING_PARAMS), plus any
       per-domain params from DOMAIN_RULES for the matching host.
    6. Sort remaining query parameters alphabetically by key for deterministic
       ordering. Stable sort preserves relative order of duplicate keys.
    7. Preserve: scheme, port, userinfo, path casing, query-value encoding.

Non-goals:
    - No IDN/punycode normalization.
    - No http → https upgrade (would misrepresent hosts that aren't reachable
      on both).
    - No path percent-encoding normalization.
    - No double-slash collapsing in paths.
    - No localhost folding — localhost is capture-skipped upstream, so ports
      are preserved everywhere else (see project-plan spec for this decision).

On parse failure the input URL is returned unchanged.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

# Keep in sync with extension/modules/utils.js::TRACKING_PARAMS.
# Order does not matter (membership is checked against a set).
TRACKING_PARAMS: frozenset[str] = frozenset(
    {
        "utm_source",
        "utm_medium",
        "utm_campaign",
        "utm_term",
        "utm_content",
        "fbclid",
        "gclid",
        "gclsrc",
        "mc_cid",
        "mc_eid",
        "share_id",
    }
)


@dataclass(frozen=True)
class _PathFold:
    """A path-collapsing rule: everything the regex matches is replaced by
    ``replacement`` (a backreference to the captured "canonical" prefix)."""

    pattern: re.Pattern[str]
    replacement: str


@dataclass(frozen=True)
class DomainRule:
    """One row of the per-domain canonicalization table.

    ``domain`` matches the request host either exactly or as a subdomain of
    it (``host == domain or host.endswith("." + domain)``). This is a single
    uniform matching rule for every row — apex entries such as "zillow.com"
    or "printables.com" therefore also cover the "www." forms seen in real
    capture data, without a separate include-subdomains flag. Entries that
    are themselves already a specific subdomain (e.g. "forum.example.com")
    stay scoped to that subdomain and its children only — they do not bleed
    onto sibling subdomains like "www.example.com", which may serve unrelated
    content (docs, not forum threads).
    """

    domain: str
    strip_params: frozenset[str] = frozenset()
    path_fold: _PathFold | None = None


# Per-domain canonicalization rules, applied on top of the global rules
# above. Each row is independent and the apply loop is domain-agnostic — add
# new rules as new rows, not new branches.
#
# param strips: extra query params to drop, scoped to the matching domain
#   only (e.g. `tab` must survive on non-github hosts).
# path folds: structural sub-paths (comment tabs, file tabs, forum post
#   numbers) that address the same underlying page as their parent path,
#   collapsed onto that parent.
#
# Keep in parity with extension/modules/utils.js::DOMAIN_RULES — same
# domains, same params, same fold semantics (regex capture group 1
# survives, everything else in the match is dropped). NOTE (2026-08-30
# extraction): per-deployment rules naming specific small-community hosts
# were pruned from this public copy; add deployment-specific DomainRule
# entries here (Flarum threads fold via r"^(/d/\d+(?:-[^/]+)?)/\d+$",
# Discourse topics via r"^(/t/[^/]+/\d+)/\d+$").
DOMAIN_RULES: tuple[DomainRule, ...] = (
    # Luma event links carry a per-share/per-session `tk` token.
    DomainRule(domain="luma.com", strip_params=frozenset({"tk"})),
    # Zillow's `mmlb` param indexes into the photo carousel; same listing.
    DomainRule(domain="zillow.com", strip_params=frozenset({"mmlb"})),
    # GitHub's `tab` param selects a profile/repo view tab, not a resource.
    DomainRule(domain="github.com", strip_params=frozenset({"tab"})),
    # Thingiverse: /thing:<id>/comments is a tab on the thing page itself.
    DomainRule(
        domain="www.thingiverse.com",
        path_fold=_PathFold(re.compile(r"^(/thing:\d+)/comments$"), r"\1"),
    ),
    # Printables: /model/<id>[-slug]/(files|comments) are tabs on the model.
    DomainRule(
        domain="printables.com",
        path_fold=_PathFold(
            re.compile(r"^(/model/\d+(?:-[^/]+)?)/(?:files|comments)$"), r"\1"
        ),
    ),
)


def _domain_matches(host: str, domain: str) -> bool:
    return host == domain or host.endswith("." + domain)


def _domain_strip_params(host: str) -> frozenset[str]:
    """Extra query params to drop for ``host``, beyond TRACKING_PARAMS."""
    for rule in DOMAIN_RULES:
        if rule.strip_params and _domain_matches(host, rule.domain):
            return rule.strip_params
    return frozenset()


def _apply_path_fold(host: str, path: str) -> str:
    """Collapse a structural sub-path onto its canonical parent, if a
    DOMAIN_RULES path-fold matches ``host``. Returns ``path`` unchanged when
    no rule matches this host or the path doesn't match the rule's pattern."""
    for rule in DOMAIN_RULES:
        if rule.path_fold and _domain_matches(host, rule.domain):
            return rule.path_fold.pattern.sub(rule.path_fold.replacement, path)
    return path


def normalize_url(url: str) -> str:
    """Return the canonical form of ``url`` for dedup comparison.

    See module docstring for the exact rules. Returns the input unchanged if
    parsing fails or the input is falsy.
    """
    if not url:
        return url

    try:
        parts = urlsplit(url)
    except ValueError:
        return url

    # ``hostname`` is already lowercased by urlsplit — use it for domain-rule
    # matching. Named distinctly from the ``host`` local below (which holds
    # the original-case host extracted from netloc for the output rebuild)
    # to avoid shadowing it.
    match_host = parts.hostname or ""

    # Rule 2: lowercase host only. urlsplit exposes ``hostname`` (lowercased)
    # and ``port`` separately, but we need to preserve userinfo and the port
    # string as-is, so we rebuild netloc manually.
    netloc = parts.netloc
    if netloc:
        # Split userinfo from host[:port]
        userinfo, sep, hostport = netloc.rpartition("@")
        # Split host from port
        if hostport.startswith("["):
            # IPv6 literal: "[::1]:8080"
            bracket_end = hostport.find("]")
            if bracket_end != -1:
                host = hostport[: bracket_end + 1]
                port = hostport[bracket_end + 1 :]
            else:
                host = hostport
                port = ""
        else:
            host, colon, port = hostport.partition(":")
            if colon:
                port = ":" + port
        netloc = f"{userinfo}{sep}{host.lower()}{port}"

    # Rule 3: strip trailing slash except when path is exactly "/"
    path = parts.path
    if len(path) > 1 and path.endswith("/"):
        path = path.rstrip("/")
        # Edge case: path was all slashes — keep a single "/" so the URL stays valid
        if not path:
            path = "/"

    # Rule 4: per-domain path folds (see DOMAIN_RULES). No-op if no rule
    # matches this host or the path doesn't match the rule's pattern.
    path = _apply_path_fold(match_host, path)

    # Rules 5+6: filter tracking params (global ∪ per-domain), sort
    # remaining alphabetically. keep_blank_values=True preserves "?foo="
    # (distinct from "?foo") because the presence of the key is meaningful
    # on some sites.
    strip_params = TRACKING_PARAMS | _domain_strip_params(match_host)
    query_pairs = [
        (k, v)
        for k, v in parse_qsl(parts.query, keep_blank_values=True)
        if k not in strip_params
    ]
    # Stable sort on key — preserves the relative order of repeated keys,
    # matching what a sane server would do with ?a=1&a=2.
    query_pairs.sort(key=lambda kv: kv[0])
    query = urlencode(query_pairs)

    # Rule 1: fragment is dropped by passing "" to urlunsplit.
    return urlunsplit((parts.scheme, netloc, path, query, ""))


if __name__ == "__main__":  # pragma: no cover — ad-hoc CLI for debugging
    import sys

    for arg in sys.argv[1:]:
        print(f"{arg}\n  → {normalize_url(arg)}")
