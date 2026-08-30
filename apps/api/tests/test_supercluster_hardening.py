"""Unit tests for batch B 4c: OpenAI JSON mode passthrough and the
keep-previous-on-failure fix for supercluster assignment (finding F15).
See plan-batch-B.md.
"""

import asyncio
from types import SimpleNamespace

import pytest

from backend.services import super_cluster_service as scs
from backend.services.llm_service import LLMService


def test_complete_openai_passes_response_format(monkeypatch):
    captured = {}

    class FakeCompletions:
        async def create(self, **kwargs):
            captured.update(kwargs)
            return SimpleNamespace(
                choices=[SimpleNamespace(message=SimpleNamespace(content="{}"))],
                usage=SimpleNamespace(
                    prompt_tokens=1, completion_tokens=1, total_tokens=2
                ),
            )

    svc = LLMService()
    svc._openai_client = SimpleNamespace(
        chat=SimpleNamespace(completions=FakeCompletions())
    )
    asyncio.run(
        svc.complete(
            prompt="return JSON",
            model="gpt-4o-mini",
            temperature=0.0,
            seed=42,
            response_format="json_object",
        )
    )
    assert captured["response_format"] == {"type": "json_object"}
    assert captured["seed"] == 42

    # omitted → not sent at all (legacy calls byte-identical)
    captured.clear()
    asyncio.run(svc.complete(prompt="hi", model="gpt-4o-mini"))
    assert "response_format" not in captured


def test_assignment_parse_failure_keeps_previous(monkeypatch):
    clusters = [
        {"id": 1, "cluster_slug": "volcanoes", "cluster_name": "Volcanoes",
         "super_cluster": "science", "page_ids": [1]},
        {"id": 2, "cluster_slug": "knitting", "cluster_name": "Knitting",
         "super_cluster": None, "page_ids": [2]},
    ]
    wiped = {"called": False}
    monkeypatch.setattr(
        scs.cluster_repo, "get_clusters_for_user", lambda uid, rid=None: clusters
    )
    monkeypatch.setattr(
        scs.cluster_repo, "update_super_clusters",
        lambda uid, a: wiped.update(called=True),
    )
    monkeypatch.setattr(scs, "_load_cluster_samples", lambda ids: {})

    class BrokenLLM:
        async def complete(self, **kwargs):
            return SimpleNamespace(
                content="{not valid json", cost_usd=0.0, latency_ms=1.0
            )

    monkeypatch.setattr(scs, "LLMService", BrokenLLM)

    result = asyncio.run(
        scs.assign_super_clusters(1, [{"keyword": "science"}])
    )
    # previous assignments reported back, and — the F15 fix — nothing written
    assert result == {"volcanoes": "science", "knitting": None}
    assert wiped["called"] is False


def test_assignment_success_still_writes(monkeypatch):
    clusters = [
        {"id": 1, "cluster_slug": "volcanoes", "cluster_name": "Volcanoes",
         "super_cluster": None, "page_ids": [1]},
    ]
    written = {}
    monkeypatch.setattr(
        scs.cluster_repo, "get_clusters_for_user", lambda uid, rid=None: clusters
    )
    monkeypatch.setattr(
        scs.cluster_repo, "update_super_clusters",
        lambda uid, a: written.update(a),
    )
    monkeypatch.setattr(scs, "_load_cluster_samples", lambda ids: {})

    class GoodLLM:
        async def complete(self, **kwargs):
            return SimpleNamespace(
                content='{"assignments": [{"id": 1, "topic": "science", '
                        '"reason": "volcanoes"}]}',
                cost_usd=0.0, latency_ms=1.0,
            )

    monkeypatch.setattr(scs, "LLMService", GoodLLM)
    result = asyncio.run(scs.assign_super_clusters(1, [{"keyword": "science"}]))
    assert result == {"volcanoes": "science"}
    assert written == {1: "science"}
