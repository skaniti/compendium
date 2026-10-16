"""Repository for the page_labels table (label-first grouping, migration 058).

One row per (``page_content_id``, ``labeller_version``). Labels are
content-level: the same page_content row is shared by every page that visited
the URL, so labelling happens once per content row, not once per visit.
"""

import json
import logging

from backend.db.connection import get_conn

logger = logging.getLogger(__name__)

_LABEL_COLUMNS = (
    "page_content_id",
    "user_id",
    "labeller_version",
    "category",
    "subtopic",
    "entity",
    "specificity",
    "content_kind",
    "knowledge_value",
    "evidence_level",
    "language",
    "flags",
    "private_sensitive",
    "confidence",
    "source",
)

_ACTIVE_SQL = "COALESCE(p.human_status, p.status) = 'active'"


def upsert_labels(rows: list[dict]) -> int:
    """Insert or update label rows (conflict key: content id + version).

    Each row carries the label columns; ``flags`` is a list (stored as JSONB),
    ``source`` defaults to ``'model'``. Returns the number of rows written.
    """
    if not rows:
        return 0
    n = 0
    with get_conn() as conn, conn.cursor() as cur:
        for row in rows:
            values = [
                json.dumps(list(row.get("flags") or []))
                if col == "flags"
                else (row.get("source") or "model" if col == "source" else row.get(col))
                for col in _LABEL_COLUMNS
            ]
            cur.execute(
                f"""
                INSERT INTO page_labels ({", ".join(_LABEL_COLUMNS)})
                VALUES ({", ".join(["%s"] * len(_LABEL_COLUMNS))})
                ON CONFLICT (page_content_id, labeller_version) DO UPDATE SET
                    user_id = EXCLUDED.user_id,
                    category = EXCLUDED.category,
                    subtopic = EXCLUDED.subtopic,
                    entity = EXCLUDED.entity,
                    specificity = EXCLUDED.specificity,
                    content_kind = EXCLUDED.content_kind,
                    knowledge_value = EXCLUDED.knowledge_value,
                    evidence_level = EXCLUDED.evidence_level,
                    language = EXCLUDED.language,
                    flags = EXCLUDED.flags,
                    private_sensitive = EXCLUDED.private_sensitive,
                    confidence = EXCLUDED.confidence,
                    source = EXCLUDED.source,
                    created_at = NOW()
                """,
                values,
            )
            n += 1
    return n


def get_labels(content_ids: list[int], labeller_version: str | None = None) -> dict[int, dict]:
    """Labels keyed by ``page_content_id``.

    With ``labeller_version`` None the latest row (``created_at``) per content
    id is returned, whatever its version; otherwise only that version's rows.
    Dicts include ``labeller_version`` and ``source``.
    """
    if not content_ids:
        return {}
    cols = ", ".join(("id",) + _LABEL_COLUMNS + ("created_at",))
    with get_conn() as conn, conn.cursor() as cur:
        if labeller_version is None:
            cur.execute(
                f"""
                SELECT DISTINCT ON (page_content_id) {cols}
                FROM page_labels
                WHERE page_content_id = ANY(%s)
                ORDER BY page_content_id, created_at DESC, id DESC
                """,
                (list(content_ids),),
            )
        else:
            cur.execute(
                f"""
                SELECT {cols} FROM page_labels
                WHERE page_content_id = ANY(%s) AND labeller_version = %s
                """,
                (list(content_ids), labeller_version),
            )
        names = [d[0] for d in cur.description]
        return {r[names.index("page_content_id")]: dict(zip(names, r)) for r in cur.fetchall()}


def get_unlabelled_content_ids(
    labeller_version: str,
    user_id: int | None = None,
    limit: int | None = None,
    only_active: bool = True,
) -> list[int]:
    """Content ids referenced by the user's pages with no label at ``labeller_version``.

    ``only_active`` restricts to pages whose effective status (human override
    first) is active; False includes archived/pending pages too. ``user_id``
    None means every user. Ordered by id so a limited run is resumable.
    """
    where = ["p.page_content_id IS NOT NULL"]
    params: list = []
    if only_active:
        where.append(_ACTIVE_SQL)
    if user_id is not None:
        where.append("p.user_id = %s")
        params.append(user_id)
    sql = f"""
        SELECT DISTINCT p.page_content_id
        FROM pages p
        WHERE {" AND ".join(where)}
          AND NOT EXISTS (
              SELECT 1 FROM page_labels l
              WHERE l.page_content_id = p.page_content_id AND l.labeller_version = %s
          )
        ORDER BY p.page_content_id
    """
    params.append(labeller_version)
    if limit is not None:
        sql += " LIMIT %s"
        params.append(limit)
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(sql, params)
        return [r[0] for r in cur.fetchall()]


def count_labels(user_id: int | None, labeller_version: str) -> int:
    """Number of labels at ``labeller_version`` (for ``user_id``; None = all)."""
    with get_conn() as conn, conn.cursor() as cur:
        if user_id is None:
            cur.execute(
                "SELECT COUNT(*) FROM page_labels WHERE labeller_version = %s",
                (labeller_version,),
            )
        else:
            cur.execute(
                "SELECT COUNT(*) FROM page_labels WHERE user_id = %s AND labeller_version = %s",
                (user_id, labeller_version),
            )
        return cur.fetchone()[0]


def get_label_inputs(content_ids: list[int]) -> list[dict]:
    """One representative page per content row, shaped for the labeller.

    The representative is the most recent ``pages`` row (by ``visited_at``) that
    points at the content. ``id`` is that page's id; ``page_content_id`` is the
    content id; ``content_summary`` prefers the page's own capture-time summary
    then the content row's;
    ``extracted_text`` prefers the content row's. ``visited_at`` is an ISO
    string. Content ids with no page are omitted.
    """
    if not content_ids:
        return []
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT DISTINCT ON (p.page_content_id)
                   p.id, p.page_content_id, p.user_id, p.title, p.url,
                   COALESCE(p.domain, pc.domain) AS domain,
                   p.visited_at, p.dwell_time_seconds,
                   COALESCE(NULLIF(p.content_summary, ''), pc.content_summary) AS content_summary,
                   COALESCE(NULLIF(pc.extracted_text, ''), p.extracted_text) AS extracted_text
            FROM pages p
            JOIN page_content pc ON pc.id = p.page_content_id
            WHERE p.page_content_id = ANY(%s)
            ORDER BY p.page_content_id, p.visited_at DESC NULLS LAST, p.id DESC
            """,
            (list(content_ids),),
        )
        names = [d[0] for d in cur.description]
        out = []
        for r in cur.fetchall():
            d = dict(zip(names, r))
            if d["visited_at"] is not None:
                d["visited_at"] = d["visited_at"].isoformat()
            out.append(d)
        return out
