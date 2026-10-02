"""Pipeline dev-view routes (read-only).

Pipeline routes, all taking ``range`` and ``tz``: ``/summary`` (the
outcome -> detail -> fate ``flow`` with top domains, plus rule-filter and
skip-gate config), ``/timeline`` (bucketed total / archived / per-outcome series
with gate categories) and ``/pages`` (paginated windowed pages, each carrying
its outcome, detail, detail_label and fate).

Auth: verify_api_key only. The 05 disposition rules Pipeline demo-visitable;
every query is scoped to the caller's user_id, so a demo session reads its
own seeded corpus. Registered late in main.py (after verify_api_key exists),
same pattern as routers/dq_bot.py.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from backend.api.main import verify_api_key
from backend.api.period_params import guard_tz, tz_param
from backend.db import auth_repo, page_repo, pipeline_repo
from backend.services import pipeline_summary as ps

router = APIRouter(prefix="/api/pipeline", tags=["Pipeline"])


@router.get("/summary")
async def pipeline_summary(
    range: str | None = None,
    tz: str = Depends(tz_param),
    user_id: int = Depends(verify_api_key),
) -> dict:
    key = pipeline_repo.normalize_range(range)
    c = guard_tz(pipeline_repo.get_flow_counts, user_id, key)
    flow = ps.build_flow(c["cells"], c["outcome_domains"], c["detail_domains"])
    status_counts = {f["key"]: f["count"] for f in flow["fates"]}
    total = flow["total"]
    return {
        "range": key,
        "total_pages": total,
        "status_counts": status_counts,
        "archive_ratio": (status_counts["archived"] / total) if total else 0.0,
        "flow": flow,
        "rule_filter_config": ps.build_rule_filter_config(auth_repo.get_role(user_id)),
        "skip_gate_config": ps.build_skip_gate_config(),
    }


@router.get("/timeline")
async def pipeline_timeline(
    range: str | None = None,
    tz: str = Depends(tz_param),
    user_id: int = Depends(verify_api_key),
) -> dict:
    return guard_tz(pipeline_repo.get_timeline, user_id, pipeline_repo.normalize_range(range), tz)


_SORT_PATTERN = "^(" + "|".join(page_repo.RECENT_PAGES_SORT_COLUMNS) + ")$"


@router.get("/pages")
async def pipeline_pages(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    sort: str = Query("created_at", pattern=_SORT_PATTERN),
    dir: str = Query("desc", pattern="^(asc|desc)$"),
    range: str | None = None,
    tz: str = Depends(tz_param),
    user_id: int = Depends(verify_api_key),
) -> dict:
    rows, total = guard_tz(
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
        "outcome",
        "detail",
        "fate",
    )
    return {
        "rows": [
            {
                **{k: r.get(k) for k in keep},
                "detail_label": ps.detail_label(r["outcome"], r["detail"]),
            }
            for r in rows
        ],
        "total": total,
        "limit": limit,
        "offset": offset,
        "sort": sort,
        "dir": dir,
    }
