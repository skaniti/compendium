"""Super-cluster assignment: group HDBSCAN clusters under user-defined topics.

Retrieve-rerank pattern: embeddings already grouped pages into clusters;
the LLM is the classifier that decides which topic each cluster belongs to.
A single batched gpt-4o-mini call handles the whole assignment — no threshold
tuning, no per-cluster loop. Also handles LLM icon selection for new topics.
"""

import json
import logging
from pathlib import Path

from backend.db import cluster_repo
from backend.db.connection import get_conn
from backend.services.llm_service import LLMService

logger = logging.getLogger(__name__)

ASSIGNMENT_MODEL = "gpt-4o-mini"
ASSIGNMENT_SEED = 42
ICON_MODEL = "gpt-4o-mini"
ICON_MANIFEST_PATH = Path(__file__).parent.parent / "data" / "icon_manifest.json"
SAMPLE_PAGES_PER_CLUSTER = 2  # Reduced from 4 on 2026-04-29 to ~halve the
# LLM input-token count for assign_super_clusters. The classifier doesn't
# need 4 example pages per cluster to assign a cluster into a small topic
# list -- 2 is enough signal in practice. Expected speedup: ~30%, with
# negligible quality impact.
ICON_FALLBACK = "lightbulb"

VERIFY_SIM_CEILING = 0.45
"""Per-member carve auto-accept threshold (Task 2 of fix-design
2026-07-16): a cluster's individual claim sim >= this ceiling auto-accepts
without an LLM audit, on the theory that an individual cluster's tight
similarity to a keyword is reliable signal even when its group's aggregate
match is not. It no longer has any group-level meaning — group-level
keyword matches are ALL audited regardless of similarity (see `matched`
in assign_super_clusters_hybrid; the old exemption for matches >=0.45 was
falsified by run 142's wrong 0.5053 group)."""


