"""Process-wide singleton for the all-MiniLM-L6-v2 SentenceTransformer.

Loading the model takes ~1.5s and emits a noisy log line each time. The
model itself is stateless and thread-safe for `.encode()` calls, so a
single shared instance is enough for the whole process.

Three call sites previously each instantiated the model lazily but
independently (vector_store, clustering_service, agent). With a startup
sweep that processes captures in series, that meant 5+ reloads in a
30-second window. Centralizing here cuts that to one load per process.
"""

from __future__ import annotations

import logging
import threading
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from sentence_transformers import SentenceTransformer

SBERT_MODEL_NAME = "all-MiniLM-L6-v2"

_model: "SentenceTransformer | None" = None
_lock = threading.Lock()
logger = logging.getLogger(__name__)


def get_sbert_model() -> "SentenceTransformer":
    """Return the shared SentenceTransformer instance, loading it on first use."""
    global _model
    if _model is None:
        with _lock:
            if _model is None:  # double-checked locking
                from sentence_transformers import SentenceTransformer

                logger.info(f"Loading shared SBERT model: {SBERT_MODEL_NAME}")
                _model = SentenceTransformer(SBERT_MODEL_NAME)
    return _model
