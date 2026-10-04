"""Prompts dev view: the registry by task, the live version per task, the
models each LLM stage calls, and per-prompt detail.

Everything is built field by field from named constants and settings:
``settings`` also carries API keys, hosts and database URLs, so it is never
serialised wholesale. Override text is for admins only, not viewing as demo
(spec R6, narrowed 2026-10-04); other roles get the registry template and an
``overridden`` flag.
"""

from __future__ import annotations

import re

from backend.prompts import override_store
from backend.prompts.templates import PROMPTS
from backend.services.eval_runs import natural_key

TASK_ORDER = [
    "skip_gate",
    "learning_gate",
    "cluster_naming",
    "supercluster_label",
    "agent_system",
    "page_summary",
    "journey_narrative",
]
TASK_LABELS = {
    "skip_gate": "Skip gate",
    "learning_gate": "Learning gate",
    "cluster_naming": "Cluster naming",
    "supercluster_label": "Supercluster labels",
    "agent_system": "Chat agent",
    "page_summary": "Page summary",
    "journey_narrative": "Journey narrative",
}
MODEL_IDS = (
    "skip_gate",
    "learning_gate",
    "cluster_naming",
    "supercluster_grouping",
    "supercluster_icons",
    "agent",
    "default_inference",
    "clustering_embeddings",
    "search_embeddings",
    "reranker",
)
_LOCAL_ROWS = {"clustering_embeddings", "search_embeddings", "reranker"}
_TASK_RE = re.compile(r"^(.*?)_v\d")


def task_of(name: str) -> str:
    m = _TASK_RE.match(name)
    return m.group(1) if m else name


def version_of(name: str) -> str:
    task = task_of(name)
    return name[len(task) + 1 :] if name != task else ""


def ordered_tasks() -> list[str]:
    present: list[str] = []
    for name in PROMPTS:
        task = task_of(name)
        if task not in present:
            present.append(task)
    return [t for t in TASK_ORDER if t in present] + [t for t in present if t not in TASK_ORDER]


def task_label(task: str) -> str:
    return TASK_LABELS.get(task) or task.replace("_", " ").capitalize()


def _registered(name: str) -> str | None:
    return name if name in PROMPTS else None


def live_prompts() -> dict[str, dict]:
    """The registry key each task's live caller uses (spec R10)."""
    from backend.api import main
    from backend.config.settings import settings
    from backend.services import agent

    return {
        "skip_gate": {
            "name": _registered(main.SKIP_GATE_PROMPT),
            "selector": "backend.api.main.SKIP_GATE_PROMPT",
        },
        "learning_gate": {
            "name": _registered(main.LEARNING_GATE_PROMPT),
            "selector": "backend.api.main.LEARNING_GATE_PROMPT",
        },
        "cluster_naming": {
            "name": _registered(f"cluster_naming_{settings.cluster_naming_prompt_version}"),
            "selector": "settings.cluster_naming_prompt_version",
        },
        "supercluster_label": {
            "name": _registered(f"supercluster_label_{settings.supercluster_label_prompt_version}"),
            "selector": "settings.supercluster_label_prompt_version",
        },
        "agent_system": {
            "name": _registered(agent._system_prompt_name()),
            "selector": "settings.agent_system_prompt_version",
        },
    }


def _safe_model(value) -> str:
    text = str(value or "")
    if not text:
        return "(unset)"
    if "://" in text or any(c.isspace() for c in text) or len(text) > 120:
        return "(custom value)"
    return text


