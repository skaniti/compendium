"""Unit tests for the ctv3 embedding-text contract (sc-followups
2026-07-16): per-page LLM gists as a gated alternative to ctv2's 300-char
head sample.

Covers: the embedding_gists repo round-trip, the ctv3 text recipe (gist hit
+ fallback), batched gist generation with fail-open behavior, and contract
routing in _compute_embeddings_openai (ctv2 stays byte-identical; ctv3
generates/persists missing gists and routes through the v3 recipe).
"""

import asyncio
import uuid
from types import SimpleNamespace

import numpy as np
import pytest

from backend.config.settings import settings
from backend.db import content_repo, embedding_repo, trends_repo
from backend.services import clustering_service
from backend.services.clustering_service import (
    GIST_BATCH_SIZE,
    GIST_PROMPT_KEY,
    ClusteringService,
)


def _page(
    db_id=1,
    content_id=11,
    title="Volcanic Eruptions",
    summary="All about phreatomagmatic eruptions.",
    full_content=None,
    url="https://example.org/volcano-article",
    tool_selected=None,
):
    return {
        "db_id": db_id,
        "url": url,
        "title": title,
        "domain": "example.org",
        "summary": summary,
        "full_content": full_content or {},
        "capture_text_id": "",
        "page_content_id": content_id,
        "tool_selected": tool_selected,
        "is_learning": True,
    }


# ── Repo round-trip (embedding_gists) ───────────────────────────────────


def test_embedding_gists_repo_round_trip():
    # Unique per-run URLs: get_or_create_content is idempotent on
    # normalized_url, and the test DB isn't truncated between runs, so a
    # fixed URL would pick up gist rows left behind by a prior run.
    nonce = uuid.uuid4().hex
    row1 = content_repo.get_or_create_content(f"https://example.org/gist-repo-1-{nonce}")
    row2 = content_repo.get_or_create_content(f"https://example.org/gist-repo-2-{nonce}")
    pcid1, pcid2 = row1["id"], row2["id"]

    # Nothing cached yet.
    assert embedding_repo.get_embedding_gists([pcid1, pcid2], GIST_PROMPT_KEY) == {}

    embedding_repo.upsert_embedding_gists(
        [(pcid1, "A gist about volcanoes."), (pcid2, "A gist about star charts.")],
        GIST_PROMPT_KEY,
    )
    got = embedding_repo.get_embedding_gists([pcid1, pcid2], GIST_PROMPT_KEY)
    assert got == {
        pcid1: "A gist about volcanoes.",
        pcid2: "A gist about star charts.",
    }

    # Different prompt_key sees nothing (namespaced).
    assert embedding_repo.get_embedding_gists([pcid1], "other_prompt_v9") == {}

    # Upsert overwrites in place (ON CONFLICT DO UPDATE).
    embedding_repo.upsert_embedding_gists(
        [(pcid1, "Updated volcano gist.")], GIST_PROMPT_KEY
    )
    got = embedding_repo.get_embedding_gists([pcid1], GIST_PROMPT_KEY)
    assert got[pcid1] == "Updated volcano gist."


def test_embedding_gists_repo_empty_inputs_short_circuit():
    # No DB round-trip for empty inputs — mostly a guard against ANY(%s)
    # on an empty list / a no-op upsert.
    assert embedding_repo.get_embedding_gists([], GIST_PROMPT_KEY) == {}
    embedding_repo.upsert_embedding_gists([], GIST_PROMPT_KEY)  # must not raise


# ── ctv3 text recipe ────────────────────────────────────────────────────


def test_build_embedding_text_v3_uses_gist():
    svc = ClusteringService(user_id=1)
    page = _page(content_id=42)
    gists = {42: "A concise summary of phreatomagmatic eruptions."}
    text, source = svc._build_embedding_text_v3(page, gists)
    assert text == "Volcanic Eruptions. A concise summary of phreatomagmatic eruptions."
    assert source == "ctv3:gist"


def test_build_embedding_text_v3_fallback_without_gist(monkeypatch):
    svc = ClusteringService(user_id=1)
    monkeypatch.setattr(
        "backend.services.content_fetcher.get_primary_text_from_dict",
        lambda tool, fc, for_clustering: ("primary body text", "FakeFetcher"),
    )
    page = _page(content_id=42, summary="")
    text, source = svc._build_embedding_text_v3(page, gists={})
    assert text == "Volcanic Eruptions. primary body text"
    assert source == "ctv3:primary_text_fallback:FakeFetcher"


