"""Integration tests for the S3 domain-silo clusters investigator.

Requires Docker PostgreSQL running:
  docker compose up -d
  python -m backend.db.migrate
  pytest tests/test_investigation_domain_silo.py -v
"""

from datetime import datetime, timezone

import pytest

from tests.test_repos import _pg_reachable

pytestmark = pytest.mark.skipif(
    not _pg_reachable(),
    reason="Test PostgreSQL not reachable -- run `docker compose up -d` and migrate",
)

from backend.db import (
    capture_repo,
    cluster_repo,
    dq_observations_repo,
    dq_recommendations_repo,
    dq_runs_repo,
    page_repo,
    recluster_repo,
    user_repo,
)
from backend.db.connection import get_conn
from backend.services.dq_investigations import domain_silo_clusters


# ── Fixtures ─────────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _clean_tables():
    """Truncate relevant tables before each test for isolation."""
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            TRUNCATE annotations, page_clusters, clusters, recluster_runs,
                     pages, page_content, captures, users
            CASCADE
            """
        )
    yield


def _make_user(email="ds_test@example.com"):
    return user_repo.create_user(email=email, name="DS Test User")


def _make_capture(user_id, capture_id="ds_cap_001"):
    return capture_repo.save_capture(
        user_id=user_id,
        capture_id=capture_id,
        source="desktop_active",
        started_at=datetime(2026, 4, 1, 10, 0, tzinfo=timezone.utc),
        ended_at=datetime(2026, 4, 1, 11, 0, tzinfo=timezone.utc),
    )


def _insert_page(capture_db_id, url, title, domain, idx):
    """Insert one page with a distinct visited_at to avoid dedup collapse."""
    ids = page_repo.insert_pages(
        capture_db_id,
        [
            {
                "url": url,
                "title": title,
                "domain": domain,
                "visited_at": datetime(
                    2026, 4, 1, 10, idx % 60, idx // 60, tzinfo=timezone.utc
                ),
            }
        ],
    )
    return ids[0]


def _make_completed_run(user_id):
    """Start + complete a recluster_run; return run id."""
    run_id = recluster_repo.start_run(user_id)
    recluster_repo.complete_run(
        run_id,
        cluster_count=0,
        noise_count=0,
        naming_cost=0.0,
        elapsed_seconds=0.1,
    )
    return run_id


def _seed_wikipedia_aggregate_clusters(uid, cid, n_clusters=6):
    """Seed n_clusters clusters (default > AGGREGATE_CLUSTER_THRESHOLD)
    each 60% wikipedia.org, 40% unique-domain filler -- the fixture shared
    by the recurrence-demotion tests below (same shape as
    test_more_than_five_clusters_sharing_domain_aggregate_to_one_global_finding)."""
    run_id = _make_completed_run(uid)
    slug_map = cluster_repo.save_clusters(
        uid,
        run_id,
        [
            {"cluster_slug": f"wiki_silo_{i}", "cluster_name": f"Wiki Silo {i}"}
            for i in range(n_clusters)
        ],
    )
    page_idx = 1
    for i in range(n_clusters):
        cl_id = slug_map[f"wiki_silo_{i}"]
        pairs = []
        for j in range(3):
            pid = _insert_page(
                cid,
                f"https://wikipedia.org/wiki/silo{i}_{j}",
                f"Wiki {i}-{j}",
                "wikipedia.org",
                page_idx,
            )
            page_idx += 1
            pairs.append((pid, cl_id))
        for j in range(2):
            pid = _insert_page(
                cid,
                f"https://silo{i}-{j}.com/",
                f"Filler {i}-{j}",
                f"silo{i}-{j}.com",
                page_idx,
            )
            page_idx += 1
            pairs.append((pid, cl_id))
        cluster_repo.save_page_clusters(pairs)
    return slug_map


def _file_prior_systemic_recommendation(uid, domain, trigger="recluster_event"):
    """Insert one prior-run filing of the systemic ``domain_silo:<domain>``
    finding: a dq_runs row + the (at-most-one-ever, per the
    dq_obs_dedup unique index) dq_observations row for this systemic
    entity_id + a dq_recommendations row linked to it carrying this run's
    run_id. Calling this N times chains N dq_recommendations rows onto the
    SAME observation row -- exactly the "supersession chain" the S3
    recurrence-demotion rule (approved rec 248) counts via
    domain_silo_clusters._prior_systemic_recurrence_count. Returns the
    observation dict."""
    from backend.db import dq_vocab_repo

    # dq_observations.issue_type is FK-constrained to dq_vocab_issue_types
    # (user_id, issue_type) (migration 028) -- register the label first,
    # same as _resolve_issue_type does on the real persist path.
    dq_vocab_repo.insert_proposal(uid, "domain_silo", None, None)

    run = dq_runs_repo.start_run(uid, trigger=trigger)
    obs = dq_observations_repo.create_observation(
        user_id=uid,
        run_id=run["id"],
        tag="core",
        entity_type="global",
        entity_id=f"domain_silo:{domain}",
        issue_type="domain_silo",
        observation=f"prior systemic filing for {domain}",
        severity="warning",
    )
    dq_recommendations_repo.create_recommendation(
        user_id=uid,
        run_id=run["id"],
        observation_id=obs["id"],
        action_type="split_cluster",
        headline=f"prior headline for {domain}",
        rationale="prior rationale",
        self_classification="judgment",
        rank_in_run=1,
        affected_entity_type="global",
        affected_entity_ids=["1"],
    )
    return obs


# ── Tests ────────────────────────────────────────────────────────────────


def test_qualifying_silo_emits_finding():
    """Silo cluster is 60% arxiv.org AND arxiv.org appears in 3 other clusters."""
    user = _make_user()
    uid = user["id"]
    cap = _make_capture(uid)
    cid = cap["id"]
    run_id = _make_completed_run(uid)

    # Create 4 clusters: 1 silo + 3 "other" clusters that each contain 1 arxiv page.
    slug_map = cluster_repo.save_clusters(
        uid,
        run_id,
        [
            {"cluster_slug": "silo", "cluster_name": "ArXiv Papers Silo"},
            {"cluster_slug": "other_a", "cluster_name": "Other Topic A"},
            {"cluster_slug": "other_b", "cluster_name": "Other Topic B"},
            {"cluster_slug": "other_c", "cluster_name": "Other Topic C"},
        ],
    )
    silo_id = slug_map["silo"]

    # Silo cluster: 5 pages, 3 arxiv.org (60%) + 2 other domains
    page_idx = 1
    silo_pairs = []
    for i in range(3):
        pid = _insert_page(
            cid, f"https://arxiv.org/abs/{i}", f"Paper {i}", "arxiv.org", page_idx
        )
        page_idx += 1
        silo_pairs.append((pid, silo_id))
    for i in range(2):
        pid = _insert_page(
            cid, f"https://other{i}.com/", f"Other {i}", f"other{i}.com", page_idx
        )
        page_idx += 1
        silo_pairs.append((pid, silo_id))
    cluster_repo.save_page_clusters(silo_pairs)

    # Each of the 3 other clusters: 1 arxiv page + 4 non-arxiv pages
    # (so arxiv share in each is 20% -- below the 40% bar)
    for slug in ("other_a", "other_b", "other_c"):
        pairs = []
        cl_id = slug_map[slug]
        pid = _insert_page(
            cid,
            f"https://arxiv.org/abs/{slug}",
            f"Arxiv in {slug}",
            "arxiv.org",
            page_idx,
        )
        page_idx += 1
        pairs.append((pid, cl_id))
        for i in range(4):
            pid = _insert_page(
                cid,
                f"https://{slug}-{i}.com/",
                f"{slug} page {i}",
                f"{slug}-{i}.com",
                page_idx,
            )
            page_idx += 1
            pairs.append((pid, cl_id))
        cluster_repo.save_page_clusters(pairs)

    findings = domain_silo_clusters.run(uid)

    assert len(findings) == 1
    f = findings[0]
    assert f["tag"] == "core"
    assert f["scope_citation"] == "S3"
    assert f["issue_type"] == "domain_silo"
    assert f["entity_type"] == "cluster"
    # No stable_id seeded on this cluster (identity off / legacy row) --
    # entity_id falls back to the stringified integer cluster id (spec S1).
    assert f["entity_id"] == str(silo_id)
    assert f["severity"] == "info"
    assert f["rank"] == 1
    assert f["recommendation"]["action_type"] == "split_cluster"
    assert f["recommendation"]["self_classification"] == "judgment"
    assert str(silo_id) in f["recommendation"]["affected_entity_ids"]
    # Missing stable_id degrades action_payload to a machine-readable flag.
    assert f["recommendation"]["action_payload"] == {"identity": "missing"}
    assert f["evidence"] == {
        "items": [
            {"type": "cluster", "id": silo_id, "stable_id": None, "label": "ArXiv Papers Silo"}
        ]
    }

    # Rationale should reference the silo domain and counts
    rationale_blob = (
        f["observation"]
        + " "
        + f["recommendation"]["headline"]
        + " "
        + f["recommendation"]["rationale"]
    )
    assert "arxiv.org" in rationale_blob
    # 3 of 5 = 60%
    assert "60" in rationale_blob


def test_dominant_but_not_ubiquitous_emits_no_finding():
    """Domain dominates 1 cluster (>40%) but appears in 0 other clusters."""
    user = _make_user()
    uid = user["id"]
    cap = _make_capture(uid)
    cid = cap["id"]
    run_id = _make_completed_run(uid)

    slug_map = cluster_repo.save_clusters(
        uid,
        run_id,
        [
            {"cluster_slug": "blog_silo", "cluster_name": "Blog Silo"},
            {"cluster_slug": "other_a", "cluster_name": "Other A"},
            {"cluster_slug": "other_b", "cluster_name": "Other B"},
        ],
    )

    # Silo cluster: 5 pages, 3 myblog.com (60%) + 2 other
    page_idx = 1
    silo_pairs = []
    for i in range(3):
        pid = _insert_page(
            cid, f"https://myblog.com/p{i}", f"Post {i}", "myblog.com", page_idx
        )
        page_idx += 1
        silo_pairs.append((pid, slug_map["blog_silo"]))
    for i in range(2):
        pid = _insert_page(
            cid, f"https://x{i}.com/", f"X {i}", f"x{i}.com", page_idx
        )
        page_idx += 1
        silo_pairs.append((pid, slug_map["blog_silo"]))
    cluster_repo.save_page_clusters(silo_pairs)

    # Other clusters: no myblog.com pages anywhere
    for slug in ("other_a", "other_b"):
        pairs = []
        for i in range(3):
            pid = _insert_page(
                cid,
                f"https://{slug}-{i}.com/",
                f"{slug} {i}",
                f"{slug}-{i}.com",
                page_idx,
            )
            page_idx += 1
            pairs.append((pid, slug_map[slug]))
        cluster_repo.save_page_clusters(pairs)

    findings = domain_silo_clusters.run(uid)
    assert findings == []


def test_ubiquitous_but_not_dominant_emits_no_finding():
    """arxiv.org appears in 4 clusters but is only 20% of each."""
    user = _make_user()
    uid = user["id"]
    cap = _make_capture(uid)
    cid = cap["id"]
    run_id = _make_completed_run(uid)

    slug_map = cluster_repo.save_clusters(
        uid,
        run_id,
        [
            {"cluster_slug": f"c{i}", "cluster_name": f"Cluster {i}"} for i in range(4)
        ],
    )

    page_idx = 1
    for i in range(4):
        pairs = []
        cl_id = slug_map[f"c{i}"]
        # 1 arxiv.org + 4 unique-domain pages = 20% arxiv share
        pid = _insert_page(
            cid,
            f"https://arxiv.org/abs/c{i}",
            f"Arxiv c{i}",
            "arxiv.org",
            page_idx,
        )
        page_idx += 1
        pairs.append((pid, cl_id))
        for j in range(4):
            pid = _insert_page(
                cid,
                f"https://c{i}-{j}.com/",
                f"c{i}-{j}",
                f"c{i}-{j}.com",
                page_idx,
            )
            page_idx += 1
            pairs.append((pid, cl_id))
        cluster_repo.save_page_clusters(pairs)

    findings = domain_silo_clusters.run(uid)
    assert findings == []


def test_more_than_five_clusters_sharing_domain_aggregate_to_one_global_finding():
    """>5 qualifying clusters sharing one dominant domain collapse into a
    single entity_type='global' finding (dq_agent_scope.md S3 aggregation
    rule, added 2026-07-17) instead of one per-cluster flag each."""
    user = _make_user()
    uid = user["id"]
    cap = _make_capture(uid)
    cid = cap["id"]
    run_id = _make_completed_run(uid)

    n_clusters = 6  # > AGGREGATE_CLUSTER_THRESHOLD (5)
    slug_map = cluster_repo.save_clusters(
        uid,
        run_id,
        [
            {"cluster_slug": f"wiki_silo_{i}", "cluster_name": f"Wiki Silo {i}"}
            for i in range(n_clusters)
        ],
    )

    page_idx = 1
    for i in range(n_clusters):
        cl_id = slug_map[f"wiki_silo_{i}"]
        pairs = []
        # 3 wikipedia.org pages (dominant domain, 60% share)
        for j in range(3):
            pid = _insert_page(
                cid,
                f"https://wikipedia.org/wiki/silo{i}_{j}",
                f"Wiki {i}-{j}",
                "wikipedia.org",
                page_idx,
            )
            page_idx += 1
            pairs.append((pid, cl_id))
        # 2 unique-domain filler pages
        for j in range(2):
            pid = _insert_page(
                cid,
                f"https://silo{i}-{j}.com/",
                f"Filler {i}-{j}",
                f"silo{i}-{j}.com",
                page_idx,
            )
            page_idx += 1
            pairs.append((pid, cl_id))
        cluster_repo.save_page_clusters(pairs)

    findings = domain_silo_clusters.run(uid)

    assert len(findings) == 1
    f = findings[0]
    assert f["tag"] == "core"
    assert f["scope_citation"] == "S3"
    assert f["issue_type"] == "domain_silo"
    assert f["entity_type"] == "global"
    assert f["entity_id"] == "domain_silo:wikipedia.org"
    assert f["rank"] == 1
    # No prior-run filings -> baseline severity is 'warning', not the old
    # hardcoded 'info' (S3 recurrence-demotion rule, approved rec 248) --
    # demotion only kicks in at >=2 priors, see the recurrence tests below.
    assert f["severity"] == "warning"
    assert "recurrence" not in f["observation"].lower()
    rec = f["recommendation"]
    assert rec["action_type"] == "split_cluster"
    # Aggregation path stays entity_type='global' and unaffected by the S1
    # stable-id rule -- affected_entity_ids keeps integer cluster ids, no
    # action_payload is fabricated (dq_agent_scope.md S3, "Tier 1" note).
    assert set(rec["affected_entity_ids"]) == set(slug_map.values())
    assert all(isinstance(cid, int) for cid in rec["affected_entity_ids"])
    assert "action_payload" not in rec

    # Per-cluster detail preserved in the rationale, not dropped.
    for i in range(n_clusters):
        assert f"Wiki Silo {i}" in rec["rationale"]
    assert "wikipedia.org" in rec["headline"]
    assert f"{n_clusters} clusters" in rec["headline"]


def test_exactly_five_clusters_sharing_domain_stays_per_cluster():
    """Exactly 5 qualifying clusters (== AGGREGATE_CLUSTER_THRESHOLD, not
    'more than') stay as 5 individual per-cluster findings -- the
    aggregation rule only fires strictly above the threshold."""
    user = _make_user()
    uid = user["id"]
    cap = _make_capture(uid)
    cid = cap["id"]
    run_id = _make_completed_run(uid)

    n_clusters = 5  # == AGGREGATE_CLUSTER_THRESHOLD, not aggregated
    slug_map = cluster_repo.save_clusters(
        uid,
        run_id,
        [
            {"cluster_slug": f"wiki_silo_{i}", "cluster_name": f"Wiki Silo {i}"}
            for i in range(n_clusters)
        ],
    )

    page_idx = 1
    for i in range(n_clusters):
        cl_id = slug_map[f"wiki_silo_{i}"]
        pairs = []
        for j in range(3):
            pid = _insert_page(
                cid,
                f"https://wikipedia.org/wiki/silo{i}_{j}",
                f"Wiki {i}-{j}",
                "wikipedia.org",
                page_idx,
            )
            page_idx += 1
            pairs.append((pid, cl_id))
        for j in range(2):
            pid = _insert_page(
                cid,
                f"https://silo{i}-{j}.com/",
                f"Filler {i}-{j}",
                f"silo{i}-{j}.com",
                page_idx,
            )
            page_idx += 1
            pairs.append((pid, cl_id))
        cluster_repo.save_page_clusters(pairs)

    findings = domain_silo_clusters.run(uid)

    assert len(findings) == n_clusters
    assert all(f["entity_type"] == "cluster" for f in findings)
    assert {int(f["entity_id"]) for f in findings} == set(slug_map.values())
    # No stable_id seeded -- every per-cluster finding degrades gracefully.
    assert all(f["recommendation"]["action_payload"] == {"identity": "missing"} for f in findings)


def test_per_cluster_finding_with_stable_id_uses_stable_id_as_entity_ref():
    """A single qualifying silo cluster carrying a stable_id (identity
    enabled + carried) references it in entity_id/affected_entity_ids/
    action_payload instead of the per-run integer id (spec S1/S4); the
    aggregation path is untouched by this (separately covered above)."""
    user = _make_user()
    uid = user["id"]
    cap = _make_capture(uid)
    cid = cap["id"]
    run_id = _make_completed_run(uid)

    stable_id = "3fa85f64-5717-4562-b3fc-2c963f66afa6"
    slug_map = cluster_repo.save_clusters(
        uid,
        run_id,
        [
            {"cluster_slug": "silo", "cluster_name": "ArXiv Papers Silo", "stable_id": stable_id},
            {"cluster_slug": "other_a", "cluster_name": "Other Topic A"},
            {"cluster_slug": "other_b", "cluster_name": "Other Topic B"},
            {"cluster_slug": "other_c", "cluster_name": "Other Topic C"},
        ],
    )
    silo_id = slug_map["silo"]

    page_idx = 1
    silo_pairs = []
    for i in range(3):
        pid = _insert_page(
            cid, f"https://arxiv.org/abs/{i}", f"Paper {i}", "arxiv.org", page_idx
        )
        page_idx += 1
        silo_pairs.append((pid, silo_id))
    for i in range(2):
        pid = _insert_page(
            cid, f"https://other{i}.com/", f"Other {i}", f"other{i}.com", page_idx
        )
        page_idx += 1
        silo_pairs.append((pid, silo_id))
    cluster_repo.save_page_clusters(silo_pairs)

    for slug in ("other_a", "other_b", "other_c"):
        pairs = []
        cl_id = slug_map[slug]
        pid = _insert_page(
            cid, f"https://arxiv.org/abs/{slug}", f"Arxiv in {slug}", "arxiv.org", page_idx
        )
        page_idx += 1
        pairs.append((pid, cl_id))
        for i in range(4):
            pid = _insert_page(
                cid, f"https://{slug}-{i}.com/", f"{slug} page {i}", f"{slug}-{i}.com", page_idx
            )
            page_idx += 1
            pairs.append((pid, cl_id))
        cluster_repo.save_page_clusters(pairs)

    findings = domain_silo_clusters.run(uid)

    assert len(findings) == 1
    f = findings[0]
    assert f["entity_id"] == stable_id
    assert f["evidence"]["items"][0] == {
        "type": "cluster", "id": silo_id, "stable_id": stable_id, "label": "ArXiv Papers Silo"
    }
    rec = f["recommendation"]
    assert rec["affected_entity_ids"] == [stable_id]
    assert rec["action_payload"] == {"stable_id": stable_id}


def test_empty_user_returns_empty_list():
    """User with zero clusters / no recluster_run yields empty list."""
    user = _make_user(email="empty_silo@example.com")
    findings = domain_silo_clusters.run(user["id"])
    assert findings == []


def test_explicit_recluster_run_id_overrides_latest():
    """An explicit recluster_run_id is used verbatim -- even when a newer
    (but here, cluster-empty) generation exists -- and `None` resolves to
    the latest completed run (Task 8's generation-snapshot fix)."""
    user = _make_user(email="gen_snapshot_silo@example.com")
    uid = user["id"]
    cap = _make_capture(uid)
    cid = cap["id"]

    # Older generation: seed a qualifying silo cluster + 3 "other" clusters
    # here (same shape as test_qualifying_silo_emits_finding).
    older_run_id = _make_completed_run(uid)
    slug_map = cluster_repo.save_clusters(
        uid,
        older_run_id,
        [
            {"cluster_slug": "silo", "cluster_name": "ArXiv Papers Silo"},
            {"cluster_slug": "other_a", "cluster_name": "Other Topic A"},
            {"cluster_slug": "other_b", "cluster_name": "Other Topic B"},
            {"cluster_slug": "other_c", "cluster_name": "Other Topic C"},
        ],
    )
    silo_id = slug_map["silo"]

    page_idx = 1
    silo_pairs = []
    for i in range(3):
        pid = _insert_page(
            cid, f"https://arxiv.org/abs/{i}", f"Paper {i}", "arxiv.org", page_idx
        )
        page_idx += 1
        silo_pairs.append((pid, silo_id))
    for i in range(2):
        pid = _insert_page(
            cid, f"https://other{i}.com/", f"Other {i}", f"other{i}.com", page_idx
        )
        page_idx += 1
        silo_pairs.append((pid, silo_id))
    cluster_repo.save_page_clusters(silo_pairs)

    for slug in ("other_a", "other_b", "other_c"):
        pairs = []
        cl_id = slug_map[slug]
        pid = _insert_page(
            cid, f"https://arxiv.org/abs/{slug}", f"Arxiv in {slug}", "arxiv.org", page_idx
        )
        page_idx += 1
        pairs.append((pid, cl_id))
        for i in range(4):
            pid = _insert_page(
                cid, f"https://{slug}-{i}.com/", f"{slug} page {i}", f"{slug}-{i}.com", page_idx
            )
            page_idx += 1
            pairs.append((pid, cl_id))
        cluster_repo.save_page_clusters(pairs)

    # Newer generation: completes later, no clusters at all.
    newer_run_id = _make_completed_run(uid)
    assert newer_run_id != older_run_id

    # Default (None) resolves to the latest completed run -- which has no
    # clusters, so no findings.
    findings_default = domain_silo_clusters.run(uid)
    assert findings_default == []

    # Explicit older run id is honored verbatim, ignoring that a newer
    # generation exists.
    findings_explicit = domain_silo_clusters.run(uid, recluster_run_id=older_run_id)
    assert len(findings_explicit) == 1
    assert findings_explicit[0]["entity_id"] == str(silo_id)


# ── S3 recurrence-demotion rule (approved rec 248) ─────────────────────────


def test_systemic_aggregate_one_prior_stays_warning():
    """Exactly 1 prior-run filing is below the >=2-priors demotion
    threshold -- severity stays 'warning' (demotion is strictly >=2, not
    'any recurrence at all')."""
    user = _make_user(email="ds_recur_one@example.com")
    uid = user["id"]
    cap = _make_capture(uid)
    cid = cap["id"]

    _file_prior_systemic_recommendation(uid, "wikipedia.org")

    _seed_wikipedia_aggregate_clusters(uid, cid, n_clusters=6)

    findings = domain_silo_clusters.run(uid)

    assert len(findings) == 1
    f = findings[0]
    assert f["entity_id"] == "domain_silo:wikipedia.org"
    assert f["severity"] == "warning"
    assert "recurrence" not in f["observation"].lower()


def test_systemic_aggregate_two_priors_demotes_to_info_with_recurrence_count():
    """>=2 prior-run filings of the same systemic finding (tracked via the
    dq_recommendations supersession chain hanging off the one
    dq_observations row for this entity_id -- dq_observations itself can
    only ever hold ONE row per entity_id, see the module docstring) demotes
    severity to 'info' and names the recurrence count in the observation
    text (S3 recurrence-demotion rule, approved rec 248)."""
    user = _make_user(email="ds_recur_two@example.com")
    uid = user["id"]
    cap = _make_capture(uid)
    cid = cap["id"]

    # Two prior-run filings -> this run's finding is the 3rd occurrence.
    _file_prior_systemic_recommendation(uid, "wikipedia.org")
    _file_prior_systemic_recommendation(uid, "wikipedia.org")

    _seed_wikipedia_aggregate_clusters(uid, cid, n_clusters=6)

    findings = domain_silo_clusters.run(uid)

    assert len(findings) == 1
    f = findings[0]
    assert f["entity_id"] == "domain_silo:wikipedia.org"
    assert f["severity"] == "info"
    assert "3rd consecutive systemic recurrence" in f["observation"]
    assert "S3 recurrence rule" in f["observation"]


def test_systemic_aggregate_recurrence_count_is_per_domain():
    """Recurrence tracking keys on the systemic entity_id (which embeds the
    domain) -- prior filings for a DIFFERENT domain must not demote this
    domain's fresh finding."""
    user = _make_user(email="ds_recur_other_domain@example.com")
    uid = user["id"]
    cap = _make_capture(uid)
    cid = cap["id"]

    _file_prior_systemic_recommendation(uid, "reddit.com")
    _file_prior_systemic_recommendation(uid, "reddit.com")

    _seed_wikipedia_aggregate_clusters(uid, cid, n_clusters=6)

    findings = domain_silo_clusters.run(uid)

    assert len(findings) == 1
    f = findings[0]
    assert f["entity_id"] == "domain_silo:wikipedia.org"
    assert f["severity"] == "warning"
    assert "recurrence" not in f["observation"].lower()
