"""Score a clustering (page_id -> cluster label, -1 = noise) against the labelled page set.

The labelled set is ``page_annotations.jsonl`` (one JSON object per page: ``page_id``,
``category``, ``subtopic``, ``knowledge_value`` and more) plus ``topic_map.json`` (a
``"<category>||<subtopic>" -> topic_key`` canonicalisation of the free-text subtopics).
Both are private and are passed in by path; they are never part of the repo.

Metrics (all computed on pages that have a label for ``key``; "clustered" = label != -1):

- ``purity``: sum over clusters of the majority ground-truth count / n clustered
- ``inverse_purity``: the same with roles swapped (how much each truth class stays together)
- ``f_purity``: harmonic mean of the two
- ``ARI``, ``NMI``, ``homogeneity``, ``completeness``: sklearn, clustered pages only
- ``ARI_all``, ``NMI_all``: every labelled page counts, with each noise page as its own
  singleton cluster -- so leaving pages out of clusters is not free
- ``keep_coverage``: share of ``knowledge_value == "keep"`` pages that are clustered
- ``share_clusters_purity_lt_0.6``: share of clusters whose majority label is under 60%
- ``noise_share``, ``n_clusters``, size stats, ``n_truth_classes``

The arithmetic is deliberately frozen: a number in one run record must mean the same thing
in every other, otherwise "no metric below baseline" gates are meaningless.
"""

from __future__ import annotations

import collections
import json
from pathlib import Path

from sklearn.metrics import (
    adjusted_rand_score,
    completeness_score,
    homogeneity_score,
    normalized_mutual_info_score,
)

CATEGORY_GROUP = {
    "personal_apps_accounts": "utility",
    "search_navigation": "utility",
    "other_unclear": "utility",
    "finance_banking_admin": "utility",
    "social_media_forums": "utility",
    "film_tv": "entertainment",
    "music_performers": "entertainment",
    "people_biography": "entertainment",
    "literature_books_comics": "literature",
    "philosophy_humanities_arts": "humanities",
    "history_politics_geography": "humanities",
    "news_current_events": "humanities",
    "science_nature": "science",
    "health_medicine_psychology": "science",
    "technology_software_dev": "tech",
    "ai_llm_tools": "tech",
    "ai_chat_transcripts": "tech",
    "work_productivity_tools": "tech",
    "consumer_electronics_gadgets": "tech",
    "education_coursework": "tech",
    "making_3d_printing": "making",
    "crafts_hobbies": "making",
    "games_gaming": "games",
    "food_cooking": "food",
    "shopping_products": "shopping",
    "travel_places_local": "travel",
}
"""26 annotation categories -> 11 coarse groups (the ``category_group`` scoring key)."""

SCORE_KEYS = ("topic_key", "category", "category_group")
"""Label grains scored by :func:`score_all`; ``topic_key`` is the shelf-level headline."""

GATED_METRICS = (
    "purity",
    "inverse_purity",
    "ARI",
    "ARI_all",
    "NMI",
    "NMI_all",
    "keep_coverage",
)
"""Metrics where lower is worse; :func:`compare_scores` gates on these."""

INVERTED_METRICS = ("share_clusters_purity_lt_0.6", "noise_share")
"""Metrics where higher is worse."""


def load_annotations(path: str | Path, topic_map: str | Path | None = None) -> dict[int, dict]:
    """``{page_id: annotation row}`` with ``category_group`` and ``topic_key`` resolved.

    ``topic_key`` is None for rows whose ``(category, subtopic)`` pair is not in the
    topic map (archived pages are not canonicalised); such rows are skipped by
    :func:`score` for ``key="topic_key"``.
    """
    tm: dict[str, str] = {}
    if topic_map is not None:
        tm = json.loads(Path(topic_map).read_text(encoding="utf-8"))
    ann: dict[int, dict] = {}
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            row["category_group"] = CATEGORY_GROUP.get(row["category"], row["category"])
            row["topic_key"] = tm.get(f"{row['category']}||{row.get('subtopic')}")
            ann[int(row["page_id"])] = row
    return ann