def test_build_embedding_text_v3_fallback_caps_at_2000_words(monkeypatch):
    svc = ClusteringService(user_id=1)
    long_text = " ".join(f"w{i}" for i in range(2500))
    monkeypatch.setattr(
        "backend.services.content_fetcher.get_primary_text_from_dict",
        lambda tool, fc, for_clustering: (long_text, "FakeFetcher"),
    )
    page = _page(summary="")
    text, _source = svc._build_embedding_text_v3(page, gists={})
    # Primary text is capped at 2000 words FIRST; since the truncated text
    # doesn't start with the title, the title is then prefixed on top --
    # so the final word count is 2000 + the title's own word count.
    assert text.startswith(f"{page['title']}. w0 w1 ")
    assert len(text.split()) == 2000 + len(page["title"].split())


def test_build_embedding_text_v3_fallback_prefixes_title_when_missing(monkeypatch):
    svc = ClusteringService(user_id=1)
    monkeypatch.setattr(
        "backend.services.content_fetcher.get_primary_text_from_dict",
        lambda tool, fc, for_clustering: ("body text without the title", "FakeFetcher"),
    )
    text, _source = svc._build_embedding_text_v3(_page(summary=""), gists={})
    assert text == "Volcanic Eruptions. body text without the title"


def test_build_embedding_text_v3_url_fallback_when_nothing_else(monkeypatch):
    svc = ClusteringService(user_id=1)
    monkeypatch.setattr(
        "backend.services.content_fetcher.get_primary_text_from_dict",
        lambda tool, fc, for_clustering: ("", "empty"),
    )
    text, source = svc._build_embedding_text_v3(_page(summary=""), gists={})
    assert source == "ctv3:url_path_fallback"
    assert "volcano article" in text


# ── Batched gist generation (fail-open) ─────────────────────────────────


class _LLMStub:
    """Stub mirroring tests/test_supercluster_hybrid.py's LLMStub pattern."""

    def __init__(self, content=None, contents=None, raise_exc=None):
        self._content = content
        self._contents = list(contents) if contents else None
        self._raise = raise_exc
        self.calls = 0

    async def complete(self, **kwargs):
        self.calls += 1
        if self._raise is not None:
            raise self._raise
        assert kwargs["response_format"] == "json_object"
        content = self._contents.pop(0) if self._contents is not None else self._content
        return SimpleNamespace(content=content, cost_usd=0.001, latency_ms=1)


def test_generate_embedding_gists_parses_and_fails_open(monkeypatch):
    svc = ClusteringService(user_id=1)
    monkeypatch.setattr(
        "backend.services.content_fetcher.get_primary_text_from_dict",
        lambda tool, fc, for_clustering: ("body text", "FakeFetcher"),
    )
    pages = [_page(content_id=1), _page(content_id=2)]

    # Happy path: batched JSON parse maps ids -> gists.
    monkeypatch.setattr(
        "backend.services.llm_service.LLMService",
        lambda: _LLMStub(
            content='{"gists": [{"id": 1, "gist": "gist one"}, '
            '{"id": 2, "gist": "gist two"}]}'
        ),
    )
    result, cost = asyncio.run(svc._generate_embedding_gists(pages))
    assert result == {1: "gist one", 2: "gist two"}
    assert cost == pytest.approx(0.001)

    # Garbage JSON -> fail-open: no gists, but the (already-spent) cost of
    # the call still surfaces.
    monkeypatch.setattr(
        "backend.services.llm_service.LLMService",
        lambda: _LLMStub(content="{not json"),
    )
    result, cost = asyncio.run(svc._generate_embedding_gists(pages))
    assert result == {}
    assert cost == pytest.approx(0.001)

    # Transport error -> fail-open: no gists, zero cost (call never billed).
    monkeypatch.setattr(
        "backend.services.llm_service.LLMService",
        lambda: _LLMStub(raise_exc=RuntimeError("connection reset")),
    )
    result, cost = asyncio.run(svc._generate_embedding_gists(pages))
    assert result == {}
    assert cost == 0.0


