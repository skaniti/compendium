"""Shaping logic for the Pipeline dev view (``/api/pipeline/summary``).

Labels and ordering for the flow classification (outcome / detail / fate, SQL in
``db/pipeline_repo.py``), plus the rule-filter and skip-gate config panels --
both read LIVE values (main.py skip lists; gate model, temperature, prompt
template with overrides, tool definitions). Pure functions; no DB access."""

from __future__ import annotations

from backend.services.skip_categories import SKIP_CATEGORIES, SKIP_CATEGORY_LABELS

SKIP_GATE_PROMPT_NAME = "skip_gate_v2_3"  # backend/api/main.py process path
SKIP_GATE_TEMPERATURE = 0.0

OUTCOME_ORDER = ("before_gate", "rule_filter", "gate", "processed", "pending")
FATE_ORDER = ("archived", "active", "pending")

OUTCOME_LABELS = {
    "before_gate": "Archived before gate",
    "rule_filter": "Rule filter \u00b7 no LLM",
    "gate": "Skipped by LLM gate",
    "processed": "Processed \u00b7 kept",
    "pending": "Pending",
}
FATE_LABELS = {"archived": "Archived", "active": "Active", "pending": "Pending"}

DETAIL_LABELS = {
    "before_gate": {
        "placeholder": "Placeholder, no content",
        "manual": "Archived manually (early)",
        "chrome": "App chrome junk",
        "duplicate": "Duplicate",
        "other": "Other",
    },
    "rule_filter": {"domain": "Domain rule", "url_pattern": "URL pattern rule"},
    "processed": {
        "active": "Still active",
        "later_manual": "Archived later \u00b7 manual",
        "later_duplicate": "Archived later \u00b7 duplicate",
        "later_chrome": "Archived later \u00b7 chrome",
        "later_other": "Archived later \u00b7 other",
    },
    "pending": {"waiting": "Not yet processed"},
}
# Display order of the fixed detail keys per outcome; gate is dynamic (count desc).
_DETAIL_ORDER = {
    "before_gate": ("placeholder", "manual", "chrome", "duplicate", "other"),
    "rule_filter": ("domain", "url_pattern"),
    "processed": ("later_manual", "later_duplicate", "later_chrome", "later_other", "active"),
    "pending": ("waiting",),
}


def skip_method_label(key: str) -> str:
    """Unknown snake_case values become Title Case."""
    return " ".join(w.capitalize() for w in key.split("_") if w)


def skip_category_label(key: str) -> str:
    return SKIP_CATEGORY_LABELS.get(key) or skip_method_label(key)


def detail_label(outcome: str, detail: str) -> str:
    if outcome == "gate":
        if detail == "uncategorized":
            return "Uncategorized (no reason)"
        return skip_category_label(detail)
    return DETAIL_LABELS.get(outcome, {}).get(detail) or skip_method_label(detail)


def _detail_sort_key(outcome: str, key: str, count: int) -> tuple:
    if outcome == "gate":
        return (key == "uncategorized", -count, key)
    order = _DETAIL_ORDER.get(outcome, ())
    return (order.index(key) if key in order else len(order), 0, key)


def build_flow(cells: list, outcome_domains: list[dict], detail_domains: list[dict]) -> dict:
    """(outcome, detail, fate, n) cells + top-domain groups -> the ``flow`` payload."""
    out_top = {g["key"]: g["top_domains"] for g in outcome_domains}
    det_top = {g["key"]: g["top_domains"] for g in detail_domains}
    out_counts = dict.fromkeys(OUTCOME_ORDER, 0)
    fate_counts = dict.fromkeys(FATE_ORDER, 0)
    details: dict[tuple[str, str], dict] = {}
    for outcome, detail, fate, n in cells:
        n = int(n)
        out_counts[outcome] = out_counts.get(outcome, 0) + n
        fate_counts[fate] = fate_counts.get(fate, 0) + n
        d = details.setdefault(
            (outcome, detail),
            {
                "outcome": outcome,
                "key": detail,
                "label": detail_label(outcome, detail),
                "count": 0,
                "top_domains": det_top.get(f"{outcome}:{detail}", []),
                "fates": dict.fromkeys(FATE_ORDER, 0),
            },
        )
        d["count"] += n
        d["fates"][fate] = d["fates"].get(fate, 0) + n
    ordered = sorted(
        (d for d in details.values() if d["count"] > 0),
        key=lambda d: (
            OUTCOME_ORDER.index(d["outcome"]),
            *_detail_sort_key(d["outcome"], d["key"], d["count"]),
        ),
    )
    return {
        "total": sum(out_counts.values()),
        "outcomes": [
            {
                "key": k,
                "label": OUTCOME_LABELS[k],
                "count": out_counts[k],
                "top_domains": out_top.get(k, []),
            }
            for k in OUTCOME_ORDER
        ],
        "details": ordered,
        "fates": [{"key": k, "label": FATE_LABELS[k], "count": fate_counts[k]} for k in FATE_ORDER],
    }


def build_rule_filter_config() -> dict:
    # Lazy import: main.py imports this module's router.
    from backend.api.main import (
        SKIP_DOMAIN_SUFFIXES,
        SKIP_DOMAINS,
        SKIP_URL_PATH_RULES,
        SKIP_URL_PATTERNS,
    )

    return {
        "domains": sorted(SKIP_DOMAINS),
        "domain_suffixes": list(SKIP_DOMAIN_SUFFIXES),
        "url_patterns": [{"domain": d, "path": p} for d, p in SKIP_URL_PATTERNS],
        "path_rules": list(SKIP_URL_PATH_RULES),
    }


def build_skip_gate_config() -> dict:
    # Lazy imports: main.py imports this module's router; llm_service is heavy.
    from backend.api.main import TOOL_SELECTION_MODEL
    from backend.prompts.templates import get_prompt_template
    from backend.services.llm_service import PAGE_PROCESSING_TOOLS

    return {
        "model": TOOL_SELECTION_MODEL,
        "temperature": SKIP_GATE_TEMPERATURE,
        "prompt_name": SKIP_GATE_PROMPT_NAME,
        "prompt": get_prompt_template(SKIP_GATE_PROMPT_NAME),
        "categories": [
            {"id": cid, "label": label, "description": desc} for cid, label, desc in SKIP_CATEGORIES
        ],
        "tools": [
            {"name": t["function"]["name"], "description": t["function"]["description"]}
            for t in PAGE_PROCESSING_TOOLS
        ],
    }
