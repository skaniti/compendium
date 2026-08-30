"""Unit tests for the gated clustering embedding upgrade (increment 1 of the
clustering rethink — see docs/project-plans/2026-07-08-180037-clustering-
supercluster-rethink/plan.md).

Covers: text recipe ctv2 selection order, versioned cache keying
(<model>@<contract>), the candidate OpenAI path with a stubbed client (no
network), cost-event recording, and the legacy-path routing guarantee (default
settings never touch the candidate path).
"""

import numpy as np
import pytest

from backend.config.settings import settings
from backend.db import embedding_repo, trends_repo
from backend.services import clustering_service
from backend.services.clustering_service import (
    EMBEDDING_TEXT_CONTRACT,
    ClusteringService,
)


def _page(
    db_id=1,
    content_id=11,
    title="Volcanic Eruptions",
    summary="All about phreatomagmatic eruptions.",
    full_content=None,
    url="https://example.org/volcano-article",
    domain="example.org",
):
    return {
        "db_id": db_id,
        "url": url,
        "title": title,
        "domain": domain,
        "summary": summary,
        "full_content": full_content or {},
        "capture_text_id": "",
        "page_content_id": content_id,
        "tool_selected": None,
        "is_learning": True,
    }


# ── Text recipe ctv2 ────────────────────────────────────────────────────


def test_recipe_v2_prefers_summary_over_content():
    svc = ClusteringService(user_id=1)
    page = _page(full_content={"text": "raw fetched body that must be ignored"})
    text, source = svc._build_embedding_text_v2(page)
    assert text == "Volcanic Eruptions. All about phreatomagmatic eruptions."
    assert source == "ctv2:title_summary"


def test_recipe_v2_falls_back_to_primary_text(monkeypatch):
    svc = ClusteringService(user_id=1)
    monkeypatch.setattr(
        "backend.services.content_fetcher.get_primary_text_from_dict",
        lambda tool, fc, for_clustering: ("primary body text", "FakeFetcher"),
    )
    page = _page(summary="")
    text, source = svc._build_embedding_text_v2(page)
    assert text == "primary body text"
    assert source == "ctv2:FakeFetcher"


def test_recipe_v2_caps_primary_text_at_2000_words(monkeypatch):
    svc = ClusteringService(user_id=1)
    long_text = " ".join(f"w{i}" for i in range(2500))
    monkeypatch.setattr(
        "backend.services.content_fetcher.get_primary_text_from_dict",
        lambda tool, fc, for_clustering: (long_text, "FakeFetcher"),
    )
    text, _source = svc._build_embedding_text_v2(_page(summary=""))
    assert len(text.split()) == 2000


def test_recipe_v2_url_fallback_when_nothing_else(monkeypatch):
    svc = ClusteringService(user_id=1)
    monkeypatch.setattr(
        "backend.services.content_fetcher.get_primary_text_from_dict",
        lambda tool, fc, for_clustering: ("", "empty"),
    )
    text, source = svc._build_embedding_text_v2(_page(summary=""))
    assert source == "ctv2:url_path_fallback"
    assert "volcano article" in text


# ── Text recipe ctv2b (body) ─────────────────────────────────────────────


def test_recipe_v2b_prefers_primary_text_over_summary(monkeypatch):
    svc = ClusteringService(user_id=1)
    long_text = "x" * 2000
    monkeypatch.setattr(
        "backend.services.content_fetcher.get_primary_text_from_dict",
        lambda tool, fc, for_clustering: (long_text, "FakeFetcher"),
    )
    page = _page(summary="short summary that must be ignored")
    text, source = svc._build_embedding_text_v2b(page)
    assert text == "Volcanic Eruptions. " + "x" * 1200
    assert source == "ctv2b:FakeFetcher"


def test_recipe_v2b_caps_primary_text_at_1200_chars(monkeypatch):
    svc = ClusteringService(user_id=1)
    monkeypatch.setattr(
        "backend.services.content_fetcher.get_primary_text_from_dict",
        lambda tool, fc, for_clustering: ("y" * 1500, "FakeFetcher"),
    )
    text, _source = svc._build_embedding_text_v2b(_page(summary=""))
    body = text.split(". ", 1)[1]
    assert len(body) == 1200


def test_recipe_v2b_falls_back_to_summary_when_no_primary_text(monkeypatch):
    svc = ClusteringService(user_id=1)
    monkeypatch.setattr(
        "backend.services.content_fetcher.get_primary_text_from_dict",
        lambda tool, fc, for_clustering: ("", "empty"),
    )
    text, source = svc._build_embedding_text_v2b(
        _page(summary="A short capture-time summary.")
    )
    assert text == "Volcanic Eruptions. A short capture-time summary."
    assert source == "ctv2b:summary_fallback"


def test_recipe_v2b_url_fallback_when_nothing_else(monkeypatch):
    svc = ClusteringService(user_id=1)
    monkeypatch.setattr(
        "backend.services.content_fetcher.get_primary_text_from_dict",
        lambda tool, fc, for_clustering: ("", "empty"),
    )
    text, source = svc._build_embedding_text_v2b(_page(summary=""))
    assert source == "ctv2b:url_path_fallback"
    assert "volcano article" in text