def test_generate_embedding_gists_batches_and_skips_unmatched_ids(monkeypatch):
    svc = ClusteringService(user_id=1)
    monkeypatch.setattr(
        "backend.services.content_fetcher.get_primary_text_from_dict",
        lambda tool, fc, for_clustering: ("body text", "FakeFetcher"),
    )
    pages = [_page(content_id=i) for i in range(1, GIST_BATCH_SIZE + 3)]

    stub = _LLMStub(
        contents=[
            # batch 1 (size GIST_BATCH_SIZE): includes an id not in this
            # chunk, which must be dropped rather than polluting results.
            '{"gists": [%s, {"id": 9999, "gist": "not in this batch"}]}'
            % ", ".join(f'{{"id": {i}, "gist": "g{i}"}}' for i in range(1, GIST_BATCH_SIZE + 1)),
            # batch 2 (remaining 2 pages)
            '{"gists": [{"id": %d, "gist": "gA"}, {"id": %d, "gist": "gB"}]}'
            % (GIST_BATCH_SIZE + 1, GIST_BATCH_SIZE + 2),
        ]
    )
    monkeypatch.setattr("backend.services.llm_service.LLMService", lambda: stub)

    result, cost = asyncio.run(svc._generate_embedding_gists(pages))
    assert stub.calls == 2
    assert 9999 not in result
    assert len(result) == GIST_BATCH_SIZE + 2
    assert cost == pytest.approx(0.002)


def test_generate_embedding_gists_skips_pages_without_content_id(monkeypatch):
    svc = ClusteringService(user_id=1)
    monkeypatch.setattr(
        "backend.services.content_fetcher.get_primary_text_from_dict",
        lambda tool, fc, for_clustering: ("body text", "FakeFetcher"),
    )
    stub = _LLMStub(content='{"gists": []}')
    monkeypatch.setattr("backend.services.llm_service.LLMService", lambda: stub)

    page_no_id = _page(content_id=None)
    result, cost = asyncio.run(svc._generate_embedding_gists([page_no_id]))
    assert result == {}
    assert stub.calls == 0  # nothing to gist -> no batches at all


# ── Contract routing in _compute_embeddings_openai ──────────────────────


class _FakeEmbeddingsAPI:
    def __init__(self, dim=4):
        self.dim = dim
        self.calls = []

    def create(self, model, input):
        self.calls.append({"model": model, "n_inputs": len(input)})

        class Item:
            def __init__(self, index, embedding):
                self.index = index
                self.embedding = embedding

        class Usage:
            total_tokens = 100 * len(input)

        class Resp:
            data = [Item(i, [float(i + 1)] * self.dim) for i in range(len(input))]
            usage = Usage()

        return Resp()


class _FakeOpenAI:
    last_instance = None

    def __init__(self, api_key=None):
        self.embeddings = _FakeEmbeddingsAPI()
        _FakeOpenAI.last_instance = self


@pytest.fixture
def candidate_env(monkeypatch):
    """Stub every external surface of the candidate path; capture calls."""
    captured = {
        "cache_key": None,
        "saved": None,
        "cost_events": [],
        "audit": None,
        "gist_gets": [],
        "gist_upserts": [],
    }

    _FakeOpenAI.last_instance = None
    monkeypatch.setattr(settings, "clustering_embedding_model", "text-embedding-3-small")
    monkeypatch.setattr("openai.OpenAI", _FakeOpenAI)

    def fake_get(content_ids, model_key):
        captured["cache_key"] = model_key
        return {}

    def fake_save(rows, model_key):
        captured["saved"] = (rows, model_key)
        return len(rows)

    def fake_cost(**kwargs):
        captured["cost_events"].append(kwargs)

    def fake_get_gists(pcids, prompt_key):
        captured["gist_gets"].append((list(pcids), prompt_key))
        return {}

    def fake_upsert_gists(rows, prompt_key):
        captured["gist_upserts"].append((rows, prompt_key))

    monkeypatch.setattr(embedding_repo, "get_clustering_embeddings", fake_get)
    monkeypatch.setattr(embedding_repo, "save_clustering_embeddings_bulk", fake_save)
    monkeypatch.setattr(embedding_repo, "get_embedding_gists", fake_get_gists)
    monkeypatch.setattr(embedding_repo, "upsert_embedding_gists", fake_upsert_gists)
    monkeypatch.setattr(trends_repo, "insert_cost_event", fake_cost)
    monkeypatch.setattr(
        ClusteringService,
        "_save_sbert_text_audit",
        staticmethod(lambda rows: captured.__setitem__("audit", rows)),
    )
    return captured


def test_contract_routing_ctv2_default_no_gist_lookups(candidate_env):
    assert settings.clustering_text_contract == "ctv2"
    svc = ClusteringService(user_id=1)
    pages = [_page(db_id=1, content_id=11), _page(db_id=2, content_id=12)]
    result = svc._compute_embeddings(pages)

    assert candidate_env["cache_key"] == "text-embedding-3-small@ctv2"
    assert result.shape == (2, 4)
    assert candidate_env["gist_gets"] == []  # ctv2 never touches embedding_gists
    audit_sources = {source for _t, source, _cid in candidate_env["audit"]}
    assert audit_sources == {"ctv2:title_summary"}


