"""Integration tests for backend/services/dq_apply.py (dqBot Tier 1, spec S5).

Requires Docker PostgreSQL running:
  docker compose up -d
  python -m backend.db.migrate
  pytest tests/test_dq_apply.py -v

cluster_identity_enabled defaults False locally, but these tests write
stable_id directly into `clusters` rows via cluster_repo.save_clusters --
no dependency on the flag (per the worker brief).
"""

from datetime import datetime, timezone

import pytest

from tests.test_repos import _pg_reachable

pytestmark = pytest.mark.skipif(
    not _pg_reachable(), reason="Test PostgreSQL not reachable"
)

from backend.db import (
    capture_repo,
    cluster_repo,
    content_repo,
    dq_observations_repo,
    dq_overrides_repo,
    dq_recommendations_repo,
    dq_runs_repo,
    page_repo,
    recluster_repo,
    user_repo,
)
from backend.db.connection import get_conn, set_current_user_id
from backend.services import dq_apply


# ── Fixtures ─────────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _clean_tables():
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            TRUNCATE dq_overrides, dq_recommendations, dq_observations, dq_runs,
                     dq_vocab_issue_types, annotations, page_clusters, clusters,
                     recluster_runs, pages, page_content, captures, users
            CASCADE
            """
        )
    yield


@pytest.fixture
def uid():
    user = user_repo.create_user(email="dqapply@test.com", name="DQ Apply Test")
    set_current_user_id(user["id"])
    return user["id"]


def _make_capture(user_id, capture_id="dqapply_cap"):
    return capture_repo.save_capture(
        user_id=user_id,
        capture_id=capture_id,
        source="desktop_active",
        started_at=datetime(2026, 7, 1, 10, 0, tzinfo=timezone.utc),
        ended_at=datetime(2026, 7, 1, 11, 0, tzinfo=timezone.utc),
    )


def _insert_page(capture_db_id, idx, *, url=None, status="active"):
    """Insert one page with a distinct visited_at to avoid dedup collapse."""
    ids = page_repo.insert_pages(
        capture_db_id,
        [
            {
                "url": url or f"https://example{idx}.com/",
                "title": f"Page {idx}",
                "domain": f"example{idx}.com",
                "visited_at": datetime(
                    2026, 7, 1, 10, idx % 60, idx // 60, tzinfo=timezone.utc
                ),
            }
        ],
    )
    page_id = ids[0]
    if status != "pending":
        with get_conn() as conn, conn.cursor() as cur:
            cur.execute("UPDATE pages SET status = %s WHERE id = %s", (status, page_id))
    return page_id


def _make_page_content(url):
    return content_repo.get_or_create_content(url=url)["id"]


def _seed_generation(user_id, clusters: list[dict]) -> tuple[int, dict[str, int]]:
    """clusters: list of {'cluster_slug', 'cluster_name', 'stable_id'} dicts.
    Returns (run_id, {slug: cluster_id})."""
    run_id = recluster_repo.start_run(user_id)
    recluster_repo.complete_run(
        run_id, cluster_count=len(clusters), noise_count=0,
        naming_cost=0.0, elapsed_seconds=0.1,
    )
    slug_to_id = cluster_repo.save_clusters(user_id, run_id, clusters)
    return run_id, slug_to_id


def _seed_run_and_obs(user_id, *, entity_type="cluster", entity_id="1", issue_type="test_issue"):
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO dq_vocab_issue_types (user_id, issue_type, status)
            VALUES (%s, %s, 'proposed')
            ON CONFLICT (user_id, issue_type) DO NOTHING
            """,
            (user_id, issue_type),
        )
    run = dq_runs_repo.start_run(user_id=user_id, trigger="manual")
    obs = dq_observations_repo.create_observation(
        user_id=user_id, run_id=run["id"], tag="core",
        entity_type=entity_type, entity_id=entity_id,
        issue_type=issue_type, observation="test observation", severity="info",
    )
    return run["id"], obs["id"]


def _seed_rec(user_id, run_id, obs_id, *, action_type, action_payload=None,
              affected_entity_ids=None, affected_entity_type="cluster"):
    return dq_recommendations_repo.create_recommendation(
        user_id=user_id, run_id=run_id, observation_id=obs_id,
        action_type=action_type, headline="test headline", rationale="test rationale",
        self_classification="judgment", rank_in_run=1,
        affected_entity_type=affected_entity_type,
        affected_entity_ids=affected_entity_ids or [],
        action_payload=action_payload,
    )


