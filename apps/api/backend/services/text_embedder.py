"""Embed short free-text strings (subtopic labels) for the shelf service.

Routes on ``settings.clustering_embedding_model`` the same way the clustering
service does: ``text-embedding-*`` goes to the OpenAI embeddings API, anything
else to the shared local SBERT model. Rows are L2-normalised so a dot product
is a cosine.
"""

from __future__ import annotations

import logging

import numpy as np

from backend.config.settings import settings

logger = logging.getLogger(__name__)

OPENAI_EMBED_BATCH_SIZE = 512
OPENAI_TIMEOUT_S = 30.0
OPENAI_EMBED_PRICE_PER_MTOK = {
    "text-embedding-3-small": 0.02,
    "text-embedding-3-large": 0.13,
}


def embedder_key() -> str:
    """Name of the embedder in use (stored on shelves.embedder_key)."""
    return settings.clustering_embedding_model


def _normalise(mat: np.ndarray) -> np.ndarray:
    mat = np.asarray(mat, dtype=np.float64)
    norms = np.linalg.norm(mat, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return mat / norms


def _embed_openai(texts: list[str], model: str, user_id: int | None) -> np.ndarray:
    from openai import OpenAI

    client = OpenAI(api_key=settings.openai_api_key, timeout=OPENAI_TIMEOUT_S, max_retries=1)
    vectors: list[list[float]] = []
    total_tokens = 0
    for start in range(0, len(texts), OPENAI_EMBED_BATCH_SIZE):
        chunk = texts[start : start + OPENAI_EMBED_BATCH_SIZE]
        resp = client.embeddings.create(model=model, input=chunk)
        for item in sorted(resp.data, key=lambda d: d.index):
            vectors.append(item.embedding)
        total_tokens += resp.usage.total_tokens
    if user_id is not None:
        cost = total_tokens / 1_000_000 * OPENAI_EMBED_PRICE_PER_MTOK.get(model, 0.02)
        try:
            from backend.db import trends_repo

            trends_repo.insert_cost_event(
                user_id=user_id,
                event_type="shelf_embedding",
                model=model,
                input_tokens=total_tokens,
                cost_usd=cost,
                metadata={"strings": len(texts)},
            )
        except Exception:
            logger.debug("shelf embedding cost event insert failed", exc_info=True)
    return np.asarray(vectors, dtype=np.float64)


def _embed_sbert(texts: list[str]) -> np.ndarray:
    from backend.services.sbert_loader import get_sbert_model

    return np.asarray(get_sbert_model().encode(texts, show_progress_bar=False), dtype=np.float64)


def embed_texts(texts: list[str], user_id: int | None = None) -> np.ndarray:
    """Return an ``(len(texts), dim)`` matrix of L2-normalised embeddings."""
    if not texts:
        return np.zeros((0, 0), dtype=np.float64)
    model = settings.clustering_embedding_model
    if model.startswith("text-embedding-"):
        raw = _embed_openai(list(texts), model, user_id)
    else:
        raw = _embed_sbert(list(texts))
    return _normalise(raw)
