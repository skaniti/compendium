"""Clusters dev-view routes (read-only).

``/summary`` is one consistent snapshot of the caller's current clustering run
(the latest completed one, as on the graph): run, page counts, clusters,
groups, similarity edges, run history and the clustering/naming parameters.
``/{cluster_id}/pages`` and ``/unclustered`` are the two unbounded lists,
loaded on demand.

Auth: verify_api_key only. Clusters is demo-visitable; every query is scoped to
the caller's user_id, never deployment-wide (the Pipeline R12 lesson).
``/{cluster_id}/pages`` takes a client-supplied id, so the repo checks
ownership in SQL and this route 404s for any cluster that is not the caller's
(cluster_repo.get_cluster_page_details has no user filter: never use it here).
Registered late in main.py, after verify_api_key exists, like the other dev
views.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Path, Query

from backend.api.main import verify_api_key
from backend.db import cluster_view_repo, recluster_repo
from backend.services import cluster_view

router = APIRouter(prefix="/api/clusters", tags=["Clusters"])

_INT4_MAX = 2_147_483_647


@router.get("/summary")
async def clusters_summary(user_id: int = Depends(verify_api_key)) -> dict:
    run = recluster_repo.get_latest_run(user_id)
    runs = cluster_view_repo.get_run_history(user_id)
    if run is None:
        return {
            "run": None,
            "pages": None,
            "clusters": [],
            "groups": cluster_view_repo.get_group_counts(user_id, None),
            "edges": cluster_view.edge_summary([]),
            "runs": runs,
            "config": cluster_view.build_config(None),
        }
    pages = cluster_view_repo.get_page_counts(user_id, run["id"], run["started_at"])
    considered = (run["noise_count"] or 0) + pages["clustered"]
    return {
        "run": cluster_view.run_row(run, with_status=False),
        "pages": pages,
        "clusters": cluster_view_repo.get_clusters(user_id, run["id"]),
        "groups": cluster_view_repo.get_group_counts(user_id, run["id"]),
        "edges": cluster_view.edge_summary(cluster_view_repo.get_edge_weights(user_id, run["id"])),
        "runs": runs,
        "config": cluster_view.build_config(considered),
    }


@router.get("/unclustered")
async def clusters_unclustered(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    user_id: int = Depends(verify_api_key),
) -> dict:
    run = recluster_repo.get_latest_run(user_id)
    if run is None:
        return {"total": 0, "limit": limit, "offset": offset, "pages": []}
    res = cluster_view_repo.get_unclustered(user_id, run["id"], run["started_at"], limit, offset)
    return {"total": res["total"], "limit": limit, "offset": offset, "pages": res["pages"]}


@router.get("/{cluster_id}/pages")
async def cluster_pages(
    cluster_id: int = Path(ge=1, le=_INT4_MAX),
    user_id: int = Depends(verify_api_key),
) -> dict:
    members = cluster_view_repo.get_cluster_members(user_id, cluster_id)
    if members is None:
        raise HTTPException(status_code=404, detail="cluster not found")
    return members
