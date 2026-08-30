"""S3 -- Domain-silo clusters.

Deterministic investigation: flags clusters that look like source-type
silos rather than topic groupings. A cluster qualifies as a silo when:

  1. A single domain accounts for strictly more than 40% of its members, AND
  2. That same domain appears in at least 3 OTHER clusters in the same
     recluster run (so the domain is structurally overrepresented across
     the user's graph -- not topic-specific).

``MIN_CROSS_CLUSTER_APPEARANCES`` excludes the silo cluster itself, so a
qualifying silo's domain appears in >=4 clusters total (silo + >=3 others).

Aggregation (added 2026-07-17, executive triage sweep; mirrors the
dq_agent_scope.md S3 "Output shape" rule dqBot's LLM pass follows): when
more than ``AGGREGATE_CLUSTER_THRESHOLD`` qualifying clusters in one run
share the same dominant domain, this pre-detector emits ONE
``entity_type='global'`` candidate for that domain (``affected_entity_ids``
lists every affected cluster id) instead of one candidate per cluster --
the same fix applied here at the source, since the wikipedia-silo run that
motivated the scope-doc rule (recs 77/222/253) was 50 per-cluster
candidates from this exact function. Per-cluster detail (share %, page
counts) is preserved in the aggregate candidate's rationale text, not
dropped. Domains at or below the threshold are unaffected and still emit
individual per-cluster candidates as before.

Recurrence demotion (added 2026-07-17, executive vocab/rec sweep, approved
rec 248): a systemic finding (this module's >5-cluster aggregation path)
that has already been filed in >=RECURRENCE_DEMOTION_THRESHOLD prior runs
is a known, tracked pattern rather than fresh news -- it files at severity
'info' instead of 'warning', with the recurrence count named in the
observation text. ``dq_observations`` enforces
UNIQUE(user_id, entity_type, entity_id, issue_type) (migration 019) via
ON CONFLICT DO NOTHING in ``create_observation``, so at most ONE row can
ever exist for a systemic entity_id like ``domain_silo:<domain>`` --
recurrence across runs is NOT visible as repeated ``dq_observations`` rows.
It IS visible in the ``dq_recommendations`` supersession chain hanging off
that one observation: each re-detection (once the prior recommendation has
resolved) creates a NEW ``dq_recommendations`` row carrying its own
``run_id``, linked via ``observation_id`` (see DQAgent.persist_findings).
See ``_prior_systemic_recurrence_count`` below for the query and
dq_agent_scope.md's S3 section for the documented rule.

Emits findings structured for DQAgent.persist_findings.
"""

from collections import Counter, defaultdict

from backend.db.connection import get_conn

SCOPE_ID = "S3"
ACTION_TYPE = "split_cluster"
ISSUE_TYPE = "domain_silo"
SILO_SHARE_THRESHOLD = 0.40
MIN_CROSS_CLUSTER_APPEARANCES = 3
# More than this many qualifying clusters sharing one dominant domain in a
# single run collapse into one systemic finding instead of N per-cluster
# ones (dq_agent_scope.md S3 aggregation rule).
AGGREGATE_CLUSTER_THRESHOLD = 5
# >=N prior-run filings of the same systemic finding demotes it from
# 'warning' to 'info' (dq_agent_scope.md S3 recurrence-demotion rule,
# approved rec 248).
RECURRENCE_DEMOTION_THRESHOLD = 2


def _cluster_entity_ref(cluster_id: int, stable_id: str | None) -> tuple[str, dict]:
    """Return (entity_id_str, action_payload) for a per-cluster finding
    (spec S1/S4). Only used on the per-cluster path -- the >5-clusters
    aggregation path below stays entity_type='global' and is unaffected
    (it isn't a single cluster entity; see module docstring).

    entity_id is the cluster's stable_id (survives reclusters) when present;
    falls back to the stringified integer cluster id when stable_id is NULL
    (identity disabled, or a legacy/pre-036 row) -- never crashes. The
    action_payload mirrors that: {"stable_id": ...} when derivable (no page
    lists -- deriving which pages to remove needs judgment this deterministic
    pass doesn't have), else a degrade-signal {"identity": "missing"} so the
    apply layer (spec S5) falls back to record-only rather than erroring on
    an unresolvable payload.
    """
    if stable_id is not None:
        return stable_id, {"stable_id": stable_id}
    return str(cluster_id), {"identity": "missing"}


