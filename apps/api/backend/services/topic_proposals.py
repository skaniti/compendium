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
UMBRELLA_SHARE = 0.6
UMBRELLA_MIN_CANDIDATES = 6
FORBIDDEN_LABELS = frozenset({
    "null", "none", "n/a", "diverse topics", "miscellaneous", "general knowledge",
    "various", "other", "mixed",
})


def validate_topics(raw, candidate_ids: set[int], max_topics: int) -> list[dict]:
    """Clean the model's ``{"topics": [...]}`` into ``[{label, cluster_ids}]``.

    Per topic: trims the label; drops it when empty, longer than 4 words or
    60 characters, or one of the literal/forbidden labels ("null", "none",
    "n/a", "Diverse Topics", "Miscellaneous", "General Knowledge", "Various",
    "Other", "Mixed"; case-insensitive); drops it as an umbrella when it
    claims more than 60 percent of the candidates (with at least 6
    candidates). Unknown cluster ids are dropped, a cluster claimed twice
    goes to the first topic that claimed it, topics whose labels are equal
    ignoring case merge (union of members, first spelling wins), topics left
    with fewer than 2 clusters are dropped and the result is capped at
    *max_topics*."""
    topics = raw.get("topics") if isinstance(raw, dict) else None
    if not isinstance(topics, list):
        return []
    claimed: dict[int, str] = {}
    by_key: dict[str, dict] = {}
    for t in topics:
        if not isinstance(t, dict):
            continue
        label = t.get("label")
        label = " ".join(label.split()) if isinstance(label, str) else ""
        ids = t.get("cluster_ids")
        if not label or not isinstance(ids, list):
            continue
        key = label.casefold()
        if (
            key in FORBIDDEN_LABELS
            or len(label) > MAX_LABEL_CHARS
            or len(label.split()) > MAX_LABEL_WORDS
        ):
            continue
        valid = {
            i for i in ids
            if isinstance(i, int) and not isinstance(i, bool) and i in candidate_ids
        }
        if (
            len(candidate_ids) >= UMBRELLA_MIN_CANDIDATES
            and len(valid) > UMBRELLA_SHARE * len(candidate_ids)
        ):
            continue
        entry = by_key.setdefault(key, {"label": label, "cluster_ids": []})
        for i in ids:
            if i in valid and claimed.get(i, key) == key and i not in entry["cluster_ids"]:
                claimed[i] = key
                entry["cluster_ids"].append(i)
    out = [t for t in by_key.values() if len(t["cluster_ids"]) >= MIN_TOPIC_CLUSTERS]
    return out[:max_topics]


async def propose_topics(
    candidates: list[dict],
    existing_topics: list[str],
    dismissed_labels: list[str],
    *,
    model: str | None = None,
    max_topics: int | None = None,
) -> tuple[list[dict], float]:
    """One model call; returns (validated topics, cost_usd).

    Fewer than ``MIN_CANDIDATES`` candidates: no call, ([], 0.0). A failed or
    malformed call logs a warning and returns ([], cost)."""
    from backend.config.settings import settings

    if len(candidates) < MIN_CANDIDATES:
        return [], 0.0
    model = model or settings.supercluster_proposal_model
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
            "supercluster_proposal_v1",
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
                max_tokens=2000,
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
    return validate_topics(raw, {c["id"] for c in candidates}, max_topics), cost


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
