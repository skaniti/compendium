"""Preview what the v2 suggestion rules would offer for one user (read-only).

Loads the suggested groups of the user's latest completed recluster run, makes
ONE call to the v2 group labeller (a few hundred tokens, well under a cent),
applies the shared offer rule (``backend.services.suggestion_offers``) and
prints a table: current label | clusters | pages | v2 label | offered, with the
reason when a group is not offered. No database writes: the stored groups are
never touched, and the v2 labels exist only in this output.

Usage:
    python -m backend.scripts.sc_suggestion_preview --user-id 1
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


def _fit(text: str, width: int) -> str:
    return text if len(text) <= width else text[: width - 1] + "…"


async def _run_proposed(user_id: int, model: str | None, shape: str | None) -> int:
    from backend.config.settings import settings
    from backend.db import auth_repo, cluster_repo, recluster_repo
    from backend.db.connection import set_current_user_id
    from backend.services import topic_proposals as tp
    from backend.services.suggestion_offers import skip_reason

    set_current_user_id(user_id)
    run = recluster_repo.get_latest_run(user_id)
    if run is None:
        print("[preview] done: no completed recluster run")
        return 0
    prefs = auth_repo.get_preferences(user_id)
    existing = [t["keyword"] for t in prefs.get("topic_interests", []) if t.get("keyword")]
    dismissed = [d["label"] for d in prefs.get("dismissed_topics", []) if d.get("label")]
    clusters = cluster_repo.get_clusters_for_user(user_id, run["id"])
    candidates = tp.collect_candidates(clusters, existing)
    model = model or settings.supercluster_proposal_model
    print(f"[preview] user {user_id}, run #{run['id']}: {len(clusters)} clusters, "
          f"{len(candidates)} not in a declared supercluster ({len(existing)} existing names, "
          f"{len(dismissed)} dismissed); model {model}, shape {shape or settings.supercluster_proposal_shape}")
    topics, cost = await tp.propose_topics(candidates, existing, dismissed, model=model, shape=shape)
    rows = tp.build_rows(topics, candidates, existing, tp.visit_evidence_for_clusters(user_id, clusters))
    names = {c["id"]: c["name"] for c in candidates}
    dismissed_lower = {d.lower() for d in dismissed}
    header = ("label", "clusters", "pages", "member clusters", "offered?")
    widths = (22, 8, 5, 70, 28)
    print()
    print("  ".join(h.ljust(w) for h, w in zip(header, widths)))
    print("  ".join("-" * w for w in widths))
    n_offered = used = 0
    for row in rows:
        reason = skip_reason(
            row,
            min_clusters=settings.supercluster_suggestion_min_clusters,
            min_pages=settings.supercluster_suggestion_min_pages,
            suggestion_source="proposed",
            dismissed_labels=dismissed_lower,
        )
        n_offered += reason is None
        members = row["evidence"]["cluster_db_ids"]
        used += len(members)
        print("  ".join(_fit(str(c), w).ljust(w) for c, w in zip(
            (row["label"], row["member_count"], row["page_count"],
             "; ".join(names[m] for m in members), "yes" if reason is None else f"no: {reason}"),
            widths)))
    print()
    print(f"[preview] done: {len(rows)} topic(s), {n_offered} offered, {used} of "
          f"{len(candidates)} candidate clusters used; cost ${cost:.5f}")
    return 0


async def _run(user_id: int) -> int:
    from backend.config.settings import settings
    from backend.db import auth_repo, cluster_repo
    from backend.db.connection import set_current_user_id
    from backend.services import super_cluster_service as scs
    from backend.services.suggestion_offers import covering_keyword, skip_reason

    set_current_user_id(user_id)
    groups = [
        g for g in cluster_repo.get_groups_for_user(user_id) if g["source"] == "suggested"
    ]
    print(f"[preview] user {user_id}: {len(groups)} suggested group(s) in the latest completed run")
    if not groups:
        print("[preview] done: nothing to preview")
        return 0

    prefs = auth_repo.get_preferences(user_id)
    keywords = [t["keyword"] for t in prefs.get("topic_interests", []) if t.get("keyword")]
    dismissed = {d["label"].lower() for d in prefs.get("dismissed_topics", []) if d.get("label")}

    cluster_names: dict[int, str] = {}
    members: dict[int, list[int]] = {}
    for g in groups:
        members[g["id"]] = list(g["cluster_ids"])
        cluster_names.update(zip(g["cluster_ids"], g["cluster_names"]))
    page_counts = cluster_repo.get_cluster_page_counts(
        user_id, [c for ids in members.values() for c in ids]
    )

    # The labeller reads the prompt version from settings; force v2 for the
    # preview without touching any file.
    settings.supercluster_label_prompt_version = "v2"
    print(f"[preview] calling the v2 labeller once ({len(keywords)} existing supercluster name(s) as style)")
    labels, cost = await scs._suggest_group_labels(
        [{"group_index": g["id"], "label": None} for g in groups],
        members,
        cluster_names,
        sibling_labels=keywords,
        existing_topics=keywords,
        cluster_page_counts=page_counts,
    )

    rows = []
    n_offered = 0
    for g in sorted(groups, key=lambda g: -g["page_count"]):
        if g["id"] not in labels:
            v2, evidence = "(no answer)", dict(g.get("evidence") or {})
        elif labels[g["id"]] is None:
            v2, evidence = "none", {**(g.get("evidence") or {}), "no_single_field": True}
        else:
            v2 = labels[g["id"]]
            evidence = dict(g.get("evidence") or {})
            covered = covering_keyword(v2, keywords)
            if covered is not None:
                evidence["covered_by"] = covered
        reason = skip_reason(
            {**g, "evidence": evidence, "label": v2 if v2 not in ("none", "(no answer)") else g["label"]},
            min_clusters=settings.supercluster_suggestion_min_clusters,
            min_pages=settings.supercluster_suggestion_min_pages,
            label_first=False,
            dismissed_labels=dismissed,
        )
        n_offered += reason is None
        rows.append((g["label"], g["member_count"], g["page_count"], v2,
                     "yes" if reason is None else f"no: {reason}"))

    header = ("current label", "clusters", "pages", "v2 label", "offered?")
    widths = (34, 8, 5, 28, 40)
    print()
    print("  ".join(h.ljust(w) for h, w in zip(header, widths)))
    print("  ".join("-" * w for w in widths))
    for row in rows:
        print("  ".join(_fit(str(c), w).ljust(w) for c, w in zip(row, widths)))
    print()
    print(f"[preview] done: {n_offered} of {len(rows)} would be offered "
          f"(floors: {settings.supercluster_suggestion_min_clusters} clusters, "
          f"{settings.supercluster_suggestion_min_pages} pages); "
          f"model call cost ${cost:.5f} (token counts are not exposed by the service)")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description="Read-only preview of the SUPERCLUSTERS widget's suggestions "
        "(proposed topics, or the v2 labelling of suggested groups) for one user."
    )
    ap.add_argument("--user-id", type=int, required=True)
    ap.add_argument("--source", choices=("proposed", "groups"), default=None)
    ap.add_argument("--shape", choices=("topics", "fields"), default=None,
                    help="proposal prompt shape override (proposed source)")
    ap.add_argument("--model", default=None, help="proposal model override (proposed source)")
    args = ap.parse_args(argv)
    from backend.config.settings import settings

    source = args.source or settings.supercluster_suggestion_source
    if source == "proposed":
        return asyncio.run(_run_proposed(args.user_id, args.model, args.shape))
    return asyncio.run(_run(args.user_id))


if __name__ == "__main__":
    sys.exit(main())
