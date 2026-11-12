"""Model-proposed superclusters for the SUPERCLUSTERS widget.

At the end of every non-label-first recluster ONE model call proposes broad
topics over the clusters that are not in a declared supercluster. Each
validated proposal is stored as a ``super_cluster_groups`` row with source
``'proposed'``. Those rows own no clusters (nothing points ``clusters.group_id``
at them; the members' ids live in ``evidence.cluster_db_ids``) and are never
painted on the graph; the shared offer rule (``suggestion_offers``) decides
which of them the widget shows.

The model output is never trusted: ``validate_topics`` drops unknown ids,
double-claimed clusters, thin topics and empty labels, and a failed call
proposes nothing (``store_proposals_for_run`` never raises).
"""

from __future__ import annotations

import asyncio
import json
import logging

logger = logging.getLogger(__name__)

MIN_CANDIDATES = 4
"""Fewer candidate clusters than this: propose nothing (no model call)."""
MIN_TOPIC_CLUSTERS = 2


def collect_candidates(clusters: list[dict], declared_keywords: list[str]) -> list[dict]:
    """Clusters not in a declared supercluster, as ``{id, name, pages}``.

    *clusters* are ``cluster_repo.get_clusters_for_user`` rows. A cluster is a
    candidate when its ``super_cluster`` is empty or is not one of the owner's
    keywords (case-insensitive). That covers both modes: hybrid clusters in
    suggested/dismissed groups carry a suggested label (or none), keyword and
    accepted groups carry the keyword; keywords mode leaves unclassified
    clusters empty."""
    declared = {k.strip().lower() for k in declared_keywords if k and k.strip()}
    out = []
    for c in clusters:
        sc = (c.get("super_cluster") or "").strip().lower()
        if sc and sc in declared:
            continue
        name = "".join(ch for ch in (c["cluster_name"] or "") if ch.isprintable())[:120]
        out.append({"id": c["id"], "name": name, "pages": len(c.get("page_ids") or [])})
    return out


MAX_LABEL_WORDS = 4
MAX_LABEL_CHARS = 60
MIN_LABEL_LETTERS = 2
UMBRELLA_SHARE = 0.6
UMBRELLA_MIN_CANDIDATES = 6
FORBIDDEN_LABELS = frozenset({
    "null", "none", "n/a", "diverse topics", "miscellaneous", "general knowledge",
    "various", "other", "mixed", "misc", "uncategorized", "unknown", "general",
    "others", "random", "stuff", "everything else",
})
TOKENS_PER_CANDIDATE = 30
MIN_MAX_TOKENS = 2000


def label_key(label: str) -> str:
    """Grouping key for a label: casefold, "&" read as "and", every
    non-alphanumeric character removed (so "Health & Fitness" and "Health and
    Fitness", "Sci-Fi" and "Sci Fi", "Cooking" and "Cooking." coincide).
    Same squashing ``covering_keyword`` uses for equality."""
    from backend.services.suggestion_offers import _squashed

    return _squashed(label.replace("&", " and "))


def _label_ok(label: str) -> bool:
    plain = label.casefold().strip(" .!?:;,")
    return (
        bool(label)
        and plain not in FORBIDDEN_LABELS
        and len(label) <= MAX_LABEL_CHARS
        and len(label.split()) <= MAX_LABEL_WORDS
        and sum(ch.isalpha() for ch in label) >= MIN_LABEL_LETTERS
    )


