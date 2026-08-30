"""Integration tests for the S5 dedup-escapees investigator.

Requires Docker PostgreSQL running:
  docker compose up -d
  python -m backend.db.migrate
  pytest tests/test_investigation_dedup_escapees.py -v
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
    content_repo,
    embedding_repo,
    page_repo,
    user_repo,
)
from backend.db.connection import get_conn
from backend.services.dq_investigations import dedup_escapees


# -- Fixtures --------------------------------------------------------------


@pytest.fixture(autouse=True)
def _clean_tables():
    """Truncate relevant tables before each test for isolation."""
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            TRUNCATE annotations, page_clusters, clusters, recluster_runs,
                     page_embeddings, pages, page_content, captures, users
            CASCADE
            """
        )
    yield


def _make_user(email="dedup_test@example.com"):
    return user_repo.create_user(email=email, name="Dedup Test User")


def _make_capture(user_id, capture_id="dedup_cap_001"):
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


def _seed_page_with_embedding(
    capture_db_id: int,
    *,
    url: str,
    domain: str,
    title: str,
    summary: str,
    embedding: list[float],
    visited_minute: int,
    status: str = "active",
) -> tuple[int, int]:
    """Insert page_content + pages row + page_embeddings row, all linked.

    Returns (page_id, page_content_id).
    """
    pc = content_repo.get_or_create_content(
        url=url,
        content_summary=summary,
    )
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

    # Link page -> page_content and set status. content_repo creates the
    # canonical row; insert_pages doesn't auto-link, so we attach here.
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE pages SET page_content_id = %s, status = %s WHERE id = %s",
            (page_content_id, status, page_id),
        )

    embedding_repo.save_embedding(page_content_id, embedding)
    return page_id, page_content_id


# -- Tests -----------------------------------------------------------------


def test_qualifying_pair_emits_finding():
    """Two pages with cosine similarity >0.94 produce one global finding."""
    user = _make_user()
    uid = user["id"]
    cap = _make_capture(uid)
    cid = cap["id"]

    # Two near-identical unit vectors. cos(v_a, v_b) = 0.99 > 0.94 → qualifies.
    v_a = _vec({0: 1.0})
    v_b = _vec({0: 0.99, 1: 0.141})  # 0.99^2 + 0.141^2 ~ 1, cos ~ 0.99

    page_a, _ = _seed_page_with_embedding(
        cid,
        url="https://example.com/article",
        domain="example.com",
        title="Article",
        summary="The original article.",
        embedding=v_a,
        visited_minute=1,
    )
    page_b, _ = _seed_page_with_embedding(
        cid,
        url="https://example.com/article?utm=foo",
        domain="example.com",
        title="Article (tracked)",
        summary="The duplicate article.",
        embedding=v_b,
        visited_minute=2,
    )

    findings = dedup_escapees.run(uid)

    assert len(findings) == 1
    f = findings[0]
    assert f["tag"] == "core"
    assert f["scope_citation"] == "S5"
    assert f["issue_type"] == "dedup_escapees"
    assert f["entity_type"] == "global"
    assert f["recommendation"]["action_type"] == "dedupe"
    assert f["rank"] == 1

    pairs = f["recommendation"]["affected_entity_ids"]
    assert pairs == [[page_a, page_b]]  # lower id first

    # Deterministic action_payload (spec S4): keep = lower page id, mirrors
    # the existing pair output directly -- no extra query needed.
    assert f["recommendation"]["action_payload"] == {
        "groups": [{"keep_page_id": page_a, "archive_page_ids": [page_b]}]
    }

    # Headline includes pair count + a domain example.
    headline = f["recommendation"]["headline"]
    assert "1 candidate duplicate pair" in headline
    assert "example.com" in headline

    # Rationale lists both URLs and a similarity figure.
    rationale = f["recommendation"]["rationale"]
    assert "example.com/article" in rationale
    assert "example.com/article?utm=foo" in rationale


def test_below_threshold_pair_emits_no_finding():
    """Two pages with cosine similarity ~0.90 (below 0.94) yield no finding."""
    user = _make_user()
    uid = user["id"]
    cap = _make_capture(uid)
    cid = cap["id"]

    # cos(v_a, v_b) = 0.90 < 0.94 → does not qualify.
    v_a = _vec({0: 1.0})
    v_b = _vec({0: 0.90, 1: 0.4359})  # 0.90^2 + 0.4359^2 ~ 1, cos ~ 0.90

    _seed_page_with_embedding(
        cid,
        url="https://example.com/topic-a",
        domain="example.com",
        title="Topic A",
        summary="Summary A.",
        embedding=v_a,
        visited_minute=1,
    )
    _seed_page_with_embedding(
        cid,
        url="https://example.com/topic-b",
        domain="example.com",
        title="Topic B",
        summary="Summary B.",
        embedding=v_b,
        visited_minute=2,
    )

    assert dedup_escapees.run(uid) == []


