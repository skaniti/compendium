"""Shaping logic for the Pipeline dev view (``/api/pipeline/summary``).

Ports the presentation rules that lived in the Dash callback
``frontend/dash/callbacks/pipeline_monitor.py`` (explorer, read-only
reference): decision-row expansion of NULL processing depths, the
skip-mechanism label map, the ``(none)`` bucket drop, and the skip-gate
config panel -- which here reads the LIVE gate (model, temperature, prompt
template with overrides, tool definitions) instead of a hard-coded snapshot.
Pure functions; no DB access."""

from __future__ import annotations

from backend.services.skip_categories import SKIP_CATEGORIES, SKIP_CATEGORY_LABELS

SKIP_GATE_PROMPT_NAME = "skip_gate_v2_3"  # backend/api/main.py process path
SKIP_GATE_TEMPERATURE = 0.0

SKIP_METHOD_LABELS = {
    "skip_gate": "LLM Skip Gate",
    "domain_skip": "Domain Filter",
    "manual_exclusion": "Manual Exclusion",
    "trivial_capture": "Trivial Capture",
    "placeholder_no_content": "Placeholder No Content",
    "dedup": "Dedup",
    "app_chrome_junk": "App Chrome Junk",
    "dedupe_fold": "Dedupe Fold",
    "other": "Other",
}


def skip_method_label(key: str) -> str:
    """Known keys use SKIP_METHOD_LABELS; unknown snake_case values become Title Case."""
    return SKIP_METHOD_LABELS.get(key) or " ".join(w.capitalize() for w in key.split("_") if w)


_DEPTH_LABELS = {"processed": "Processed", "skipped": "Skipped"}
_NULL_KEYS = {"Pending": "pending", "Trivial Capture": "trivial_capture", "Other": "other"}


def build_decision_rows(depth_counts: dict[str, int], null_breakdown: dict[str, int]) -> list[dict]:
    breakdown = dict(null_breakdown)
    legacy_active = breakdown.pop("legacy_active", 0)
    rows: list[dict] = []
    for raw, count in depth_counts.items():
        if raw == "null":
            for label, n in breakdown.items():
                rows.append(
                    {
                        "key": _NULL_KEYS.get(label, label.lower()),
                        "label": label,
                        "count": n,
                        "evaluated": False,
                    }
                )
        elif raw == "processed":
            rows.append(
                {
                    "key": "processed",
                    "label": "Processed",
                    "count": count + legacy_active,
                    "evaluated": True,
                }
            )
        else:
            rows.append(
                {
                    "key": raw,
                    "label": _DEPTH_LABELS.get(raw, raw.title()),
                    "count": count,
                    "evaluated": True,
                }
            )
    if "processed" not in depth_counts and legacy_active > 0:
        rows.append(
            {"key": "processed", "label": "Processed", "count": legacy_active, "evaluated": True}
        )
    rows.sort(key=lambda r: r["count"], reverse=True)
    return rows


def build_skip_method_rows(skip_methods: dict[str, int]) -> list[dict]:
    rows = [{"key": k, "label": skip_method_label(k), "count": c} for k, c in skip_methods.items()]
    rows.sort(key=lambda r: r["count"], reverse=True)
    return rows


def build_archive_reason_rows(groups: list[dict]) -> list[dict]:
    """Archive-reason groups (key/count/top_domains) -> rows with method labels."""
    return [{**g, "label": skip_method_label(g["key"])} for g in groups]


def skip_category_label(key: str) -> str:
    if key == "uncategorized":
        return "Uncategorized"
    return SKIP_CATEGORY_LABELS.get(key) or skip_method_label(key)


def build_skip_category_rows(groups: list[dict]) -> list[dict]:
    return [{**g, "label": skip_category_label(g["key"])} for g in groups]


def build_skip_gate_reasons(rows: list[tuple[str, int]]) -> list[dict]:
    return [{"reason": r, "count": c} for r, c in rows if r != "(none)"]


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
