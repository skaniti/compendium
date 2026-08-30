"""Integration tests for the S1 skip-gate reversal audit investigator.

Requires Docker PostgreSQL running:
  docker compose up -d
  python -m backend.db.migrate
  pytest tests/test_investigation_skip_gate.py -v
"""

from datetime import datetime, timezone

import pytest

from tests.test_repos import _pg_reachable

pytestmark = pytest.mark.skipif(
    not _pg_reachable(),
    reason="Test PostgreSQL not reachable -- run `docker compose up -d` and migrate",
)

from backend.db import annotation_repo, capture_repo, page_repo, user_repo
from backend.db.connection import get_conn
from backend.services.dq_investigations import skip_gate_reversal_audit


# ── Fixtures ─────────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _clean_tables():
    """Truncate relevant tables before each test for isolation."""
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            TRUNCATE annotations, pages, page_content,
                     captures, users
            CASCADE
            """
        )
    yield


def _make_user(email="sg_test@example.com"):
    return user_repo.create_user(email=email, name="SG Test User")


def _make_capture(user_id, capture_id="sg_cap_001"):
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
                "visited_at": datetime(2026, 4, 1, 10, idx, tzinfo=timezone.utc),
            }
        ],
    )
    return ids[0]


def _set_skip_reasoning(page_id, skip_reasoning):
    """Stamp a skip_reasoning value directly on the page row."""
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE pages SET skip_reasoning = %s WHERE id = %s",
            (skip_reasoning, page_id),
        )


def _annotate(user_id, page_id, new_value, note=None):
    """Create a validate_archive annotation."""
    annotation_repo.create_annotation(
        user_id,
        entity_type="page",
        entity_id=page_id,
        action="validate_archive",
        new_value=new_value,
        note=note,
    )


@pytest.fixture
def seeded(request):
    """Seed the three test patterns and return (user_id, pattern_labels).

    Pattern A -- "personal blog, low density":
        4 pages, 3 labelled incorrect, 1 correct. Should produce a finding.

    Pattern B -- "navigation page":
        3 pages, 0 labelled incorrect, 3 correct. Should NOT qualify
        (0 < MIN_INCORRECT=2).

    Pattern C -- "short stub":
        2 pages, 2 labelled incorrect. Should NOT qualify
        (2 < MIN_TOTAL=3).
    """
    user = _make_user()
    uid = user["id"]
    cap = _make_capture(uid)
    cid = cap["id"]

    reason_a = "personal blog, low density"
    reason_b = "navigation page"
    reason_c = "short stub"

    # Pattern A: 4 pages, 3 incorrect, 1 correct
    page_idx = 1
    a_ids = []
    for i in range(4):
        pid = _insert_page(cid, f"https://blog{i}.example.com/", f"Blog {i}", "blog.example.com", page_idx)
        page_idx += 1
        _set_skip_reasoning(pid, reason_a)
        a_ids.append(pid)

    _annotate(uid, a_ids[0], "incorrect", note="too shallow")
    _annotate(uid, a_ids[1], "incorrect", note="relevant content skipped")
    _annotate(uid, a_ids[2], "incorrect")
    _annotate(uid, a_ids[3], "correct")

    # Pattern B: 3 pages, 0 incorrect
    b_ids = []
    for i in range(3):
        pid = _insert_page(cid, f"https://nav{i}.example.com/", f"Nav {i}", "nav.example.com", page_idx)
        page_idx += 1
        _set_skip_reasoning(pid, reason_b)
        b_ids.append(pid)

    for pid in b_ids:
        _annotate(uid, pid, "correct")

    # Pattern C: 2 pages, 2 incorrect (below MIN_TOTAL)
    c_ids = []
    for i in range(2):
        pid = _insert_page(cid, f"https://stub{i}.example.com/", f"Stub {i}", "stub.example.com", page_idx)
        page_idx += 1
        _set_skip_reasoning(pid, reason_c)
        c_ids.append(pid)

    for pid in c_ids:
        _annotate(uid, pid, "incorrect")

    return {
        "user_id": uid,
        "reason_a": reason_a,
        "reason_b": reason_b,
        "reason_c": reason_c,
    }


# ── Tests ────────────────────────────────────────────────────────────────


def test_run_produces_finding_for_qualifying_pattern(seeded):
    """Pattern A meets both thresholds; exactly one finding is returned."""
    findings = skip_gate_reversal_audit.run(seeded["user_id"])

    assert len(findings) == 1

    f = findings[0]
    assert f["tag"] == "core"
    assert f["scope_citation"] == "S1"
    assert f["recommendation"]["action_type"] == "edit_prompt"
    assert f["rank"] == 1
    # Observation should reference the pattern text
    assert seeded["reason_a"] in f["observation"] or seeded["reason_a"][:80] in f["observation"]


def test_run_ignores_patterns_below_threshold(seeded):
    """Pattern B (0 incorrect) and Pattern C (2 total) must not appear."""
    findings = skip_gate_reversal_audit.run(seeded["user_id"])

    reason_b = seeded["reason_b"]
    reason_c = seeded["reason_c"]

    observation_texts = [f["observation"] for f in findings]
    for obs in observation_texts:
        assert reason_b not in obs, f"Pattern B should not appear in findings: {obs}"
        assert reason_c not in obs, f"Pattern C should not appear in findings: {obs}"


def test_run_returns_empty_when_no_annotations():
    """A user with no validate_archive annotations should get an empty list."""
    user = _make_user(email="empty@example.com")
    uid = user["id"]
    # Create a capture + page with skip_reasoning, but no annotation
    cap = _make_capture(uid, capture_id="empty_cap")
    pid = _insert_page(cap["id"], "https://example.com/solo", "Solo", "example.com", 1)
    _set_skip_reasoning(pid, "personal blog, low density")

    findings = skip_gate_reversal_audit.run(uid)
    assert findings == []


def test_recluster_run_id_accepted_but_unused(seeded):
    """S1 accepts recluster_run_id for interface uniformity with the other
    five investigators (Task 8 calls all six with the same signature) but
    ignores it -- annotations aren't scoped to a recluster generation.
    Passing an arbitrary value must not change the result."""
    findings_default = skip_gate_reversal_audit.run(seeded["user_id"])
    findings_with_id = skip_gate_reversal_audit.run(
        seeded["user_id"], recluster_run_id=999999
    )
    assert findings_with_id == findings_default
