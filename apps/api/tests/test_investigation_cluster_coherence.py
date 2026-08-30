"""Integration tests for the S2 cluster-coherence-drift investigator.

Requires Docker PostgreSQL running:
  docker compose up -d
  python -m backend.db.migrate
  pytest tests/test_investigation_cluster_coherence.py -v

SBERT is mocked for determinism (real embeddings drift across model
versions and would couple this test to the actual MiniLM weights).

Tier 2 (2026-07-19): the per-candidate ``rival_hypothesis_guard`` retired.
S2 now emits every threshold candidate unconditionally and performs NO LLM
calls of any kind -- see ``test_no_llm_calls_anywhere_in_s2`` below, which
poisons ``LLMService.__init__`` to prove nothing in this module's code path
constructs one. Findings also carry a top-level ``members`` list (the
batched upstream adjudicator's evidence).
"""

from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import numpy as np
import pytest

from tests.test_repos import _pg_reachable

pytestmark = pytest.mark.skipif(
    not _pg_reachable(),
    reason="Test PostgreSQL not reachable -- run `docker compose up -d` and migrate",
)

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
from backend.services.dq_investigations import cluster_coherence_drift


# -- Fixtures --------------------------------------------------------------


@pytest.fixture(autouse=True)
def _clean_tables():
    """Truncate relevant tables before each test for isolation."""
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            TRUNCATE annotations, page_embeddings, page_clusters, clusters,
                     recluster_runs, pages, page_content, captures, users
            CASCADE
            """
        )
    yield


def _make_user(email="cc_test@example.com"):
    return user_repo.create_user(email=email, name="CC Test User")


def _make_capture(user_id, capture_id="cc_cap_001"):
    return capture_repo.save_capture(
        user_id=user_id,
        capture_id=capture_id,
        source="desktop_active",
        started_at=datetime(2026, 4, 1, 10, 0, tzinfo=timezone.utc),
        ended_at=datetime(2026, 4, 1, 11, 0, tzinfo=timezone.utc),
    )


def _vec(idx_to_value: dict[int, float]) -> list[float]:
    """Build a 384-dim vector from sparse {index: value} pairs.

    Cosine similarity between two such vectors is fully determined by the
    chosen indices and values, so tests can target an exact similarity
    without depending on a real SBERT model.
    """
    v = [0.0] * 384
    for i, val in idx_to_value.items():
        v[i] = val
    return v


def _seed_member_page(
    capture_db_id: int,
    *,
    url: str,
    domain: str,
    title: str,
    summary: str,
    embedding: list[float] | None,
    visited_minute: int,
) -> int:
    """Insert page_content + pages row + (optional) embedding; return page_id.

    If embedding is None, no row is inserted into page_embeddings -- exercises
    the "members without embeddings are skipped" path.
    """
    pc = content_repo.get_or_create_content(url=url, content_summary=summary)
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
        embedding_repo.save_embedding(page_content_id, embedding)
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


def _mock_sbert_returning(label_vec: list[float]):
    """Build a MagicMock SBERT model whose .encode() returns label_vec."""
    mock = MagicMock()
    mock.encode = MagicMock(return_value=np.array(label_vec, dtype=float))
    return mock


def _seed_incoherent_cluster(uid, cid, run_id, *, cluster_slug, cluster_name):
    """Seed one cluster with 1 label-aligned member + 4 orthogonal outliers
    (coherence_ratio 0.2, well below the 0.60 threshold). Returns
    (cluster_id, aligned_id, outlier_ids, outlier_titles, outlier_domains).
    """
    slug_map = cluster_repo.save_clusters(
        uid,
        run_id,
        [{"cluster_slug": cluster_slug, "cluster_name": cluster_name}],
    )
    cluster_id = slug_map[cluster_slug]

    aligned_id = _seed_member_page(
        cid,
        url=f"https://example.com/{cluster_slug}-aligned",
        domain="arxiv.org",
        title="A Quantum Paper",
        summary="Quantum stuff.",
        embedding=_vec({0: 1.0}),
        visited_minute=1,
    )
    outlier_ids = []
    outlier_titles = []
    outlier_domains = []
    for i in range(4):
        title = f"Outlier {i}"
        domain = f"{cluster_slug}-outlier{i}.com"
        pid = _seed_member_page(
            cid,
            url=f"https://{cluster_slug}-outlier{i}.com/page",
            domain=domain,
            title=title,
            summary=f"Off-topic {i}.",
            # Orthogonal vector: nonzero on a unique index well outside index 0.
            embedding=_vec({100 + i: 1.0}),
            visited_minute=i + 2,
        )
        outlier_ids.append(pid)
        outlier_titles.append(title)
        outlier_domains.append(domain)

    pairs = [(aligned_id, cluster_id)] + [(pid, cluster_id) for pid in outlier_ids]
    cluster_repo.save_page_clusters(pairs)
    return cluster_id, aligned_id, outlier_ids, outlier_titles, outlier_domains


# -- Tests -----------------------------------------------------------------


@patch("backend.services.dq_investigations.cluster_coherence_drift.get_sbert_model")
def test_coherent_cluster_emits_no_finding(mock_get_sbert):
    """All members align with the label embedding => coherence_ratio = 1.0,
    no candidate, no finding."""
    label_vec = _vec({0: 1.0})
    mock_get_sbert.return_value = _mock_sbert_returning(label_vec)

    user = _make_user()
    uid = user["id"]
    cap = _make_capture(uid)
    cid = cap["id"]
    run_id = _make_completed_run(uid)

    slug_map = cluster_repo.save_clusters(
        uid,
        run_id,
        [{"cluster_slug": "coherent", "cluster_name": "Coherent Topic"}],
    )

    # 5 members, all with embeddings highly aligned to the label
    # (cos sim with v_label = 1.0, well above 0.35 threshold).
    pairs = []
    for i in range(5):
        pid = _seed_member_page(
            cid,
            url=f"https://example.com/coherent-{i}",
            domain="example.com",
            title=f"Coherent {i}",
            summary=f"Summary {i}.",
            embedding=_vec({0: 1.0}),
            visited_minute=i + 1,
        )
        pairs.append((pid, slug_map["coherent"]))
    cluster_repo.save_page_clusters(pairs)

    findings = cluster_coherence_drift.run(uid)

    assert findings == []


@patch("backend.services.dq_investigations.cluster_coherence_drift.get_sbert_model")
def test_incoherent_cluster_emits_finding(mock_get_sbert):
    """Only 1/5 members align with the label => one finding (no guard to
    suppress it -- Tier 2 removed the per-candidate rival-hypothesis
    check)."""
    label_vec = _vec({0: 1.0})
    mock_get_sbert.return_value = _mock_sbert_returning(label_vec)

    user = _make_user()
    uid = user["id"]
    cap = _make_capture(uid)
    cid = cap["id"]
    run_id = _make_completed_run(uid)

    cluster_id, _aligned_id, _outlier_ids, outlier_titles, outlier_domains = (
        _seed_incoherent_cluster(
            uid, cid, run_id, cluster_slug="drift", cluster_name="Quantum Computing"
        )
    )

    findings = cluster_coherence_drift.run(uid)

    assert len(findings) == 1
    f = findings[0]
    assert f["tag"] == "core"
    assert f["scope_citation"] == "S2"
    assert f["issue_type"] == "cluster_coherence_drift"
    assert f["entity_type"] == "cluster"
    # No stable_id seeded on this cluster (identity off / legacy row) --
    # entity_id falls back to the stringified integer cluster id, never
    # crashes (spec S1).
    assert f["entity_id"] == str(cluster_id)
    assert f["severity"] == "warning"
    assert f["rank"] == 1
    # The integer id + current label ride along in evidence for display.
    assert f["evidence"] == {
        "items": [
            {"type": "cluster", "id": cluster_id, "stable_id": None, "label": "Quantum Computing"}
        ]
    }
    rec = f["recommendation"]
    assert rec["action_type"] == "flag_for_review"
    assert rec["self_classification"] == "judgment"
    assert rec["affected_entity_ids"] == [str(cluster_id)]
    # Missing stable_id degrades action_payload to a machine-readable flag
    # rather than guessing or crashing (spec S4/S5).
    assert rec["action_payload"] == {"identity": "missing"}
    # Headline names the cluster + incoherence shape (counts).
    assert str(cluster_id) in rec["headline"]
    assert "Quantum Computing" in rec["headline"]
    # Rationale lists outlier pages.
    rationale = rec["rationale"]
    for title, domain in zip(outlier_titles, outlier_domains):
        assert title in rationale
        assert domain in rationale
    # No rival-hypothesis guard exists anymore -- its old reasoning tail is
    # gone from the rationale.
    assert "guard" not in rationale.lower()


@patch("backend.services.dq_investigations.cluster_coherence_drift.get_sbert_model")
def test_incoherent_cluster_with_stable_id_uses_stable_id_as_entity_ref(mock_get_sbert):
    """When the cluster carries a stable_id (identity enabled + carried),
    entity_id / affected_entity_ids / action_payload reference it instead of
    the per-run integer id (spec S1/S4) -- the integer id is still surfaced
    in evidence for display."""
    label_vec = _vec({0: 1.0})
    mock_get_sbert.return_value = _mock_sbert_returning(label_vec)

    user = _make_user()
    uid = user["id"]
    cap = _make_capture(uid)
    cid = cap["id"]
    run_id = _make_completed_run(uid)

    stable_id = "3fa85f64-5717-4562-b3fc-2c963f66afa6"
    slug_map = cluster_repo.save_clusters(
        uid,
        run_id,
        [{
            "cluster_slug": "drift",
            "cluster_name": "Quantum Computing",
            "stable_id": stable_id,
        }],
    )
    cluster_id = slug_map["drift"]

    aligned_id = _seed_member_page(
        cid,
        url="https://example.com/quantum-paper",
        domain="arxiv.org",
        title="A Quantum Paper",
        summary="Quantum stuff.",
        embedding=_vec({0: 1.0}),
        visited_minute=1,
    )
    outlier_ids = []
    for i in range(4):
        pid = _seed_member_page(
            cid,
            url=f"https://outlier{i}.com/page",
            domain=f"outlier{i}.com",
            title=f"Outlier {i}",
            summary=f"Off-topic {i}.",
            embedding=_vec({100 + i: 1.0}),
            visited_minute=i + 2,
        )
        outlier_ids.append(pid)

    pairs = [(aligned_id, cluster_id)] + [(pid, cluster_id) for pid in outlier_ids]
    cluster_repo.save_page_clusters(pairs)

    findings = cluster_coherence_drift.run(uid)

    assert len(findings) == 1
    f = findings[0]
    assert f["entity_id"] == stable_id
    assert f["evidence"]["items"][0]["id"] == cluster_id
    assert f["evidence"]["items"][0]["stable_id"] == stable_id
    assert f["evidence"]["items"][0]["label"] == "Quantum Computing"
    rec = f["recommendation"]
    assert rec["affected_entity_ids"] == [stable_id]
    assert rec["action_payload"] == {"stable_id": stable_id}


@patch("backend.services.dq_investigations.cluster_coherence_drift.get_sbert_model")
def test_previously_guard_suppressed_pattern_now_emits_finding(mock_get_sbert):
    """Tier 2 behavior change: a 'Curiosities Mix'-labeled incoherent
    cluster -- the exact shape the old rival_hypothesis_guard used to
    suppress as 'heterogeneity is intentional' -- now emits a finding
    unconditionally. That judgment call moved upstream to the batched
    adjudicator (backend/services/dq_adjudicator.py), which this
    deterministic module no longer makes on its own."""
    label_vec = _vec({0: 1.0})
    mock_get_sbert.return_value = _mock_sbert_returning(label_vec)

    user = _make_user()
    uid = user["id"]
    cap = _make_capture(uid)
    cid = cap["id"]
    run_id = _make_completed_run(uid)

    slug_map = cluster_repo.save_clusters(
        uid,
        run_id,
        [{"cluster_slug": "miscellany", "cluster_name": "Curiosities Mix"}],
    )
    cluster_id = slug_map["miscellany"]

    pairs = []
    aligned_id = _seed_member_page(
        cid,
        url="https://example.com/aligned",
        domain="example.com",
        title="Aligned",
        summary="aligned",
        embedding=_vec({0: 1.0}),
        visited_minute=1,
    )
    pairs.append((aligned_id, cluster_id))
    for i in range(4):
        pid = _seed_member_page(
            cid,
            url=f"https://other{i}.com/page",
            domain=f"other{i}.com",
            title=f"Other {i}",
            summary=f"other {i}",
            embedding=_vec({100 + i: 1.0}),
            visited_minute=i + 2,
        )
        pairs.append((pid, cluster_id))
    cluster_repo.save_page_clusters(pairs)

    findings = cluster_coherence_drift.run(uid)

    assert len(findings) == 1
    assert findings[0]["entity_id"] == str(cluster_id)


@patch("backend.services.dq_investigations.cluster_coherence_drift.get_sbert_model")
def test_small_cluster_skipped(mock_get_sbert):
    """Cluster with fewer than MIN_CLUSTER_SIZE members is skipped before
    any embedding lookup."""
    label_vec = _vec({0: 1.0})
    mock_get_sbert.return_value = _mock_sbert_returning(label_vec)

    user = _make_user()
    uid = user["id"]
    cap = _make_capture(uid)
    cid = cap["id"]
    run_id = _make_completed_run(uid)

    slug_map = cluster_repo.save_clusters(
        uid,
        run_id,
        [{"cluster_slug": "tiny", "cluster_name": "Tiny Cluster"}],
    )
    cluster_id = slug_map["tiny"]

    # 2 members -- below the MIN_CLUSTER_SIZE = 3 floor.
    pairs = []
    for i in range(2):
        pid = _seed_member_page(
            cid,
            url=f"https://x{i}.com/p",
            domain=f"x{i}.com",
            title=f"X {i}",
            summary=f"x {i}",
            # Even though embeddings would yield 0% coherence, the cluster
            # never reaches the embedding-similarity step.
            embedding=_vec({100 + i: 1.0}),
            visited_minute=i + 1,
        )
        pairs.append((pid, cluster_id))
    cluster_repo.save_page_clusters(pairs)

    findings = cluster_coherence_drift.run(uid)

    assert findings == []


@patch("backend.services.dq_investigations.cluster_coherence_drift.get_sbert_model")
def test_empty_user_returns_empty_list(mock_get_sbert):
    """User with no recluster_run yields []; SBERT is never even loaded."""
    user = _make_user(email="empty_cc@example.com")
    findings = cluster_coherence_drift.run(user["id"])
    assert findings == []
    mock_get_sbert.assert_not_called()


@patch("backend.services.dq_investigations.cluster_coherence_drift.get_sbert_model")
def test_cluster_with_no_embeddings_skipped(mock_get_sbert):
    """A cluster whose members have no cached embeddings is skipped silently."""
    label_vec = _vec({0: 1.0})
    mock_get_sbert.return_value = _mock_sbert_returning(label_vec)

    user = _make_user()
    uid = user["id"]
    cap = _make_capture(uid)
    cid = cap["id"]
    run_id = _make_completed_run(uid)

    slug_map = cluster_repo.save_clusters(
        uid,
        run_id,
        [{"cluster_slug": "noembed", "cluster_name": "No Embeddings"}],
    )
    cluster_id = slug_map["noembed"]

    pairs = []
    for i in range(5):
        pid = _seed_member_page(
            cid,
            url=f"https://noembed{i}.com/p",
            domain=f"noembed{i}.com",
            title=f"NoEmbed {i}",
            summary=f"summary {i}",
            embedding=None,  # no row in page_embeddings for this content
            visited_minute=i + 1,
        )
        pairs.append((pid, cluster_id))
    cluster_repo.save_page_clusters(pairs)

    findings = cluster_coherence_drift.run(uid)

    assert findings == []


# -- Tier 2: zero-LLM + member evidence + generation snapshot --------------


@patch("backend.services.llm_service.LLMService.__init__")
@patch("backend.services.dq_investigations.cluster_coherence_drift.get_sbert_model")
def test_no_llm_calls_anywhere_in_s2(mock_get_sbert, mock_llm_init):
    """S2 is zero-LLM post-Tier-2: even with LLMService.__init__ poisoned to
    raise, running S2 over an incoherent cluster must not raise and must
    still emit its finding -- nothing in this module's code path
    constructs an LLMService (the old rival_hypothesis_guard did)."""
    mock_llm_init.side_effect = RuntimeError("LLMService must not be constructed by S2")
    label_vec = _vec({0: 1.0})
    mock_get_sbert.return_value = _mock_sbert_returning(label_vec)

    user = _make_user(email="no_llm_cc@example.com")
    uid = user["id"]
    cap = _make_capture(uid)
    cid = cap["id"]
    run_id = _make_completed_run(uid)

    cluster_id, *_ = _seed_incoherent_cluster(
        uid, cid, run_id, cluster_slug="drift", cluster_name="Quantum Computing"
    )

    findings = cluster_coherence_drift.run(uid)  # must not raise

    assert len(findings) == 1
    assert findings[0]["entity_id"] == str(cluster_id)
    mock_llm_init.assert_not_called()


@patch("backend.services.dq_investigations.cluster_coherence_drift.get_sbert_model")
def test_incoherent_cluster_carries_member_evidence(mock_get_sbert):
    """Finding carries a top-level `members` list -- title/domain/
    page_content_id for every member with a cached embedding, coherent AND
    outlier alike -- the batched upstream adjudicator's evidence (Tier 2,
    replaces the old guard's label + 5-outlier-prose input)."""
    label_vec = _vec({0: 1.0})
    mock_get_sbert.return_value = _mock_sbert_returning(label_vec)

    user = _make_user(email="members_cc@example.com")
    uid = user["id"]
    cap = _make_capture(uid)
    cid = cap["id"]
    run_id = _make_completed_run(uid)

    _cluster_id, _aligned_id, _outlier_ids, outlier_titles, outlier_domains = (
        _seed_incoherent_cluster(
            uid, cid, run_id, cluster_slug="drift", cluster_name="Quantum Computing"
        )
    )

    findings = cluster_coherence_drift.run(uid)

    assert len(findings) == 1
    members = findings[0]["members"]
    # All 5 members with cached embeddings ride along, not just the
    # rationale's 5-outlier preview.
    assert len(members) == 5
    for m in members:
        assert set(m.keys()) == {"title", "domain", "page_content_id"}
        assert isinstance(m["page_content_id"], int)
    titles = {m["title"] for m in members}
    assert titles == {"A Quantum Paper", *outlier_titles}
    domains = {m["domain"] for m in members}
    assert domains == {"arxiv.org", *outlier_domains}


