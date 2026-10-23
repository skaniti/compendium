"""Tests for backend.db.audit_repo (server-audit-and-ops-journal Task 1).

Real rows in the test DB. Fake secrets are assembled at runtime so no
token-shaped literal is committed.
"""

import hashlib
import hmac
import logging
from datetime import UTC, datetime, timedelta

import pytest

from backend.config.settings import settings
from backend.db import audit_repo
from backend.db.connection import get_conn


@pytest.fixture(autouse=True)
def _clean_audit_table():
    def _wipe():
        with get_conn() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM audit_events")

    _wipe()
    yield
    _wipe()


def test_record_and_list_roundtrip():
    audit_repo.record(
        "auth.login.ok",
        actor_user_id=1,
        subject_user_id=1,
        origin_class="tailnet",
        client_key="203.0.113.9",
        detail={"role": "admin", "remembered": True},
    )
    rows = audit_repo.list_events()
    assert len(rows) == 1
    row = rows[0]
    assert row["event"] == "auth.login.ok"
    assert row["actor_user_id"] == 1
    assert row["subject_user_id"] == 1
    assert row["origin_class"] == "tailnet"
    assert row["detail"] == {"role": "admin", "remembered": True}
    assert row["client_hash"] == audit_repo.client_hash("203.0.113.9")
    assert "203.0.113.9" not in str(row)
    assert row["at"] is not None and row["id"] is not None


def test_detail_defaults_to_empty_dict():
    audit_repo.record("auth.logout")
    row = audit_repo.list_events()[0]
    assert row["detail"] == {}
    assert row["origin_class"] == "unknown"
    assert row["client_hash"] is None


def test_paging_newest_first_and_limit_cap():
    for i in range(5):
        audit_repo.record("auth.logout", subject_user_id=i)
    rows = audit_repo.list_events(limit=2)
    assert [r["subject_user_id"] for r in rows] == [4, 3]
    page2 = audit_repo.list_events(limit=2, before_id=rows[-1]["id"])
    assert [r["subject_user_id"] for r in page2] == [2, 1]
    assert len(audit_repo.list_events(limit=10_000)) == 5


def test_filters():
    audit_repo.record("auth.login.ok", subject_user_id=1)
    audit_repo.record("auth.login.failed", subject_user_id=2)
    audit_repo.record("auth.login.failed", subject_user_id=1)
    assert len(audit_repo.list_events(event="auth.login.failed")) == 2
    assert len(audit_repo.list_events(subject_user_id=1)) == 2
    both = audit_repo.list_events(event="auth.login.failed", subject_user_id=1)
    assert len(both) == 1


def test_client_hash_stable_and_none():
    expected = hmac.new(settings.jwt_secret_key.encode(), b"198.51.100.4", "sha256").hexdigest()[
        :16
    ]
    assert audit_repo.client_hash("198.51.100.4") == expected
    assert audit_repo.client_hash("198.51.100.4") == expected
    assert len(expected) == 16
    assert audit_repo.client_hash("198.51.100.5") != expected
    assert audit_repo.client_hash(None) is None


def test_record_swallows_failure_and_logs_warning(monkeypatch, caplog):
    def boom():
        raise RuntimeError("db down")

    monkeypatch.setattr(audit_repo, "get_conn", boom)
    with caplog.at_level(logging.WARNING, logger=audit_repo.logger.name):
        assert audit_repo.record("auth.logout") is None
    assert any(r.levelno == logging.WARNING for r in caplog.records)


def test_record_swallows_invalid_event():
    # violates the CHECK constraint; must not raise
    assert audit_repo.record("not.an.event") is None
    assert audit_repo.list_events() == []


def test_detail_guard_redacts_secret_shapes():
    fake_key = "cmp_" + "a1B2" * 8
    audit_repo.record(
        "api_key.rotated",
        detail={
            "old_prefix": "cmp_abcd",
            "note": f"key {fake_key} leaked",
            "nested": {"deep": ["ok", fake_key]},
        },
    )
    row = audit_repo.list_events()[0]
    assert row["detail"]["note"] == "<redacted>"
    assert row["detail"]["nested"]["deep"] == ["ok", "<redacted>"]
    assert row["detail"]["old_prefix"] == "cmp_abcd"
    assert row["detail"]["redacted"] is True
    assert fake_key not in str(row)


def test_detail_guard_lets_git_sha_through():
    sha = "0123456789abcdef" * 2 + "01234567"  # 40 hex chars
    assert len(sha) == 40
    audit_repo.record("user.role_set", detail={"sha": sha, "role": "admin"})
    row = audit_repo.list_events()[0]
    assert row["detail"] == {"sha": sha, "role": "admin"}
    assert "redacted" not in row["detail"]


