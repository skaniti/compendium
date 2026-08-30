"""dqBot API router -- 8 endpoints for triggering investigations, reading
results, and managing recommendations + observations.

Registered late in main.py (after verify_api_key is defined) to avoid the
circular-import problem that arises when a router imports from main.py and
main.py imports the router at the top level.
"""

import logging
import os
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from backend.api.main import (
    verify_admin_context,
    verify_api_key,
    verify_not_plain_demo,
)
from backend.db import (
    dq_observations_repo,
    dq_overrides_repo,
    dq_recommendations_repo,
    dq_run_events_repo,
    dq_runs_repo,
    dq_vocab_repo,
)
from backend.db.connection import get_conn
from backend.services import dq_apply
from backend.services.dq_sql_receipt import execute as run_sql_receipt
from backend.services.sbert_loader import get_sbert_model

logger = logging.getLogger(__name__)

# Router-level demo gate: dqBot surfaces data-quality findings, SQL receipts
# and run transcripts derived from the REAL corpus, so a plain-demo session is
# refused every route here -- reads included, not just mutations. This is the
# per-role gate the docker/server/docker-compose.yml comment anticipated
# ("admin sees, demo does not"); DQ_BOT_DISABLED remains the deployment-wide
# kill switch and is unaffected. Regular (non-demo) user sessions are
# unchanged -- see verify_not_plain_demo, which only rejects role == "demo"
# without an acting_as_demo claim.
router = APIRouter(
    prefix="/api/dq",
    tags=["DQ Bot"],
    dependencies=[Depends(verify_not_plain_demo)],
)

# ---------------------------------------------------------------------------
# Pydantic request models
# ---------------------------------------------------------------------------

_PATCH_REC_VALID_STATUSES = frozenset({"approved", "rejected", "snoozed"})


class PatchRecommendationBody(BaseModel):
    status: str
    user_note: Optional[str] = None


class PatchHandoffStatusBody(BaseModel):
    status: str  # 'sent' | 'dismissed'


# ---------------------------------------------------------------------------
# POST /api/dq/run-now
# ---------------------------------------------------------------------------


@router.post("/run-now")
def start_run_now(user_id: int = Depends(verify_admin_context)):
    """Enqueue a manual DQ run for the worker to pick up. Returns immediately;
    poll GET /api/dq/runs/{id} for status.

    Admin-context only, on top of the router-level demo gate: a run spawns a
    Claude CLI subprocess on the worker, so this is the one dqBot route that
    spends (subscription quota) rather than just reading. It carries no rate
    limit, so the role gate is the only thing bounding it -- keep it that way
    unless a limiter is added. DQ_BOT_DISABLED still short-circuits below."""
    if os.getenv("DQ_BOT_DISABLED", "").lower() in ("1", "true", "yes"):
        raise HTTPException(status_code=503, detail="dqBot is temporarily disabled on this deployment.")
    run = dq_runs_repo.enqueue(user_id=user_id, trigger="manual")
    return {"run_id": run["id"], "status": "queued"}


# ---------------------------------------------------------------------------
# POST /api/dq/runs/{run_id}/abort
# ---------------------------------------------------------------------------


