"""Cross-encoder reranker for the RAG retrieval path.

Bi-encoder embedding search (pgvector cosine) gives fast recall but poor
precision — it returns topically related chunks, not necessarily chunks
that answer the question. A cross-encoder processes each (query, chunk)
pair jointly through a full transformer forward pass, producing a
joint-relevance score with full cross-attention.

Two-stage retrieval:
    query → embed → pgvector top-25 → cross-encoder → top-5 → LLM

The embedding stage is cheap and high-recall; the reranker is slower but
scores only the 25 survivors.

Model choice:
    cross-encoder/ms-marco-MiniLM-L-6-v2 (~22M params, ~90MB on disk).
    Replaced BAAI/bge-reranker-v2-m3 (~568M params, ~1.5GB on disk) on
    2026-04-29 because v2-m3 inference on CPU was costing ~8 seconds per
    (query, chunk) pair — 200+ seconds for a 25-candidate rerank, which
    dominated chat latency. MiniLM-L-6 is the standard CPU-bound reranker
    in the sentence-transformers ecosystem; expected per-pair inference
    is ~10-30ms on CPU, ~1000× faster end-to-end. Quality differs
    (MiniLM is trained on MS-MARCO passage ranking, v2-m3 is multilingual
    + larger context) but for biographical / factual Wikipedia retrieval
    the difference is small. If quality regressions surface, swap back is
    a one-line change to MODEL_NAME below.

See the 2026-04-08 rag-reranker plan (private) for the original design
rationale.
"""

import logging
import math
import os
from typing import Any

logger = logging.getLogger(__name__)

MODEL_NAME = "cross-encoder/ms-marco-MiniLM-L-6-v2"

_reranker: Any = None


def _disabled() -> bool:
    """Allow `RERANKER_DISABLED=1` to skip reranking (benchmarking, CI)."""
    return os.environ.get("RERANKER_DISABLED", "").lower() in {"1", "true", "yes"}


def get_reranker():
    """Lazy-load the cross-encoder model. First call downloads ~90MB."""
    global _reranker
    if _reranker is None:
        from sentence_transformers import CrossEncoder

        logger.info(f"Loading reranker model: {MODEL_NAME} (first call downloads ~90MB)")
        _reranker = CrossEncoder(MODEL_NAME)
    return _reranker


def _sigmoid(x: float) -> float:
    """Map a logit (any real) to a probability-like score in (0, 1)."""
    return 1.0 / (1.0 + math.exp(-x))


def rerank(query: str, chunks: list[dict], top_k: int = 5) -> list[dict]:
    """Rerank chunks by cross-encoder joint relevance to the query.

    Each chunk dict is expected to contain a ``chunk_text`` key (the shape
    returned by ``embedding_repo.find_similar_chunks``). Returned chunks
    get an added ``rerank_score`` field (sigmoid-mapped to [0,1]) and are
    sorted descending by that score.

    Args:
        query: The user's search query.
        chunks: Candidate chunks from the bi-encoder stage.
        top_k: Number of top results to return.

    Returns:
        Top-k chunks with ``rerank_score`` attached, sorted by that score.
        Empty list if no candidates.
    """
    if not chunks:
        return []
    if _disabled():
        return chunks[:top_k]

    reranker = get_reranker()
    pairs = [[query, c.get("chunk_text", "")] for c in chunks]

    # CrossEncoder.predict returns a numpy ndarray of raw logits. Apply
    # sigmoid so scores are in [0,1] -- matches the previous bge model's
    # normalize=True semantics, so downstream callers (agent.py format
    # strings expecting `relevance: 0.NNN`, threshold checks if/when
    # added) keep working.
    raw_scores = reranker.predict(pairs)
    scores = [_sigmoid(float(s)) for s in raw_scores]

    scored = []
    for chunk, score in zip(chunks, scores):
        annotated = {**chunk, "rerank_score": score}
        scored.append(annotated)

    scored.sort(key=lambda c: c["rerank_score"], reverse=True)
    return scored[:top_k]