def _ordinal(n: int) -> str:
    """1 -> '1st', 2 -> '2nd', 3 -> '3rd', 4 -> '4th', 11 -> '11th', ..."""
    if 10 <= n % 100 <= 20:
        suffix = "th"
    else:
        suffix = {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n}{suffix}"


def _prior_systemic_recurrence_count(user_id: int, domain: str) -> int:
    """Count prior-run filings of the systemic domain-silo finding for
    ``domain`` (S3 recurrence-demotion rule; approved rec 248).

    Counts DISTINCT ``run_id`` in the ``dq_recommendations`` chain linked to
    this domain's one ``dq_observations`` row -- see the module docstring
    for why that row (not repeated inserts) is where recurrence actually
    lives. This function runs during the deterministic pre-detection pass,
    before the current run's own observation/recommendation exist, so every
    row it finds is necessarily from a PRIOR run; there is no run_id for
    "the current run" to exclude yet (investigation modules are called as
    ``run(user_id)`` only -- run_id is assigned later, by the orchestrator,
    at persist time).
    """
    entity_id = f"domain_silo:{domain}"
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT COUNT(DISTINCT r.run_id)
            FROM dq_recommendations r
            JOIN dq_observations o ON o.id = r.observation_id
            WHERE o.user_id = %s
              AND o.entity_type = 'global'
              AND o.entity_id = %s
              AND o.issue_type = %s
            """,
            (user_id, entity_id, ISSUE_TYPE),
        )
        row = cur.fetchone()
    return row[0] if row else 0


def _resolve_run_id(user_id: int, recluster_run_id: int | None) -> int | None:
    """Resolve the recluster_run id to scope this investigation to.

    An explicit ``recluster_run_id`` (Task 8's full-pass generation
    snapshot -- resolved ONCE at pass start and threaded to every
    investigator, so a recluster completing mid-pass can't split findings
    across two generations) is used verbatim. ``None`` falls back to this
    user's latest completed run, preserving direct/manual-invocation
    back-compat.
    """
    if recluster_run_id is not None:
        return recluster_run_id
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT id FROM recluster_runs
            WHERE user_id = %s AND status = 'completed'
            ORDER BY completed_at DESC LIMIT 1
            """,
            (user_id,),
        )
        row = cur.fetchone()
    return row[0] if row else None


