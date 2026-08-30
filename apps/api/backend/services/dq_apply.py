"""Executor for the approve-applies path (dqBot Tier 1, spec S5).

``apply(rec, user_id)`` inspects ``rec["action_type"]`` / ``rec["action_payload"]``
and performs the corresponding DB-level action synchronously:

  - relabel_cluster -- UPDATE the current-generation cluster's cluster_name,
    plus a durable ``pin_label`` override (so the label survives future
    reclusters even if this specific stable_id goes dormant and comes back).
  - split_cluster   -- remove the named pages from the current-generation
    cluster's membership now, plus a durable ``exclude_from_cluster``
    override.
  - dedupe          -- archive the redundant pages now (archive_reason=
    'dedupe_fold', migration 041); no override needed, archived pages don't
    recluster.
  - merge_clusters  -- override-only (``merge_clusters``); the actual merge
    is cross-cluster surgery deferred to the next recluster (spec S6), not
    worth the risk to do live against edges/superclusters in v1.
  - anything else (flag_for_review, edit_prompt, relabel_supercluster, an
    unrecognized action_type, or a resolvable type with a missing/malformed
    payload) -- record-only: ``{"applied": False, "reason": "record-only: ..."}``.
    This path NEVER raises for a shape problem; the recommendation still
    approves, it just didn't auto-apply.

"Current generation" for a cluster-entity action means
``recluster_run = (SELECT MAX(recluster_run) FROM clusters WHERE user_id = %s)``
-- the stable_id may not have carried into that generation (identity carry
is 44-96% per run by design, see spec's Risks section). That's NOT an error:
zero rows affected means the target is dormant this generation, and the
override captured here is exactly what makes it apply automatically the
next time the stable_id carries.

All DB access goes through get_conn()/dq_overrides_repo with explicit
user_id predicates in every WHERE clause -- app.current_user_id (RLS) is set
by the request path already, but raw UPDATE/DELETE statements here don't
rely on it alone (defense in depth, matches the guard style in
backend/scripts/dq_junk_cleanup.py).

The whole dispatch is wrapped in try/except: unexpected DB/runtime errors
never propagate out of apply() -- they come back as
``{"applied": False, "error": str(e)}`` so a PATCH approve never 500s on an
apply failure (the verdict stands; the detail carries the failure for a
retry).
"""

import logging

from backend.db import dq_overrides_repo
from backend.db.connection import get_conn

logger = logging.getLogger(__name__)

_DORMANT_REASON = "target dormant this generation"


def apply(rec: dict, user_id: int) -> dict:
    """Apply the machine-actionable side of an approved recommendation.

    Returns the applied_detail dict (persisted via
    dq_recommendations_repo.mark_applied by the caller). Never raises.
    """
    action_type = rec.get("action_type")
    try:
        if action_type == "relabel_cluster":
            return _apply_relabel_cluster(rec, user_id)
        if action_type == "split_cluster":
            return _apply_split_cluster(rec, user_id)
        if action_type == "merge_clusters":
            return _apply_merge_clusters(rec, user_id)
        if action_type == "dedupe":
            return _apply_dedupe(rec, user_id)
        return {
            "action": action_type,
            "applied": False,
            "reason": f"record-only: action_type {action_type!r} has no auto-apply path",
        }
    except Exception as e:  # noqa: BLE001 -- deliberate catch-all, see module docstring
        logger.exception(
            "dq_apply.apply failed for rec_id=%s action_type=%s",
            rec.get("id"), action_type,
        )
        return {"action": action_type, "applied": False, "error": str(e)}


