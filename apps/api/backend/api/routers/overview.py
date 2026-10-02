"""Overview dev-view routes (read-only).

``/summary`` (headline counts, spend by purpose, the latest clustering run) and
``/timeline`` (growth, captures and spend per bucket), both taking ``range`` and
``tz`` with Pipeline's semantics (backend.db.period).

Auth: verify_api_key only. Overview is demo-visitable; every query is scoped to
the caller's user_id, never deployment-wide (the Pipeline R12 lesson), so a demo
session reads its own seeded corpus. Registered late in main.py, after
verify_api_key exists, like routers/pipeline.py.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from backend.api.main import verify_api_key
from backend.api.period_params import guard_tz, tz_param
from backend.db import overview_repo, period, trends_repo
from backend.services import overview_summary

router = APIRouter(prefix="/api/overview", tags=["Overview"])


@router.get("/summary")
async def overview_summary_route(
    range: str | None = None,
    tz: str = Depends(tz_param),
    user_id: int = Depends(verify_api_key),
) -> dict:
    key = period.normalize_range(range)
    h = guard_tz(overview_repo.get_headline, user_id, key)
    return {
        "range": key,
        "pages": {
            "captured": h["captured"],
            "in_graph": h["in_graph"],
            "all_time_captured": h["all_time_captured"],
        },
        "captures": h["captures"],
        "spend": overview_summary.build_spend(
            h["spend_rows"], trends_repo.get_total_cost_usd(user_id)
        ),
        "clusters": overview_repo.get_latest_clusters(user_id),
    }


@router.get("/timeline")
async def overview_timeline(
    range: str | None = None,
    tz: str = Depends(tz_param),
    user_id: int = Depends(verify_api_key),
) -> dict:
    return guard_tz(overview_repo.get_timeline, user_id, period.normalize_range(range), tz)
