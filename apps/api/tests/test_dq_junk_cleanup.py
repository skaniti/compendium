"""Integration tests for backend/scripts/dq_junk_cleanup.py.

The three archive reasons this script writes (``app_chrome_junk``,
``placeholder_no_content``, ``dedupe_fold``) are allowlisted in
``pages_archive_reason_check`` by migration 041 (the gap was caught during
implementation: migration 011's original list predated them).
"""

from datetime import datetime, timezone

import pytest

from tests.test_repos import _pg_reachable

pytestmark = pytest.mark.skipif(not _pg_reachable(), reason="Test PostgreSQL not reachable")

from backend.db import capture_repo, user_repo
from backend.db.connection import get_conn
from backend.scripts import dq_junk_cleanup


@pytest.fixture
def ctx():
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "TRUNCATE annotations, page_clusters, clusters, recluster_runs, "
            "pages, page_content, captures, users CASCADE"
        )
    uid = user_repo.create_user(email="cleanup@t.com", name="cleanup")["id"]
    cap = capture_repo.save_capture(
        user_id=uid,
        capture_id="cleanup_cap_1",
        source="desktop_active",
        started_at=datetime(2026, 7, 1, 10, 0, tzinfo=timezone.utc),
        ended_at=datetime(2026, 7, 1, 11, 0, tzinfo=timezone.utc),
    )
    return {"user_id": uid, "capture_id": cap["id"]}