def validate_topics(raw, candidate_ids: set[int], max_topics: int | None = None) -> list[dict]:
    """Clean the model's ``{"topics": [...]}`` into ``[{label, cluster_ids}]``.

    Per entry: trims the label; drops it when it is too long (more than 4
    words or 60 characters), has fewer than 2 letters, or is a
    literal/catch-all label ("null", "none", "n/a", "Diverse Topics",
    "Miscellaneous", "General Knowledge", "Various", "Other", "Mixed", "Misc",
    "Uncategorized", "Unknown", "General", "Others", "Random", "Stuff",
    "Everything Else"; case-insensitive). Entries whose labels have the same
    ``label_key`` merge (union of members, first spelling wins). After the
    merge, a topic claiming more than 60 percent of the candidates (with at
    least 6 candidates) is dropped as an umbrella. Unknown cluster ids are
    dropped, a cluster claimed twice goes to the first topic that claimed it,
    and topics left with fewer than 2 clusters are dropped. With
    *max_topics* the result is cut in model-output order; callers that can
    rank use ``rank_and_cap`` instead."""
    topics = raw.get("topics") if isinstance(raw, dict) else None
    if not isinstance(topics, list):
        return []
    merged: dict[str, dict] = {}
    for t in topics:
        if not isinstance(t, dict):
            continue
        label = t.get("label")
        label = " ".join(label.split()) if isinstance(label, str) else ""
        ids = t.get("cluster_ids")
        if not _label_ok(label) or not isinstance(ids, list):
            continue
        entry = merged.setdefault(label_key(label), {"label": label, "ids": []})
        for i in ids:
            if (
                isinstance(i, int) and not isinstance(i, bool)
                and i in candidate_ids and i not in entry["ids"]
            ):
                entry["ids"].append(i)
    claimed: set[int] = set()
    out: list[dict] = []
    for entry in merged.values():
        if (
            len(candidate_ids) >= UMBRELLA_MIN_CANDIDATES
            and len(entry["ids"]) > UMBRELLA_SHARE * len(candidate_ids)
        ):
            continue
        kept = [i for i in entry["ids"] if i not in claimed]
        if len(kept) < MIN_TOPIC_CLUSTERS:
            continue
        claimed.update(kept)
        out.append({"label": entry["label"], "cluster_ids": kept})
    return out if max_topics is None else out[:max_topics]


def rank_and_cap(
    topics: list[dict],
    candidates: list[dict],
    existing_topics: list[str],
    dismissed_labels: list[str],
    max_topics: int,
    *,
    min_clusters: int,
    min_pages: int,
) -> list[dict]:
    """Keep the topics worth a slot: drop those that cannot be offered right
    now (under the cluster or page floor, covered by an existing keyword,
    dismissed), sort the rest by page total descending (ties by cluster
    count descending, then label) and only then cap at *max_topics*."""
    from backend.services.suggestion_offers import covering_keyword

    pages_of = {c["id"]: c["pages"] for c in candidates}
    dismissed = {d.casefold() for d in dismissed_labels}
    scored = []
    for t in topics:
        pages = sum(pages_of.get(i, 0) for i in t["cluster_ids"])
        if (
            len(t["cluster_ids"]) < min_clusters
            or pages < min_pages
            or covering_keyword(t["label"], existing_topics) is not None
            or t["label"].casefold() in dismissed
        ):
            continue
        scored.append((-pages, -len(t["cluster_ids"]), t["label"].casefold(), t))
    scored.sort(key=lambda x: x[:3])
    return [x[3] for x in scored[:max_topics]]


def parse_fields(raw, candidate_ids: set[int]) -> dict[int, str]:
    """``{"fields": [{"id", "field"}]}`` -> {cluster id: field}.

    Drops unknown or non-integer ids, non-string, empty or literal "null"
    fields; when an id appears more than once the first entry wins (even if
    that first entry was unusable)."""
    entries = raw.get("fields") if isinstance(raw, dict) else None
    if not isinstance(entries, list):
        return {}
    seen: set[int] = set()
    out: dict[int, str] = {}
    for e in entries:
        if not isinstance(e, dict):
            continue
        i = e.get("id")
        if isinstance(i, bool) or not isinstance(i, int) or i not in candidate_ids or i in seen:
            continue
        seen.add(i)
        field = e.get("field")
        field = " ".join(field.split()) if isinstance(field, str) else ""
        if field and field.casefold() not in ("null", "none"):
            out[i] = field
    return out