# ── relabel_cluster ─────────────────────────────────────────────────────


class TestRelabelCluster:
    def test_happy_path_updates_current_gen_and_creates_override(self, uid):
        run_id, slugs = _seed_generation(
            uid, [{"cluster_slug": "old", "cluster_name": "Old Name", "stable_id": "sid-1"}]
        )
        r_run_id, obs_id = _seed_run_and_obs(uid)
        rec = _seed_rec(
            uid, r_run_id, obs_id,
            action_type="relabel_cluster",
            action_payload={"stable_id": "sid-1", "proposed_label": "New Name"},
        )

        detail = dq_apply.apply(rec, uid)

        assert detail["applied"] is True
        assert detail["cluster_rows_updated"] == 1
        assert detail["override_id"] is not None
        assert "reason" not in detail

        with get_conn() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT cluster_name FROM clusters WHERE id = %s", (slugs["old"],)
            )
            assert cur.fetchone()[0] == "New Name"

        overrides = dq_overrides_repo.list_active(uid)
        assert len(overrides) == 1
        assert overrides[0]["override_type"] == "pin_label"
        assert overrides[0]["subject"] == {"stable_id": "sid-1"}
        assert overrides[0]["payload"] == {"label": "New Name"}
        assert overrides[0]["source_rec_id"] == rec["id"]

    def test_dormant_stable_id_still_creates_override(self, uid):
        # Two generations: gen 1 has sid-1, gen 2 (current) does not carry it.
        _seed_generation(
            uid, [{"cluster_slug": "old", "cluster_name": "Old Name", "stable_id": "sid-1"}]
        )
        _seed_generation(
            uid, [{"cluster_slug": "new", "cluster_name": "Unrelated", "stable_id": "sid-2"}]
        )
        r_run_id, obs_id = _seed_run_and_obs(uid)
        rec = _seed_rec(
            uid, r_run_id, obs_id,
            action_type="relabel_cluster",
            action_payload={"stable_id": "sid-1", "proposed_label": "New Name"},
        )

        detail = dq_apply.apply(rec, uid)

        assert detail["applied"] is False
        assert detail["cluster_rows_updated"] == 0
        assert detail["reason"] == "target dormant this generation"
        assert detail["override_id"] is not None

        overrides = dq_overrides_repo.list_active(uid)
        assert len(overrides) == 1
        assert overrides[0]["override_type"] == "pin_label"

    def test_malformed_payload_missing_proposed_label_is_record_only(self, uid):
        _seed_generation(
            uid, [{"cluster_slug": "old", "cluster_name": "Old Name", "stable_id": "sid-1"}]
        )
        r_run_id, obs_id = _seed_run_and_obs(uid)
        rec = _seed_rec(
            uid, r_run_id, obs_id,
            action_type="relabel_cluster",
            action_payload={"stable_id": "sid-1"},
        )

        detail = dq_apply.apply(rec, uid)

        assert detail["applied"] is False
        assert detail["reason"].startswith("record-only")
        assert dq_overrides_repo.list_active(uid) == []

    def test_missing_payload_entirely_is_record_only(self, uid):
        r_run_id, obs_id = _seed_run_and_obs(uid)
        rec = _seed_rec(uid, r_run_id, obs_id, action_type="relabel_cluster", action_payload=None)

        detail = dq_apply.apply(rec, uid)

        assert detail["applied"] is False
        assert detail["reason"].startswith("record-only")
        assert dq_overrides_repo.list_active(uid) == []


# ── split_cluster ───────────────────────────────────────────────────────


