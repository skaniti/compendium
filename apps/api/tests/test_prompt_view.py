"""Prompts view shaping: tasks, live versions, models from the real constants."""

import json

from backend.config.settings import settings
from backend.prompts import templates
from backend.services import prompt_view as pv


def test_task_split_and_versions():
    assert pv.task_of("skip_gate_v2_3") == "skip_gate"
    assert pv.task_of("journey_narrative_v2a") == "journey_narrative"
    assert pv.task_of("supercluster_label_v1b") == "supercluster_label"
    assert pv.version_of("skip_gate_v2_3") == "v2_3"
    assert pv.version_of("agent_system_v4") == "v4"


def test_every_registry_task_is_ordered_and_every_prompt_listed_once():
    tasks = pv.build_tasks({})
    assert [t["task"] for t in tasks] == pv.ordered_tasks()
    assert set(pv.ordered_tasks()) <= set(pv.TASK_ORDER), (
        "a new registry task needs a TASK_ORDER entry"
    )
    names = [p["name"] for t in tasks for p in t["prompts"]]
    assert sorted(names) == sorted(templates.PROMPTS) and len(names) == len(set(names))
    skip = next(t for t in tasks if t["task"] == "skip_gate")
    assert [p["version"] for p in skip["prompts"]] == ["v1", "v2", "v2_1", "v2_2", "v2_3"]
    assert skip["label"] == "Skip gate"


def test_live_versions_follow_the_real_selectors(monkeypatch):
    from backend.api import main
    from backend.services import agent

    live = pv.live_prompts()
    assert live["skip_gate"] == {
        "name": main.SKIP_GATE_PROMPT,
        "selector": "backend.api.main.SKIP_GATE_PROMPT",
    }
    assert live["learning_gate"]["name"] == main.LEARNING_GATE_PROMPT
    assert live["agent_system"]["name"] == agent._system_prompt_name()
    monkeypatch.setattr(settings, "cluster_naming_prompt_version", "v1b")
    monkeypatch.setattr(settings, "supercluster_label_prompt_version", "v9z")
    live = pv.live_prompts()
    assert live["cluster_naming"]["name"] == "cluster_naming_v1b"
    assert live["supercluster_label"] == {
        "name": None,
        "selector": "settings.supercluster_label_prompt_version",
    }
    tasks = {t["task"]: t for t in pv.build_tasks({})}
    assert tasks["page_summary"]["live"] is None and tasks["page_summary"]["selector"] is None
    flags = {p["name"]: p["live"] for p in tasks["cluster_naming"]["prompts"]}
    assert flags == {"cluster_naming_v1a": False, "cluster_naming_v1b": True}


def test_pipeline_twin_constant_matches_main():
    from backend.api import main
    from backend.services import pipeline_summary

    assert pipeline_summary.SKIP_GATE_PROMPT_NAME == main.SKIP_GATE_PROMPT


def test_model_rows_equal_their_constants():
    from backend.api import main
    from backend.services import (
        agent,
        clustering_service,
        reranker,
        sbert_loader,
        super_cluster_service,
    )

    rows = {r["id"]: r for r in pv.build_models()}
    assert tuple(rows) == pv.MODEL_IDS
    assert rows["skip_gate"]["model"] == main.TOOL_SELECTION_MODEL
    assert rows["learning_gate"]["model"] == main.LEARNING_GATE_MODEL
    assert rows["cluster_naming"]["model"] == clustering_service.NAMING_MODEL
    assert rows["supercluster_grouping"]["model"] == super_cluster_service.ASSIGNMENT_MODEL
    assert rows["supercluster_icons"]["model"] == super_cluster_service.ICON_MODEL
    assert rows["agent"]["model"] == agent.AGENT_MODEL
    assert rows["default_inference"]["model"] == settings.default_inference_model
    assert rows["clustering_embeddings"]["model"] == settings.clustering_embedding_model
    assert rows["search_embeddings"]["model"] == sbert_loader.SBERT_MODEL_NAME
    assert rows["reranker"]["model"] == reranker.MODEL_NAME
    assert rows["skip_gate"]["prompt"] == main.SKIP_GATE_PROMPT
    assert rows["supercluster_icons"]["prompt"] is None
    assert rows["skip_gate"]["source"] == "backend.api.main.TOOL_SELECTION_MODEL"


def test_provider_and_price(monkeypatch):
    from backend.services.llm_service import MODEL_PRICING

    rows = {r["id"]: r for r in pv.build_models()}
    m = rows["skip_gate"]["model"]
    if m in MODEL_PRICING:
        assert rows["skip_gate"]["price_in"] == round(MODEL_PRICING[m]["input"] * 1000, 4)
        assert rows["skip_gate"]["price_out"] == round(MODEL_PRICING[m]["output"] * 1000, 4)
    assert rows["reranker"]["provider"] == "local" and rows["reranker"]["price_in"] is None
    monkeypatch.setattr(settings, "clustering_embedding_model", "text-embedding-3-small")
    rows = {r["id"]: r for r in pv.build_models()}
    assert rows["clustering_embeddings"]["provider"] == "openai"


def test_safe_model(monkeypatch):
    for bad in ("https://host.example/v1", "two words", "x" * 121):
        monkeypatch.setattr(settings, "default_inference_model", bad)
        assert {r["id"]: r for r in pv.build_models()}["default_inference"][
            "model"
        ] == "(custom value)"
    monkeypatch.setattr(settings, "default_inference_model", "")
    assert {r["id"]: r for r in pv.build_models()}["default_inference"]["model"] == "(unset)"


def test_unused_models():
    assert pv.build_unused_models() == [
        {"model": settings.default_summary_model, "source": "settings.default_summary_model"},
        {"model": settings.default_embedding_model, "source": "settings.default_embedding_model"},
    ]


def test_overridden_flags_and_detail_redaction():
    overrides = {"page_summary_v1": "O {title}", "page_summary_v2": "", "bogus": "x"}
    tasks = {t["task"]: t for t in pv.build_tasks(overrides)}
    flags = {p["name"]: p["overridden"] for p in tasks["page_summary"]["prompts"]}
    assert flags == {"page_summary_v1": True, "page_summary_v2": False, "page_summary_v3": False}
    plain = pv.template_detail("page_summary_v1", overrides, admin=False)
    assert "override" not in plain
    assert plain["overridden"] is True
    assert plain["registry_template"] == templates.PROMPTS["page_summary_v1"]["template"]
    assert plain["placeholders"] == ["content", "title"]
    assert plain["task_has_live"] is False and plain["live"] is False
    admin = pv.template_detail("page_summary_v1", overrides, admin=True)
    assert admin["override"] == "O {title}"
    assert pv.template_detail("page_summary_v2", overrides, admin=True)["override"] is None
    assert set(admin) - set(plain) == {"override"}


def test_payloads_never_carry_secret_settings():
    blob = json.dumps(
        {"m": pv.build_models(), "u": pv.build_unused_models(), "t": pv.build_tasks({})}
    )
    assert "://" not in blob
    for field in (
        "openai_api_key",
        "openai_api_key_demo",
        "anthropic_api_key",
        "hf_token",
        "youtube_api_key",
        "langchain_api_key",
        "jwt_secret_key",
        "database_url",
        "test_database_url",
        "proxy_shared_secret",
        "frontend_url",
        "api_host",
    ):
        value = getattr(settings, field, None)
        if isinstance(value, str) and len(value) >= 6:
            assert value not in blob, field