def _apply_relabel_cluster(rec: dict, user_id: int) -> dict:
    payload = rec.get("action_payload") or {}
    stable_id = payload.get("stable_id")
    proposed_label = payload.get("proposed_label")
    if not stable_id or not proposed_label:
        return {
            "action": "relabel_cluster",
            "applied": False,
            "reason": "record-only: payload missing stable_id/proposed_label",
        }

    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            UPDATE clusters
            SET cluster_name = %s
            WHERE user_id = %s AND stable_id = %s
              AND recluster_run = (
                  SELECT MAX(recluster_run) FROM clusters WHERE user_id = %s
              )
            """,
            (proposed_label, user_id, stable_id, user_id),
        )
        rows_updated = cur.rowcount

    override = dq_overrides_repo.create_override(
        user_id=user_id,
        override_type="pin_label",
        subject={"stable_id": stable_id},
        payload={"label": proposed_label},
        source_rec_id=rec.get("id"),
    )

    detail = {
        "action": "relabel_cluster",
        "applied": rows_updated > 0,
        "cluster_rows_updated": rows_updated,
        "override_id": override["id"],
    }
    if rows_updated == 0:
        detail["reason"] = _DORMANT_REASON
    return detail


def _apply_split_cluster(rec: dict, user_id: int) -> dict:
    payload = rec.get("action_payload") or {}
    stable_id = payload.get("stable_id")
    remove_page_content_ids = payload.get("remove_page_content_ids")
    if not stable_id or not remove_page_content_ids:
        return {
            "action": "split_cluster",
            "applied": False,
            "reason": "record-only: payload missing stable_id/remove_page_content_ids",
        }

    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            DELETE FROM page_clusters
            WHERE cluster_id IN (
                SELECT id FROM clusters
                WHERE user_id = %s AND stable_id = %s
                  AND recluster_run = (
                      SELECT MAX(recluster_run) FROM clusters WHERE user_id = %s
                  )
            )
            AND page_id IN (
                SELECT id FROM pages
                WHERE page_content_id = ANY(%s) AND user_id = %s
            )
            """,
            (user_id, stable_id, user_id, remove_page_content_ids, user_id),
        )
        rows_removed = cur.rowcount

    override = dq_overrides_repo.create_override(
        user_id=user_id,
        override_type="exclude_from_cluster",
        subject={"stable_id": stable_id},
        payload={"page_content_ids": remove_page_content_ids},
        source_rec_id=rec.get("id"),
    )

    detail = {
        "action": "split_cluster",
        "applied": rows_removed > 0,
        "page_cluster_rows_removed": rows_removed,
        "override_id": override["id"],
    }
    if rows_removed == 0:
        detail["reason"] = _DORMANT_REASON
    return detail


def _apply_merge_clusters(rec: dict, user_id: int) -> dict:
    payload = rec.get("action_payload") or {}
    stable_ids = payload.get("stable_ids")
    if not stable_ids or len(stable_ids) < 2:
        return {
            "action": "merge_clusters",
            "applied": False,
            "reason": "record-only: payload missing stable_ids (need >= 2)",
        }

    # Durability rider (Task 5): capture the union of the subject clusters'
    # current-generation member page_content_ids at approve time. Merging
    # destroys the stable_ids this override is keyed on -- the absorbed
    # cid's identity doesn't carry into the next generation -- so without
    # this, a re-approved merge override goes dormant forever after one
    # application. apply_dq_overrides' merge branch uses this as a content
    # fallback when stable_id matching yields <2 clusters.
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT DISTINCT p.page_content_id
            FROM clusters c
            JOIN page_clusters pc ON pc.cluster_id = c.id
            JOIN pages p ON p.id = pc.page_id
            WHERE c.user_id = %s AND c.stable_id = ANY(%s)
              AND c.recluster_run = (SELECT max(id) FROM recluster_runs
                                     WHERE user_id = %s AND status = 'completed')
              AND p.page_content_id IS NOT NULL
            """,
            (user_id, stable_ids, user_id),
        )
        member_content_ids = [r[0] for r in cur.fetchall()]

    override = dq_overrides_repo.create_override(
        user_id=user_id,
        override_type="merge_clusters",
        subject={"stable_ids": stable_ids, "member_content_ids": member_content_ids},
        source_rec_id=rec.get("id"),
    )

    return {
        "action": "merge_clusters",
        "applied": False,
        "reason": "applies at next recluster",
        "override_id": override["id"],
    }


def _apply_dedupe(rec: dict, user_id: int) -> dict:
    payload = rec.get("action_payload") or {}
    groups = payload.get("groups")
    if not groups:
        return {
            "action": "dedupe",
            "applied": False,
            "reason": "record-only: payload missing groups",
        }

    archived_total = 0
    skipped_total = 0
    per_group = []
    with get_conn() as conn, conn.cursor() as cur:
        for g in groups:
            archive_ids = g.get("archive_page_ids") or []
            if not archive_ids:
                per_group.append(
                    {"keep_page_id": g.get("keep_page_id"), "archived": [], "skipped": []}
                )
                continue
            cur.execute(
                """
                UPDATE pages
                SET status = 'archived', archive_reason = 'dedupe_fold'
                WHERE id = ANY(%s) AND user_id = %s
                  AND status = 'active' AND human_status IS NULL
                RETURNING id
                """,
                (archive_ids, user_id),
            )
            archived_ids = [r[0] for r in cur.fetchall()]
            skipped_ids = [pid for pid in archive_ids if pid not in archived_ids]
            archived_total += len(archived_ids)
            skipped_total += len(skipped_ids)
            per_group.append(
                {
                    "keep_page_id": g.get("keep_page_id"),
                    "archived": archived_ids,
                    "skipped": skipped_ids,
                }
            )

    detail = {
        "action": "dedupe",
        "applied": archived_total > 0,
        "archived_count": archived_total,
        "skipped_count": skipped_total,
        "groups": per_group,
    }
    if archived_total == 0:
        detail["reason"] = "no pages archived -- already resolved or human-overridden"
    return detail