# ── Text recipe ctv2s (stripped) ─────────────────────────────────────────


@pytest.mark.parametrize(
    "domain,expected",
    [
        ("en.wikipedia.org", "wikipedia"),
        ("www.printables.com", "printables"),
        ("svelte.dev", "svelte"),
        ("claude.ai", "claude"),
        ("github.com", "github"),
        ("", ""),
    ],
)
def test_derive_site_token(domain, expected):
    assert ClusteringService._derive_site_token(domain) == expected


def test_strip_title_suffix_strips_wikipedia_suffix():
    assert (
        ClusteringService._strip_title_suffix("Cnidocyte - Wikipedia", "en.wikipedia.org")
        == "Cnidocyte"
    )


def test_strip_title_suffix_keeps_mid_title_hyphen_but_strips_real_suffix():
    # "Anti-diarrheal" has NO spaces around its hyphen (never a separator
    # candidate); the trailing " - Wikipedia" DOES, and matches the domain.
    title = "Anti-diarrheal medication - Wikipedia"
    assert (
        ClusteringService._strip_title_suffix(title, "en.wikipedia.org")
        == "Anti-diarrheal medication"
    )


def test_strip_title_suffix_never_touches_spaceless_hyphen():
    # Real corpus title SHAPE (github.com) — no spaced separator at
    # all, so it must never reach the domain-match check.
    title = "octocat/widget-catalog: Catalog of Widget Designs and Other Resources"
    assert ClusteringService._strip_title_suffix(title, "github.com") == title


def test_strip_title_suffix_leaves_unrelated_trailing_content():
    title = "Pride and Prejudice - Chapter 1"
    assert ClusteringService._strip_title_suffix(title, "gutenberg.org") == title


def test_strip_title_suffix_strips_last_matching_pipe_segment():
    # Real corpus title shape (printables.com): multiple " | " separators;
    # only the LAST segment (which names the domain) is stripped.
    title = (
        "Modular Widget Stand (WidgetKit) by Alex Doe | "
        "Download free STL model | Printables.com"
    )
    expected = (
        "Modular Widget Stand (WidgetKit) by Alex Doe | "
        "Download free STL model"
    )
    assert ClusteringService._strip_title_suffix(title, "www.printables.com") == expected


def test_strip_title_suffix_no_token_no_change():
    assert ClusteringService._strip_title_suffix("Some Title - Site", "") == "Some Title - Site"


def test_strip_title_suffix_keeps_content_when_trailing_merely_contains_token():
    # Regression (2026-08-14 tightening): the old check stripped whenever
    # the site token appeared ANYWHERE in the trailing segment's word set,
    # eating real content — "Contest Winner" isn't a format cue.
    title = "Spool Holder - Printables Contest Winner"
    assert ClusteringService._strip_title_suffix(title, "www.printables.com") == title


def test_strip_title_suffix_strips_when_trailing_is_token_plus_filler():
    title = "Widget Catalog - Printables.com"
    assert (
        ClusteringService._strip_title_suffix(title, "www.printables.com")
        == "Widget Catalog"
    )


def test_strip_title_suffix_strips_when_trailing_is_token_plus_word_filler():
    title = "Setup Guide - The Official Wikipedia"
    assert (
        ClusteringService._strip_title_suffix(title, "en.wikipedia.org")
        == "Setup Guide"
    )


def test_strip_domain_tokens_removes_literal_domain_string():
    text = "Modular Widget Stand | Download free STL model | Printables.com"
    result = ClusteringService._strip_domain_tokens(text, "www.printables.com")
    assert "printables.com" not in result.lower()
    assert "Modular Widget Stand" in result


def test_strip_domain_tokens_leaves_bare_site_name_word_alone():
    # A plain mention of the site's name, with no domain suffix attached,
    # is prose — never stripped.
    text = "Printables is a great community for makers."
    result = ClusteringService._strip_domain_tokens(text, "www.printables.com")
    assert result == text


def test_strip_domain_tokens_no_domain_no_change():
    text = "Nothing to strip here."
    assert ClusteringService._strip_domain_tokens(text, "") == text


def test_recipe_v2s_strips_title_suffix(monkeypatch):
    svc = ClusteringService(user_id=1)
    monkeypatch.setattr(
        "backend.services.content_fetcher.get_primary_text_from_dict",
        lambda tool, fc, for_clustering: (
            "Box jellyfish are highly venomous cnidarians.",
            "FakeFetcher",
        ),
    )
    page = _page(title="Box jellyfish - Wikipedia", domain="en.wikipedia.org", summary="ignored")
    text, source = svc._build_embedding_text_v2s(page)
    assert text == "Box jellyfish. Box jellyfish are highly venomous cnidarians."
    assert source == "ctv2s:FakeFetcher"