def run(user_id: int, recluster_run_id: int | None = None) -> list[dict]:
    """Return S3 findings for the given user.

    Args:
        user_id: the user to investigate.
        recluster_run_id: explicit generation snapshot to scope membership
            queries to (Task 8's full-pass snapshot); an explicit id is
            used verbatim. ``None`` resolves this user's latest completed
            recluster_run internally (back-compat for direct/manual
            invocation).

    Queries cluster membership for the resolved recluster run, computes
    per-cluster domain shares and per-domain cross-cluster appearances, and
    emits one finding per cluster that meets BOTH thresholds. Findings are
    ranked by domain-share descending, with cross-cluster-count as
    tiebreaker.
    """
    run_id = _resolve_run_id(user_id, recluster_run_id)
    if run_id is None:
        return []

    with get_conn() as conn, conn.cursor() as cur:
        # Pull (cluster_id, cluster_name, stable_id, domain) for every page
        # in the run. Pages with NULL/empty domain are excluded -- they
        # can't drive a silo signal and would skew the share denominator if
        # counted. stable_id (migration 036) survives reclusters when
        # identity is enabled; NULL when identity is off or the row
        # predates 036.
        cur.execute(
            """
            SELECT c.id, c.cluster_name, c.stable_id, p.domain
            FROM clusters c
            JOIN page_clusters pc ON pc.cluster_id = c.id
            JOIN pages p ON pc.page_id = p.id
            WHERE c.user_id = %s
              AND c.recluster_run = %s
              AND p.domain IS NOT NULL
              AND p.domain <> ''
            """,
            (user_id, run_id),
        )
        rows = cur.fetchall()

    if not rows:
        return []

    # Per-cluster domain counts and totals.
    cluster_names: dict[int, str] = {}
    cluster_stable_ids: dict[int, str | None] = {}
    cluster_domain_counts: dict[int, Counter] = defaultdict(Counter)
    cluster_totals: dict[int, int] = defaultdict(int)
    # Per-domain set of cluster ids it appears in.
    domain_clusters: dict[str, set[int]] = defaultdict(set)

    for cluster_id, cluster_name, stable_id, domain in rows:
        cluster_names[cluster_id] = cluster_name
        cluster_stable_ids[cluster_id] = stable_id
        cluster_domain_counts[cluster_id][domain] += 1
        cluster_totals[cluster_id] += 1
        domain_clusters[domain].add(cluster_id)

    qualifying: list[tuple[int, str, int, int, float, int]] = []
    # Tuple shape: (cluster_id, top_domain, top_count, total, share, cross_cluster_count)

    for cluster_id, domain_counts in cluster_domain_counts.items():
        total = cluster_totals[cluster_id]
        if total == 0:
            continue
        # Most-frequent domain in this cluster. Ties broken by lowest
        # domain string (alpha) so output is deterministic across runs.
        max_count = max(domain_counts.values())
        top_domain = sorted(d for d, c in domain_counts.items() if c == max_count)[0]
        top_count = max_count

        share = top_count / total
        if share <= SILO_SHARE_THRESHOLD:
            continue

        # OTHER clusters where this domain appears (exclude the silo itself).
        cross_count = len(domain_clusters[top_domain] - {cluster_id})
        if cross_count < MIN_CROSS_CLUSTER_APPEARANCES:
            continue

        qualifying.append(
            (cluster_id, top_domain, top_count, total, share, cross_count)
        )

    # Rank: highest share first; tiebreak by cross_count desc, then
    # cluster_id asc for full determinism.
    qualifying.sort(key=lambda q: (-q[4], -q[5], q[0]))

    # Group qualifying clusters by dominant domain to detect the aggregation
    # case: >AGGREGATE_CLUSTER_THRESHOLD clusters sharing one dominant domain
    # collapse into a single systemic finding (see module docstring).
    domain_members: dict[str, list[tuple[int, str, int, int, float, int]]] = defaultdict(list)
    for entry in qualifying:
        domain_members[entry[1]].append(entry)
    aggregate_domains = {
        domain for domain, members in domain_members.items()
        if len(members) > AGGREGATE_CLUSTER_THRESHOLD
    }

    findings = []
    rank = 0

    # Aggregate domains first (systemic pattern, highest signal), ordered
    # deterministically by cluster count desc then domain name asc.
    for domain in sorted(
        aggregate_domains, key=lambda d: (-len(domain_members[d]), d)
    ):
        members = domain_members[domain]
        rank += 1
        cluster_ids = [m[0] for m in members]
        detail_lines = "\n".join(
            f"- cluster {cid} ('{cluster_names[cid]}'): {count}/{total} pages "
            f"({round(share * 100)}%), domain also in {cross_count} other clusters"
            for cid, _domain, count, total, share, cross_count in members
        )

        # S3 recurrence-demotion rule (approved rec 248) -- see
        # _prior_systemic_recurrence_count and the module docstring for the
        # mechanism (dq_recommendations supersession chain, since
        # dq_observations can only ever hold one row per systemic entity_id).
        prior_runs = _prior_systemic_recurrence_count(user_id, domain)
        if prior_runs >= RECURRENCE_DEMOTION_THRESHOLD:
            severity = "info"
            recurrence_note = (
                f" This is the {_ordinal(prior_runs + 1)} consecutive "
                f"systemic recurrence; demoted to info per the S3 "
                f"recurrence rule."
            )
        else:
            severity = "warning"
            recurrence_note = ""

        findings.append({
            "tag": "core",
            "scope_citation": SCOPE_ID,
            "adjacency_contract_ref": None,
            "issue_type": ISSUE_TYPE,
            "entity_type": "global",
            "entity_id": f"domain_silo:{domain}",
            "observation": (
                f"{len(members)} clusters are dominated (>"
                f"{round(SILO_SHARE_THRESHOLD * 100)}%) by domain '{domain}' in "
                f"this recluster run -- filed as one systemic finding instead "
                f"of {len(members)} per-cluster flags "
                f"(threshold {AGGREGATE_CLUSTER_THRESHOLD})."
                f"{recurrence_note}"
            ),
            "severity": severity,
            "rank": rank,
            "recommendation": {
                "headline": (
                    f"{len(members)} clusters are dominated by '{domain}' -- "
                    f"systemic source silo, not per-cluster incidents"
                ),
                "rationale": (
                    f"Domain '{domain}' exceeds the {round(SILO_SHARE_THRESHOLD * 100)}% "
                    f"silo share in {len(members)} clusters this run, each of "
                    f"which also independently clears the cross-cluster "
                    f"ubiquity threshold. Filed as one systemic finding per "
                    f"dq_agent_scope.md S3's aggregation rule "
                    f"(>{AGGREGATE_CLUSTER_THRESHOLD} clusters sharing a "
                    f"dominant domain). Per-cluster detail:\n{detail_lines}"
                ),
                "self_classification": "judgment",
                "action_type": ACTION_TYPE,
                "affected_entity_ids": cluster_ids,
            },
            "handoff_prompt_draft": None,
        })

    # Remaining per-cluster findings, preserving prior share/cross_count/
    # cluster_id ordering for everything not swept into an aggregate above.
    for cluster_id, domain, count, total, share, cross_count in qualifying:
        if domain in aggregate_domains:
            continue
        rank += 1
        share_pct = round(share * 100)
        cluster_name = cluster_names[cluster_id]
        stable_id = cluster_stable_ids.get(cluster_id)
        entity_id, action_payload = _cluster_entity_ref(cluster_id, stable_id)
        findings.append({
            "tag": "core",
            "scope_citation": SCOPE_ID,
            "adjacency_contract_ref": None,
            "issue_type": ISSUE_TYPE,
            "entity_type": "cluster",
            "entity_id": entity_id,
            "observation": (
                f"Cluster {cluster_id} ('{cluster_name}') is {share_pct}% "
                f"{domain} ({count}/{total} pages); domain also appears in "
                f"{cross_count} other clusters."
            ),
            "severity": "info",
            "rank": rank,
            "evidence": {
                "items": [
                    {
                        "type": "cluster",
                        "id": cluster_id,
                        "stable_id": stable_id,
                        "label": cluster_name,
                    }
                ]
            },
            "recommendation": {
                "headline": (
                    f"Cluster {cluster_id} is {share_pct}% {domain} -- appears "
                    f"to be a source silo, not a topic"
                ),
                "rationale": (
                    f"{count} of {total} pages ({share_pct}%) in cluster "
                    f"'{cluster_name}' come from {domain}. The same domain "
                    f"appears in {cross_count} other clusters in this recluster "
                    f"run, suggesting {domain} is a structural source rather "
                    f"than a topic signal. Consider splitting this cluster "
                    f"so its members regroup by topic."
                ),
                "self_classification": "judgment",
                "action_type": ACTION_TYPE,
                "affected_entity_ids": [entity_id],
                "action_payload": action_payload,
            },
            "handoff_prompt_draft": None,
        })

    return findings
