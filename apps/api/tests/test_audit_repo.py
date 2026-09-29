"""Tests for backend.db.audit_repo (server-audit-and-ops-journal Task 1).

Real rows in the test DB. Fake secrets are assembled at runtime so no
token-shaped literal is committed.
"""

import hashlib
import hmac
import logging

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
