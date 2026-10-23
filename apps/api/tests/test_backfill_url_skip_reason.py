"""Migration 062 (``url_skip`` archive reason) and the backfill that relabels old rows.

Synthetic data only. The backfill is global (every user), dry-run by default, and must
touch exactly the Stage-0 URL-pattern skips that were stored as ``skip_gate``.
"""

import psycopg2
import pytest

from backend.config.settings import settings


def _pg_reachable() -> bool:
    try:
        psycopg2.connect(settings.test_database_url).close()
        return True
    except psycopg2.Error:
        return False


pytestmark = pytest.mark.skipif(not _pg_reachable(), reason="Test PostgreSQL not reachable")

from backend.scripts import backfill_url_skip_reason as bf
from tests import _label_fixtures as fx

URL_SUMMARY = "URL pattern skipped: a.example.test (4s)"


@pytest.fixture(autouse=True)
def _clean():
    fx.truncate()
    yield


def _page(user, cap, name, *, reason, depth="skipped", status="archived", summary=None):
    pid, _ = fx.make_page(user, cap, name)
    fx.sql(
        "UPDATE pages SET status=%s, archive_reason=%s, processing_depth=%s, "
        "content_summary=%s WHERE id=%s",
        (status, reason, depth, summary, pid),
    )
    return pid


def _reason(pid):
    return fx.sql("SELECT archive_reason FROM pages WHERE id=%s", (pid,))[0][0]


@pytest.fixture
def world():
    u1, u2 = fx.make_user("one"), fx.make_user("two")
    c1, c2 = fx.make_capture(u1), fx.make_capture(u2, "cap_two")
    return {
        "u1": u1["id"],
        "u2": u2["id"],
        # to relabel: legacy URL-pattern skips, two users
        "legacy1": _page(u1, c1, "legacy1", reason="skip_gate", summary=URL_SUMMARY),
        "legacy2": _page(u1, c1, "legacy2", reason="skip_gate", summary=URL_SUMMARY),
        "legacy_u2": _page(u2, c2, "legacyu2", reason="skip_gate", summary=URL_SUMMARY),
        # must stay untouched
        "llm_skip": _page(u1, c1, "llmskip", reason="skip_gate", summary="a forum thread"),
        "mid_text": _page(
            u1, c1, "midtext", reason="skip_gate", summary="Notes on a URL pattern skipped list"
        ),
        "no_summary": _page(u1, c1, "nosummary", reason="skip_gate", summary=None),
        "domain": _page(u1, c1, "domain", reason="domain_skip", summary="Domain skipped: x"),
        "already": _page(u1, c1, "already", reason="url_skip", summary=URL_SUMMARY),
        "not_skipped": _page(
            u1, c1, "notskipped", reason="skip_gate", depth="processed", summary=URL_SUMMARY
        ),
        "restored": _page(
            u1, c1, "restored", reason=None, status="active", summary=URL_SUMMARY
        ),
    }


UNTOUCHED = {
    "llm_skip": "skip_gate",
    "mid_text": "skip_gate",
    "no_summary": "skip_gate",
    "domain": "domain_skip",
    "already": "url_skip",
    "not_skipped": "skip_gate",
    "restored": None,
}


# ── migration 062 ──────────────────────────────────────────────────────────


def test_check_constraint_allows_url_skip_and_still_rejects_unknown_reasons(world):
    fx.sql("UPDATE pages SET archive_reason='url_skip' WHERE id=%s", (world["llm_skip"],))
    assert _reason(world["llm_skip"]) == "url_skip"
    with pytest.raises(psycopg2.errors.CheckViolation):
        fx.sql("UPDATE pages SET archive_reason='url_skipped' WHERE id=%s", (world["llm_skip"],))


# ── backfill ────────────────────────────────────────────────────────────────


def test_dry_run_reports_counts_and_writes_nothing(world, capsys):
    assert bf.main([]) == 0
    out = capsys.readouterr().out
    assert "DRY RUN" in out
    assert "3 page(s)" in out  # legacy1, legacy2, legacy_u2
    assert "nothing written" in out
    for key in ("legacy1", "legacy2", "legacy_u2"):
        assert _reason(world[key]) == "skip_gate"


def test_apply_relabels_only_legacy_url_pattern_skips_across_users(world, capsys):
    assert bf.main(["--apply"]) == 0
    out = capsys.readouterr().out
    assert "relabelled 3" in out
    for key in ("legacy1", "legacy2", "legacy_u2"):
        assert _reason(world[key]) == "url_skip"
    for key, expected in UNTOUCHED.items():
        assert _reason(world[key]) == expected, key


def test_apply_leaves_every_other_column_alone(world):
    before = fx.sql(
        "SELECT status, processing_depth, content_summary, skip_reasoning, skip_category, "
        "human_status FROM pages WHERE id=%s",
        (world["legacy1"],),
    )
    bf.main(["--apply"])
    after = fx.sql(
        "SELECT status, processing_depth, content_summary, skip_reasoning, skip_category, "
        "human_status FROM pages WHERE id=%s",
        (world["legacy1"],),
    )
    assert before == after


def test_apply_is_idempotent(world, capsys):
    bf.main(["--apply"])
    capsys.readouterr()
    assert bf.main(["--apply"]) == 0
    out = capsys.readouterr().out
    assert "0 page(s)" in out
    assert "relabelled 0" in out


def test_user_id_limits_the_run(world):
    assert bf.main(["--apply", "--user-id", str(world["u2"])]) == 0
    assert _reason(world["legacy_u2"]) == "url_skip"
    assert _reason(world["legacy1"]) == "skip_gate"
    assert _reason(world["legacy2"]) == "skip_gate"


def test_reports_remaining_legacy_rows_after_apply(world, capsys):
    bf.main(["--apply"])
    out = capsys.readouterr().out
    assert "legacy URL-pattern skips remaining: 0" in out


def test_reports_url_summary_rows_it_does_not_relabel(world, capsys):
    bf.main(["--apply"])
    out = capsys.readouterr().out
    assert "not touched (URL-pattern summary, other archive_reason): NULL=1" in out


def test_error_exits_nonzero_and_writes_nothing(world, monkeypatch, capsys):
    def boom(cur):
        raise RuntimeError("synthetic failure")

    monkeypatch.setattr(bf, "_check_sees_all_rows", boom)
    assert bf.main(["--apply"]) == 1
    assert "synthetic failure" in capsys.readouterr().err
    assert _reason(world["legacy1"]) == "skip_gate"
