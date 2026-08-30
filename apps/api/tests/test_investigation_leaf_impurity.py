"""Integration tests for the S6 leaf-impurity investigator.

Requires Docker PostgreSQL running:
  docker compose up -d
  python -m backend.db.migrate
  pytest tests/test_investigation_leaf_impurity.py -v

No mocking needed: unlike S2 (cluster_coherence_drift), this investigator
touches no SBERT model and no LLM guard -- it is pure pairwise cosine math
over cached clustering-cache embeddings.
"""

from datetime import datetime, timezone

import pytest

from tests.test_repos import _pg_reachable

pytestmark = pytest.mark.skipif(
    not _pg_reachable(),
    reason="Test PostgreSQL not reachable -- run `docker compose up -d` and migrate",
)

from backend.config.settings import settings
from backend.db import (
    capture_repo,
    cluster_repo,
    content_repo,
    embedding_repo,
    page_repo,
    recluster_repo,
    user_repo,
)
from backend.db.connection import get_conn
from backend.services.dq_investigations import leaf_impurity

MODEL_KEY = f"{settings.clustering_embedding_model}@{settings.clustering_text_contract}"


# -- Fixtures ----------------------------------------------------------------


@pytest.fixture(autouse=True)
def _clean_tables():
    """Truncate relevant tables before each test for isolation."""
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            TRUNCATE annotations, clustering_embeddings, page_clusters, clusters,
                     recluster_runs, pages, page_content, captures, users
            CASCADE
            """
        )
    yield


def _make_user(email="li_test@example.com"):
    return user_repo.create_user(email=email, name="LI Test User")


def _make_capture(user_id, capture_id="li_cap_001"):
    return capture_repo.save_capture(
        user_id=user_id,
        capture_id=capture_id,
        source="desktop_active",
        started_at=datetime(2026, 4, 1, 10, 0, tzinfo=timezone.utc),
        ended_at=datetime(2026, 4, 1, 11, 0, tzinfo=timezone.utc),
    )


def _vec(idx_to_value: dict[int, float], dim: int = 384) -> list[float]:
    """Build a sparse dim-dimensional vector from {index: value} pairs.

    Cosine similarity between two such vectors is fully determined by the
    chosen indices and values, so tests can target an exact similarity
    without depending on a real embedding model.
    """
    v = [0.0] * dim
    for i, val in idx_to_value.items():
        v[i] = val
    return v


def _seed_member_page(
    capture_db_id: int,
    *,
    url: str,
    domain: str,
    title: str,
    embedding: list[float] | None,
    visited_minute: int,
) -> int:
    """Insert page_content + pages row + (optional) clustering embedding;
    return page_id.

    If embedding is None, no row is inserted into clustering_embeddings --
    exercises the "members without embeddings are skipped" path.
    """
    pc = content_repo.get_or_create_content(url=url, content_summary=f"Summary for {title}.")
    page_content_id = pc["id"]

    page_ids = page_repo.insert_pages(
        capture_db_id,
        [
            {
                "url": url,
                "title": title,
                "domain": domain,
                "visited_at": datetime(
                    2026, 4, 1, 10, visited_minute, tzinfo=timezone.utc
                ),
            }
        ],
    )
    page_id = page_ids[0]

    # Link page -> page_content and set status active so the investigator
    # picks it up.
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE pages SET page_content_id = %s, status = 'active' WHERE id = %s",
            (page_content_id, page_id),
        )

    if embedding is not None:
        embedding_repo.save_clustering_embeddings_bulk(
            [(page_content_id, embedding)], MODEL_KEY
        )
    return page_id


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


# -- Tests ---------------------------------------------------------------


def test_tight_cluster_emits_no_finding():
    """All 3 members share the same embedding direction (min pairwise sim
    1.0, well above the 0.19 threshold) -- no finding."""
    user = _make_user()
    uid = user["id"]
    cap = _make_capture(uid)
    cid = cap["id"]
    run_id = _make_completed_run(uid)

    slug_map = cluster_repo.save_clusters(
        uid,
        run_id,
        [{"cluster_slug": "tight", "cluster_name": "Tight Topic"}],
    )
    cluster_id = slug_map["tight"]

    pairs = []
    for i in range(3):
        pid = _seed_member_page(
            cid,
            url=f"https://example.com/tight-{i}",
            domain="example.com",
            title=f"Tight {i}",
            embedding=_vec({0: 1.0, 1: 0.1 * i}),
            visited_minute=i + 1,
        )
        pairs.append((pid, cluster_id))
    cluster_repo.save_page_clusters(pairs)

    findings = leaf_impurity.run(uid)

    assert findings == []


def test_mixed_cluster_flagged_with_offending_pair_named():
    """One tight cluster (min-sim well above threshold, seeded first) and one
    mixed cluster (two aligned members + one orthogonal outlier, min-sim 0.0)
    -- only the mixed cluster is flagged, ranked worst-first, with the
    offending (most-distant) pair named in the observation."""
    user = _make_user()
    uid = user["id"]
    cap = _make_capture(uid)
    cid = cap["id"]
    run_id = _make_completed_run(uid)

    slug_map = cluster_repo.save_clusters(
        uid,
        run_id,
        [
            {"cluster_slug": "tight", "cluster_name": "Tight Topic"},
            {"cluster_slug": "mixed", "cluster_name": "Suspicious Mix"},
        ],
    )
    tight_id = slug_map["tight"]
    mixed_id = slug_map["mixed"]

    pairs = []
    for i in range(3):
        pid = _seed_member_page(
            cid,
            url=f"https://example.com/tight-{i}",
            domain="example.com",
            title=f"Tight {i}",
            embedding=_vec({0: 1.0, 1: 0.05 * i}),
            visited_minute=i + 1,
        )
        pairs.append((pid, tight_id))

    # Mixed cluster: two members aligned on index 0, one orthogonal outlier
    # on index 200 -- min pairwise sim is 0.0 between the outlier and either
    # aligned member.
    aligned_a = _seed_member_page(
        cid,
        url="https://example.com/mixed-aligned-a",
        domain="example.com",
        title="Big Cats Field Guide",
        embedding=_vec({0: 1.0}),
        visited_minute=10,
    )
    aligned_b = _seed_member_page(
        cid,
        url="https://example.com/mixed-aligned-b",
        domain="example.com",
        title="Big Cats Conservation Status",
        embedding=_vec({0: 1.0}),
        visited_minute=11,
    )
    outlier = _seed_member_page(
        cid,
        url="https://example.com/mixed-outlier",
        domain="mythology.example.com",
        title="Hindu Deity Overview",
        embedding=_vec({200: 1.0}),
        visited_minute=12,
    )
    pairs += [
        (aligned_a, mixed_id),
        (aligned_b, mixed_id),
        (outlier, mixed_id),
    ]
    cluster_repo.save_page_clusters(pairs)

    findings = leaf_impurity.run(uid)

    assert len(findings) == 1
    f = findings[0]
    assert f["tag"] == "core"
    assert f["scope_citation"] == "S6"
    assert f["issue_type"] == "impure_leaf"
    assert f["entity_type"] == "cluster"
    # No stable_id seeded (identity off / legacy row) -- entity_id falls
    # back to the stringified integer cluster id (spec S1).
    assert f["entity_id"] == str(mixed_id)
    assert f["severity"] == "info"
    assert f["rank"] == 1
    assert f["evidence"] == {
        "items": [
            {"type": "cluster", "id": mixed_id, "stable_id": None, "label": "Suspicious Mix"}
        ]
    }
    rec = f["recommendation"]
    assert rec["action_type"] == "split_cluster"
    assert rec["self_classification"] == "judgment"
    assert rec["affected_entity_ids"] == [str(mixed_id)]
    assert rec["action_payload"] == {"identity": "missing"}
    # Cluster + offending (most-distant) pair named in the observation.
    assert str(mixed_id) in f["observation"]
    assert "Suspicious Mix" in f["observation"]
    assert "Hindu Deity Overview" in f["observation"]
    # One of the two aligned titles is the outlier's counterpart in the
    # min-sim pair (both are equidistant from the outlier at sim 0.0; either
    # is a valid "most-distant" partner).
    assert (
        "Big Cats Field Guide" in f["observation"]
        or "Big Cats Conservation Status" in f["observation"]
    )


def test_mixed_cluster_with_stable_id_uses_stable_id_as_entity_ref():
    """A mixed cluster carrying a stable_id (identity enabled + carried)
    references it in entity_id/affected_entity_ids/action_payload instead of
    the per-run integer id (spec S1/S4)."""
    user = _make_user()
    uid = user["id"]
    cap = _make_capture(uid)
    cid = cap["id"]
    run_id = _make_completed_run(uid)

    stable_id = "3fa85f64-5717-4562-b3fc-2c963f66afa6"
    slug_map = cluster_repo.save_clusters(
        uid,
        run_id,
        [{"cluster_slug": "mixed", "cluster_name": "Suspicious Mix", "stable_id": stable_id}],
    )
    mixed_id = slug_map["mixed"]

    aligned_a = _seed_member_page(
        cid,
        url="https://example.com/mixed-aligned-a",
        domain="example.com",
        title="Big Cats Field Guide",
        embedding=_vec({0: 1.0}),
        visited_minute=10,
    )
    aligned_b = _seed_member_page(
        cid,
        url="https://example.com/mixed-aligned-b",
        domain="example.com",
        title="Big Cats Conservation Status",
        embedding=_vec({0: 1.0}),
        visited_minute=11,
    )
    outlier = _seed_member_page(
        cid,
        url="https://example.com/mixed-outlier",
        domain="mythology.example.com",
        title="Hindu Deity Overview",
        embedding=_vec({200: 1.0}),
        visited_minute=12,
    )
    cluster_repo.save_page_clusters([
        (aligned_a, mixed_id), (aligned_b, mixed_id), (outlier, mixed_id),
    ])

    findings = leaf_impurity.run(uid)

    assert len(findings) == 1
    f = findings[0]
    assert f["entity_id"] == stable_id
    assert f["evidence"]["items"][0] == {
        "type": "cluster", "id": mixed_id, "stable_id": stable_id, "label": "Suspicious Mix"
    }
    rec = f["recommendation"]
    assert rec["affected_entity_ids"] == [stable_id]
    assert rec["action_payload"] == {"stable_id": stable_id}


def test_size_two_cluster_exempt():
    """A 2-member cluster with min-sim 0.0 (well below threshold) is exempt
    -- 2-page leaves are noise-adjacent by nature and are never scored."""
    user = _make_user()
    uid = user["id"]
    cap = _make_capture(uid)
    cid = cap["id"]
    run_id = _make_completed_run(uid)

    slug_map = cluster_repo.save_clusters(
        uid,
        run_id,
        [{"cluster_slug": "pair", "cluster_name": "Just A Pair"}],
    )
    cluster_id = slug_map["pair"]

    pid_a = _seed_member_page(
        cid,
        url="https://example.com/pair-a",
        domain="example.com",
        title="Pair A",
        embedding=_vec({0: 1.0}),
        visited_minute=1,
    )
    pid_b = _seed_member_page(
        cid,
        url="https://example.com/pair-b",
        domain="example.com",
        title="Pair B",
        embedding=_vec({200: 1.0}),
        visited_minute=2,
    )
    cluster_repo.save_page_clusters([(pid_a, cluster_id), (pid_b, cluster_id)])

    findings = leaf_impurity.run(uid)

    assert findings == []


def test_cluster_with_incomplete_embedding_coverage_skipped():
    """A cluster where one member has no cached clustering embedding is
    skipped entirely -- no partial scoring, no fallback compute -- even
    though the two embedded members would otherwise read as impure."""
    user = _make_user()
    uid = user["id"]
    cap = _make_capture(uid)
    cid = cap["id"]
    run_id = _make_completed_run(uid)

    slug_map = cluster_repo.save_clusters(
        uid,
        run_id,
        [{"cluster_slug": "partial", "cluster_name": "Partial Coverage"}],
    )
    cluster_id = slug_map["partial"]

    pid_a = _seed_member_page(
        cid,
        url="https://example.com/partial-a",
        domain="example.com",
        title="Partial A",
        embedding=_vec({0: 1.0}),
        visited_minute=1,
    )
    pid_b = _seed_member_page(
        cid,
        url="https://example.com/partial-b",
        domain="example.com",
        title="Partial B",
        embedding=_vec({200: 1.0}),
        visited_minute=2,
    )
    pid_c = _seed_member_page(
        cid,
        url="https://example.com/partial-c",
        domain="example.com",
        title="Partial C",
        embedding=None,  # no clustering_embeddings row for this member
        visited_minute=3,
    )
    cluster_repo.save_page_clusters(
        [(pid_a, cluster_id), (pid_b, cluster_id), (pid_c, cluster_id)]
    )

    findings = leaf_impurity.run(uid)

    assert findings == []


def test_empty_user_returns_empty_list():
    """User with no recluster_run yields []."""
    user = _make_user(email="empty_li@example.com")
    findings = leaf_impurity.run(user["id"])
    assert findings == []


def test_explicit_recluster_run_id_overrides_latest():
    """An explicit recluster_run_id is used verbatim -- even when a newer
    (but here, cluster-empty) generation exists -- and `None` resolves to
    the latest completed run (Task 8's generation-snapshot fix)."""
    user = _make_user(email="gen_snapshot_li@example.com")
    uid = user["id"]
    cap = _make_capture(uid)
    cid = cap["id"]

    # Older generation: seed the mixed (impure) cluster here (same shape as
    # test_mixed_cluster_flagged_with_offending_pair_named, minus the tight
    # cluster -- irrelevant to this test).
    older_run_id = _make_completed_run(uid)
    slug_map = cluster_repo.save_clusters(
        uid,
        older_run_id,
        [{"cluster_slug": "mixed", "cluster_name": "Suspicious Mix"}],
    )
    mixed_id = slug_map["mixed"]

    aligned_a = _seed_member_page(
        cid,
        url="https://example.com/mixed-aligned-a",
        domain="example.com",
        title="Big Cats Field Guide",
        embedding=_vec({0: 1.0}),
        visited_minute=10,
    )
    aligned_b = _seed_member_page(
        cid,
        url="https://example.com/mixed-aligned-b",
        domain="example.com",
        title="Big Cats Conservation Status",
        embedding=_vec({0: 1.0}),
        visited_minute=11,
    )
    outlier = _seed_member_page(
        cid,
        url="https://example.com/mixed-outlier",
        domain="mythology.example.com",
        title="Hindu Deity Overview",
        embedding=_vec({200: 1.0}),
        visited_minute=12,
    )
    cluster_repo.save_page_clusters([
        (aligned_a, mixed_id), (aligned_b, mixed_id), (outlier, mixed_id),
    ])

    # Newer generation: completes later, no clusters at all.
    newer_run_id = _make_completed_run(uid)
    assert newer_run_id != older_run_id

    # Default (None) resolves to the latest completed run -- which has no
    # clusters, so no findings.
    findings_default = leaf_impurity.run(uid)
    assert findings_default == []

    # Explicit older run id is honored verbatim, ignoring that a newer
    # generation exists.
    findings_explicit = leaf_impurity.run(uid, recluster_run_id=older_run_id)
    assert len(findings_explicit) == 1
    assert findings_explicit[0]["entity_id"] == str(mixed_id)
