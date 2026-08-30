"""Tests for the cross-encoder reranker.

Most tests avoid loading the 1.5GB model (too slow for unit tests). The
live-model test is gated behind ``RERANKER_LIVE_TEST=1`` so CI / quick
local runs skip it by default.
"""

import os

import pytest

from backend.services import reranker


def test_rerank_empty_input_returns_empty():
    """No candidates in → no reranking work, empty list out."""
    assert reranker.rerank("any query", [], top_k=5) == []


def test_rerank_disabled_passes_through_top_k(monkeypatch):
    """When RERANKER_DISABLED=1, rerank should slice without loading model."""
    monkeypatch.setenv("RERANKER_DISABLED", "1")
    # Reset cached model handle to guarantee no load attempt.
    monkeypatch.setattr(reranker, "_reranker", None)

    chunks = [{"chunk_text": f"passage {i}", "idx": i} for i in range(10)]
    out = reranker.rerank("query", chunks, top_k=3)

    assert len(out) == 3
    # Disabled mode preserves input order (no rerank_score annotation).
    assert [c["idx"] for c in out] == [0, 1, 2]


def test_rerank_disabled_handles_fewer_candidates_than_top_k(monkeypatch):
    monkeypatch.setenv("RERANKER_DISABLED", "1")
    monkeypatch.setattr(reranker, "_reranker", None)

    chunks = [{"chunk_text": "only one"}]
    out = reranker.rerank("query", chunks, top_k=5)
    assert len(out) == 1


@pytest.mark.skipif(
    os.environ.get("RERANKER_LIVE_TEST") != "1",
    reason="Live reranker test downloads ~1.5GB; set RERANKER_LIVE_TEST=1 to enable.",
)
def test_rerank_live_orders_relevant_chunk_first():
    """Smoke test: reranker should put the on-topic chunk above the distractor."""
    query = "how do I cancel a subscription"
    chunks = [
        {
            "chunk_text": "Our premium subscription costs $9.99 per month and includes...",
            "id": "pricing",
        },
        {
            "chunk_text": "To cancel your subscription, go to Settings → Billing → Cancel.",
            "id": "cancel",
        },
        {
            "chunk_text": "The API rate limit for free accounts is 100 requests per hour.",
            "id": "ratelimit",
        },
    ]

    out = reranker.rerank(query, chunks, top_k=3)

    assert len(out) == 3
    assert out[0]["id"] == "cancel"
    # Every result should carry a normalized score in [0,1].
    for r in out:
        assert 0.0 <= r["rerank_score"] <= 1.0
