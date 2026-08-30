"""S5 -- Dedup-escapees.

Deterministic investigation: flags page pairs whose summary embeddings have
cosine similarity > 0.94 but distinct URLs -- candidates that slipped past
the existing dedup layer (canonical/AMP, query-string variants, mirror
domains, paginated content fragments).

Threshold (from dq_agent_scope.md): cosine similarity strictly greater
than 0.94 (equivalently, pgvector cosine distance < 0.06).

Granularity: emits one global finding per run that lists every qualifying
pair in ``recommendation.affected_entity_ids``. The scope-doc headline
``"N candidate duplicate pairs: <domain examples>"`` is naturally a
single message; downstream LLM enrichment can re-rank or split if needed.

Status filter: only ``status = 'active'`` pages are considered. Already-
archived/skipped pages have no actionable dedup outcome.

Placeholder-summary exclusion (added 2026-07-17, executive triage sweep):
pages whose ``content_summary`` matches the 'Page browsed outside API tool
scope for N seconds' placeholder (see
``backend/api/main.py::_persist_single_page`` and
``clustering_service._BOILERPLATE_SUMMARY_RE``) are excluded from the
candidate scan. These placeholders are near-identical boilerplate strings
that differ only in the dwell-time number, so pairs of them land above the
similarity threshold for no real content reason -- false "duplicates" that
pollute S5. The placeholder purge (rec RC-D, this same sweep) archives
today's population of these pages, so this filter is belt-and-braces
against regression, not the primary fix.

Emits findings structured for DQAgent.persist_findings.
"""

from collections import Counter

from backend.db.connection import get_conn
from backend.db.embedding_repo import DEFAULT_MODEL

SCOPE_ID = "S5"
ACTION_TYPE = "dedupe"
ISSUE_TYPE = "dedup_escapees"
SIMILARITY_THRESHOLD = 0.94
# pgvector cosine distance corresponding to the similarity threshold.
_DISTANCE_THRESHOLD = 1.0 - SIMILARITY_THRESHOLD
# Placeholder-summary pages (see module docstring) share this boilerplate
# prefix regardless of dwell time -- excluded from the candidate scan.
_PLACEHOLDER_SUMMARY_PATTERN = "Page browsed outside API tool scope%"


def run(user_id: int, recluster_run_id: int | None = None) -> list[dict]:
    """Return S5 findings for the given user.

    Args:
        user_id: the user to investigate.
        recluster_run_id: accepted for interface uniformity with the other
            five investigators (Task 8's full-pass snapshot calls all six
            with the same signature) but UNUSED here -- S5 scans active
            page-summary embeddings directly and has no recluster_run
            concept to scope against.

    Joins ``page_embeddings`` to itself via ``page_content`` and ``pages``,
    user-scoping through ``pages.user_id`` (denormalized in migration 003).
    Pairs are deduplicated by ``pa.id < pb.id`` and ordered deterministically
    by similarity desc, then page-id ascending.
    """
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT pa.id              AS page_a_id,
                   pb.id              AS page_b_id,
                   pca.url            AS url_a,
                   pcb.url            AS url_b,
                   pa.domain          AS domain_a,
                   pb.domain          AS domain_b,
                   (1.0 - (ea.embedding <=> eb.embedding)) AS similarity
            FROM pages pa
            JOIN page_embeddings ea ON ea.page_content_id = pa.page_content_id
            JOIN pages pb ON pb.id > pa.id
            JOIN page_embeddings eb ON eb.page_content_id = pb.page_content_id
            JOIN page_content pca ON pca.id = pa.page_content_id
            JOIN page_content pcb ON pcb.id = pb.page_content_id
            WHERE pa.user_id = %s
              AND pb.user_id = %s
              AND pa.status = 'active'
              AND pb.status = 'active'
              AND ea.model_name = %s
              AND eb.model_name = %s
              AND ea.embedding <=> eb.embedding < %s
              AND pca.url <> pcb.url
              AND (pca.content_summary IS NULL OR pca.content_summary NOT LIKE %s)
              AND (pcb.content_summary IS NULL OR pcb.content_summary NOT LIKE %s)
            ORDER BY (ea.embedding <=> eb.embedding) ASC, pa.id, pb.id
            """,
            (
                user_id,
                user_id,
                DEFAULT_MODEL,
                DEFAULT_MODEL,
                _DISTANCE_THRESHOLD,
                _PLACEHOLDER_SUMMARY_PATTERN,
                _PLACEHOLDER_SUMMARY_PATTERN,
            ),
        )
        rows = cur.fetchall()

    if not rows:
        return []

    pair_ids: list[list[int]] = []
    groups: list[dict] = []
    rationale_lines: list[str] = []
    domain_counter: Counter[str] = Counter()

    for page_a_id, page_b_id, url_a, url_b, domain_a, domain_b, similarity in rows:
        pair_ids.append([page_a_id, page_b_id])
        # Suggested keep: lower page id (captured first). Cleaner-URL
        # arbitration is deferred to downstream LLM enrichment.
        keep_id = page_a_id  # pa.id < pb.id by JOIN clause
        # Deterministic action_payload (spec S4): one group per pair, using
        # the same keep-lower-id heuristic as the rationale text below.
        groups.append({"keep_page_id": keep_id, "archive_page_ids": [page_b_id]})
        rationale_lines.append(
            f"- pages {page_a_id} & {page_b_id}: similarity {similarity:.3f} "
            f"-- {url_a} vs {url_b} (suggest keep page {keep_id})"
        )
        if domain_a:
            domain_counter[domain_a] += 1
        if domain_b and domain_b != domain_a:
            domain_counter[domain_b] += 1

    n_pairs = len(pair_ids)
    top_domains = [d for d, _ in domain_counter.most_common(3)]
    domains_str = ", ".join(top_domains) if top_domains else "no domain"
    pair_word = "pair" if n_pairs == 1 else "pairs"

    headline = f"{n_pairs} candidate duplicate {pair_word}: {domains_str}"
    observation = (
        f"Scanned page-summary embeddings for the user; found {n_pairs} "
        f"candidate duplicate {pair_word} above similarity {SIMILARITY_THRESHOLD}."
    )
    rationale = (
        f"{n_pairs} {pair_word} with summary cosine-similarity > "
        f"{SIMILARITY_THRESHOLD}:\n" + "\n".join(rationale_lines)
    )

    return [{
        "tag": "core",
        "scope_citation": SCOPE_ID,
        "adjacency_contract_ref": None,
        "issue_type": ISSUE_TYPE,
        "entity_type": "global",
        "entity_id": "dedup_pairs",
        "observation": observation,
        "severity": "info",
        "rank": 1,
        "recommendation": {
            "headline": headline,
            "rationale": rationale,
            "self_classification": "trivial" if n_pairs <= 3 else "judgment",
            "action_type": ACTION_TYPE,
            "affected_entity_ids": pair_ids,
            # Deterministic action_payload (spec S4): dedupe's shape is
            # directly derivable from the pair scan itself (keep = lower
            # page id), no extra query needed.
            "action_payload": {"groups": groups},
        },
        "handoff_prompt_draft": None,
    }]