class TestSplitCluster:
    def test_happy_path_removes_page_and_creates_override(self, uid):
        cap = _make_capture(uid)
        page_id = _insert_page(cap["id"], 1)
        content_id = _make_page_content("https://example1.com/")
        with get_conn() as conn, conn.cursor() as cur:
            cur.execute(
                "UPDATE pages SET page_content_id = %s WHERE id = %s",
                (content_id, page_id),
            )

        run_id, slugs = _seed_generation(
            uid, [{"cluster_slug": "silo", "cluster_name": "Silo", "stable_id": "sid-split"}]
        )
        cluster_repo.save_page_clusters([(page_id, slugs["silo"])])

        r_run_id, obs_id = _seed_run_and_obs(uid)
        rec = _seed_rec(
            uid, r_run_id, obs_id,
            action_type="split_cluster",
            action_payload={
                "stable_id": "sid-split",
                "remove_page_content_ids": [content_id],
                "page_ids": [page_id],
            },
        )

        detail = dq_apply.apply(rec, uid)

        assert detail["applied"] is True
        assert detail["page_cluster_rows_removed"] == 1
        assert detail["override_id"] is not None

        with get_conn() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT COUNT(*) FROM page_clusters WHERE cluster_id = %s AND page_id = %s",
                (slugs["silo"], page_id),
            )
            assert cur.fetchone()[0] == 0

        overrides = dq_overrides_repo.list_active(uid)
        assert len(overrides) == 1
        assert overrides[0]["override_type"] == "exclude_from_cluster"
        assert overrides[0]["subject"] == {"stable_id": "sid-split"}
        assert overrides[0]["payload"] == {"page_content_ids": [content_id]}

    def test_dormant_stable_id_still_creates_override(self, uid):
        cap = _make_capture(uid)
        page_id = _insert_page(cap["id"], 1)
        content_id = _make_page_content("https://example1.com/")
        with get_conn() as conn, conn.cursor() as cur:
            cur.execute(
                "UPDATE pages SET page_content_id = %s WHERE id = %s",
                (content_id, page_id),
            )

        _seed_generation(
            uid, [{"cluster_slug": "silo", "cluster_name": "Silo", "stable_id": "sid-split"}]
        )
        _seed_generation(
            uid, [{"cluster_slug": "other", "cluster_name": "Other", "stable_id": "sid-other"}]
        )

        r_run_id, obs_id = _seed_run_and_obs(uid)
        rec = _seed_rec(
            uid, r_run_id, obs_id,
            action_type="split_cluster",
            action_payload={"stable_id": "sid-split", "remove_page_content_ids": [content_id]},
        )

        detail = dq_apply.apply(rec, uid)

        assert detail["applied"] is False
        assert detail["page_cluster_rows_removed"] == 0
        assert detail["reason"] == "target dormant this generation"
        assert detail["override_id"] is not None

    def test_malformed_payload_missing_remove_ids_is_record_only(self, uid):
        r_run_id, obs_id = _seed_run_and_obs(uid)
        rec = _seed_rec(
            uid, r_run_id, obs_id,
            action_type="split_cluster",
            action_payload={"stable_id": "sid-split"},
        )

        detail = dq_apply.apply(rec, uid)

        assert detail["applied"] is False
        assert detail["reason"].startswith("record-only")
        assert dq_overrides_repo.list_active(uid) == []


# ── dedupe ──────────────────────────────────────────────────────────────