def group_fields(fields: dict[int, str]) -> dict:
    """Group clusters by ``label_key`` of the field (first spelling wins) into
    the ``{"topics": [...]}`` shape ``validate_topics`` takes. Singletons are
    left to validation, which drops topics with fewer than 2 clusters."""
    groups: dict[str, dict] = {}
    for i, field in fields.items():
        g = groups.setdefault(label_key(field), {"label": field, "cluster_ids": []})
        g["cluster_ids"].append(i)
    return {"topics": list(groups.values())}


async def propose_topics(
    candidates: list[dict],
    existing_topics: list[str],
    dismissed_labels: list[str],
    *,
    model: str | None = None,
    max_topics: int | None = None,
    shape: str | None = None,
) -> tuple[list[dict], float]:
    """One model call; returns (validated topics, cost_usd).

    Fewer than ``MIN_CANDIDATES`` candidates: no call, ([], 0.0). A failed or
    malformed call logs a warning and returns ([], cost)."""
    from backend.config.settings import settings

    if len(candidates) > settings.supercluster_proposal_max_candidates:
        # keep the largest clusters: the reply grows with the candidate count
        keep = sorted(candidates, key=lambda c: (-c["pages"], c["id"]))
        keep = keep[: settings.supercluster_proposal_max_candidates]
        logger.info(
            f"Topic proposals: {len(candidates) - len(keep)} of {len(candidates)} "
            f"candidate clusters left out (cap {settings.supercluster_proposal_max_candidates})"
        )
        candidates = keep
    if len(candidates) < MIN_CANDIDATES:
        return [], 0.0
    model = model or settings.supercluster_proposal_model
    shape = shape or settings.supercluster_proposal_shape
    max_topics = max_topics or settings.supercluster_suggestion_max_topics
    cost = 0.0
    try:
        from backend.prompts.templates import get_prompt_raw
        from backend.services.llm_service import LLMService
        from backend.services.super_cluster_service import ASSIGNMENT_SEED

        # get_prompt_raw, not get_prompt: get_prompt brace-escapes string
        # kwargs for a second .format() pass, which would double the braces
        # of the JSON payload the model reads. Cluster names are stripped of
        # control characters and length-capped in collect_candidates instead.
        prompt = get_prompt_raw(
            "supercluster_fields_v1" if shape == "fields" else "supercluster_proposal_v1",
            max_topics=max_topics,
            existing_topics_block=(
                "\n".join(f"- {t}" for t in sorted(set(existing_topics), key=str.lower))
                or "(none yet -- use short, broad field names)"
            ),
            dismissed_block=(
                "\n".join(f"- {t}" for t in sorted(set(dismissed_labels), key=str.lower))
                or "(none)"
            ),
            clusters_json=json.dumps(candidates, ensure_ascii=False),
        )
        response = await asyncio.wait_for(
            LLMService().complete(
                prompt=prompt,
                model=model,
                temperature=0.0,
                max_tokens=max(MIN_MAX_TOKENS, TOKENS_PER_CANDIDATE * len(candidates) + 500),
                seed=ASSIGNMENT_SEED,
                response_format="json_object",
            ),
            timeout=settings.supercluster_proposal_timeout_seconds,
        )
        cost = response.cost_usd
        raw = json.loads(response.content)
    except asyncio.TimeoutError:
        logger.warning(
            f"Topic proposal call timed out after "
            f"{settings.supercluster_proposal_timeout_seconds}s (proposing nothing)"
        )
        return [], cost
    except Exception as e:
        logger.warning(f"Topic proposal call failed (proposing nothing): {e}")
        return [], cost
    ids = {c["id"] for c in candidates}
    if shape == "fields":
        raw = group_fields(parse_fields(raw, ids))
    topics = validate_topics(raw, ids, None)
    return rank_and_cap(
        topics, candidates, existing_topics, dismissed_labels, max_topics,
        min_clusters=settings.supercluster_suggestion_min_clusters,
        min_pages=settings.supercluster_suggestion_min_pages,
    ), cost


