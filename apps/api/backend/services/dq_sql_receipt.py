"""Validate and execute dqbot's pre-generated SQL receipts.

Each finding emitted by the agent carries a single SELECT statement that
"shows the data behind the claim." The receipt is executed at write time
(in `persist_findings`) so any contradiction surfaces before the user sees
the card -- they can't argue with a SQL result that returned 0 rows.

Safety layers (depth, not just one check):
  1. sqlparse: must be exactly one SELECT statement (no semicolons inside)
  2. allowlist: only tables in READONLY_ALLOWLIST
  3. injected ``LIMIT 100`` if missing
  4. ``dq_bot_readonly`` role: SELECT-only privileges (DB-enforced)
  5. ``statement_timeout 5s``: prevents runaway queries

The sqlparse-based table extractor (#2) is intentionally simple: it covers
the prompt-shaped SELECTs the agent generates today. The role grants (#4)
are the actual fence -- they enforce the allowlist server-side regardless
of what the validator notices in-process.

The allowlist must mirror the ``GRANT SELECT ON ...`` statement in
migration 028. Note: ``superclusters`` is a TEXT column on ``clusters``
in this codebase, not a separate table.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional

import sqlparse
from psycopg2 import errors as pg_errors

from backend.db.connection import get_readonly_db_conn

READONLY_ALLOWLIST = frozenset({
    "pages",
    "clusters",
    "page_clusters",
    "annotations",
    "captures",
    "dq_observations",
    "dq_recommendations",
    "dq_runs",
    "dq_run_events",
    "dq_vocab_issue_types",
})


@dataclass
class SQLReceiptResult:
    """Captured outcome of a SQL-receipt execution.

    ``status``:
      - ``ok``    -- query ran, rows returned
      - ``empty`` -- query ran, zero rows (signals stale or incorrect claim)
      - ``error`` -- validator rejected, role denied, timeout, or runtime error
    """

    status: str
    n_rows: int
    error_text: Optional[str]
    rows: Optional[list[tuple]]
    columns: Optional[list[str]]


class SQLValidationError(Exception):
    """Raised when the validator rejects a SELECT before execution."""


def validate(sql: str) -> str:
    """Return SQL with LIMIT injected if missing. Raise SQLValidationError on rejection."""
    parsed = sqlparse.parse(sql)
    if len(parsed) != 1:
        raise SQLValidationError("expected exactly one statement")

    stmt = parsed[0]
    if stmt.get_type() != "SELECT":
        raise SQLValidationError(f"expected SELECT, got {stmt.get_type()}")

    referenced = _extract_referenced_tables(stmt)
    not_allowed = referenced - READONLY_ALLOWLIST
    if not_allowed:
        raise SQLValidationError(f"tables outside allowlist: {sorted(not_allowed)}")

    text = str(stmt).rstrip(" ;\n")
    if not re.search(r"\bLIMIT\s+\d+\b", text, re.IGNORECASE):
        text = f"{text} LIMIT 100"
    return text


def _extract_referenced_tables(stmt) -> set[str]:
    """Return identifiers appearing in FROM/JOIN positions.

    Token walk with a ``from_seen`` flag. Handles single FROM + plain JOINs.
    Known limitations: CTEs, scalar subqueries, and schema-qualified names
    are not perfectly tracked. The dq_bot_readonly role grants are the
    actual fence; this is courtesy filtering for clearer error messages.
    """
    tables: set[str] = set()
    from_seen = False
    for token in stmt.flatten():
        ttype = str(token.ttype) if token.ttype else ""
        val = token.value.lower().strip()
        if val in {"from", "join"}:
            from_seen = True
            continue
        if not from_seen or "Name" not in ttype:
            continue
        if val in {"on", "where", "group", "order", "limit", "as"}:
            continue
        tables.add(val.split(".")[-1])
        from_seen = False
    return tables


_CANARY_SQL = "SELECT id FROM dq_runs LIMIT 1"
_CANARY_USER_ID = 0


def verify_readonly_grants() -> Optional[str]:
    """Startup canary: execute a trivial allowlisted SELECT through the same
    readonly path (get_readonly_db_conn / SET ROLE dq_bot_readonly) that
    every SQL receipt uses.

    Returns None on success, or the error text on failure. Existence of
    dq_bot_readonly with SELECT grants is a migration-time concern (040
    re-applies 028's grant block), but dump/restore drops role ACLs even
    when the migrations ledger says the grant migration already ran -- this
    is the runtime check that actually proves receipts will work, rather
    than trusting the ledger. RLS scopes the query to user_id=0 (unlikely to
    own any dq_runs rows); a 0-row result is still success -- only the
    role's table-level SELECT privilege is under test, not the row content.
    """
    try:
        with get_readonly_db_conn(_CANARY_USER_ID) as conn, conn.cursor() as cur:
            cur.execute(_CANARY_SQL)
            cur.fetchall()
    except Exception as e:
        return str(e)
    return None


def execute(user_id: int, sql: str) -> SQLReceiptResult:
    """Validate, run, and capture the result.

    Never raises -- every failure path returns ``status='error'`` with
    error_text populated, so the caller can persist the outcome on the
    observation row regardless of what went wrong.
    """
    try:
        validated = validate(sql)
    except SQLValidationError as e:
        return SQLReceiptResult(
            status="error", n_rows=0,
            error_text=f"validation: {e}", rows=None, columns=None,
        )

    try:
        with get_readonly_db_conn(user_id) as conn, conn.cursor() as cur:
            cur.execute(validated)
            rows = cur.fetchall() if cur.description else []
            columns = [d.name for d in cur.description] if cur.description else []
    except pg_errors.QueryCanceled:
        return SQLReceiptResult(
            status="error", n_rows=0,
            error_text="query exceeded 5s statement_timeout",
            rows=None, columns=None,
        )
    except Exception as e:
        return SQLReceiptResult(
            status="error", n_rows=0,
            error_text=str(e), rows=None, columns=None,
        )

    if not rows:
        return SQLReceiptResult(
            status="empty", n_rows=0,
            error_text=None, rows=[], columns=columns,
        )
    return SQLReceiptResult(
        status="ok", n_rows=len(rows),
        error_text=None, rows=list(rows), columns=columns,
    )
