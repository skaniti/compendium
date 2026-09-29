"""Repository for the audit_events table (migration 045).

`record()` is the only writer: own short connection, synchronous, and it
NEVER raises -- an audit outage must not break login. `list_events()` backs
the admin read endpoint.
"""

import hashlib
import hmac
import logging
import re
from typing import Any

from psycopg2.extras import Json

from backend.config.settings import settings
from backend.db.connection import get_conn

logger = logging.getLogger(__name__)

# Belt-and-braces guard: detail may never hold a secret. Any string value
# matching one of these shapes is replaced with "<redacted>". A 40-hex git
# SHA must NOT match (hex rule starts at 48). Keep in sync with the
# ops_mask.py list (a sibling test asserts equality of the raw strings).
SECRET_SHAPE_PATTERNS: tuple[str, ...] = (
    r"sk-ant-[A-Za-z0-9_-]{20,}",
    r"sk-[A-Za-z0-9_-]{20,}",
    r"cmp_[A-Za-z0-9_-]{20,}",
    r"hf_[A-Za-z0-9]{20,}",
    r"ghp_[A-Za-z0-9]{20,}",
    r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}",
    r"(?i)bearer\s+[A-Za-z0-9._~+/=-]{16,}",
    r"(?i)\b(password|pgpassword|passwd|secret|token)=\S+",
    r"postgres(?:ql)?://[^:\s/]+:[^@\s]+@",
    r"\b[A-Fa-f0-9]{48,}\b",
    r"\b[A-Za-z0-9_-]{48,}\b",
)
SECRET_SHAPES: tuple[re.Pattern[str], ...] = tuple(re.compile(p) for p in SECRET_SHAPE_PATTERNS)

_REDACTED = "<redacted>"
_MAX_LIMIT = 500

_COLUMNS = "id, at, event, actor_user_id, subject_user_id, origin_class, client_hash, detail"


def client_hash(client_key: str | None) -> str | None:
    """HMAC-SHA256(client_key, JWT_SECRET_KEY) hex, first 16 chars."""
    if client_key is None:
        return None
    return hmac.new(
        settings.jwt_secret_key.encode(), client_key.encode(), hashlib.sha256
    ).hexdigest()[:16]


def _scrub(value: Any) -> tuple[Any, bool]:
    """Recursively replace secret-shaped strings. Returns (value, redacted)."""
    if isinstance(value, str):
        if any(p.search(value) for p in SECRET_SHAPES):
            return _REDACTED, True
        return value, False
    if isinstance(value, dict):
        out, hit = {}, False
        for k, v in value.items():
            out[k], h = _scrub(v)
            hit = hit or h
        return out, hit
    if isinstance(value, (list, tuple)):
        items, hit = [], False
        for v in value:
            s, h = _scrub(v)
            items.append(s)
            hit = hit or h
        return items, hit
    return value, False


def record(
    event: str,
    *,
    actor_user_id: int | None = None,
    subject_user_id: int | None = None,
    origin_class: str = "unknown",
    client_key: str | None = None,
    detail: dict | None = None,
) -> None:
    """Write one audit row. Never raises; failures log at WARNING."""
    try:
        clean, redacted = _scrub(detail or {})
        if redacted:
            clean["redacted"] = True
        chash = client_hash(client_key)
        with get_conn() as conn, conn.cursor() as cur:
            cur.execute(
                """
                    INSERT INTO audit_events
                        (event, actor_user_id, subject_user_id,
                         origin_class, client_hash, detail)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    """,
                (
                    event,
                    actor_user_id,
                    subject_user_id,
                    origin_class,
                    chash,
                    Json(clean),
                ),
            )
    except Exception as exc:  # noqa: BLE001 - audit must never break callers
        logger.warning("audit record failed for %r: %s", event, exc)


def list_events(
    limit: int = 100,
    before_id: int | None = None,
    event: str | None = None,
    subject_user_id: int | None = None,
) -> list[dict]:
    """Return audit rows newest first (limit capped at 500)."""
    limit = max(1, min(int(limit), _MAX_LIMIT))
    where, params = [], []
    if before_id is not None:
        where.append("id < %s")
        params.append(before_id)
    if event is not None:
        where.append("event = %s")
        params.append(event)
    if subject_user_id is not None:
        where.append("subject_user_id = %s")
        params.append(subject_user_id)
    clause = f"WHERE {' AND '.join(where)}" if where else ""
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            f"SELECT {_COLUMNS} FROM audit_events {clause} ORDER BY id DESC LIMIT %s",
            (*params, limit),
        )
        rows = cur.fetchall()
    keys = [c.strip() for c in _COLUMNS.split(",")]
    return [dict(zip(keys, r)) for r in rows]
