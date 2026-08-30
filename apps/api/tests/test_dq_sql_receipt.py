"""Validation + execution tests for dq_sql_receipt.

The 5 safety layers (validator + role grants + statement_timeout) are
tested in three dimensions:
  - validator behaviour (rejects DROP, DELETE, multi-statement, off-allowlist)
  - LIMIT injection
  - execute() captures errors instead of raising (so persist_findings can
    write the receipt outcome to the observation row regardless)
"""

import uuid

import pytest

from tests.test_repos import _pg_reachable

pytestmark = pytest.mark.skipif(
    not _pg_reachable(), reason="Test PostgreSQL not reachable"
)

from backend.db import user_repo
from backend.services.dq_sql_receipt import (
    READONLY_ALLOWLIST,
    SQLValidationError,
    execute,
    validate,
)


def _fresh_user(label: str) -> int:
    email = f"{label}-{uuid.uuid4().hex[:8]}@test.local"
    return user_repo.create_user(email=email, name="sql_receipt_test")["id"]


# ----------------------------------------------------------- validation


def test_validate_rejects_drop():
    with pytest.raises(SQLValidationError, match="SELECT"):
        validate("DROP TABLE pages")


def test_validate_rejects_delete():
    with pytest.raises(SQLValidationError, match="SELECT"):
        validate("DELETE FROM pages WHERE id = 1")


def test_validate_rejects_update():
    with pytest.raises(SQLValidationError, match="SELECT"):
        validate("UPDATE pages SET title = 'x' WHERE id = 1")


def test_validate_rejects_multiple_statements():
    with pytest.raises(SQLValidationError, match="one statement"):
        validate("SELECT 1; SELECT 2")


def test_validate_rejects_table_outside_allowlist():
    with pytest.raises(SQLValidationError, match="allowlist"):
        validate("SELECT id FROM users LIMIT 10")


def test_validate_injects_limit_when_missing():
    out = validate("SELECT id FROM pages")
    assert "LIMIT 100" in out


def test_validate_preserves_existing_limit():
    out = validate("SELECT id FROM pages LIMIT 5")
    assert "LIMIT 5" in out
    assert "LIMIT 100" not in out


def test_validate_accepts_join_within_allowlist():
    """JOIN across allowlist tables passes validation."""
    out = validate(
        """
        SELECT p.id, pc.cluster_id FROM pages p
        JOIN page_clusters pc ON pc.page_id = p.id
        """
    )
    assert "LIMIT 100" in out


# ----------------------------------------------------------- execution


def test_execute_ok_returns_status_in_expected_set():
    """SELECT against an allowlisted table returns ok or empty (no error)."""
    uid = _fresh_user("ok_status")
    result = execute(user_id=uid, sql="SELECT id FROM pages LIMIT 1")
    assert result.status in ("ok", "empty")
    assert result.error_text is None


def test_execute_captures_drop_attempt_via_validator():
    """Validation rejects DROP before execution; error mentions validation."""
    uid = _fresh_user("drop_attempt")
    result = execute(user_id=uid, sql="DROP TABLE pages")
    assert result.status == "error"
    assert result.error_text is not None
    assert "validation" in result.error_text


def test_execute_captures_postgres_runtime_error():
    """Reference to nonexistent column produces a captured error, not a raise."""
    uid = _fresh_user("runtime_error")
    result = execute(user_id=uid, sql="SELECT no_such_column FROM pages")
    assert result.status == "error"
    assert result.rows is None


def test_execute_off_allowlist_blocked_by_validator():
    """Off-allowlist table is caught by the validator (defense-in-depth)."""
    uid = _fresh_user("off_allowlist")
    result = execute(user_id=uid, sql="SELECT id FROM users LIMIT 1")
    assert result.status == "error"
    assert result.error_text is not None
    assert "allowlist" in result.error_text


def test_allowlist_does_not_include_users_or_superclusters():
    """Sanity-check the spec correction: superclusters is not a table here."""
    assert "users" not in READONLY_ALLOWLIST
    assert "superclusters" not in READONLY_ALLOWLIST