def _insert_page(
    ctx,
    url="https://example.com/x",
    title="t",
    status="active",
    human_status=None,
    content_summary=None,
) -> int:
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO pages (capture_id, user_id, url, normalized_url, title,
                                status, human_status, content_summary)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING id
            """,
            (ctx["capture_id"], ctx["user_id"], url, url, title, status, human_status, content_summary),
        )
        return cur.fetchone()[0]


def _matched_ids(where_fn) -> list[int]:
    where_sql, params = where_fn()
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(f"SELECT id FROM pages WHERE {where_sql} ORDER BY id", params)
        return [r[0] for r in cur.fetchall()]


def _fetch_page(page_id):
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT status, archive_reason FROM pages WHERE id = %s", (page_id,)
        )
        return cur.fetchone()


# ── (a) chrome: path matching + /chat exclusion + human-override guard ─────


def test_chrome_matches_bare_root(ctx):
    pid = _insert_page(ctx, url="https://claude.ai")
    assert _matched_ids(dq_junk_cleanup._chrome_where) == [pid]


def test_chrome_matches_root_with_trailing_slash(ctx):
    pid = _insert_page(ctx, url="https://claude.ai/")
    assert _matched_ids(dq_junk_cleanup._chrome_where) == [pid]


def test_chrome_matches_denylist_prefix_paths(ctx):
    ids = [
        _insert_page(ctx, url="https://claude.ai/new"),
        _insert_page(ctx, url="https://claude.ai/recents"),
        _insert_page(ctx, url="https://www.claude.ai/settings"),
        _insert_page(ctx, url="https://claude.ai/settings/profile"),
        _insert_page(ctx, url="https://claude.ai/projects"),
        _insert_page(ctx, url="https://claude.ai/downloads"),
        _insert_page(ctx, url="https://claude.ai/login"),
        _insert_page(ctx, url="https://claude.ai/logout"),
        _insert_page(ctx, url="https://claude.ai/oauth"),
        _insert_page(ctx, url="https://claude.ai/magic-link"),
    ]
    assert sorted(_matched_ids(dq_junk_cleanup._chrome_where)) == sorted(ids)


def test_chrome_excludes_chat_transcripts(ctx):
    _insert_page(ctx, url="https://claude.ai/chat/abc-123-uuid")
    assert _matched_ids(dq_junk_cleanup._chrome_where) == []


def test_chrome_excludes_other_paths(ctx):
    _insert_page(ctx, url="https://claude.ai/some-other-page")
    assert _matched_ids(dq_junk_cleanup._chrome_where) == []


def test_chrome_excludes_non_claude_domain(ctx):
    _insert_page(ctx, url="https://notclaude.ai/new")
    _insert_page(ctx, url="https://example.com/settings")
    assert _matched_ids(dq_junk_cleanup._chrome_where) == []


def test_chrome_excludes_human_override(ctx):
    _insert_page(ctx, url="https://claude.ai/new", human_status="active")
    assert _matched_ids(dq_junk_cleanup._chrome_where) == []


def test_chrome_excludes_non_active_status(ctx):
    _insert_page(ctx, url="https://claude.ai/new", status="archived")
    assert _matched_ids(dq_junk_cleanup._chrome_where) == []


# ── (b) placeholder pattern ─────────────────────────────────────────────────


def test_placeholder_matches_prefix(ctx):
    pid = _insert_page(
        ctx, content_summary="Page browsed outside API tool scope for 12 seconds"
    )
    assert _matched_ids(dq_junk_cleanup._placeholder_where) == [pid]


def test_placeholder_excludes_unrelated_summary(ctx):
    _insert_page(ctx, content_summary="A real summary of real content.")
    assert _matched_ids(dq_junk_cleanup._placeholder_where) == []


def test_placeholder_excludes_human_override(ctx):
    _insert_page(
        ctx,
        content_summary="Page browsed outside API tool scope for 5 seconds",
        human_status="active",
    )
    assert _matched_ids(dq_junk_cleanup._placeholder_where) == []


# ── (c) dedupe folds: only active, non-overridden rows are candidates ──────


def test_dedupe_list_applies_only_active_rows(ctx, monkeypatch):
    active_id = _insert_page(ctx, url="https://a.example.com/keep-dupe")
    overridden_id = _insert_page(
        ctx, url="https://b.example.com/overridden", human_status="archived"
    )
    already_archived_id = _insert_page(
        ctx, url="https://c.example.com/already-gone", status="archived"
    )
    missing_id = 999_999_999  # not present in DB at all

    fold_ids = {
        active_id: {"keep_id": 1, "note": "group-a"},
        overridden_id: {"keep_id": 1, "note": "group-b"},
        already_archived_id: {"keep_id": 1, "note": "group-c"},
        missing_id: {"keep_id": 1, "note": "group-d"},
    }
    monkeypatch.setattr(dq_junk_cleanup, "DEDUPE_FOLD_IDS", fold_ids)

    assert _matched_ids(dq_junk_cleanup._dedupe_where) == [active_id]

    outcomes = {o["id"]: o["outcome"] for o in dq_junk_cleanup._dedupe_outcomes()}
    assert outcomes[active_id] == "candidate"
    assert outcomes[overridden_id] == "skip (human_status=archived)"
    assert outcomes[already_archived_id] == "skip (status=archived)"
    assert outcomes[missing_id] == "skip (not_found)"


def test_dedupe_fold_ids_derived_from_groups_no_overlap():
    """Sanity check on the real hardcoded manifest: 17 ids, no duplicates."""
    all_archive_ids = [
        aid for g in dq_junk_cleanup.DEDUPE_FOLD_GROUPS for aid in g["archive_ids"]
    ]
    assert len(all_archive_ids) == 17
    assert len(set(all_archive_ids)) == 17
    assert set(dq_junk_cleanup.DEDUPE_FOLD_IDS.keys()) == set(all_archive_ids)


# ── --only restricts which ops run ──────────────────────────────────────────


def test_only_flag_restricts_to_single_op(monkeypatch):
    calls = []
    monkeypatch.setattr(
        dq_junk_cleanup, "_run_op", lambda name, apply: calls.append(name) or 0
    )
    dq_junk_cleanup.main(apply=False, only="chrome")
    assert calls == ["chrome"]


def test_no_only_flag_runs_all_ops(monkeypatch):
    calls = []
    monkeypatch.setattr(
        dq_junk_cleanup, "_run_op", lambda name, apply: calls.append(name) or 0
    )
    dq_junk_cleanup.main(apply=False, only=None)
    assert calls == ["chrome", "placeholder", "dedupe"]


# ── --apply write path (blocked by pages_archive_reason_check today) ──────


def test_apply_archives_chrome_candidate(ctx):
    pid = _insert_page(ctx, url="https://claude.ai/new")
    n = dq_junk_cleanup._run_op("chrome", apply=True)
    assert n == 1
    status, archive_reason = _fetch_page(pid)
    assert status == "archived"
    assert archive_reason == "app_chrome_junk"


def test_apply_archives_placeholder_candidate(ctx):
    pid = _insert_page(
        ctx, content_summary="Page browsed outside API tool scope for 9 seconds"
    )
    n = dq_junk_cleanup._run_op("placeholder", apply=True)
    assert n == 1
    status, archive_reason = _fetch_page(pid)
    assert status == "archived"
    assert archive_reason == "placeholder_no_content"


def test_apply_archives_dedupe_candidate_only(ctx, monkeypatch):
    active_id = _insert_page(ctx, url="https://a.example.com/dupe")
    overridden_id = _insert_page(
        ctx, url="https://b.example.com/protected", human_status="active"
    )
    monkeypatch.setattr(
        dq_junk_cleanup,
        "DEDUPE_FOLD_IDS",
        {
            active_id: {"keep_id": 1, "note": "x"},
            overridden_id: {"keep_id": 1, "note": "y"},
        },
    )
    n = dq_junk_cleanup._run_op("dedupe", apply=True)
    assert n == 1
    status, archive_reason = _fetch_page(active_id)
    assert status == "archived"
    assert archive_reason == "dedupe_fold"
    # The human-overridden row is untouched.
    other_status, other_reason = _fetch_page(overridden_id)
    assert other_status == "active"
    assert other_reason is None