def score(
    assign: dict[int, int],
    ann: dict[int, dict],
    key: str = "topic_key",
    exclude_kv_exclude: bool = False,
) -> dict:
    """Score ``assign`` (page_id -> int label, -1 = noise) against ``ann`` on label ``key``."""
    pages = [p for p in assign if p in ann and ann[p].get(key) is not None]
    if exclude_kv_exclude:
        pages = [p for p in pages if ann[p].get("knowledge_value") != "exclude"]
    n_in = len(pages)
    clustered = [p for p in pages if assign[p] != -1]
    if not clustered:
        return {"key": key, "n_pages": n_in, "n_clustered": 0}
    labels = [assign[p] for p in clustered]
    truth = [ann[p][key] for p in clustered]
    by_cluster: dict[int, list] = collections.defaultdict(list)
    for p in clustered:
        by_cluster[assign[p]].append(ann[p][key])
    by_truth: dict = collections.defaultdict(list)
    for p in clustered:
        by_truth[ann[p][key]].append(assign[p])
    maj = sum(collections.Counter(v).most_common(1)[0][1] for v in by_cluster.values())
    inv = sum(collections.Counter(v).most_common(1)[0][1] for v in by_truth.values())
    purity = maj / len(clustered)
    ipur = inv / len(clustered)
    per_cluster = {
        c: collections.Counter(v).most_common(1)[0][1] / len(v) for c, v in by_cluster.items()
    }
    sizes = sorted((len(v) for v in by_cluster.values()), reverse=True)

    # Noise pages become singleton clusters (unique negative ids) for the *_all variants.
    all_truth = [ann[p][key] for p in pages]
    all_labels = [assign[p] if assign[p] != -1 else -1_000_000 - i for i, p in enumerate(pages)]
    n_keep = sum(1 for p in pages if ann[p].get("knowledge_value") == "keep")
    n_keep_clustered = sum(1 for p in clustered if ann[p].get("knowledge_value") == "keep")

    return {
        "key": key,
        "n_pages": n_in,
        "n_clustered": len(clustered),
        "noise_share": round(1 - len(clustered) / n_in, 3),
        "n_clusters": len(by_cluster),
        "size_median": sizes[len(sizes) // 2],
        "size_max": sizes[0],
        "purity": round(purity, 3),
        "inverse_purity": round(ipur, 3),
        "f_purity": round(2 * purity * ipur / (purity + ipur), 3),
        "ARI": round(adjusted_rand_score(truth, labels), 3),
        "NMI": round(normalized_mutual_info_score(truth, labels), 3),
        "homogeneity": round(homogeneity_score(truth, labels), 3),
        "completeness": round(completeness_score(truth, labels), 3),
        "share_clusters_purity_lt_0.6": round(
            sum(1 for v in per_cluster.values() if v < 0.6) / len(per_cluster), 3
        ),
        "n_truth_classes": len(by_truth),
        "ARI_all": round(adjusted_rand_score(all_truth, all_labels), 3),
        "NMI_all": round(normalized_mutual_info_score(all_truth, all_labels), 3),
        "keep_coverage": round(n_keep_clustered / max(1, n_keep), 3),
    }


def score_all(assign: dict[int, int], ann: dict[int, dict]) -> dict[str, dict]:
    """:func:`score` on every grain in :data:`SCORE_KEYS`, keyed by grain."""
    return {key: score(assign, ann, key=key) for key in SCORE_KEYS}


def compare_scores(
    baseline: dict, candidate: dict, tolerance: float = 0.0
) -> tuple[list[dict], bool]:
    """Per-metric deltas for one grain; the flag is False when any gated metric regresses.

    A metric regresses when the candidate is below ``baseline - tolerance`` (or above
    ``baseline + tolerance`` for :data:`INVERTED_METRICS`). Metrics missing on either
    side are reported with ``delta=None`` and never fail the gate.
    """
    rows: list[dict] = []
    ok = True
    for name in GATED_METRICS + INVERTED_METRICS:
        b = baseline.get(name)
        c = candidate.get(name)
        if not isinstance(b, (int, float)) or not isinstance(c, (int, float)):
            rows.append({"metric": name, "baseline": b, "candidate": c, "delta": None, "ok": True})
            continue
        delta = round(c - b, 3)
        if name in INVERTED_METRICS:
            passed = c <= b + tolerance
        else:
            passed = c >= b - tolerance
        ok = ok and passed
        rows.append({"metric": name, "baseline": b, "candidate": c, "delta": delta, "ok": passed})
    return rows, ok
