"""Pipeline dev-view routes (read-only).

Replaces the in-process repo reads of the Dash Pipeline Monitor
(explorer frontend/dash/callbacks/pipeline_monitor.py) and the two
pipeline charts of the Dash Trends tab (trends.py: _chart_skip_rate,
_chart_skip_reasons_trend). Archive-health metrics are NOT here: the Next
view reuses GET /api/analytics/archive-health unchanged.

Auth: verify_api_key only. The 05 disposition rules Pipeline demo-visitable;
every query is scoped to the caller's user_id, so a demo session reads its
own seeded corpus. Registered late in main.py (after verify_api_key exists),
same pattern as routers/dq_bot.py.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from backend.api.main import verify_api_key
from backend.db import page_repo, trends_repo
from backend.services import pipeline_summary as ps

router = APIRouter(prefix="/api/pipeline", tags=["Pipeline"])

_STATUS_KEYS = ("active", "pending", "archived")


@router.get("/summary")
async def pipeline_summary(user_id: int = Depends(verify_api_key)) -> dict:
    status_counts = page_repo.get_page_status_counts(user_id)
    depth_counts = page_repo.get_processing_depth_counts(user_id)
    null_breakdown = page_repo.get_null_depth_breakdown(user_id) if depth_counts else {}
    skip_methods = page_repo.get_skip_method_counts(user_id)
    skip_reasons = page_repo.get_skip_reasoning_counts(user_id)
    return {
        "status_counts": {k: int(status_counts.get(k, 0)) for k in _STATUS_KEYS},
        "total_pages": int(sum(status_counts.values())),
        "decisions": ps.build_decision_rows(depth_counts, null_breakdown),
        "skip_methods": ps.build_skip_method_rows(skip_methods),
        "skip_gate_reasons": ps.build_skip_gate_reasons(skip_reasons),
        "skip_gate_config": ps.build_skip_gate_config(),
    }


_SORT_PATTERN = "^(" + "|".join(page_repo.RECENT_PAGES_SORT_COLUMNS) + ")$"


@router.get("/pages")
async def pipeline_pages(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    sort: str = Query("created_at", pattern=_SORT_PATTERN),
    dir: str = Query("desc", pattern="^(asc|desc)$"),
    user_id: int = Depends(verify_api_key),
) -> dict:
    rows, total = page_repo.get_recent_pages(
        user_id, limit=limit, offset=offset, sort=sort, direction=dir
    )
    keep = (
        "id",
        "title",
        "domain",
        "status",
        "processing_depth",
        "archive_reason",
        "skip_reasoning",
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


@router.get("/skip-trends")
async def pipeline_skip_trends(
    range: str | None = None,
    user_id: int = Depends(verify_api_key),
) -> dict:
    key = range or "all"
    since = trends_repo.since_from_range(key)
    return {
        "range": key,
        "skip_rate": trends_repo.get_daily_skip_rate(user_id, since),
        "skip_reasons": trends_repo.get_daily_skip_reasons(user_id, since),
    }