def build_rows(
    topics: list[dict],
    candidates: list[dict],
    existing_topics: list[str],
    visit_evidence_for,
) -> list[dict]:
    """Rows for ``cluster_repo.save_super_cluster_groups`` (source 'proposed').

    *visit_evidence_for(cluster_ids)* returns the visit-recurrence evidence
    dict for those clusters' pages. ``covered_by`` is set when the label
    near-duplicates an existing supercluster."""
    from backend.services import supercluster_discovery as sd
    from backend.services.suggestion_offers import PROPOSED_SOURCE, covering_keyword

    pages_of = {c["id"]: c["pages"] for c in candidates}
    rows = []
    for i, t in enumerate(topics):
        pages = sum(pages_of[c] for c in t["cluster_ids"])
        evidence = dict(visit_evidence_for(t["cluster_ids"]))
        evidence["cluster_db_ids"] = list(t["cluster_ids"])
        covered = covering_keyword(t["label"], existing_topics)
        if covered is not None:
            evidence["covered_by"] = covered
        rows.append(
            {
                "group_index": i,
                "label": t["label"],
                "source": PROPOSED_SOURCE,
                "topic": None,
                "topic_similarity": None,
                "interest_tier": sd.interest_tier(evidence, n_pages=pages, declared=False),
                "evidence": evidence,
                "member_count": len(t["cluster_ids"]),
                "page_count": pages,
                "split_proposal": None,
            }
        )
    return rows


def visit_evidence_for_clusters(user_id: int, clusters: list[dict]):
    """Closure computing visit evidence for sets of cluster ids (one history
    query per call over the clusters' member pages)."""
    from backend.db import page_repo
    from backend.services import supercluster_discovery as sd

    pages_by_cluster = {c["id"]: c.get("page_ids") or [] for c in clusters}

    def evidence_for(cluster_ids: list[int]) -> dict:
        page_ids = [p for c in cluster_ids for p in pages_by_cluster.get(c, [])]
        history = page_repo.get_visit_history(user_id, page_ids)
        rows: list[dict] = []
        for p in page_ids:
            rows.extend(history.get(p, []))
        return sd.aggregate_visit_evidence(rows)

    return evidence_for


async def store_proposals_for_run(user_id: int, run_id: int) -> dict:
    """Propose and store topics for a freshly clustered run. Never raises:
    any failure is logged and the recluster carries on without proposals."""
    try:
        from backend.config.settings import settings
        from backend.db import auth_repo, cluster_repo

        if settings.label_first_enabled or settings.supercluster_suggestion_source != "proposed":
            return {"proposed": 0}
        prefs = auth_repo.get_preferences(user_id) or {}
        existing = [t["keyword"] for t in prefs.get("topic_interests", []) if t.get("keyword")]
        dismissed = [d["label"] for d in prefs.get("dismissed_topics", []) if d.get("label")]
        clusters = cluster_repo.get_clusters_for_user(user_id, run_id)
        candidates = collect_candidates(clusters, existing)
        topics, cost = await propose_topics(candidates, existing, dismissed)
        if cost:
            try:
                from backend.db import trends_repo

                trends_repo.insert_cost_event(
                    user_id=user_id,
                    event_type="topic_proposal",
                    model=settings.supercluster_proposal_model,
                    cost_usd=cost,
                    metadata={"run_id": run_id, "candidates": len(candidates),
                              "topics": len(topics)},
                )
            except Exception:
                logger.debug("topic proposal cost event failed", exc_info=True)
        if not topics:
            logger.info(f"Topic proposals: none ({len(candidates)} candidate clusters)")
            return {"proposed": 0, "candidates": len(candidates), "cost": cost}
        rows = build_rows(
            topics, candidates, existing, visit_evidence_for_clusters(user_id, clusters)
        )
        cluster_repo.save_super_cluster_groups(user_id, run_id, rows)
        logger.info(
            f"Topic proposals: {len(rows)} stored from {len(candidates)} candidate clusters, ${cost:.4f}"
        )
        return {"proposed": len(rows), "candidates": len(candidates), "cost": cost}
    except Exception:
        logger.warning("Topic proposals failed (recluster unaffected)", exc_info=True)
        return {"proposed": 0}