def test_recipe_v2s_strips_domain_token_from_assembled_body(monkeypatch):
    svc = ClusteringService(user_id=1)
    monkeypatch.setattr(
        "backend.services.content_fetcher.get_primary_text_from_dict",
        lambda tool, fc, for_clustering: (
            "SnapCap universal refill cap, hosted on Printables.com by James.",
            "FakeFetcher",
        ),
    )
    page = _page(
        title=(
            "SnapCap - Universal Refill Cap by James | "
            "Download free STL model | Printables.com"
        ),
        domain="www.printables.com",
        summary="ignored",
    )
    text, source = svc._build_embedding_text_v2s(page)
    assert "printables.com" not in text.lower()
    assert text.startswith("SnapCap - Universal Refill Cap by James | Download free STL model.")
    assert source == "ctv2s:FakeFetcher"


def test_recipe_v2s_falls_back_through_v2b_chain(monkeypatch):
    svc = ClusteringService(user_id=1)
    monkeypatch.setattr(
        "backend.services.content_fetcher.get_primary_text_from_dict",
        lambda tool, fc, for_clustering: ("", "empty"),
    )
    text, source = svc._build_embedding_text_v2s(
        _page(title="Cnidocyte - Wikipedia", domain="en.wikipedia.org",
              summary="A short capture-time summary.")
    )
    assert text == "Cnidocyte. A short capture-time summary."
    assert source == "ctv2s:summary_fallback"


# ── Candidate OpenAI path ───────────────────────────────────────────────


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
            data = [
                Item(i, [float(i + 1)] * self.dim) for i in range(len(input))
            ]
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
    captured = {"cache_key": None, "saved": None, "cost": None, "audit": None}

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
        captured["cost"] = kwargs

    monkeypatch.setattr(embedding_repo, "get_clustering_embeddings", fake_get)
    monkeypatch.setattr(embedding_repo, "save_clustering_embeddings_bulk", fake_save)
    monkeypatch.setattr(trends_repo, "insert_cost_event", fake_cost)
    monkeypatch.setattr(
        ClusteringService,
        "_save_sbert_text_audit",
        staticmethod(lambda rows: captured.__setitem__("audit", rows)),
    )
    return captured


def test_candidate_path_versioned_key_matrix_and_cost(candidate_env):
    svc = ClusteringService(user_id=1)
    pages = [_page(db_id=1, content_id=11), _page(db_id=2, content_id=12)]
    result = svc._compute_embeddings(pages)

    assert candidate_env["cache_key"] == f"text-embedding-3-small@{EMBEDDING_TEXT_CONTRACT}"
    assert result.shape == (2, 4)
    # rows must be exactly unit-norm regardless of what the API returned
    np.testing.assert_allclose(np.linalg.norm(result, axis=1), 1.0)

    saved_rows, saved_key = candidate_env["saved"]
    assert saved_key == f"text-embedding-3-small@{EMBEDDING_TEXT_CONTRACT}"
    assert [cid for cid, _ in saved_rows] == [11, 12]

    cost = candidate_env["cost"]
    assert cost["event_type"] == "clustering_embedding"
    assert cost["model"] == "text-embedding-3-small"
    assert cost["input_tokens"] == 200
    assert cost["cost_usd"] == pytest.approx(200 / 1_000_000 * 0.02)

    audit_sources = {source for _text, source, _cid in candidate_env["audit"]}
    assert audit_sources == {"ctv2:title_summary"}


def test_candidate_path_cache_hit_skips_api(candidate_env, monkeypatch):
    monkeypatch.setattr(
        embedding_repo,
        "get_clustering_embeddings",
        lambda content_ids, model_key: {11: [1.0, 0.0, 0.0, 0.0], 12: [0.0, 1.0, 0.0, 0.0]},
    )
    svc = ClusteringService(user_id=1)
    result = svc._compute_embeddings([_page(content_id=11), _page(db_id=2, content_id=12)])
    assert result.shape == (2, 4)
    assert _FakeOpenAI.last_instance is None or _FakeOpenAI.last_instance.embeddings.calls == []
    assert candidate_env["saved"] is None  # nothing written
    assert candidate_env["cost"] is None  # no spend, no event


def test_default_model_routes_to_legacy_path(monkeypatch):
    # Forced rather than asserted: the ambient .env sets
    # text-embedding-3-small for prod parity; this test's subject is the
    # SBERT-default routing branch, not the environment.
    monkeypatch.setattr(
        settings, "clustering_embedding_model", "all-MiniLM-L6-v2"
    )

    def _boom(self, pages, model_name):
        raise AssertionError("candidate path must not run on default settings")

    monkeypatch.setattr(ClusteringService, "_compute_embeddings_openai", _boom)
    monkeypatch.setattr(
        embedding_repo,
        "get_embeddings_for_content_ids",
        lambda content_ids: {11: [0.5] * 384, 12: [0.25] * 384},
    )
    svc = ClusteringService(user_id=1)
    result = svc._compute_embeddings([_page(content_id=11), _page(db_id=2, content_id=12)])
    assert result.shape == (2, 384)