def _model_sources() -> list[tuple[str, str, str, object, str, str | None]]:
    """(id, use, detail, model, source, task whose live prompt it runs), in display order."""
    from backend.api import main
    from backend.config.settings import settings
    from backend.services import (
        agent,
        clustering_service,
        reranker,
        sbert_loader,
        super_cluster_service,
    )

    return [
        (
            "skip_gate",
            "Skip gate",
            "Decides whether a captured page is processed or skipped.",
            main.TOOL_SELECTION_MODEL,
            "backend.api.main.TOOL_SELECTION_MODEL",
            "skip_gate",
        ),
        (
            "learning_gate",
            "Learning gate",
            "Classifies whether a kept page shows active learning.",
            main.LEARNING_GATE_MODEL,
            "backend.api.main.LEARNING_GATE_MODEL",
            "learning_gate",
        ),
        (
            "cluster_naming",
            "Cluster naming",
            "Names each cluster from a sample of its pages.",
            clustering_service.NAMING_MODEL,
            "backend.services.clustering_service.NAMING_MODEL",
            "cluster_naming",
        ),
        (
            "supercluster_grouping",
            "Supercluster grouping",
            "Groups clusters into superclusters and labels the groups.",
            super_cluster_service.ASSIGNMENT_MODEL,
            "backend.services.super_cluster_service.ASSIGNMENT_MODEL",
            "supercluster_label",
        ),
        (
            "supercluster_icons",
            "Supercluster icons",
            "Picks an icon for each supercluster.",
            super_cluster_service.ICON_MODEL,
            "backend.services.super_cluster_service.ICON_MODEL",
            None,
        ),
        (
            "agent",
            "Chat agent",
            "Answers questions in chat by searching your pages.",
            agent.AGENT_MODEL,
            "backend.services.agent.AGENT_MODEL",
            "agent_system",
        ),
        (
            "default_inference",
            "Default",
            "Used by any call that names no model.",
            settings.default_inference_model,
            "settings.default_inference_model",
            None,
        ),
        (
            "clustering_embeddings",
            "Clustering embeddings",
            "Embeds pages for clustering and supercluster discovery.",
            settings.clustering_embedding_model,
            "settings.clustering_embedding_model",
            None,
        ),
        (
            "search_embeddings",
            "Search embeddings",
            "Embeds page text for search.",
            sbert_loader.SBERT_MODEL_NAME,
            "backend.services.sbert_loader.SBERT_MODEL_NAME",
            None,
        ),
        (
            "reranker",
            "Search reranking",
            "Re-ranks retrieved passages before the agent reads them.",
            reranker.MODEL_NAME,
            "backend.services.reranker.MODEL_NAME",
            None,
        ),
    ]


def _provider(row_id: str, model: str) -> str | None:
    from backend.services.llm_service import MODEL_PROVIDERS

    if model in MODEL_PROVIDERS:
        return MODEL_PROVIDERS[model].value
    if model.startswith("text-embedding-"):
        return "openai"
    if row_id in _LOCAL_ROWS:
        return "local"
    return None


def _price(model: str, side: str) -> float | None:
    from backend.services.llm_service import MODEL_PRICING

    entry = MODEL_PRICING.get(model)
    return round(entry[side] * 1000, 4) if entry else None


def build_models() -> list[dict]:
    live = live_prompts()
    rows = []
    for row_id, use, detail, raw, source, task in _model_sources():
        model = _safe_model(raw)
        rows.append(
            {
                "id": row_id,
                "use": use,
                "detail": detail,
                "model": model,
                "source": source,
                "provider": _provider(row_id, model),
                "price_in": _price(model, "input"),
                "price_out": _price(model, "output"),
                "prompt": live.get(task, {}).get("name") if task else None,
            }
        )
    return rows


def build_unused_models() -> list[dict]:
    from backend.config.settings import settings

    return [
        {
            "model": _safe_model(settings.default_summary_model),
            "source": "settings.default_summary_model",
        },
        {
            "model": _safe_model(settings.default_embedding_model),
            "source": "settings.default_embedding_model",
        },
    ]


def _overridden(overrides: dict, name: str) -> bool:
    value = overrides.get(name)
    return isinstance(value, str) and bool(value)


def build_tasks(overrides: dict) -> list[dict]:
    live = live_prompts()
    out = []
    for task in ordered_tasks():
        names = sorted(
            (n for n in PROMPTS if task_of(n) == task), key=lambda n: natural_key(version_of(n))
        )
        sel = live.get(task, {"name": None, "selector": None})
        out.append(
            {
                "task": task,
                "label": task_label(task),
                "live": sel["name"],
                "selector": sel["selector"],
                "prompts": [
                    {
                        "name": n,
                        "version": version_of(n),
                        "description": PROMPTS[n]["description"],
                        "techniques": list(PROMPTS[n]["techniques"]),
                        "live": n == sel["name"],
                        "overridden": _overridden(overrides, n),
                    }
                    for n in names
                ],
            }
        )
    return out


def template_detail(name: str, overrides: dict, admin: bool) -> dict:
    task = task_of(name)
    live_name = live_prompts().get(task, {}).get("name")
    entry = PROMPTS[name]
    out = {
        "name": name,
        "task": task,
        "task_label": task_label(task),
        "version": version_of(name),
        "description": entry["description"],
        "techniques": list(entry["techniques"]),
        "placeholders": override_store.template_fields(entry["template"]),
        "live": name == live_name,
        "task_has_live": live_name is not None,
        "overridden": _overridden(overrides, name),
        "registry_template": entry["template"],
    }
    if admin:
        out["override"] = overrides[name] if _overridden(overrides, name) else None
    return out