class TestDedupe:
    def test_happy_path_archives_pages(self, uid):
        cap = _make_capture(uid)
        keep_id = _insert_page(cap["id"], 1)
        dup_id = _insert_page(cap["id"], 2)

        r_run_id, obs_id = _seed_run_and_obs(
            uid, entity_type="page", entity_id=str(keep_id)
        )
        rec = _seed_rec(
            uid, r_run_id, obs_id,
            action_type="dedupe",
            affected_entity_type="page",
            action_payload={"groups": [{"keep_page_id": keep_id, "archive_page_ids": [dup_id]}]},
        )

        detail = dq_apply.apply(rec, uid)

        assert detail["applied"] is True
        assert detail["archived_count"] == 1
        assert detail["skipped_count"] == 0
        assert detail["groups"] == [
            {"keep_page_id": keep_id, "archived": [dup_id], "skipped": []}
        ]

        with get_conn() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT status, archive_reason FROM pages WHERE id = %s", (dup_id,)
            )
            status, reason = cur.fetchone()
            assert status == "archived"
            assert reason == "dedupe_fold"
            # keep_id untouched
            cur.execute("SELECT status FROM pages WHERE id = %s", (keep_id,))
            assert cur.fetchone()[0] == "active"

        # No override created for dedupe.
        assert dq_overrides_repo.list_active(uid) == []

    def test_human_override_page_is_skipped(self, uid):
        cap = _make_capture(uid)
        keep_id = _insert_page(cap["id"], 1)
        protected_id = _insert_page(cap["id"], 2)
        unprotected_id = _insert_page(cap["id"], 3)

        with get_conn() as conn, conn.cursor() as cur:
            cur.execute(
                "UPDATE pages SET human_status = 'active' WHERE id = %s", (protected_id,)
            )

        r_run_id, obs_id = _seed_run_and_obs(
            uid, entity_type="page", entity_id=str(keep_id)
        )
        rec = _seed_rec(
            uid, r_run_id, obs_id,
            action_type="dedupe",
            affected_entity_type="page",
            action_payload={
                "groups": [
                    {
                        "keep_page_id": keep_id,
                        "archive_page_ids": [protected_id, unprotected_id],
                    }
                ]
            },
        )

        detail = dq_apply.apply(rec, uid)

        assert detail["applied"] is True
        assert detail["archived_count"] == 1
        assert detail["skipped_count"] == 1
        group = detail["groups"][0]
        assert group["archived"] == [unprotected_id]
        assert group["skipped"] == [protected_id]

        with get_conn() as conn, conn.cursor() as cur:
            cur.execute("SELECT status FROM pages WHERE id = %s", (protected_id,))
            assert cur.fetchone()[0] == "active"
            cur.execute("SELECT status FROM pages WHERE id = %s", (unprotected_id,))
            assert cur.fetchone()[0] == "archived"

    def test_all_skipped_is_applied_false_with_reason(self, uid):
        cap = _make_capture(uid)
        keep_id = _insert_page(cap["id"], 1)
        protected_id = _insert_page(cap["id"], 2)
        with get_conn() as conn, conn.cursor() as cur:
            cur.execute(
                "UPDATE pages SET human_status = 'active' WHERE id = %s", (protected_id,)
            )

        r_run_id, obs_id = _seed_run_and_obs(uid, entity_type="page", entity_id=str(keep_id))
        rec = _seed_rec(
            uid, r_run_id, obs_id,
            action_type="dedupe",
            affected_entity_type="page",
            action_payload={"groups": [{"keep_page_id": keep_id, "archive_page_ids": [protected_id]}]},
        )

        detail = dq_apply.apply(rec, uid)

        assert detail["applied"] is False
        assert detail["archived_count"] == 0
        assert detail["skipped_count"] == 1
        assert "reason" in detail

    def test_malformed_payload_missing_groups_is_record_only(self, uid):
        r_run_id, obs_id = _seed_run_and_obs(uid, entity_type="page", entity_id="1")
        rec = _seed_rec(
            uid, r_run_id, obs_id, action_type="dedupe", affected_entity_type="page",
            action_payload={},
        )

        detail = dq_apply.apply(rec, uid)

        assert detail["applied"] is False
        assert detail["reason"].startswith("record-only")


# ── merge_clusters ──────────────────────────────────────────────────────


