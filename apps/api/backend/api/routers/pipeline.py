"""Pipeline dev-view routes (read-only).

Pipeline v2 routes, all taking ``range`` and ``tz``: ``/summary`` (period
counts and top domains), ``/timeline`` (bucketed kept/archived/skipped series
with skip categories) and ``/pages`` (paginated windowed pages, each carrying
its ``skip_category``).

Auth: verify_api_key only. The 05 disposition rules Pipeline demo-visitable;
every query is scoped to the caller's user_id, so a demo session reads its
own seeded corpus. Registered late in main.py (after verify_api_key exists),
same pattern as routers/dq_bot.py.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from psycopg2 import DataError
from psycopg2.errors import InvalidParameterValue

from backend.api.main import verify_api_key
from backend.db import page_repo, pipeline_repo
from backend.services import pipeline_summary as ps

router = APIRouter(prefix="/api/pipeline", tags=["Pipeline"])

_STATUS_KEYS = ("active", "pending", "archived")


def _tz(tz: str = Query("UTC")) -> str:
    try:
        pipeline_repo.validate_tz(tz)
    except ValueError:
        raise HTTPException(status_code=422, detail="invalid time zone") from None
    return tz


def _guard_tz(fn, *args, **kwargs):
    """Run a repo call; a zone name Postgres doesn't know is a 422, not a 500."""
    try:
        return fn(*args, **kwargs)
    except (InvalidParameterValue, DataError):
        raise HTTPException(status_code=422, detail="invalid time zone") from None


@router.get("/summary")
async def pipeline_summary(
    range: str | None = None,
    tz: str = Depends(_tz),
    user_id: int = Depends(verify_api_key),
) -> dict:
    key = pipeline_repo.normalize_range(range)
    c = _guard_tz(pipeline_repo.get_summary_counts, user_id, key)
    status_counts = {k: int(c["status_counts"].get(k, 0)) for k in _STATUS_KEYS}
    total = int(sum(c["status_counts"].values()))
    return {
        "range": key,
        "status_counts": status_counts,
        "total_pages": total,
        "archive_ratio": (status_counts["archived"] / total) if total else 0.0,
        "decisions": ps.build_decision_rows(c["depth_counts"], c["null_breakdown"]),
        "archive_reasons": ps.build_archive_reason_rows(c["archive_reasons"]),
        "skip_categories": ps.build_skip_category_rows(c["skip_categories"]),
        "skip_gate_config": ps.build_skip_gate_config(),
    }


@router.get("/timeline")
async def pipeline_timeline(
    range: str | None = None,
    tz: str = Depends(_tz),
    user_id: int = Depends(verify_api_key),
) -> dict:
    return _guard_tz(pipeline_repo.get_timeline, user_id, pipeline_repo.normalize_range(range), tz)


_SORT_PATTERN = "^(" + "|".join(page_repo.RECENT_PAGES_SORT_COLUMNS) + ")$"


@router.get("/pages")
async def pipeline_pages(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    sort: str = Query("created_at", pattern=_SORT_PATTERN),
    dir: str = Query("desc", pattern="^(asc|desc)$"),
    range: str | None = None,
    tz: str = Depends(_tz),
    user_id: int = Depends(verify_api_key),
) -> dict:
    rows, total = _guard_tz(
        pipeline_repo.get_windowed_pages,
        user_id,
        pipeline_repo.normalize_range(range),
        limit=limit,
        offset=offset,
        sort=sort,
        direction=dir,
    )
    keep = (
        "id",
        "title",
        "domain",
        "status",
        "processing_depth",
        "archive_reason",
        "skip_reasoning",
        "skip_category",
        "visited_at",
        "created_at",
    )
    return {
        "rows": [{k: r.get(k) for k in keep} for r in rows],
        "total": total,
        "limit": limit,
        "offset": offset,
        "sort": sort,
        "dir": dir,
    }