@router.post("/runs/{run_id}/abort")
def abort_run(run_id: int, user_id: int = Depends(verify_api_key)):
    """Request abort of a run. The worker checks the flag mid-stream and kills
    its claude subprocess. Returns 404 if the run isn't found / not owned."""
    run = dq_runs_repo.get_run(run_id=run_id, user_id=user_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found")
    dq_runs_repo.request_abort(run_id)
    return {"run_id": run_id, "status": "abort_requested"}


# ---------------------------------------------------------------------------
# GET /api/dq/runs (Task 7.3 -- runs-history pane)
# ---------------------------------------------------------------------------


_RUNS_LIST_MAX_LIMIT = 100


@router.get("/runs")
def list_runs(
    limit: int = 20,
    user_id: int = Depends(verify_api_key),
):
    """List recent dqBot runs for the History tab in the right pane.

    Returns runs ordered most-recent-first, each enriched with findings_count
    (count of dq_observations rows with the run's id). limit is capped at
    _RUNS_LIST_MAX_LIMIT to bound the response payload.
    """
    capped = max(1, min(limit, _RUNS_LIST_MAX_LIMIT))
    return dq_runs_repo.list_runs_for_user(user_id=user_id, limit=capped)


# ---------------------------------------------------------------------------
# GET /api/dq/runs/{run_id}
# ---------------------------------------------------------------------------


@router.get("/runs/{run_id}")
def get_run(
    run_id: int,
    user_id: int = Depends(verify_api_key),
):
    """Get status + telemetry for a specific run."""
    run = dq_runs_repo.get_run(run_id=run_id, user_id=user_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found")
    return run


# ---------------------------------------------------------------------------
# GET /api/dq/runs/{run_id}/events
# ---------------------------------------------------------------------------


@router.get("/runs/{run_id}/events")
def get_run_events(
    run_id: int,
    since: int = -1,
    limit: int = 500,
    user_id: int = Depends(verify_api_key),
):
    """List streaming events for a run, paginated by seq.

    Client passes since=<last_seq_seen> to fetch only new events.
    Returns events with seq > since, ordered ascending.
    next_since is the latest seq seen (client should pass this on the next poll).
    """
    events = dq_run_events_repo.list_events_since(
        user_id=user_id, run_id=run_id, after_seq=since, limit=limit
    )
    max_seq = dq_run_events_repo.max_seq_for_run(run_id)
    return {
        "events": events,
        "latest_seq": max_seq,
        "next_since": max_seq if events else since,
    }


# ---------------------------------------------------------------------------
# GET /api/dq/runs/{run_id}/detail
# ---------------------------------------------------------------------------


_RUN_DETAIL_OBS_MAX_LIMIT = 100
_RUN_DETAIL_PHASES_MAX_LIMIT = 50


@router.get("/runs/{run_id}/detail")
def get_run_detail(
    run_id: int,
    user_id: int = Depends(verify_api_key),
):
    """Rich run-detail view for the History tab.

    Combines the run's telemetry row, its observations (each enriched with
    its newest recommendation via a LATERAL join), and a summary of the
    run's streamed events (count/first/last + chronological '_phase' rows +
    the terminal 'result' event's cost/turn/duration stats). Reuses the same
    ownership check as GET /runs/{run_id} -- 404 when not found / not owned,
    so no observations or events for another user's run ever leak here.
    """
    run = dq_runs_repo.get_run(run_id=run_id, user_id=user_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found")

    observations = dq_observations_repo.list_for_run_with_recommendation(
        run_id=run_id, limit=_RUN_DETAIL_OBS_MAX_LIMIT
    )
    events_summary = dq_run_events_repo.summarize_for_run(
        run_id=run_id, phase_limit=_RUN_DETAIL_PHASES_MAX_LIMIT
    )

    return {
        "run": run,
        "observations": observations,
        "events_summary": events_summary,
    }


# ---------------------------------------------------------------------------
# GET /api/dq/recommendations
# ---------------------------------------------------------------------------


@router.get("/recommendations")
def list_recommendations(
    limit: int = 5,
    include_ranks_above: bool = False,
    include_superseded: bool = False,
    user_id: int = Depends(verify_api_key),
):
    """List recommendations.

    limit: max rows to return (default 5 = inbox view).
    include_ranks_above: when True, return the full ranked list (up to 1000
    rows) rather than just the top-N inbox.
    include_superseded: when True, also include status='superseded' rows so the
    all-findings expander can render replacement chains. Default False preserves
    the inbox behavior of pending-only.
    """
    effective_limit = 1000 if include_ranks_above else limit
    recs = dq_recommendations_repo.list_pending(
        user_id=user_id,
        limit=effective_limit,
        include_superseded=include_superseded,
    )
    return {"recommendations": recs, "total": len(recs)}


# ---------------------------------------------------------------------------
# PATCH /api/dq/recommendations/{rec_id}
# ---------------------------------------------------------------------------


@router.patch("/recommendations/{rec_id}")
def patch_recommendation(
    rec_id: int,
    body: PatchRecommendationBody,
    user_id: int = Depends(verify_api_key),
):
    """Update status of a recommendation.

    Allowed statuses: 'approved', 'rejected', 'snoozed'.
    Returns 400 if status is invalid; 404 if not found / not owned by user.

    On a successful approve, additionally runs the apply layer (spec S5):
    dq_apply.apply() dispatches on action_type/action_payload to perform the
    machine-actionable side of the recommendation (or degrade to record-only
    for non-actionable types / unresolvable payloads), and the outcome is
    persisted via mark_applied + returned as `applied_detail`. Apply never
    fails the PATCH -- the approve verdict stands even when the apply itself
    errors; the error surfaces in applied_detail for a retry instead.
    """
    if body.status not in _PATCH_REC_VALID_STATUSES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid status '{body.status}'. Must be one of: approved, rejected, snoozed.",
        )
    try:
        updated = dq_recommendations_repo.update_status(
            rec_id=rec_id,
            new_status=body.status,
            user_note=body.user_note,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    # update_status returns a row dict; if it returned None the row didn't exist.
    # The repo raises on invalid status but silently returns if the id doesn't exist
    # (psycopg2 RETURNING on UPDATE with no match returns None).
    if updated is None:
        raise HTTPException(status_code=404, detail="Recommendation not found")

    if body.status == "approved":
        try:
            applied_detail = dq_apply.apply(updated, user_id)
        except Exception as exc:  # noqa: BLE001 -- apply() failures must not fail the PATCH
            logger.exception("dq_apply.apply raised unexpectedly for rec_id=%s", rec_id)
            applied_detail = {
                "action": updated.get("action_type"),
                "applied": False,
                "error": str(exc),
            }
        applied_row = dq_recommendations_repo.mark_applied(rec_id, applied_detail)
        updated = applied_row if applied_row is not None else {**updated, "applied_detail": applied_detail}

    return updated


# ---------------------------------------------------------------------------
# POST /api/dq/recommendations/{rec_id}/promote
# ---------------------------------------------------------------------------


@router.post("/recommendations/{rec_id}/promote")
def promote_recommendation(
    rec_id: int,
    user_id: int = Depends(verify_api_key),
):
    """Manually promote a recommendation from ranks 6+ into the active inbox.

    Sets promoted_at = NOW() so list_pending orders the rec first
    (promoted_at DESC NULLS LAST, rank_in_run ASC). The rec will appear
    in the top-5 inbox on the next fetch.
    Returns 404 if the rec doesn't exist or isn't owned by this user.

    GUI-unwired since the Option B expander redesign (2026-07-17) -- no
    frontend component calls this endpoint anymore. Retained (endpoint +
    repo function, tested) for a possible Tier-1 inbox redesign.
    """
    updated = dq_recommendations_repo.promote(rec_id=rec_id, user_id=user_id)
    if updated is None:
        raise HTTPException(status_code=404, detail="Recommendation not found or not owned by user")
    return updated


# ---------------------------------------------------------------------------
# GET /api/dq/observations
# ---------------------------------------------------------------------------


@router.get("/observations")
def list_observations(
    tag: Optional[str] = None,
    has_handoff: Optional[bool] = None,
    user_id: int = Depends(verify_api_key),
):
    """List observations.

    tag: optional filter -- 'core' or 'adjacent'.
    has_handoff: optional bool filter on whether handoff_prompt_draft IS NOT NULL.
    """
    obs = dq_observations_repo.list_for_user(
        user_id=user_id,
        tag=tag,
        has_handoff=has_handoff,
    )
    return {"observations": obs, "total": len(obs)}


# ---------------------------------------------------------------------------
# PATCH /api/dq/observations/{obs_id}/handoff-status
# ---------------------------------------------------------------------------


@router.patch("/observations/{obs_id}/handoff-status")
def patch_observation_handoff_status(
    obs_id: int,
    body: PatchHandoffStatusBody,
    user_id: int = Depends(verify_api_key),
):
    """Update handoff_status of an observation.

    Allowed values: 'sent', 'dismissed'.
    Returns 400 if status is invalid; 404 if row not found.
    """
    try:
        updated = dq_observations_repo.update_handoff_status(obs_id=obs_id, new_status=body.status)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if updated is None:
        raise HTTPException(status_code=404, detail="Observation not found")
    return updated


# ---------------------------------------------------------------------------
# GET /api/dq/calibration
# ---------------------------------------------------------------------------


@router.get("/calibration")
def get_calibration(user_id: int = Depends(verify_api_key)):
    """Approval-rate summary over the last 20 reviewed recs, grouped by action_type.

    Also includes the overall summary from calibration_summary as `overall` for
    the header-line "N approved, M rejected" display.
    """
    by_action = dq_recommendations_repo.calibration_by_action_type(user_id=user_id, limit=20)
    overall = dq_recommendations_repo.calibration_summary(user_id=user_id)
    return {"by_action_type": by_action, "overall": overall}


# ---------------------------------------------------------------------------
# Vocab endpoints (Phase 5 / migration 028)
# ---------------------------------------------------------------------------


class VocabCanonicalizeBody(BaseModel):
    description: str  # validated to >= 10 chars at the endpoint


class VocabAliasBody(BaseModel):
    target: str  # must already be canonical for this user


@router.get("/vocab/list")
def vocab_list(user_id: int = Depends(verify_api_key)):
    """Vocab grouped by status with example observations for proposed entries.

    Drives the Vocab tab. Pending = status='proposed', canonical =
    status='canonical', rejected = status='rejected' (with or without
    aliased_to).
    """
    return _build_vocab_view(user_id)


@router.post("/vocab/{issue_type}/canonicalize")
def vocab_canonicalize(
    issue_type: str,
    body: VocabCanonicalizeBody,
    user_id: int = Depends(verify_api_key),
):
    """Promote an entry to canonical with a description + embedding.

    The embedding is what the cosine gate compares against on future runs,
    so the description must be substantive (>=10 chars).
    """
    if len(body.description.strip()) < 10:
        raise HTTPException(
            status_code=400,
            detail="description must be at least 10 characters",
        )
    if dq_vocab_repo.lookup(user_id, issue_type) is None:
        raise HTTPException(status_code=404, detail=f"vocab entry not found: {issue_type!r}")
    embedding = get_sbert_model().encode(body.description).tolist()
    dq_vocab_repo.canonicalize(
        user_id=user_id,
        issue_type=issue_type,
        description=body.description,
        embedding=embedding,
        canonicalized_by=user_id,
    )
    return {"ok": True}


@router.post("/vocab/{issue_type}/alias")
def vocab_alias(
    issue_type: str,
    body: VocabAliasBody,
    user_id: int = Depends(verify_api_key),
):
    """Reject the source entry and rewrite future findings to the alias target."""
    target_entry = dq_vocab_repo.lookup(user_id, body.target)
    if target_entry is None or target_entry.status != "canonical":
        raise HTTPException(
            status_code=400,
            detail=f"alias target {body.target!r} is not a canonical vocab entry",
        )
    if dq_vocab_repo.lookup(user_id, issue_type) is None:
        raise HTTPException(status_code=404, detail=f"vocab entry not found: {issue_type!r}")
    dq_vocab_repo.alias_to(user_id=user_id, issue_type=issue_type, target=body.target)
    return {"ok": True}


@router.post("/vocab/{issue_type}/reject")
def vocab_reject(issue_type: str, user_id: int = Depends(verify_api_key)):
    """Reject without alias. Re-proposing flips the entry back to 'proposed'."""
    if dq_vocab_repo.lookup(user_id, issue_type) is None:
        raise HTTPException(status_code=404, detail=f"vocab entry not found: {issue_type!r}")
    dq_vocab_repo.reject(user_id=user_id, issue_type=issue_type)
    return {"ok": True}


def _build_vocab_view(user_id: int) -> dict:
    """Group vocab entries by status with up to 3 example observations each.

    Examples are drawn from dq_observations.observation; they help the user
    see what dqbot has actually been labelling with the proposed entry
    before deciding whether to canonicalize, alias, or reject.
    """
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SET app.current_user_id = %s", (user_id,))
        cur.execute(
            """
            SELECT v.issue_type, v.status, v.aliased_to, v.description,
                   v.proposal_rationale, v.n_proposals, v.last_proposed_at,
                   COALESCE(
                     (SELECT json_agg(json_build_object(
                          'id', x.id,
                          'observation', x.observation,
                          'severity', x.severity
                      ))
                      FROM (
                        SELECT id, observation, severity FROM dq_observations
                        WHERE user_id = v.user_id AND issue_type = v.issue_type
                        ORDER BY observed_at DESC LIMIT 3
                      ) x),
                     '[]'::json
                   ) AS examples
            FROM dq_vocab_issue_types v
            WHERE v.user_id = %s
            ORDER BY v.issue_type
            """,
            (user_id,),
        )
        rows = cur.fetchall()

    pending: list[dict] = []
    canonical: list[dict] = []
    rejected: list[dict] = []
    for r in rows:
        entry = {
            "issue_type": r[0],
            "description": r[3],
            "rationale": r[4],
            "n_proposals": r[5],
            "last_proposed_at": r[6].isoformat() if r[6] else None,
            "aliased_to": r[2],
            "examples": r[7] or [],
        }
        status = r[1]
        if status == "proposed":
            pending.append(entry)
        elif status == "canonical":
            canonical.append(entry)
        else:
            rejected.append(entry)
    return {"pending": pending, "canonical": canonical, "rejected": rejected}


# ---------------------------------------------------------------------------
# Overrides endpoints (dqBot Tier 1, spec S7 -- Worker O / Phase 3)
# ---------------------------------------------------------------------------


@router.get("/overrides")
def list_overrides(user_id: int = Depends(verify_api_key)):
    """List all overrides (active + retired) for the Overrides tab (spec S7).

    Each override from dq_overrides_repo.list_all is enriched with:
      - resolved: for pin_label / exclude_from_cluster / merge_clusters
        subjects, the CURRENT generation's cluster_name(s) for the subject
        stable_id(s), looked up via one batched query. A stable_id that
        didn't carry into the latest generation resolves to
        {"dormant": True} (pin_label/exclude_from_cluster) or is listed
        under resolved["dormant"] (merge_clusters) -- never an error.
        never_cocluster subjects key on page_content_ids, not stable_id,
        so "resolved" is omitted (null) for them; the frontend renders the
        content-id pair directly from `subject`.
      - source_headline: the originating recommendation's headline, via a
        null-safe lookup (source_rec_id is nullable / ON DELETE SET NULL
        per migration 042, so a retired rec's override still resolves).
    """
    overrides = dq_overrides_repo.list_all(user_id)
    if not overrides:
        return {"overrides": []}

    stable_ids: set[str] = set()
    source_rec_ids: set[int] = set()
    for ov in overrides:
        subject = ov.get("subject") or {}
        if ov.get("override_type") == "merge_clusters":
            stable_ids.update(subject.get("stable_ids") or [])
        elif subject.get("stable_id"):
            stable_ids.add(subject["stable_id"])
        if ov.get("source_rec_id") is not None:
            source_rec_ids.add(ov["source_rec_id"])

    name_by_stable_id: dict[str, str] = {}
    headline_by_rec_id: dict[int, str] = {}
    with get_conn() as conn, conn.cursor() as cur:
        if stable_ids:
            cur.execute(
                """
                SELECT stable_id, cluster_name
                FROM clusters
                WHERE user_id = %s AND stable_id = ANY(%s)
                  AND recluster_run = (
                      SELECT MAX(recluster_run) FROM clusters WHERE user_id = %s
                  )
                """,
                (user_id, list(stable_ids), user_id),
            )
            name_by_stable_id = {r[0]: r[1] for r in cur.fetchall()}
        if source_rec_ids:
            cur.execute(
                "SELECT id, headline FROM dq_recommendations WHERE id = ANY(%s)",
                (list(source_rec_ids),),
            )
            headline_by_rec_id = {r[0]: r[1] for r in cur.fetchall()}

    enriched: list[dict] = []
    for ov in overrides:
        ov = dict(ov)
        subject = ov.get("subject") or {}
        ov_type = ov.get("override_type")

        if ov_type == "merge_clusters":
            ids = subject.get("stable_ids") or []
            names = {sid: name_by_stable_id[sid] for sid in ids if sid in name_by_stable_id}
            dormant = [sid for sid in ids if sid not in name_by_stable_id]
            ov["resolved"] = {"names": names, "dormant": dormant}
        elif ov_type in ("pin_label", "exclude_from_cluster"):
            sid = subject.get("stable_id")
            name = name_by_stable_id.get(sid) if sid else None
            if name is not None:
                ov["resolved"] = {"stable_id": sid, "cluster_name": name}
            else:
                ov["resolved"] = {"stable_id": sid, "dormant": True}
        else:
            ov["resolved"] = None

        src_id = ov.get("source_rec_id")
        ov["source_headline"] = headline_by_rec_id.get(src_id) if src_id is not None else None
        enriched.append(ov)

    return {"overrides": enriched}


@router.post("/overrides/{override_id}/retire")
def retire_override(override_id: int, user_id: int = Depends(verify_api_key)):
    """Retire a standing override (status='active' -> 'retired').

    Returns 404 when the override doesn't exist / isn't owned by this user.
    Retirement is a one-way UI action (spec S7) -- there's no un-retire
    endpoint; a user who wants the constraint back approves a fresh
    recommendation or files one manually via a later tier.
    """
    updated = dq_overrides_repo.retire(override_id, user_id)
    if updated is None:
        raise HTTPException(status_code=404, detail="Override not found")
    return updated


# ---------------------------------------------------------------------------
# Trends endpoints (Phase 5)
# ---------------------------------------------------------------------------


@router.get("/trends/per-investigator")
def trends_per_investigator(weeks: int = 4, user_id: int = Depends(verify_api_key)):
    """Per-issue_type aggregations over the last N weeks.

    Each row carries approve/reject/recur percentages plus a diagnosis label
    that maps to: COMPENDIUM RESTRUCTURE / DETECTION TUNING / Noise / Healthy.
    """
    return _aggregate_trends(user_id, group_by="investigator", weeks=weeks)


@router.get("/trends/per-cluster")
def trends_per_cluster(weeks: int = 4, user_id: int = Depends(verify_api_key)):
    """Per-cluster aggregations (entity_type='cluster' only)."""
    return _aggregate_trends(user_id, group_by="cluster", weeks=weeks)


def _aggregate_trends(user_id: int, *, group_by: str, weeks: int) -> list[dict]:
    """Group window observations + their recommendations by issue_type or cluster.

    Approve/reject/recur are counted at the *observation* level (an obs
    counts in a category if at least one of its recommendations has that
    status). Recurrence proxies via dq_recommendations.status='superseded':
    a new rec was created that replaced an old rec for the same observation,
    signaling re-detection.
    """
    if group_by == "investigator":
        select_expr = "o.issue_type"
        where_extra = ""
    elif group_by == "cluster":
        # entity_id for cluster entities is now the stable_id (dqBot Tier 1,
        # spec S1) -- resolve display names via a stable_id match first.
        # c.id::text = o.entity_id is kept as an OR fallback for pre-Tier-1
        # rows whose entity_id is still the per-run integer cluster id.
        select_expr = (
            "(COALESCE("
            "(SELECT cluster_name FROM clusters c "
            " WHERE (c.stable_id = o.entity_id OR c.id::text = o.entity_id)"
            "   AND c.user_id = o.user_id"
            " ORDER BY c.recluster_run DESC LIMIT 1), "
            "'cluster ' || o.entity_id"
            ")) "
        )
        where_extra = "AND o.entity_type = 'cluster'"
    else:
        raise ValueError(f"unknown group_by: {group_by!r}")

    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SET app.current_user_id = %s", (user_id,))
        cur.execute(
            f"""
            WITH window_obs AS (
                SELECT * FROM dq_observations o
                WHERE o.user_id = %s
                  AND o.observed_at >= NOW() - (%s || ' weeks')::INTERVAL
                  {where_extra}
            )
            SELECT {select_expr} AS group_key,
                   COUNT(DISTINCT o.id) AS total,
                   COUNT(DISTINCT o.id) FILTER (WHERE r.status = 'approved')   AS approved_obs,
                   COUNT(DISTINCT o.id) FILTER (WHERE r.status = 'rejected')   AS rejected_obs,
                   COUNT(DISTINCT o.id) FILTER (WHERE r.status = 'superseded') AS recurred_obs,
                   array_agg(DISTINCT o.id) AS observation_ids
            FROM window_obs o
            LEFT JOIN dq_recommendations r ON r.observation_id = o.id
            GROUP BY group_key
            ORDER BY total DESC
            """,
            (user_id, weeks),
        )
        rows = cur.fetchall()

    out: list[dict] = []
    for group_key, total, approved, rejected, recurred, ids in rows:
        app_pct = round(100 * approved / total, 1) if total else 0.0
        rej_pct = round(100 * rejected / total, 1) if total else 0.0
        rec_pct = round(100 * recurred / total, 1) if total else 0.0
        out.append({
            "group_key": group_key,
            "count": total,
            "approve_pct": app_pct,
            "reject_pct": rej_pct,
            "recur_pct": rec_pct,
            "diagnosis": _diagnose(app_pct, rej_pct, rec_pct),
            "observation_ids": ids,
        })
    return out


def _diagnose(approve_pct: float, reject_pct: float, recur_pct: float) -> str:
    """Map the approve/reject/recur tuple to a single-label diagnosis.

    Thresholds are starter heuristics; tune after observing real distributions.
    """
    if approve_pct >= 70 and recur_pct >= 50:
        return "COMPENDIUM RESTRUCTURE"
    if reject_pct >= 50 and recur_pct >= 30:
        return "DETECTION TUNING"
    if reject_pct >= 50:
        return "Noise (low cost)"
    return "Healthy"


# ---------------------------------------------------------------------------
# Receipt fetch endpoint (Phase 6)
# ---------------------------------------------------------------------------


@router.get("/observations/{obs_id}/receipt")
def get_observation_receipt(obs_id: int, user_id: int = Depends(verify_api_key)):
    """Return one observation with all receipt fields + linked recommendations.

    Drives the Receipt tab. ``observation`` carries Layer 1-3 data (evidence,
    reasoning, ambiguities) plus the SQL block fields; ``recommendations``
    carries sibling rec entries for Layer 4 (Alternatives), including
    superseded ones so the supersession chain is visible.
    """
    obs = dq_observations_repo.get_observation(user_id=user_id, obs_id=obs_id)
    if obs is None:
        raise HTTPException(status_code=404, detail="observation not found")
    recs = dq_recommendations_repo.list_for_observation(user_id=user_id, observation_id=obs_id)
    return {"observation": obs, "recommendations": recs}


# ---------------------------------------------------------------------------
# SQL receipt rerun endpoint (Phase 5)
# ---------------------------------------------------------------------------


@router.post("/observations/{obs_id}/sql/run")
def rerun_sql_receipt(obs_id: int, user_id: int = Depends(verify_api_key)):
    """Re-execute the stored SELECT for an observation and update the captured columns.

    Returns the rerun status + up to 50 rows for inline display. The full
    result isn't streamed; the rendered Receipt pane shows status + row count
    inline and the user can open the SQL block to see the query.
    """
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SET app.current_user_id = %s", (user_id,))
        cur.execute(
            "SELECT sql_query FROM dq_observations WHERE id = %s AND user_id = %s",
            (obs_id, user_id),
        )
        row = cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="observation not found")
    sql = row[0]
    if sql is None:
        raise HTTPException(status_code=400, detail="no SQL receipt for this observation")

    result = run_sql_receipt(user_id, sql)

    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SET app.current_user_id = %s", (user_id,))
        cur.execute(
            """
            UPDATE dq_observations
            SET sql_query_executed_at = NOW(),
                sql_query_status = %s,
                sql_query_n_rows = %s,
                sql_query_error_text = %s
            WHERE id = %s AND user_id = %s
            """,
            (result.status, result.n_rows, result.error_text, obs_id, user_id),
        )

    return {
        "status": result.status,
        "n_rows": result.n_rows,
        "error_text": result.error_text,
        "rows": result.rows[:50] if result.rows else [],
        "columns": result.columns or [],
    }