def test_contract_routing_ctv3_uses_cached_gist(candidate_env, monkeypatch):
    monkeypatch.setattr(settings, "clustering_text_contract", "ctv3")
    monkeypatch.setattr(
        embedding_repo,
        "get_embedding_gists",
        lambda pcids, prompt_key: {11: "cached gist for page 11"},
    )
    svc = ClusteringService(user_id=1)
    pages = [_page(db_id=1, content_id=11, title="Volcanic Eruptions", summary="ignored ctv2 text")]
    result = svc._compute_embeddings(pages)

    assert candidate_env["cache_key"] == "text-embedding-3-small@ctv3"
    assert result.shape == (1, 4)
    audit_sources = {source for _t, source, _cid in candidate_env["audit"]}
    assert audit_sources == {"ctv3:gist"}
    audit_texts = {text for text, _s, _cid in candidate_env["audit"]}
    assert audit_texts == {"Volcanic Eruptions. cached gist for page 11"}


def test_contract_routing_ctv3_generates_and_persists_missing_gist(
    candidate_env, monkeypatch
):
    monkeypatch.setattr(settings, "clustering_text_contract", "ctv3")
    monkeypatch.setattr(
        "backend.services.llm_service.LLMService",
        lambda: _LLMStub(content='{"gists": [{"id": 11, "gist": "a freshly generated gist"}]}'),
    )
    svc = ClusteringService(user_id=1)
    pages = [_page(db_id=1, content_id=11)]
    result = svc._compute_embeddings(pages)

    assert result.shape == (1, 4)
    assert candidate_env["gist_upserts"] == [
        ([(11, "a freshly generated gist")], GIST_PROMPT_KEY)
    ]
    gist_cost_events = [
        e for e in candidate_env["cost_events"] if e["event_type"] == "embedding_gist"
    ]
    assert len(gist_cost_events) == 1
    assert gist_cost_events[0]["cost_usd"] == pytest.approx(0.001)
    audit_sources = {source for _t, source, _cid in candidate_env["audit"]}
    assert audit_sources == {"ctv3:gist"}


def test_contract_routing_ctv3_from_inside_running_event_loop(candidate_env, monkeypatch):
    """recluster_all is async and calls _compute_embeddings synchronously
    inline -- the ctv3 gist-generation path must not blow up with
    "asyncio.run() cannot be called from a running event loop"."""
    monkeypatch.setattr(settings, "clustering_text_contract", "ctv3")
    monkeypatch.setattr(
        "backend.services.llm_service.LLMService",
        lambda: _LLMStub(content='{"gists": [{"id": 11, "gist": "loop-safe gist"}]}'),
    )
    svc = ClusteringService(user_id=1)
    pages = [_page(db_id=1, content_id=11)]

    async def _caller():
        # Runs _compute_embeddings (sync) from inside a running loop, exactly
        # like ClusteringService.recluster_all does with _compute_embeddings.
        return svc._compute_embeddings(pages)

    result = asyncio.run(_caller())
    assert result.shape == (1, 4)
    audit_sources = {source for _t, source, _cid in candidate_env["audit"]}
    assert audit_sources == {"ctv3:gist"}


def test_contract_routing_ctv3_fallback_when_generation_fails(candidate_env, monkeypatch):
    """Fail-open: if gist generation fails for a page, it embeds via the v3
    fallback register this run rather than blocking the recluster."""
    monkeypatch.setattr(settings, "clustering_text_contract", "ctv3")
    monkeypatch.setattr(
        "backend.services.llm_service.LLMService",
        lambda: _LLMStub(raise_exc=RuntimeError("connection reset")),
    )
    monkeypatch.setattr(
        "backend.services.content_fetcher.get_primary_text_from_dict",
        lambda tool, fc, for_clustering: ("fallback body text", "FakeFetcher"),
    )
    svc = ClusteringService(user_id=1)
    pages = [_page(db_id=1, content_id=11, summary="")]
    result = svc._compute_embeddings(pages)

    assert result.shape == (1, 4)
    assert candidate_env["gist_upserts"] == []  # nothing to persist
    audit_sources = {source for _t, source, _cid in candidate_env["audit"]}
    assert audit_sources == {"ctv3:primary_text_fallback:FakeFetcher"}