def _load_cluster_samples(
    cluster_ids: list[int],
    k: int = SAMPLE_PAGES_PER_CLUSTER,
) -> dict[int, list[tuple[str, str]]]:
    """Return {cluster_id: [(title, domain), ...]} with up to k pages per cluster."""
    if not cluster_ids:
        return {}

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT cluster_id, title, domain FROM (
                    SELECT pc.cluster_id, p.title, p.domain,
                           ROW_NUMBER() OVER (
                               PARTITION BY pc.cluster_id
                               ORDER BY p.id
                           ) AS rn
                    FROM page_clusters pc
                    JOIN pages p ON p.id = pc.page_id
                    WHERE pc.cluster_id = ANY(%s)
                ) t
                WHERE rn <= %s
                """,
                (cluster_ids, k),
            )
            result: dict[int, list[tuple[str, str]]] = {}
            for cid, title, domain in cur.fetchall():
                result.setdefault(cid, []).append((title or "(no title)", domain or ""))
            return result


def _build_assignment_prompt(
    clusters: list[dict],
    samples: dict[int, list[tuple[str, str]]],
    topics: list[str],
) -> str:
    """Construct the batched classification prompt."""
    topic_list = "\n".join(f"- {t}" for t in topics)

    cluster_payload = []
    for c in clusters:
        pages = samples.get(c["id"], [])
        page_lines = [
            f"{title[:120]} ({domain})" if domain else title[:120]
            for title, domain in pages[:SAMPLE_PAGES_PER_CLUSTER]
        ]
        cluster_payload.append(
            {
                "id": c["id"],
                "name": c["cluster_name"],
                "pages": page_lines,
            }
        )

    return (
        f"You are organizing clusters of web pages into topic buckets. "
        f"For each cluster below, decide which topic it genuinely belongs to, "
        f'or return "none" if no topic is a real fit.\n\n'
        f"TOPICS:\n{topic_list}\n\n"
        f"RULES:\n"
        f"- Judge by the actual subject matter, not surface keywords.\n"
        f"- A cluster about fonts styled like galaxies is NOT astronomy.\n"
        f'- A film called "Interstellar" is NOT astronomy, it is film.\n'
        f'- A hair salon named "Space Cuts" is NOT astronomy, it is beauty.\n'
        f'- A calendar algorithm called "Doomsday Rule" is NOT astronomy.\n'
        f'- When no topic genuinely fits, return "none". Do not force.\n\n'
        f"CLUSTERS (JSON):\n{json.dumps(cluster_payload, ensure_ascii=False)}\n\n"
        f"Return JSON ONLY, no prose, no markdown fences, in this exact shape:\n"
        f'{{"assignments": [{{"id": <cluster_id>, "topic": "<topic_or_none>", '
        f'"reason": "<one short sentence>"}}, ...]}}'
    )


def _parse_assignments(
    raw: str,
    valid_topics: set[str],
    known_ids: set[int],
) -> dict[int, tuple[str | None, str]]:
    """Parse LLM JSON response into {cluster_id: (topic_or_None, reason)}.

    Strips optional markdown fences. Drops entries with unknown ids or topics.
    """
    text = raw.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else text
        if text.endswith("```"):
            text = text.rsplit("```", 1)[0]
        text = text.strip()

    data = json.loads(text)
    assignments = data.get("assignments", [])

    result: dict[int, tuple[str | None, str]] = {}
    for entry in assignments:
        cid = entry.get("id")
        topic = entry.get("topic")
        reason = entry.get("reason", "")

        if cid not in known_ids:
            continue
        if topic in valid_topics:
            result[cid] = (topic, reason)
        else:
            result[cid] = (None, reason)

    return result


async def _run_assignment_llm(
    llm: LLMService,
    prompt: str,
    *,
    batch_mode: bool,
) -> tuple[str, float, float]:
    """Run the single-prompt supercluster assignment call.

    Returns ``(content, cost_usd, latency_ms)``. In ``batch_mode`` the
    request is wrapped in a one-entry OpenAI Batch API job; otherwise
    the realtime chat-completions path is used. The prompt content,
    model, temperature, and max_tokens are identical in both paths so
    quality is unchanged — only the transport and the price differ.
    """
    if not batch_mode:
        response = await llm.complete(
            prompt=prompt,
            model=ASSIGNMENT_MODEL,
            temperature=0.0,
            max_tokens=8000,
            seed=ASSIGNMENT_SEED,
            response_format="json_object",
        )
        return response.content, response.cost_usd, response.latency_ms

    import time as _time

    t0 = _time.perf_counter()
    batch_id = await llm.submit_batch(
        [
            {
                "custom_id": "supercluster_assignment",
                "body": {
                    "model": ASSIGNMENT_MODEL,
                    "messages": [{"role": "user", "content": prompt}],
                    "temperature": 0.0,
                    "max_tokens": 8000,
                    "seed": ASSIGNMENT_SEED,
                    "response_format": {"type": "json_object"},
                },
            }
        ]
    )
    logger.info(f"Super-cluster assignment: submitted batch {batch_id}")

    results = await llm.await_batch(
        batch_id,
        poll_interval=10.0,
        timeout=3600.0,
        model_for_pricing=ASSIGNMENT_MODEL,
    )
    latency_ms = (_time.perf_counter() - t0) * 1000

    entry = results.get("supercluster_assignment") or {}
    if entry.get("status_code") != 200:
        raise RuntimeError(
            f"batch supercluster assignment returned status "
            f"{entry.get('status_code')!r}; falling back is caller's job"
        )
    return entry["content"], float(entry["cost_usd"]), latency_ms


async def assign_super_clusters(
    user_id: int,
    topic_interests: list[dict],
    recluster_run_id: int | None = None,
    batch_mode: bool = False,
) -> dict[str, str | None]:
    """Assign clusters to user-defined topics via a single batched LLM call.

    Args:
        user_id: The user whose clusters to assign.
        topic_interests: List of dicts with at least a "keyword" key.
        recluster_run_id: If provided, operate on this specific run's clusters
            instead of the latest completed run. Required when called during
            recluster (before the run is marked completed).
        batch_mode: When True, route the single assignment call through the
            OpenAI Batch API (50% discount, ≤24h SLA) instead of the realtime
            endpoint. Intended for the nightly scheduler path; the dev
            Recluster button stays on realtime so the user sees results
            quickly.

    Returns:
        {cluster_slug: topic_keyword_or_None} mapping.
    """
    clusters = cluster_repo.get_clusters_for_user(user_id, recluster_run_id)
    if not clusters:
        return {}

    keywords = [t["keyword"] for t in topic_interests if t.get("keyword")]
    if not keywords:
        db_assignments: dict[int, str | None] = {c["id"]: None for c in clusters}
        cluster_repo.update_super_clusters(user_id, db_assignments)
        return {c["cluster_slug"]: None for c in clusters}

    samples = _load_cluster_samples([c["id"] for c in clusters])
    prompt = _build_assignment_prompt(clusters, samples, keywords)

    llm = LLMService()
    content, cost_usd, latency_ms = await _run_assignment_llm(
        llm, prompt, batch_mode=batch_mode
    )

    known_ids = {c["id"] for c in clusters}
    valid_topics = set(keywords)
    try:
        parsed = _parse_assignments(content, valid_topics, known_ids)
    except (json.JSONDecodeError, ValueError) as e:
        # Keep-previous-on-failure (batch B 4c, finding F15): one malformed
        # response must NOT wipe every stored assignment. Leave the previous
        # run's super_cluster values untouched and report current state.
        logger.error(
            f"Super-cluster assignment: failed to parse LLM response "
            f"({type(e).__name__}: {e}) — keeping previous assignments. "
            f"Raw response (first 500 chars): {content[:500]!r}"
        )
        return {c["cluster_slug"]: c.get("super_cluster") for c in clusters}

    db_assignments = {}
    slug_assignments: dict[str, str | None] = {}
    for c in clusters:
        topic, reason = parsed.get(c["id"], (None, ""))
        db_assignments[c["id"]] = topic
        slug_assignments[c["cluster_slug"]] = topic
        if reason:
            logger.debug(f"Cluster '{c['cluster_name']}' → {topic or 'none'}: {reason}")

    cluster_repo.update_super_clusters(user_id, db_assignments)

    assigned_count = sum(1 for v in slug_assignments.values() if v is not None)
    mode_label = "batch" if batch_mode else "realtime"
    logger.info(
        f"Super-cluster assignment: {assigned_count}/{len(clusters)} clusters "
        f"assigned to {len(keywords)} topics via {mode_label} "
        f"(cost=${cost_usd:.4f}, latency={latency_ms:.0f}ms)"
    )

    return slug_assignments


def _evidence_for(
    member_cids: list[int], labels, pages: list[dict], history: dict
) -> tuple[dict, int]:
    """(interest-evidence dict, page_count) for a set of member cluster ids.

    Shared by the main group-build loop and the carve-out pass so donor
    groups get their evidence/tier recomputed identically after members
    leave."""
    from backend.services import supercluster_discovery as sd

    idxs = [i for i in range(len(pages)) if labels[i] in member_cids]
    rows: list[dict] = []
    for i in idxs:
        rows.extend(history.get(pages[i]["db_id"], []))
    return sd.aggregate_visit_evidence(rows), len(idxs)


async def _apply_carve_outs(
    user_id: int,
    recluster_run_id: int,
    claims: dict[int, dict],
    groups: list[dict],
    members_by_group: dict[int, list[int]],
    cluster_ids: list[int],
    labels,
    pages: list[dict],
    history: dict,
    cluster_names: dict[int, str],
) -> tuple[list[dict], dict[int, list[int]]]:
    """Materialize cluster-level keyword claims (fix B+C, 2026-07-14 spec).

    One carved group per claiming keyword (source='keyword', tier declared).
    Audits are PER-MEMBER with a per-member ceiling (fix-design 2026-07-16,
    P3): a member cluster's own claim sim >= VERIFY_SIM_CEILING auto-accepts;
    every member below it is audited INDIVIDUALLY via `_verify_topic_members`
    — FAIL-OPEN — and a rejected MEMBER (not the whole carve group) dissolves
    back into its donor group. Donors that lose members get evidence/counts
    recomputed; donors emptied entirely are dropped (no row, no paint).
    Returns updated (groups, members_by_group)."""
    from backend.services import supercluster_discovery as sd

    by_keyword: dict[str, list[tuple[int, float]]] = {}
    for row_idx, claim in claims.items():
        by_keyword.setdefault(claim["keyword"], []).append(
            (cluster_ids[row_idx], claim["similarity"])
        )

    next_index = max(g["group_index"] for g in groups) + 1
    carved: list[dict] = []
    carved_members: dict[int, list[int]] = {}
    carved_sims: dict[int, dict[int, float]] = {}
    for kw in sorted(by_keyword):
        pairs = by_keyword[kw]
        member_cids = [cid for cid, _ in pairs]
        evidence, page_count = _evidence_for(member_cids, labels, pages, history)
        carved.append(
            {
                "group_index": next_index,
                "topic": kw,
                "topic_similarity": max(s for _, s in pairs),
                "interest_tier": sd.interest_tier(
                    evidence, n_pages=page_count, declared=True
                ),
                "evidence": evidence,
                "member_count": len(member_cids),
                "page_count": page_count,
                "source": "keyword",
                "label": kw,
                "split_proposal": None,
            }
        )
        carved_members[next_index] = member_cids
        carved_sims[next_index] = {cid: s for cid, s in pairs}
        next_index += 1

    # Per-member audit (fix-design 2026-07-16, P3): a member at/above
    # VERIFY_SIM_CEILING auto-accepts; every member below is audited
    # INDIVIDUALLY. The old group-max gate let weak members ride through
    # unaudited behind one strong co-claimant (run 142: 'Travel Planning'
    # rode the machine-learning carve behind a 0.49 claimant, and the
    # whole astronomy carve skipped audit on a 0.47 max).
    to_audit = [
        {
            "group_index": g["group_index"],
            "topic": g["topic"],
            "cluster_id": cid,
            "similarity": carved_sims[g["group_index"]][cid],
        }
        for g in carved
        for cid in carved_members[g["group_index"]]
        if carved_sims[g["group_index"]][cid] < VERIFY_SIM_CEILING
    ]
    rejected_members: set[tuple[int, int]] = set()
    if to_audit:
        rejected_members, verify_cost = await _verify_topic_members(
            to_audit, cluster_names
        )
        if rejected_members:
            for g in carved:
                gi = g["group_index"]
                keep = [
                    cid for cid in carved_members[gi]
                    if (gi, cid) not in rejected_members
                ]
                if len(keep) == len(carved_members[gi]):
                    continue
                for cid in carved_members[gi]:
                    if (gi, cid) in rejected_members:
                        logger.info(
                            f"Carve claim rejected by verifier: "
                            f"'{cluster_names.get(cid, cid)}' -> "
                            f"'{g['topic']}' (sim {carved_sims[gi][cid]})"
                        )
                carved_members[gi] = keep
                if keep:
                    g["topic_similarity"] = max(carved_sims[gi][c] for c in keep)
                    evidence, page_count = _evidence_for(
                        keep, labels, pages, history
                    )
                    g["evidence"] = evidence
                    g["member_count"] = len(keep)
                    g["page_count"] = page_count
                    # Carves are declared=True so this is currently a no-op
                    # (tier short-circuits to "declared"), but recompute like
                    # the sibling shrink paths so a future tier-logic change
                    # can't leave a stale value here (2026-07-16 review).
                    g["interest_tier"] = sd.interest_tier(
                        evidence, n_pages=page_count, declared=True
                    )
            carved = [g for g in carved if carved_members[g["group_index"]]]
        if verify_cost:
            try:
                from backend.db import trends_repo

                trends_repo.insert_cost_event(
                    user_id=user_id,
                    event_type="topic_verify",
                    model=ASSIGNMENT_MODEL,
                    cost_usd=verify_cost,
                    metadata={"run_id": recluster_run_id, "carve": True,
                              "checked": len(to_audit),
                              "rejected": len(rejected_members)},
                )
            except Exception:
                logger.debug("carve verify cost event failed", exc_info=True)
    if not carved:
        return groups, members_by_group

    moved: set[int] = set()
    for g in carved:
        members_by_group[g["group_index"]] = carved_members[g["group_index"]]
        moved.update(carved_members[g["group_index"]])
        logger.info(
            f"Carve-out: {g['member_count']} cluster(s) -> '{g['topic']}' "
            f"(max sim {g['topic_similarity']})"
        )

    kept: list[dict] = []
    for g in groups:
        gi = g["group_index"]
        remaining = [c for c in members_by_group[gi] if c not in moved]
        if not remaining:
            del members_by_group[gi]
            continue
        if len(remaining) != len(members_by_group[gi]):
            members_by_group[gi] = remaining
            evidence, page_count = _evidence_for(remaining, labels, pages, history)
            g["evidence"] = evidence
            g["member_count"] = len(remaining)
            g["page_count"] = page_count
            g["interest_tier"] = sd.interest_tier(
                evidence, n_pages=page_count, declared=g["topic"] is not None
            )
        kept.append(g)
    return kept + carved, members_by_group


def _apply_member_exclusions(
    exclusions: set[tuple[str, str]],
    groups: list[dict],
    members_by_group: dict[int, list[int]],
    cluster_names: dict[int, str],
    labels,
    pages: list[dict],
    history: dict,
) -> tuple[list[dict], dict[int, list[int]]]:
    """Class-(e) negative feedback (sc-followups 2026-07-16): peel user-
    excluded (keyword, cluster) members out of their keyword group.

    Mirrors the support gate's residual mechanics exactly (same group-dict
    shape): excluded members of a donor form ONE residual suggested group
    per donor (topic None, source 'suggested', label filled by the naming
    pass below); the donor shrinks with evidence/count/tier recomputed. A
    fully-excluded keyword group (every member excluded) is dropped -- no
    row, no paint. Runs over every group with a topic, so it covers BOTH
    declared keyword matches and carved groups (the caller applies this
    after `_apply_carve_outs`).
    """
    from backend.services import supercluster_discovery as sd
    from backend.services.clustering_service import _slugify

    next_index = max(g["group_index"] for g in groups) + 1
    residuals: list[dict] = []
    emptied: set[int] = set()
    for g in groups:
        if not g["topic"]:
            continue
        gi = g["group_index"]
        member_cids = members_by_group[gi]
        topic_lower = g["topic"].lower()
        excluded = [
            cid for cid in member_cids
            if (topic_lower, _slugify(cluster_names[cid])) in exclusions
        ]
        if not excluded:
            continue
        excluded_set = set(excluded)
        kept = [cid for cid in member_cids if cid not in excluded_set]
        logger.info(
            f"Member exclusion: group {gi} '{g['topic']}' — {len(excluded)} "
            f"member(s) excluded -> residual suggested group {next_index}"
        )
        evidence, page_count = _evidence_for(excluded, labels, pages, history)
        residuals.append(
            {
                "group_index": next_index,
                "topic": None,
                "topic_similarity": 0.0,
                "interest_tier": sd.interest_tier(
                    evidence, n_pages=page_count, declared=False
                ),
                "evidence": evidence,
                "member_count": len(excluded),
                "page_count": page_count,
                "source": "suggested",
                "label": None,
                "split_proposal": None,
            }
        )
        members_by_group[next_index] = excluded
        if kept:
            members_by_group[gi] = kept
            evidence, page_count = _evidence_for(kept, labels, pages, history)
            g["evidence"] = evidence
            g["member_count"] = len(kept)
            g["page_count"] = page_count
            g["interest_tier"] = sd.interest_tier(
                evidence, n_pages=page_count, declared=True
            )
        else:
            emptied.add(gi)
        next_index += 1

    if emptied:
        for gi in emptied:
            del members_by_group[gi]
        groups = [g for g in groups if g["group_index"] not in emptied]
    groups.extend(residuals)
    return groups, members_by_group


def _collapse_singleton_groups(
    groups: list[dict],
    members_by_group: dict[int, list[int]],
    cluster_ids: list[int],
    cents,
    labels,
    pages: list[dict],
    history: dict,
    threshold: float,
    exclusions: set[tuple[str, str]] | None = None,
    cluster_names: dict[int, str] | None = None,
    blocked_pairs: set[tuple[int, int]] | None = None,
) -> tuple[list[dict], dict[int, list[int]]]:
    """Fold legally-single-member groups into their nearest multi-member
    group (clustering-quality backlog, item 3). ``discover_groups`` legally
    emits singleton groups (its own docstring says so), but many read as
    clutter once the later passes (support gate, carve-outs, exclusions)
    have run — a carved-out cluster can land <0.1 cosine away from the very
    group it was carved from. Runs after naming/dismissed-marking (fresh
    labels needed for dismissed protection) but before ``_compute_split_
    proposals`` (fix 4, clustering-quality backlog review 2026-08-14: an
    absorbing target's split proposal must reflect its FINAL membership,
    not stale pre-collapse members), so "single-member" and "nearest
    multi-member centroid" are judged against final run state minus split
    proposals, which is recomputed afterward anyway.

    Distances are computed once against the PRE-collapse target centroids
    (frozen before the loop) so the outcome doesn't depend on iteration
    order across multiple singletons absorbed into the same target.
    ``threshold`` <= 0 disables the pass — singletons stay exactly as
    discovered/carved. Dismissed groups (source == 'dismissed') are
    excluded as both merge source and merge target: dismissal is a
    user-negative signal and NULL/dismissal semantics on
    ``clusters.super_cluster`` are reserved (see the dismissed-skip at
    persistence below) — this pass never writes NULL, it only ever
    repoints a singleton's members at ANOTHER real group's label. The
    absorbing group keeps its own label/source/topic; only member_count,
    page_count, and interest_tier are recomputed (via the same
    ``_evidence_for``/``sd.interest_tier`` calls the other membership
    passes use — no ad-hoc arithmetic). Singletons with no near-enough
    multi-member neighbor remain singletons, same as today.

    Three additional per-candidate guards (review fixes 1-3,
    2026-08-14) skip an otherwise-eligible target:

    - ``exclusions`` — user member-exclusions (``sc_member_exclusions``,
      same ``(keyword_lower, cluster_slug)`` shape ``_apply_member_
      exclusions`` matches on). A residual singleton peeled off by an
      exclusion must never fold back into a target whose topic is the
      excluded keyword — that would silently undo the user's explicit
      boundary. Requires ``cluster_names`` to slugify the singleton's
      sole member.
    - Same-label guard (fix 2) — a keyword-source singleton (``source ==
      "keyword"``, i.e. a surviving carve fragment or a lone verified
      keyword match) may only merge into a target whose ``label``
      case-insensitively matches its OWN label. Folding a verified
      different-keyword carve into an unrelated group's label would
      silently undo an LLM-audited carve decision. Non-keyword-source
      (``"suggested"``) singletons are unaffected — they may merge into
      any eligible target, keyword or suggested.
    - ``blocked_pairs`` — ``(donor_group_index, member_cid)`` pairs
      produced by the support-fraction gate's pruning (fix 3): a member
      the gate just pushed OUT of a group for weak individual support
      must not immediately fold back into that SAME group via geometric
      proximity (other targets remain eligible).
    """
    if threshold <= 0:
        return groups, members_by_group

    import numpy as np

    from backend.services import supercluster_discovery as sd
    from backend.services.clustering_service import _slugify

    exclusions = exclusions or set()
    cluster_names = cluster_names or {}
    blocked_pairs = blocked_pairs or set()

    row_of = {cid: i for i, cid in enumerate(cluster_ids)}

    def group_centroid(member_cids: list[int]) -> np.ndarray | None:
        rows = [cents[row_of[cid]] for cid in member_cids if cid in row_of]
        if not rows:
            return None
        mean = np.mean(rows, axis=0)
        norm = np.linalg.norm(mean)
        return mean / norm if norm > 0 else mean

    targets = [
        g for g in groups
        if g["member_count"] >= 2 and g["source"] != "dismissed"
    ]
    if not targets:
        return groups, members_by_group
    target_centroids = {
        g["group_index"]: group_centroid(members_by_group[g["group_index"]])
        for g in targets
    }
    groups_by_index = {g["group_index"]: g for g in groups}

    absorbed: set[int] = set()
    for g in groups:
        if g["member_count"] != 1 or g["source"] == "dismissed":
            continue
        gi = g["group_index"]
        member_cid = members_by_group[gi][0]
        member_slug = _slugify(cluster_names[member_cid]) if member_cid in cluster_names else None
        is_keyword_source = g["source"] == "keyword"
        svec = group_centroid(members_by_group[gi])
        if svec is None:
            continue
        best_gid, best_dist = None, None
        for tg in targets:
            tgi = tg["group_index"]
            if (tgi, member_cid) in blocked_pairs:
                continue
            if member_slug and tg["topic"] and (tg["topic"].lower(), member_slug) in exclusions:
                continue
            if is_keyword_source and (
                not tg["label"] or tg["label"].lower() != g["label"].lower()
            ):
                continue
            tvec = target_centroids[tgi]
            if tvec is None:
                continue
            dist = 1.0 - float(np.dot(svec, tvec))
            if best_dist is None or dist < best_dist:
                best_gid, best_dist = tgi, dist
        if best_gid is None or best_dist > threshold:
            continue

        target = groups_by_index[best_gid]
        members_by_group[best_gid] = members_by_group[best_gid] + members_by_group[gi]
        del members_by_group[gi]
        evidence, page_count = _evidence_for(
            members_by_group[best_gid], labels, pages, history
        )
        target["evidence"] = evidence
        target["member_count"] = len(members_by_group[best_gid])
        target["page_count"] = page_count
        target["interest_tier"] = sd.interest_tier(
            evidence, n_pages=page_count, declared=target["topic"] is not None
        )
        absorbed.add(gi)
        logger.info(
            f"Singleton collapse: group {gi} ('{g['label']}') -> group "
            f"{best_gid} ('{target['label']}'), distance {best_dist:.4f}"
        )

    if absorbed:
        groups = [g for g in groups if g["group_index"] not in absorbed]
    return groups, members_by_group


async def assign_super_clusters_hybrid(
    user_id: int,
    recluster_run_id: int,
    labels,
    cluster_names: dict[int, str],
    pages: list[dict],
    embeddings,
    slug_to_db_id: dict[str, int],
) -> dict:
    """Hybrid supercluster assignment (batch B 4b; Q2 = Hybrid; F13/F17/F18).

    Inverts the legacy direction: groups are DISCOVERED from cluster-centroid
    geometry (``supercluster_discovery``), the user's ``topic_interests``
    keywords are embedding-mapped ONTO groups, and unmatched groups become
    suggested topics (gpt-4o-mini labels, JSON mode). Interest tiers come
    from visit-recurrence evidence. Works with ZERO typed keywords — the F13
    dead end (no keywords → everything NULL) is gone.

    Persists: ``super_cluster_groups`` rows, ``clusters.group_id``, and the
    display label into ``clusters.super_cluster`` (both grouping modes share
    that column, so the D3 Phase-1.5 layout and /api/topics counts work
    unchanged). Suggested-name LLM failure degrades to a member-derived
    fallback label — never a wipe.

    Args mirror the recluster pipeline's in-memory state: ``labels`` is the
    POST-slug-dedup label array, ``embeddings`` the ORIGINAL-space matrix,
    ``slug_to_db_id`` the mapping returned by ``_write_clusters_to_db``.
    Runs realtime-only (suggested-name spend is pennies; Batch API not worth
    the 24h SLA here).
    """
    import numpy as np

    from backend.db import auth_repo, page_repo
    from backend.services import supercluster_discovery as sd
    from backend.services.clustering_service import _slugify

    cluster_ids = sorted(set(int(c) for c in labels[labels != -1]))
    if not cluster_ids:
        return {"groups": 0, "matched": 0, "suggested": 0}

    cents = np.vstack(
        [embeddings[labels == cid].mean(axis=0) for cid in cluster_ids]
    )
    norms = np.linalg.norm(cents, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    cents = cents / norms

    from backend.config.settings import settings

    group_labels = sd.discover_groups(
        cents, distance_threshold=settings.supercluster_group_threshold
    )
    group_cents = sd.compute_group_centroids(cents, group_labels)

    prefs = auth_repo.get_preferences(user_id)
    all_topics = prefs.get("topic_interests", [])
    interests = [t for t in all_topics if t.get("keyword")]
    keywords = [t["keyword"] for t in interests]

    # Depth-1 umbrella expansion (2026-07-14 spec): keywords match through
    # LLM-generated narrower sub-terms (max-over-terms similarity). Terms
    # are generated lazily — once per keyword lifetime — and cached inside
    # the topic_interests entry, so keyword edits (new entry, no terms)
    # self-heal on the next recluster. Fail-open at every stage.
    expansion: dict[str, list[str]] = {}
    if keywords and settings.supercluster_keyword_expansion:
        missing = [t["keyword"] for t in interests if not t.get("expansion_terms")]
        if missing:
            generated, exp_cost = await _expand_keywords(missing)
            if generated:
                for t in interests:
                    if t["keyword"] in generated:
                        t["expansion_terms"] = generated[t["keyword"]]
                auth_repo.update_preferences(
                    user_id, {"topic_interests": all_topics}
                )
                try:
                    from backend.db import trends_repo

                    trends_repo.insert_cost_event(
                        user_id=user_id,
                        event_type="keyword_expansion",
                        model=ASSIGNMENT_MODEL,
                        cost_usd=exp_cost,
                        metadata={"run_id": recluster_run_id,
                                  "keywords": len(generated)},
                    )
                except Exception:
                    logger.debug(
                        "keyword expansion cost event failed", exc_info=True
                    )
        expansion = {
            t["keyword"]: list(t.get("expansion_terms") or []) for t in interests
        }

    flat_terms: list[str] = []
    term_slices: list[slice] = []
    for k in keywords:
        terms = [k] + expansion.get(k, [])
        term_slices.append(slice(len(flat_terms), len(flat_terms) + len(terms)))
        flat_terms.extend(terms)
    all_vecs = sd.embed_keywords(flat_terms, user_id=user_id)
    term_vectors = [all_vecs[s] for s in term_slices]
    kw_vecs = (
        np.vstack([tv[0] for tv in term_vectors])
        if term_vectors
        else np.empty((0, 0))
    )

    group_sims = sd.keyword_sim_matrix(group_cents, term_vectors)
    mapping = sd.map_topics_to_groups(
        group_cents, keywords, kw_vecs,
        match_threshold=settings.supercluster_topic_match_threshold,
        sims=group_sims,
    )

    # Accepted splits (batch C C2, keep-both semantics): umbrellas the user
    # split stay as keywords, but the GROUPING subdivides along the finer
    # cut, and each piece re-maps independently — the accepted subgroup
    # keywords win their pieces, leftovers may keep the umbrella label.
    split_topics = {t.lower() for t in prefs.get("split_topics", [])}
    if split_topics:
        to_split = {
            g for g, m in mapping.items()
            if m["topic"] and m["topic"].lower() in split_topics
        }
        if to_split:
            fine_labels = sd.discover_groups(
                cents,
                distance_threshold=settings.supercluster_split_threshold,
            )
            group_labels = sd.subdivide_groups(group_labels, fine_labels, to_split)
            group_cents = sd.compute_group_centroids(cents, group_labels)
            group_sims = sd.keyword_sim_matrix(group_cents, term_vectors)
            mapping = sd.map_topics_to_groups(
                group_cents, keywords, kw_vecs,
                match_threshold=settings.supercluster_topic_match_threshold,
                sims=group_sims,
            )
            logger.info(
                f"Split overrides applied: {len(to_split)} umbrella group(s) "
                f"subdivided -> {int(group_labels.max()) + 1} groups total"
            )

    clustered_page_ids = [
        pages[i]["db_id"] for i in range(len(pages)) if labels[i] != -1
    ]
    history = page_repo.get_visit_history(user_id, clustered_page_ids)

    n_groups = int(group_labels.max()) + 1
    groups: list[dict] = []
    members_by_group: dict[int, list[int]] = {}
    for g in range(n_groups):
        member_cids = [cluster_ids[k] for k in np.where(group_labels == g)[0]]
        members_by_group[g] = member_cids
        evidence, page_count = _evidence_for(member_cids, labels, pages, history)
        m = mapping.get(g, {"topic": None, "similarity": 0.0})
        groups.append(
            {
                "group_index": g,
                "topic": m["topic"],
                "topic_similarity": m["similarity"],
                "interest_tier": sd.interest_tier(
                    evidence, n_pages=page_count,
                    declared=m["topic"] is not None,
                ),
                "evidence": evidence,
                "member_count": len(member_cids),
                "page_count": page_count,
                "source": "keyword" if m["topic"] else "suggested",
                "label": m["topic"],  # suggested labels filled below
                "split_proposal": None,  # filled below for declared umbrellas
            }
        )

    # Verify EVERY keyword match before labeling (batch C C4; widened by
    # fix-design 2026-07-16 P1). The old ceiling exemption assumed strong
    # matches are uniformly genuine — falsified on run 142, where a 0.5053
    # group (graphic-design clusters labeled '3d printing' via an expansion
    # term) was wrong and the verifier rejected it when shown, while the
    # strong 0.529 true group passed (both stable across repeat calls).
    # A wrongly-rejected strong group is not lost: its genuinely-strong
    # members re-enter via the carve pass below (per-member auto-accept at
    # VERIFY_SIM_CEILING). Fail-open: a verify failure keeps the embedding
    # matches — verification only removes bad matches, never wipes good ones.
    matched = [g for g in groups if g["topic"]]
    if matched:
        rejected, verify_cost = await _verify_topic_matches(
            matched, members_by_group, cluster_names
        )
        for g in matched:
            if g["group_index"] in rejected:
                logger.info(
                    f"Topic match demoted by verifier: group {g['group_index']} "
                    f"'{g['topic']}' (sim {g['topic_similarity']})"
                )
                g["topic"] = None
                g["label"] = None
                g["source"] = "suggested"
                g["interest_tier"] = sd.interest_tier(
                    g["evidence"], n_pages=g["page_count"], declared=False
                )
        if verify_cost:
            try:
                from backend.db import trends_repo

                trends_repo.insert_cost_event(
                    user_id=user_id,
                    event_type="topic_verify",
                    model=ASSIGNMENT_MODEL,
                    cost_usd=verify_cost,
                    metadata={"run_id": recluster_run_id,
                              "checked": len(matched), "rejected": len(rejected)},
                )
            except Exception:
                logger.debug("topic verify cost event failed", exc_info=True)

    # Class-(e) negative feedback (sc-followups 2026-07-16): user-dismissed
    # (keyword, cluster) pairs are a hard exclusion — the one signal that
    # encodes the USER's semantic boundary rather than embedding space's
    # (run-142 residual: Hominin Evolution, Snow and Ice Phenomena). Built
    # here (before the carve block) so both the claim filter below and the
    # post-carve `_apply_member_exclusions` call share one set.
    exclusions = {
        (e["keyword"].lower(), e["cluster_slug"])
        for e in prefs.get("sc_member_exclusions", [])
    }

    # Run-local (donor group_index, pruned member cid) pairs produced by
    # the support-fraction gate below (fix 3, clustering-quality backlog
    # review 2026-08-14): the singleton-collapse pass must not fold a
    # just-pruned member straight back into the SAME group it was pruned
    # from (other targets remain eligible). No schema/persistence change —
    # lives only for the duration of this call.
    support_gate_pruned: set[tuple[int, int]] = set()

    # Cluster-level carve-outs (fix B+C, 2026-07-14 spec): group-level
    # mapping above stays the recall mechanism; this pass adds precision.
    # A cluster with a strong INDIVIDUAL claim to a different keyword than
    # its group's post-verify topic is carved into a per-keyword group
    # (margin-band claims audited, rejects revert). Runs BEFORE suggested-
    # label naming so donor labels describe their final membership.
    if keywords:
        cluster_sims = sd.keyword_sim_matrix(cents, term_vectors)
        row_of = {cid: i for i, cid in enumerate(cluster_ids)}

        # Support-fraction gate (fix-design 2026-07-16, P2): a keyword
        # group where fewer than supercluster_group_support_min of the
        # members individually clear the match threshold is passenger-
        # heavy — group averaging is hiding members that do not resemble
        # the topic (run 142: 12 of 17 misfires were such passengers, and
        # per-member distance-to-centroid does NOT separate them; own
        # keyword sim does). Passing members keep the keyword group;
        # failing members move to a residual suggested group (named by the
        # suggested-label pass below) and stay eligible for carve claims.
        # Cohesive groups are untouched — group averaging stays the recall
        # mechanism, so this never degenerates into the pure cluster-level
        # claiming the carve-outs spec ruled out for recall.
        support_min = settings.supercluster_group_support_min
        if support_min > 0:
            match_thr = settings.supercluster_topic_match_threshold
            kw_col = {k: j for j, k in enumerate(keywords)}
            next_index = max(g["group_index"] for g in groups) + 1
            residuals: list[dict] = []
            emptied: set[int] = set()
            for g in groups:
                if not g["topic"]:
                    continue
                gi = g["group_index"]
                member_cids = members_by_group[gi]
                j = kw_col[g["topic"]]
                passing = [
                    cid for cid in member_cids
                    if float(cluster_sims[row_of[cid]][j]) >= match_thr
                ]
                if len(passing) / len(member_cids) >= support_min:
                    continue
                passing_set = set(passing)
                failing = [
                    cid for cid in member_cids if cid not in passing_set
                ]
                support_gate_pruned.update((gi, cid) for cid in failing)
                logger.info(
                    f"Support gate: group {gi} '{g['topic']}' support "
                    f"{len(passing)}/{len(member_cids)} < {support_min} — "
                    f"{len(failing)} member(s) -> residual suggested group "
                    f"{next_index}"
                )
                evidence, page_count = _evidence_for(
                    failing, labels, pages, history
                )
                residuals.append(
                    {
                        "group_index": next_index,
                        "topic": None,
                        "topic_similarity": 0.0,
                        "interest_tier": sd.interest_tier(
                            evidence, n_pages=page_count, declared=False
                        ),
                        "evidence": evidence,
                        "member_count": len(failing),
                        "page_count": page_count,
                        "source": "suggested",
                        "label": None,
                        "split_proposal": None,
                    }
                )
                members_by_group[next_index] = failing
                for cid in failing:
                    group_labels[row_of[cid]] = next_index
                if passing:
                    members_by_group[gi] = passing
                    evidence, page_count = _evidence_for(
                        passing, labels, pages, history
                    )
                    g["evidence"] = evidence
                    g["member_count"] = len(passing)
                    g["page_count"] = page_count
                    g["interest_tier"] = sd.interest_tier(
                        evidence, n_pages=page_count, declared=True
                    )
                else:
                    emptied.add(gi)
                next_index += 1
            if emptied:
                for gi in emptied:
                    del members_by_group[gi]
                groups = [
                    g for g in groups if g["group_index"] not in emptied
                ]
            groups.extend(residuals)

        group_topics = {g["group_index"]: g["topic"] for g in groups}
        claims = sd.refine_by_cluster(
            group_labels, group_topics, keywords, cluster_sims,
            match_threshold=settings.supercluster_topic_match_threshold,
            margin=settings.supercluster_carve_margin,
        )
        if claims:
            # Excluded (keyword, cluster) pairs never carve, even when the
            # individual claim is strong — the exclusion is the user's
            # explicit boundary and must win over embedding-space signal.
            claims = {
                i: c for i, c in claims.items()
                if (c["keyword"].lower(),
                    _slugify(cluster_names[cluster_ids[i]])) not in exclusions
            }
        if claims:
            groups, members_by_group = await _apply_carve_outs(
                user_id, recluster_run_id, claims, groups, members_by_group,
                cluster_ids, labels, pages, history, cluster_names,
            )

    # Excluded members leave their keyword group into a residual suggested
    # group, exactly like the support gate prunes passengers. Applied AFTER
    # carves so it covers both membership mechanisms (declared matches and
    # carved groups).
    if exclusions:
        groups, members_by_group = _apply_member_exclusions(
            exclusions, groups, members_by_group, cluster_names,
            labels, pages, history,
        )

    # Suggested-topic labels for unmatched groups (JSON mode + fallback).
    unlabeled = [g for g in groups if g["label"] is None]
    naming_cost = 0.0
    if unlabeled:
        # Already-known labels of OTHER groups in this run (declared /
        # keyword-matched groups that didn't need LLM naming) -- only
        # consumed by supercluster_label_v1b's distinctiveness rule; see
        # _suggest_group_labels's docstring.
        sibling_labels = sorted({g["label"] for g in groups if g.get("label")})
        suggested, naming_cost = await _suggest_group_labels(
            unlabeled, members_by_group, cluster_names,
            sibling_labels=sibling_labels,
        )
        for g in unlabeled:
            g["label"] = suggested.get(g["group_index"]) or _fallback_group_label(
                members_by_group[g["group_index"]], cluster_names, labels
            )
        try:
            from backend.db import trends_repo

            trends_repo.insert_cost_event(
                user_id=user_id,
                event_type="group_naming",
                model=ASSIGNMENT_MODEL,
                cost_usd=naming_cost,
                metadata={"run_id": recluster_run_id, "groups": len(unlabeled)},
            )
        except Exception:
            logger.debug("group naming cost event failed", exc_info=True)

    # Dismissed suggestions stay dismissed (design audit 2026-07-11 §1C).
    # Previously dismissal only hid the panel row; the group was rediscovered,
    # relabeled, painted onto clusters, and counted every subsequent run. Now
    # a suggested group whose fresh label matches preferences.dismissed_topics
    # keeps its row (source='dismissed' — the negative-signal substrate for
    # batch D) but is NOT painted: no cluster label, no group FK, so no
    # territory on the graph and no badge count.
    dismissed_labels = {
        d["label"].lower()
        for d in prefs.get("dismissed_topics", [])
        if d.get("label")
    }
    if dismissed_labels:
        for g in groups:
            if (
                g["source"] == "suggested"
                and g["label"]
                and g["label"].lower() in dismissed_labels
            ):
                g["source"] = "dismissed"

    # Singleton collapse (clustering-quality backlog, item 3): fold
    # legally-single-member groups into their nearest multi-member group.
    # Runs after every membership-mutating pass above (support gate,
    # carve-outs, exclusions, dismissed-marking), so "single-member" and
    # "nearest multi-member centroid" reflect final run state — several
    # run-171 singletons were carve-out fragments sitting well under this
    # threshold from the group they were carved out of. Runs BEFORE
    # ``_compute_split_proposals`` (fix 4, review 2026-08-14): proposals
    # read nothing this pass produces on the way in, but an absorbing
    # target's proposal must reflect its POST-collapse membership, not a
    # stale pre-collapse snapshot — so collapse must land first.
    groups, members_by_group = _collapse_singleton_groups(
        groups, members_by_group, cluster_ids, cents, labels, pages, history,
        threshold=settings.supercluster_singleton_merge_threshold,
        exclusions=exclusions,
        cluster_names=cluster_names,
        blocked_pairs=support_gate_pruned,
    )

    # Split proposals for declared umbrellas (batch C C2): cut the SAME
    # centroid linkage tree at the finer threshold; a keyword group spanning
    # >=2 subgroups gets its subgroups stored as an actionable proposal
    # ("split science into ...?"). Nesting is exact — same tree, lower cut.
    # Runs AFTER singleton collapse so an absorbing group's proposal is
    # computed over its final membership.
    _compute_split_proposals(
        cents, groups, members_by_group, cluster_ids,
        cluster_names, labels, slug_to_db_id,
    )

    # Persist groups, then point clusters at them (label + FK). Dismissed
    # groups are persisted but never painted.
    index_to_group_id = cluster_repo.save_super_cluster_groups(
        user_id, recluster_run_id, groups
    )
    label_assignments: dict[int, str | None] = {}
    group_assignments: dict[int, int | None] = {}
    for g in groups:
        if g["source"] == "dismissed":
            continue
        db_group_id = index_to_group_id[g["group_index"]]
        for cid in members_by_group[g["group_index"]]:
            db_cluster_id = slug_to_db_id.get(_slugify(cluster_names[cid]))
            if db_cluster_id:
                label_assignments[db_cluster_id] = g["label"]
                group_assignments[db_cluster_id] = db_group_id
    cluster_repo.update_super_clusters(user_id, label_assignments)
    cluster_repo.update_cluster_groups(user_id, group_assignments)

    matched = sum(1 for g in groups if g["source"] == "keyword")
    dismissed = sum(1 for g in groups if g["source"] == "dismissed")
    logger.info(
        f"Hybrid superclusters: {len(groups)} groups discovered "
        f"({matched} keyword-matched, {len(groups) - matched - dismissed} "
        f"suggested, {dismissed} dismissed), "
        f"{len(label_assignments)} clusters labeled, "
        f"naming ${naming_cost:.4f}"
    )
    return {
        "groups": len(groups),
        "matched": matched,
        "suggested": len(groups) - matched - dismissed,
        "dismissed": dismissed,
        "naming_cost": naming_cost,
    }


def apply_member_exclusion_now(
    user_id: int, keyword: str, cluster_slug: str
) -> bool:
    """Immediately unlabel a cluster on a fresh member exclusion, without
    waiting for the next recluster (class-(e), sc-followups 2026-07-16).

    Looks up the cluster by slug in the latest completed run; if it is
    currently painted with *keyword* (case-insensitive), clears both
    ``super_cluster`` and ``group_id`` and best-effort rebuilds graph_cache
    (mirrors the rebuild block in ``ClusteringService.recluster_all`` —
    failure is logged but non-fatal, the cluster mutation stands regardless
    since graph_cache can be rebuilt later).

    Shared by the ``POST /api/topics/exclusions`` endpoint and Task 5's UI
    callback so the unlabel logic lives in exactly one place.

    Returns whether a cluster was actually unlabeled (False when no cluster
    matches the slug, or it isn't currently labeled with this keyword).
    """
    from backend.db import cluster_repo
    from backend.services.clustering_service import _slugify

    clusters = cluster_repo.get_clusters_for_user(user_id)
    target = next(
        (c for c in clusters if _slugify(c["cluster_name"]) == cluster_slug), None
    )
    if target is None:
        return False
    current = target.get("super_cluster")
    if not current or current.lower() != keyword.lower():
        return False

    cluster_repo.update_super_clusters(user_id, {target["id"]: None})
    cluster_repo.update_cluster_groups(user_id, {target["id"]: None})
    logger.info(
        f"Member exclusion unlabel: cluster {target['id']} "
        f"('{target['cluster_name']}') cleared from '{keyword}'"
    )

    try:
        from backend.services.graph_builder import build_graph_from_db
        from backend.services.graph_service import save_graph

        graph = build_graph_from_db(user_id)
        save_graph(graph, user_id)
    except Exception:
        logger.exception(
            "graph_cache rebuild failed after member-exclusion unlabel "
            "(user %s, cluster %s) — unlabel stands, graph_cache may be stale",
            user_id, cluster_slug,
        )
    return True


def _compute_split_proposals(
    cents,
    groups: list[dict],
    members_by_group: dict[int, list[int]],
    cluster_ids: list[int],
    cluster_names: dict[int, str],
    labels,
    slug_to_db_id: dict[str, int],
) -> None:
    """Attach ``split_proposal`` to declared groups spanning >=2 fine subgroups.

    Subgroup labels use the largest member cluster's name (no LLM — the pass
    judges whether abstractive labels are needed). Mutates ``groups`` in
    place; groups without a viable split keep split_proposal=None.
    """
    from backend.config.settings import settings
    from backend.services import supercluster_discovery as sd
    from backend.services.clustering_service import _slugify

    declared = [g for g in groups if g["topic"] and g["member_count"] >= 2]
    if not declared:
        return

    fine = sd.discover_groups(
        cents, distance_threshold=settings.supercluster_split_threshold
    )
    idx_of = {cid: k for k, cid in enumerate(cluster_ids)}
    for g in declared:
        by_fine: dict[int, list[int]] = {}
        for cid in members_by_group[g["group_index"]]:
            by_fine.setdefault(int(fine[idx_of[cid]]), []).append(cid)
        if len(by_fine) < 2:
            continue
        proposal = []
        for cids in sorted(by_fine.values(), key=len, reverse=True):
            biggest = max(cids, key=lambda c: int((labels == c).sum()))
            proposal.append(
                {
                    "label": cluster_names.get(biggest) or f"cluster {biggest}",
                    "cluster_db_ids": [
                        db_id for c in cids
                        if (db_id := slug_to_db_id.get(_slugify(cluster_names[c])))
                    ],
                    "n_clusters": len(cids),
                    "n_pages": int(sum(int((labels == c).sum()) for c in cids)),
                }
            )
        g["split_proposal"] = proposal
        logger.info(
            f"Split proposal for '{g['topic']}': "
            f"{' / '.join(p['label'] for p in proposal)}"
        )


def _fallback_group_label(
    member_cids: list[int], cluster_names: dict[int, str], labels
) -> str:
    """Label of the largest member cluster — used when LLM naming fails.
    Degrades gracefully (a real topical name, just less abstractive)."""
    biggest = max(member_cids, key=lambda c: int((labels == c).sum()))
    return cluster_names.get(biggest) or f"Group {member_cids[0]}"


async def _verify_topic_matches(
    matched_groups: list[dict],
    members_by_group: dict[int, list[int]],
    cluster_names: dict[int, str],
) -> tuple[set[int], float]:
    """One batched gpt-4o-mini call auditing every keyword→group match.

    Returns ({rejected group_index}, cost_usd). FAIL-OPEN: any call or parse
    failure returns an empty rejection set — the embedding matches stand
    (increment-3-validated baseline). Same "do not force" spirit as the
    legacy classifier prompt: a genuine-but-partial fit should PASS; only
    reject when the topic misdescribes the group's actual subject matter.
    """
    payload = [
        {
            "group_id": g["group_index"],
            "topic": g["topic"],
            "clusters": [
                cluster_names.get(cid, f"cluster {cid}")
                for cid in members_by_group[g["group_index"]]
            ],
        }
        for g in matched_groups
    ]
    prompt = (
        "Each entry pairs a user TOPIC with a GROUP of related web-page "
        "clusters that was matched to it automatically. For each entry, "
        "decide whether the topic genuinely describes the group's subject "
        "matter.\n\n"
        "RULES:\n"
        "- Judge the actual subject matter, not surface keywords.\n"
        "- A partial fit that covers the group's core is fits=true.\n"
        "- If MOST member clusters fit the topic, fits=true — never reject "
        "over a minority of adjacent or miscellaneous clusters.\n"
        "- Reject only when the topic misdescribes the group as a whole "
        "(e.g. a keyboard-ergonomics group labeled '3d printing').\n\n"
        f"ENTRIES (JSON):\n{json.dumps(payload, ensure_ascii=False)}\n\n"
        "Return JSON ONLY in this exact shape:\n"
        '{"verdicts": [{"group_id": <id>, "fits": true|false, '
        '"reason": "<one short sentence>"}, ...]}'
    )
    llm = LLMService()
    try:
        response = await llm.complete(
            prompt=prompt,
            model=ASSIGNMENT_MODEL,
            temperature=0.0,
            max_tokens=2000,
            seed=ASSIGNMENT_SEED,
            response_format="json_object",
        )
    except Exception as e:
        logger.error(f"Topic-match verify call failed (fail-open): {e}")
        return set(), 0.0

    known = {g["group_index"] for g in matched_groups}
    rejected: set[int] = set()
    try:
        for entry in json.loads(response.content).get("verdicts", []):
            gid = entry.get("group_id")
            if gid in known and entry.get("fits") is False:
                rejected.add(gid)
                logger.debug(
                    f"verify reject group {gid}: {entry.get('reason', '')}"
                )
    except (json.JSONDecodeError, ValueError) as e:
        logger.error(f"Topic-match verify parse failed (fail-open): {e}")
        return set(), response.cost_usd
    return rejected, response.cost_usd


async def _verify_topic_members(
    entries: list[dict],
    cluster_names: dict[int, str],
) -> tuple[set[tuple[int, int]], float]:
    """One batched gpt-4o-mini call auditing individual cluster→topic claims.

    ``entries``: [{"group_index", "topic", "cluster_id", "similarity"}].
    Returns ({(group_index, cluster_id) rejected}, cost_usd). FAIL-OPEN:
    any call or parse failure returns an empty rejection set — the claims
    stand.

    Complements ``_verify_topic_matches`` (one holistic verdict per group):
    a carve claim is an individual-outlier assertion by construction —
    every claimant crossed the match threshold alone — so it is judged one
    cluster at a time. The per-member shape is deliberately NOT used for
    ordinary group members, whose membership rationale is the group
    geometry, not their solo sim (fix-design 2026-07-16: the per-member
    prompt falsely rejects group-recall fits like 'Box Jellyfish and
    Cnidocytes' under zoology when applied outside carves). Prompt
    validated against the run-142 ground truth — see
    the 2026-07-14 sc-misfire-fix-design plan (private).
    """
    payload = [
        {
            "group_id": e["group_index"],
            "topic": e["topic"],
            "cluster": cluster_names.get(e["cluster_id"], f"cluster {e['cluster_id']}"),
        }
        for e in entries
    ]
    prompt = (
        "Each entry below is ONE member CLUSTER that belongs to a GROUP "
        "matched to a user TOPIC. For each entry, decide whether that "
        "specific cluster's subject matter genuinely belongs under the "
        "topic.\n\n"
        "Example: a keyboard-ergonomics CLUSTER inside a group labeled "
        "'3d printing' does not fit the topic even if most of the rest of "
        "the group does.\n\n"
        "RULES:\n"
        "- Judge each cluster on its own merits, not the group as a whole.\n"
        "- Do not let other members of the same group influence this "
        "cluster's verdict.\n"
        "- Keep it (fits=true) only if a person tracking the topic would "
        "file that specific cluster under it.\n\n"
        f"ENTRIES (JSON):\n{json.dumps(payload, ensure_ascii=False)}\n\n"
        "Return JSON ONLY in this exact shape:\n"
        '{"verdicts": [{"group_id": <id>, "cluster": "<name>", '
        '"fits": true|false, "reason": "<short>"}, ...]}'
    )
    llm = LLMService()
    try:
        response = await llm.complete(
            prompt=prompt,
            model=ASSIGNMENT_MODEL,
            temperature=0.0,
            max_tokens=4000,
            seed=ASSIGNMENT_SEED,
            response_format="json_object",
        )
    except Exception as e:
        logger.error(f"Per-member carve verify call failed (fail-open): {e}")
        return set(), 0.0

    cid_by_key = {
        (
            e["group_index"],
            cluster_names.get(e["cluster_id"], f"cluster {e['cluster_id']}"),
        ): e["cluster_id"]
        for e in entries
    }
    rejected: set[tuple[int, int]] = set()
    try:
        for entry in json.loads(response.content).get("verdicts", []):
            key = (entry.get("group_id"), entry.get("cluster"))
            cid = cid_by_key.get(key)
            if cid is not None and entry.get("fits") is False:
                rejected.add((key[0], cid))
                logger.debug(
                    f"per-member verify reject {key}: {entry.get('reason', '')}"
                )
    except (json.JSONDecodeError, ValueError) as e:
        logger.error(f"Per-member carve verify parse failed (fail-open): {e}")
        return set(), response.cost_usd
    return rejected, response.cost_usd


async def _suggest_group_labels(
    unlabeled: list[dict],
    members_by_group: dict[int, list[int]],
    cluster_names: dict[int, str],
    sibling_labels: list[str] | None = None,
) -> tuple[dict[int, str], float]:
    """One batched gpt-4o-mini call labeling all unmatched groups.

    JSON mode (4c) makes malformed output structurally unlikely; any missing
    entry falls back per-group in the caller. Returns ({group_index: label},
    cost_usd).

    Renders from the versioned prompt registry (``backend.prompts.templates``,
    entries ``supercluster_label_v1a`` / ``supercluster_label_v1b``) -- moved
    out of an inline prompt string by the clustering-quality backlog
    (2026-08-14). Version selected by
    ``settings.supercluster_label_prompt_version`` (default v1a, byte-
    identical to the pre-migration prompt). ``sibling_labels`` -- the
    already-known labels of OTHER groups in this run (declared/keyword-
    matched groups that didn't need LLM naming) -- is only consumed by
    v1b's distinctiveness rule; v1a's template has no placeholder for it,
    so it is silently ignored when v1a is active."""
    payload = [
        {
            "group_id": g["group_index"],
            "clusters": [
                cluster_names.get(cid, f"cluster {cid}")
                for cid in members_by_group[g["group_index"]]
            ],
        }
        for g in unlabeled
    ]
    if sibling_labels:
        sibling_labels_block = "\n".join(
            f"- {label}" for label in sorted(set(sibling_labels))
        )
    else:
        sibling_labels_block = (
            "(none yet -- infer distinctiveness only from the other "
            "GROUPS below)"
        )

    llm = LLMService()
    try:
        # Registry render lives INSIDE this try deliberately (review fix,
        # 2026-08-14): a typo'd SUPERCLUSTER_LABEL_PROMPT_VERSION raises
        # KeyError from get_prompt_raw() before any LLM call happens. That
        # must fail open exactly like an LLM/transport failure does --
        # groups keep their fallback labels (_fallback_group_label in the
        # caller) -- not propagate out and fail the whole recluster. This
        # is deliberately DIFFERENT from cluster_naming's pre-flight raise
        # (ClusteringService._name_clusters aborts on the first naming
        # call's failure to avoid writing garbage 'Cluster N' rows) --
        # that raise is about protecting persisted cluster rows; a bad
        # supercluster label version has no such persistence risk, so
        # fail-open is the right degrade here.
        from backend.config.settings import settings
        from backend.prompts.templates import get_prompt_raw

        prompt = get_prompt_raw(
            f"supercluster_label_{settings.supercluster_label_prompt_version}",
            groups_json=json.dumps(payload, ensure_ascii=False),
            sibling_labels_block=sibling_labels_block,
        )
        response = await llm.complete(
            prompt=prompt,
            model=ASSIGNMENT_MODEL,
            temperature=0.0,
            max_tokens=2000,
            seed=ASSIGNMENT_SEED,
            response_format="json_object",
        )
    except Exception as e:
        logger.error(f"Suggested-group naming call failed: {e}")
        return {}, 0.0

    known = {g["group_index"] for g in unlabeled}
    result: dict[int, str] = {}
    try:
        for entry in json.loads(response.content).get("labels", []):
            gid, label = entry.get("group_id"), (entry.get("label") or "").strip()
            if gid in known and label:
                result[gid] = label
    except (json.JSONDecodeError, ValueError) as e:
        logger.error(f"Suggested-group naming parse failed despite JSON mode: {e}")
    return result, response.cost_usd


async def _expand_keywords(
    keywords: list[str],
) -> tuple[dict[str, list[str]], float]:
    """One batched gpt-4o-mini call generating narrower sub-terms per keyword.

    Depth-1 umbrella expansion (2026-07-14 spec): embedding space punishes
    generality, so umbrella keywords ("science") match clusters through
    their facets ("physics", "geology") instead of the bare word. Terms are
    cached in the keyword's ``topic_interests`` entry by the caller — this
    runs once per keyword lifetime, not per recluster. FAIL-OPEN: any call
    or parse failure returns ({}, cost) — keyword-only matching (the
    pre-expansion baseline) is the degraded mode, never a crash."""
    payload = [{"topic": k} for k in keywords]
    prompt = (
        "For each TOPIC below, list 4-8 narrower sub-topics or facets that "
        "a person interested in that topic might browse. Terms must be "
        "short noun phrases (1-3 words), concrete, and strictly narrower "
        "than the topic — never synonyms of it and never broader terms.\n\n"
        f"TOPICS (JSON):\n{json.dumps(payload, ensure_ascii=False)}\n\n"
        "Return JSON ONLY in this exact shape:\n"
        '{"expansions": [{"topic": "<topic>", "terms": ["<term>", ...]}, '
        "...]}"
    )
    llm = LLMService()
    try:
        response = await llm.complete(
            prompt=prompt,
            model=ASSIGNMENT_MODEL,
            temperature=0.0,
            max_tokens=2000,
            seed=ASSIGNMENT_SEED,
            response_format="json_object",
        )
    except Exception as e:
        logger.error(f"Keyword expansion call failed (fail-open): {e}")
        return {}, 0.0

    known = set(keywords)
    result: dict[str, list[str]] = {}
    try:
        for entry in json.loads(response.content).get("expansions", []):
            topic = entry.get("topic")
            terms = [
                str(t).strip() for t in entry.get("terms") or []
                if str(t).strip()
            ]
            if topic in known and terms:
                result[topic] = terms[:8]
    except (json.JSONDecodeError, ValueError) as e:
        logger.error(f"Keyword expansion parse failed (fail-open): {e}")
    return result, response.cost_usd


async def select_icon_for_topic(topic_keyword: str) -> str:
    """Use LLM to pick the best icon from the curated manifest for a topic.

    Returns the icon_id string.
    """
    manifest = _load_icon_manifest()
    if not manifest:
        return ICON_FALLBACK

    icon_list = ", ".join(f"{icon_id} ({label})" for icon_id, label in manifest.items())

    prompt = (
        f"Pick the single best icon for the topic '{topic_keyword}'.\n\n"
        f"Available icons: {icon_list}\n\n"
        f"Output ONLY the icon id (e.g., 'microscope'), nothing else."
    )

    llm = LLMService()
    response = await llm.complete(
        prompt=prompt,
        model=ICON_MODEL,
        temperature=0.0,
        max_tokens=20,
        seed=ASSIGNMENT_SEED,
    )

    icon_id = response.content.strip().strip("\"'").lower()
    if icon_id not in manifest:
        logger.warning(
            f"LLM picked invalid icon '{icon_id}' for topic '{topic_keyword}', "
            f"falling back to {ICON_FALLBACK!r}"
        )
        return ICON_FALLBACK

    return icon_id


def _load_icon_manifest() -> dict[str, str]:
    """Load icon manifest: {icon_id: label}."""
    if not ICON_MANIFEST_PATH.exists():
        logger.warning(f"Icon manifest not found at {ICON_MANIFEST_PATH}")
        return {}
    return json.loads(ICON_MANIFEST_PATH.read_text(encoding="utf-8"))
