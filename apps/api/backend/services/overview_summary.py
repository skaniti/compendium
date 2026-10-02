"""Pure shaping for the Overview dev view: spend by purpose, graph superclusters."""

from __future__ import annotations

# Purpose groups, in display order. TWIN: SPEND_ORDER / SPEND_LABELS in
# apps/web/lib/overview.ts; keep keys and labels in step.
PURPOSES: list[tuple[str, str]] = [
    ("gates", "Skip & learning gates"),
    ("clustering", "Clustering & naming"),
    ("chat", "Chat"),
    ("other", "Other"),
]
PURPOSE_KEYS = tuple(k for k, _ in PURPOSES)

EVENT_PURPOSE = {
    "skip_gate": "gates",
    "skip_gate_deterministic": "gates",
    "learning_gate": "gates",
    "regate": "gates",
    "cluster_naming": "clustering",
    "group_naming": "clustering",
    "clustering_embedding": "clustering",
    "topic_verify": "clustering",
    "keyword_expansion": "clustering",
    "embedding_gist": "clustering",
    "agent_query": "chat",
}

EVENT_LABELS = {
    "skip_gate": "Skip gate",
    "skip_gate_deterministic": "Skip gate · rules",
    "learning_gate": "Learning gate",
    "regate": "Re-gate",
    "cluster_naming": "Cluster naming",
    "group_naming": "Group naming",
    "clustering_embedding": "Clustering embeddings",
    "topic_verify": "Topic checks",
    "keyword_expansion": "Keyword expansion",
    "embedding_gist": "Embedding gists",
    "agent_query": "Chat answers",
    "skip_category_backfill": "Skip-category backfill",
}


def purpose_of(event_type: str) -> str:
    return EVENT_PURPOSE.get(event_type, "other")


def event_label(event_type: str) -> str:
    return EVENT_LABELS.get(event_type) or " ".join(
        w.capitalize() for w in event_type.split("_") if w
    )


def _usd(v: float) -> float:
    return round(float(v), 6)


def build_spend(rows: list[tuple[str, float, int]], all_time_usd: float) -> dict:
    """``rows`` = (event_type, usd, calls) for the period. Purposes with calls only, in PURPOSES order."""
    groups: dict[str, list[dict]] = {}
    for event_type, usd, calls in rows:
        groups.setdefault(purpose_of(event_type), []).append(
            {
                "key": event_type,
                "label": event_label(event_type),
                "usd": float(usd),
                "calls": int(calls),
            }
        )
    purposes = []
    for key, label in PURPOSES:
        types = [t for t in groups.get(key, []) if t["calls"] > 0]
        if not types:
            continue
        types.sort(key=lambda t: (-t["usd"], -t["calls"], t["key"]))
        purposes.append(
            {
                "key": key,
                "label": label,
                "usd": _usd(sum(t["usd"] for t in types)),
                "calls": sum(t["calls"] for t in types),
                "event_types": [{**t, "usd": _usd(t["usd"])} for t in types],
            }
        )
    return {
        "usd": _usd(sum(float(u) for _, u, _ in rows)),
        "calls": sum(int(c) for _, _, c in rows),
        "all_time_usd": _usd(all_time_usd),
        "purposes": purposes,
    }


def count_graph_superclusters(sc_map: dict[str, str | None], topic_keywords: list[str]) -> int:
    """Superclusters the graph draws. TWIN of backend/utils/graph_export.py:
    a cluster's ``super_cluster`` is shown only when it names a topic_interests keyword."""
    topics = set(topic_keywords)
    return len({sc for sc in sc_map.values() if sc and sc in topics})