@patch("backend.services.dq_investigations.cluster_coherence_drift.get_sbert_model")
def test_explicit_recluster_run_id_overrides_latest(mock_get_sbert):
    """An explicit recluster_run_id is used verbatim -- even when a newer
    (but here, cluster-empty) generation exists -- and `None` resolves to
    the latest completed run (Task 8's generation-snapshot fix)."""
    label_vec = _vec({0: 1.0})
    mock_get_sbert.return_value = _mock_sbert_returning(label_vec)

    user = _make_user(email="gen_snapshot_cc@example.com")
    uid = user["id"]
    cap = _make_capture(uid)
    cid = cap["id"]

    # Older generation: seed the incoherent cluster here.
    older_run_id = _make_completed_run(uid)
    cluster_id, *_ = _seed_incoherent_cluster(
        uid, cid, older_run_id, cluster_slug="drift", cluster_name="Quantum Computing"
    )

    # Newer generation: completes later, no clusters at all.
    newer_run_id = _make_completed_run(uid)
    assert newer_run_id != older_run_id

    # Default (None) resolves to the latest completed run -- which has no
    # clusters, so no findings.
    findings_default = cluster_coherence_drift.run(uid)
    assert findings_default == []

    # Explicit older run id is honored verbatim, ignoring that a newer
    # generation exists.
    findings_explicit = cluster_coherence_drift.run(uid, recluster_run_id=older_run_id)
    assert len(findings_explicit) == 1
    assert findings_explicit[0]["entity_id"] == str(cluster_id)