def test_archived_pages_are_excluded():
    """Archived/skipped pages don't surface as dedup candidates."""
    user = _make_user()
    uid = user["id"]
    cap = _make_capture(uid)
    cid = cap["id"]

    v_a = _vec({0: 1.0})
    v_b = _vec({0: 0.99, 1: 0.141})  # cos ~ 0.99, would qualify if both active

    _seed_page_with_embedding(
        cid,
        url="https://example.com/active",
        domain="example.com",
        title="Active",
        summary="Active page.",
        embedding=v_a,
        visited_minute=1,
        status="active",
    )
    _seed_page_with_embedding(
        cid,
        url="https://example.com/archived",
        domain="example.com",
        title="Archived",
        summary="Archived page.",
        embedding=v_b,
        visited_minute=2,
        status="archived",
    )

    assert dedup_escapees.run(uid) == []


def test_placeholder_summary_pairs_are_excluded():
    """Pages whose content_summary is the 'Page browsed outside API tool
    scope for N seconds' placeholder must never surface as dedup
    candidates, even though their boilerplate embeddings clear the
    similarity threshold (added 2026-07-17, belt-and-braces against the
    placeholder purge regressing -- see module docstring)."""
    user = _make_user()
    uid = user["id"]
    cap = _make_capture(uid)
    cid = cap["id"]

    v_a = _vec({0: 1.0})
    v_b = _vec({0: 0.99, 1: 0.141})  # cos ~ 0.99, would qualify if not placeholders

    _seed_page_with_embedding(
        cid,
        url="https://example.com/placeholder-a",
        domain="example.com",
        title="Placeholder A",
        summary="Page browsed outside API tool scope for 12 seconds",
        embedding=v_a,
        visited_minute=1,
    )
    _seed_page_with_embedding(
        cid,
        url="https://example.com/placeholder-b",
        domain="example.com",
        title="Placeholder B",
        summary="Page browsed outside API tool scope for 47 seconds",
        embedding=v_b,
        visited_minute=2,
    )

    assert dedup_escapees.run(uid) == []


def test_placeholder_paired_with_real_page_is_also_excluded():
    """A placeholder page paired with a real (non-placeholder) page above
    threshold is excluded too -- either side matching the pattern
    disqualifies the pair, not just placeholder-placeholder pairs."""
    user = _make_user()
    uid = user["id"]
    cap = _make_capture(uid)
    cid = cap["id"]

    v_a = _vec({0: 1.0})
    v_b = _vec({0: 0.99, 1: 0.141})

    _seed_page_with_embedding(
        cid,
        url="https://example.com/real-article",
        domain="example.com",
        title="Real Article",
        summary="An in-depth look at something real.",
        embedding=v_a,
        visited_minute=1,
    )
    _seed_page_with_embedding(
        cid,
        url="https://example.com/placeholder-only",
        domain="example.com",
        title="Placeholder",
        summary="Page browsed outside API tool scope for 5 seconds",
        embedding=v_b,
        visited_minute=2,
    )

    assert dedup_escapees.run(uid) == []


def test_other_user_pairs_are_not_surfaced():
    """A near-duplicate pair owned by another user must not leak across."""
    user_a = _make_user(email="user_a@example.com")
    user_b = _make_user(email="user_b@example.com")
    cap_a = _make_capture(user_a["id"], capture_id="dedup_cap_a")
    cap_b = _make_capture(user_b["id"], capture_id="dedup_cap_b")

    v_a = _vec({0: 1.0})
    v_b = _vec({0: 0.99, 1: 0.141})

    # User A has only one page.
    _seed_page_with_embedding(
        cap_a["id"],
        url="https://example.com/lonely",
        domain="example.com",
        title="Lonely",
        summary="Only page for A.",
        embedding=v_a,
        visited_minute=1,
    )

    # User B has the near-duplicate. Even though both share the embedding
    # space, the query must filter to user A only.
    _seed_page_with_embedding(
        cap_b["id"],
        url="https://example.com/other-user",
        domain="example.com",
        title="Other",
        summary="Other user's page.",
        embedding=v_b,
        visited_minute=1,
    )

    assert dedup_escapees.run(user_a["id"]) == []


def test_empty_user_returns_empty_list():
    """User with no pages / no embeddings returns an empty list."""
    user = _make_user(email="empty_dedup@example.com")
    assert dedup_escapees.run(user["id"]) == []


def test_recluster_run_id_accepted_but_unused():
    """S5 accepts recluster_run_id for interface uniformity with the other
    five investigators (Task 8 calls all six with the same signature) but
    ignores it -- S5 scans active page-summary embeddings directly and has
    no recluster_run concept. Passing an arbitrary value must not change
    the result."""
    user = _make_user()
    uid = user["id"]
    cap = _make_capture(uid)
    cid = cap["id"]

    v_a = _vec({0: 1.0})
    v_b = _vec({0: 0.99, 1: 0.141})

    page_a, _ = _seed_page_with_embedding(
        cid,
        url="https://example.com/article",
        domain="example.com",
        title="Article",
        summary="The original article.",
        embedding=v_a,
        visited_minute=1,
    )
    page_b, _ = _seed_page_with_embedding(
        cid,
        url="https://example.com/article?utm=foo",
        domain="example.com",
        title="Article (tracked)",
        summary="The duplicate article.",
        embedding=v_b,
        visited_minute=2,
    )

    findings_default = dedup_escapees.run(uid)
    findings_with_id = dedup_escapees.run(uid, recluster_run_id=999999)
    assert findings_with_id == findings_default
    assert len(findings_default) == 1