def test_secret_shape_patterns_match_compiled():
    assert audit_repo.SECRET_SHAPE_PATTERNS == tuple(p.pattern for p in audit_repo.SECRET_SHAPES)
    assert len(audit_repo.SECRET_SHAPES) == 11


# -- retention: prune_older_than (backlog #90) -------------------------------

# Every event the table allows (migrations 045/050/051/053). The prune must touch
# exactly ANONYMOUS_CLASSES and none of the rest.
_ALL_EVENTS = (
    "api_key.rotated",
    "api_key.auth_failed",
    "auth.login.ok",
    "auth.login.failed",
    "auth.refresh.ok",
    "auth.refresh.reuse_detected",
    "auth.logout",
    "auth.viewas.start",
    "auth.viewas.denied",
    "auth.viewas.stop",
    "user.role_set",
    "user.password_set",
    "auth.trusted_browser.added",
    "auth.demo_entry.ok",
    "auth.demo_entry.failed",
    "auth.passkey.enroll_link_issued",
    "auth.passkey.registered",
    "auth.passkey.register_failed",
    "auth.passkey.revoked",
    "auth.break_glass.issued",
    "auth.trusted_browser.revoked",
    "auth.sessions.ended",
)
_EXPECTED_ANONYMOUS = {
    "api_key.auth_failed",
    "auth.login.failed",
    "auth.demo_entry.failed",
    "auth.demo_entry.ok",
}


def _insert_at(event: str, age_days: float, subject_user_id: int | None = None) -> None:
    """Insert a row backdated ``age_days`` (record() always stamps now())."""
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO audit_events (event, at, subject_user_id, origin_class)
            VALUES (%s, now() - %s * interval '1 day', %s, 'public')
            """,
            (event, age_days, subject_user_id),
        )


def _remaining() -> list[tuple[str, int]]:
    """(event, subject_user_id-or-0) of every surviving row, sorted."""
    return sorted((r["event"], r["subject_user_id"] or 0) for r in audit_repo.list_events(500))


def test_anonymous_classes_are_exactly_the_listed_ones():
    # Adding or dropping a class must be a deliberate edit of this test.
    assert set(audit_repo.ANONYMOUS_CLASSES) == _EXPECTED_ANONYMOUS
    assert set(audit_repo.ANONYMOUS_CLASSES) <= set(_ALL_EVENTS)


def test_prune_deletes_only_old_anonymous_classes():
    for event in _ALL_EVENTS:
        _insert_at(event, age_days=120)
        _insert_at(event, age_days=5)
    deleted = audit_repo.prune_older_than(90)
    assert deleted == len(_EXPECTED_ANONYMOUS)
    remaining = audit_repo.list_events(500)
    assert len(remaining) == 2 * len(_ALL_EVENTS) - len(_EXPECTED_ANONYMOUS)
    # every authenticated class keeps BOTH its old and its recent row
    for event in set(_ALL_EVENTS) - _EXPECTED_ANONYMOUS:
        assert sum(1 for r in remaining if r["event"] == event) == 2, event
    # every anonymous class keeps only its recent row
    for event in _EXPECTED_ANONYMOUS:
        assert sum(1 for r in remaining if r["event"] == event) == 1, event


def test_prune_window_boundary():
    _insert_at("api_key.auth_failed", age_days=91)
    _insert_at("api_key.auth_failed", age_days=89)
    assert audit_repo.prune_older_than(90) == 1
    assert _remaining() == [("api_key.auth_failed", 0)]
    survivor = audit_repo.list_events()[0]["at"]
    assert datetime.now(tz=UTC) - survivor < timedelta(days=90)


def test_prune_honours_the_days_argument():
    _insert_at("auth.login.failed", age_days=40)
    assert audit_repo.prune_older_than(90) == 0
    assert audit_repo.prune_older_than(30) == 1
    assert audit_repo.list_events() == []


def test_prune_covers_known_identifier_login_failures():
    # a failed login that names a real account (subject set) is still an
    # unauthenticated actor and part of the unbounded public growth path
    _insert_at("auth.login.failed", age_days=200, subject_user_id=7)
    _insert_at("auth.login.failed", age_days=200, subject_user_id=None)
    assert audit_repo.prune_older_than(90) == 2
    assert audit_repo.list_events() == []


def test_prune_on_empty_table_returns_zero():
    assert audit_repo.prune_older_than(90) == 0


@pytest.mark.parametrize("days", [0, -1, -90])
def test_prune_rejects_non_positive_days(days):
    _insert_at("api_key.auth_failed", age_days=500)
    with pytest.raises(ValueError):
        audit_repo.prune_older_than(days)
    assert len(audit_repo.list_events()) == 1  # nothing deleted