class TestMergeClusters:
    def test_creates_override_only_no_live_mutation(self, uid):
        _seed_generation(
            uid, [
                {"cluster_slug": "a", "cluster_name": "A", "stable_id": "sid-a"},
                {"cluster_slug": "b", "cluster_name": "B", "stable_id": "sid-b"},
            ]
        )
        r_run_id, obs_id = _seed_run_and_obs(uid)
        rec = _seed_rec(
            uid, r_run_id, obs_id,
            action_type="merge_clusters",
            action_payload={"stable_ids": ["sid-a", "sid-b"]},
        )

        detail = dq_apply.apply(rec, uid)

        assert detail["applied"] is False
        assert detail["reason"] == "applies at next recluster"
        assert detail["override_id"] is not None

        overrides = dq_overrides_repo.list_active(uid)
        assert len(overrides) == 1
        assert overrides[0]["override_type"] == "merge_clusters"
        # No pages seeded onto either cluster -- union is empty, but the key
        # is always present now (durability rider, Task 5).
        assert overrides[0]["subject"] == {
            "stable_ids": ["sid-a", "sid-b"],
            "member_content_ids": [],
        }
        assert overrides[0]["source_rec_id"] == rec["id"]

        # Cluster rows are untouched -- merge is deferred, not live surgery.
        with get_conn() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT COUNT(*) FROM clusters WHERE user_id = %s", (uid,)
            )
            assert cur.fetchone()[0] == 2

    def test_happy_path_captures_member_content_ids_union(self, uid):
        """Merge-override durability rider (Task 5): the override's subject
        must carry the union of the subject clusters' current-generation
        member page_content_ids, captured at approve time -- this is what
        lets the override re-match by content after a merge destroys the
        stable_ids it was keyed on."""
        cap = _make_capture(uid)
        page_a1 = _insert_page(cap["id"], 1)
        page_a2 = _insert_page(cap["id"], 2)
        page_b1 = _insert_page(cap["id"], 3)
        content_a1 = _make_page_content("https://example1.com/")
        content_a2 = _make_page_content("https://example2.com/")
        content_b1 = _make_page_content("https://example3.com/")
        with get_conn() as conn, conn.cursor() as cur:
            cur.execute(
                "UPDATE pages SET page_content_id = %s WHERE id = %s",
                (content_a1, page_a1),
            )
            cur.execute(
                "UPDATE pages SET page_content_id = %s WHERE id = %s",
                (content_a2, page_a2),
            )
            cur.execute(
                "UPDATE pages SET page_content_id = %s WHERE id = %s",
                (content_b1, page_b1),
            )

        run_id, slugs = _seed_generation(
            uid, [
                {"cluster_slug": "a", "cluster_name": "A", "stable_id": "sid-a"},
                {"cluster_slug": "b", "cluster_name": "B", "stable_id": "sid-b"},
            ]
        )
        cluster_repo.save_page_clusters(
            [
                (page_a1, slugs["a"]),
                (page_a2, slugs["a"]),
                (page_b1, slugs["b"]),
            ]
        )

        r_run_id, obs_id = _seed_run_and_obs(uid)
        rec = _seed_rec(
            uid, r_run_id, obs_id,
            action_type="merge_clusters",
            action_payload={"stable_ids": ["sid-a", "sid-b"]},
        )

        detail = dq_apply.apply(rec, uid)

        assert detail["applied"] is False
        assert detail["reason"] == "applies at next recluster"

        overrides = dq_overrides_repo.list_active(uid)
        assert len(overrides) == 1
        subject = overrides[0]["subject"]
        assert subject["stable_ids"] == ["sid-a", "sid-b"]
        assert sorted(subject["member_content_ids"]) == sorted(
            [content_a1, content_a2, content_b1]
        )

    def test_malformed_payload_single_stable_id_is_record_only(self, uid):
        r_run_id, obs_id = _seed_run_and_obs(uid)
        rec = _seed_rec(
            uid, r_run_id, obs_id,
            action_type="merge_clusters",
            action_payload={"stable_ids": ["sid-a"]},
        )

        detail = dq_apply.apply(rec, uid)

        assert detail["applied"] is False
        assert detail["reason"].startswith("record-only")
        assert dq_overrides_repo.list_active(uid) == []


# ── record-only action types + generic error handling ──────────────────


class TestRecordOnlyAndErrors:
    @pytest.mark.parametrize(
        "action_type", ["flag_for_review", "edit_prompt", "relabel_supercluster", "totally_unknown"]
    )
    def test_non_actionable_types_are_record_only(self, uid, action_type):
        r_run_id, obs_id = _seed_run_and_obs(uid, entity_type="global", entity_id="x")
        rec = _seed_rec(
            uid, r_run_id, obs_id, action_type=action_type,
            affected_entity_type="global",
            action_payload={"stable_id": "sid-doesnt-matter", "proposed_label": "x"},
        )

        detail = dq_apply.apply(rec, uid)

        assert detail["applied"] is False
        assert detail["reason"].startswith("record-only")
        assert dq_overrides_repo.list_active(uid) == []

    def test_unexpected_exception_is_caught_and_reported(self, uid, monkeypatch):
        """An exception raised mid-apply (e.g. override creation blows up) must
        never propagate -- apply() catches it and reports applied=False+error."""
        _seed_generation(
            uid, [{"cluster_slug": "old", "cluster_name": "Old Name", "stable_id": "sid-1"}]
        )
        r_run_id, obs_id = _seed_run_and_obs(uid)
        rec = _seed_rec(
            uid, r_run_id, obs_id,
            action_type="relabel_cluster",
            action_payload={"stable_id": "sid-1", "proposed_label": "New Name"},
        )

        def _boom(*args, **kwargs):
            raise RuntimeError("simulated override-creation failure")

        monkeypatch.setattr(dq_apply.dq_overrides_repo, "create_override", _boom)

        detail = dq_apply.apply(rec, uid)

        assert detail["applied"] is False
        assert "error" in detail
        assert "simulated override-creation failure" in detail["error"]
