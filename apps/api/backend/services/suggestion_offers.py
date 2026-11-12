"""Which super_cluster_groups are OFFERED to the owner as suggested superclusters.

One rule, shared by ``GET /api/topics/suggestions`` (the SUPERCLUSTERS widget)
and the "N suggested" segment of ``GET /api/clustering/status`` (the
CLUSTERING card), so the two always agree. Groups that are not offered stay on
the graph exactly as before; only the offer changes.

No database access. ``skip_reason`` and ``covering_keyword`` are pure (callers
pass the floors), so every reason is unit-testable; ``offer_reason`` and
``offered_suggestions`` read the current settings and the owner's preferences.
"""

from __future__ import annotations

import re

PROPOSED_SOURCE = "proposed"
"""``super_cluster_groups.source`` of model-proposed topics
(``topic_proposals``); they own no clusters."""

TAXONOMY_SOURCE = "taxonomy"
"""``super_cluster_groups.source`` written by label-first clustering
(``label_first_clustering.SUPERCLUSTER_SOURCE``)."""


def _tokens(text: str) -> list[str]:
    """Casefolded whitespace-split tokens with punctuation stripped from the
    token edges (inner hyphens stay: "Non-Fiction" is one token)."""
    out = []
    for tok in text.casefold().split():
        tok = re.sub(r"^[\W_]+|[\W_]+$", "", tok)
        if tok:
            out.append(tok)
    return out


def _squashed(text: str) -> str:
    """Casefolded text with every non-alphanumeric character removed."""
    return "".join(ch for ch in text.casefold() if ch.isalnum())


def covering_keyword(label: str, keywords: list[str]) -> str | None:
    """The existing supercluster keyword that already covers *label*, or None.

    Covered = equal after casefolding and removing every non-alphanumeric
    character ("3D-Printing" equals "3d printing", "Science!" equals
    "science"), or the keyword is the label's trailing whole words, i.e. the
    label names a kind of the keyword: "Computer Science" and "Applied
    Machine Learning" are covered by "science" and "machine learning".
    "Science Fiction" is not covered by "science" (leading words),
    "Non-Fiction" is not covered by "fiction" (the hyphen joins one word) and
    "Machine Learning Models" is not covered by "machine learning" (the
    proposal prompt's no-rewording rule handles that)."""
    squashed = _squashed(label)
    if not squashed:
        return None
    label_tokens = _tokens(label)
    for kw in keywords:
        if not isinstance(kw, str):
            continue
        if squashed == _squashed(kw):
            return kw
        kw_tokens = _tokens(kw)
        n = len(kw_tokens)
        if n and len(label_tokens) > n and label_tokens[-n:] == kw_tokens:
            return kw
    return None


def topic_keywords(prefs: dict) -> list[str]:
    """The owner's supercluster keywords from preferences (dict entries)."""
    out = []
    for t in prefs.get("topic_interests", []) or []:
        kw = t.get("keyword") if isinstance(t, dict) else t
        if isinstance(kw, str) and kw.strip():
            out.append(kw)
    return out


def skip_reason(
    group: dict,
    *,
    min_clusters: int,
    min_pages: int,
    label_first: bool = False,
    suggestion_source: str = "groups",
    dismissed_labels: frozenset[str] | set[str] = frozenset(),
) -> str | None:
    """Why *group* is not offered as a suggestion, or None when it is offered.

    *group* is a ``cluster_repo.get_groups_for_user`` row (fetched with
    ``include_proposed=True``). *suggestion_source* is
    ``settings.supercluster_suggestion_source``: "groups" makes
    ``source='suggested'`` rows the candidates, "proposed" makes
    ``source='proposed'`` rows the candidates. *dismissed_labels* holds
    lower-cased labels from ``preferences.dismissed_topics``."""
    source = group.get("source")
    if source == "suggested" and suggestion_source == "groups":
        pass
    elif source == PROPOSED_SOURCE and suggestion_source == "proposed":
        if (group.get("evidence") or {}).get("accepted_as"):
            return "accepted"
    elif (
        label_first
        and source == TAXONOMY_SOURCE
        and group.get("topic_similarity") is None  # not declared
    ):
        pass
    else:
        return "not a suggestion"
    if (group.get("member_count") or 0) < min_clusters:
        return f"fewer than {min_clusters} clusters"
    if (group.get("page_count") or 0) < min_pages:
        return f"fewer than {min_pages} pages"
    evidence = group.get("evidence") or {}
    if evidence.get("no_single_field"):
        return "no single field"
    if evidence.get("covered_by"):
        return f"covered by {evidence['covered_by']}"
    if (group.get("label") or "").lower() in dismissed_labels:
        return "dismissed"
    return None


def is_offered(group: dict, **kwargs) -> bool:
    """True when :func:`skip_reason` finds nothing against *group*."""
    return skip_reason(group, **kwargs) is None


def _current_rule_kwargs(prefs: dict) -> dict:
    from backend.config.settings import settings

    return dict(
        min_clusters=settings.supercluster_suggestion_min_clusters,
        min_pages=settings.supercluster_suggestion_min_pages,
        label_first=settings.label_first_enabled,
        suggestion_source=settings.supercluster_suggestion_source,
        dismissed_labels={
            d["label"].lower() for d in prefs.get("dismissed_topics", []) if d.get("label")
        },
    )


def offer_reason(group: dict, prefs: dict) -> str | None:
    """Why *group* is not offered right now, or None. :func:`skip_reason`
    under the current settings, plus a read-time check against the owner's
    CURRENT keywords (so a keyword added by hand hides an identically named
    suggestion at once, not only after the next recluster)."""
    reason = skip_reason(group, **_current_rule_kwargs(prefs))
    if reason is None:
        covered = covering_keyword(group.get("label") or "", topic_keywords(prefs))
        if covered is not None:
            return f"covered by {covered}"
    return reason


def offered_suggestions(groups: list[dict], prefs: dict) -> list[dict]:
    """The groups to offer, ordered by interest tier then pages, one per
    label (case-insensitive). Uses :func:`offer_reason` (settings floors, the
    label-first flag, the source setting, dismissed labels and current
    keywords from *prefs*)."""
    from backend.services.supercluster_discovery import TIER_ORDER

    offered = [g for g in groups if offer_reason(g, prefs) is None]
    tier_rank = {t: i for i, t in enumerate(TIER_ORDER)}
    offered.sort(key=lambda g: (tier_rank.get(g["interest_tier"], 99), -g["page_count"]))
    seen: set[str] = set()
    unique = []
    for g in offered:
        key = g["label"].lower()
        if key not in seen:
            seen.add(key)
            unique.append(g)
    return unique
