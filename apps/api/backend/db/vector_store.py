"""pgvector-backed vector store for RAG document indexing and similarity search.

This module is the storage adapter for the RAG pipeline. It chunks fetched
content (via callers in rag_pipeline.py) and persists the resulting passages
to two tables:

- ``page_chunks``: one row per retrieval unit (passage), with FK to the
  canonical ``page_content`` row that sourced it.
- ``chunk_embeddings``: one embedding per chunk per model, keyed on
  ``page_chunk_id``.

Prior to 2026-04-04 this module wrote chunks directly into ``page_content``
by synthesizing ``#chunk-{hash}`` URL fragments to work around the URL
UNIQUE constraint. That approach conflated "canonical page" with "chunk"
and blocked the normalized_url migration in Plan 04. See Plan 02 for the
full history.
"""

import hashlib
import logging
from typing import Optional

from backend.db import embedding_repo
from backend.db.connection import get_conn

logger = logging.getLogger(__name__)

SBERT_MODEL_NAME = "all-MiniLM-L6-v2"


class VectorStore:
    """pgvector vector store with cosine similarity search over RAG chunks."""

    def __init__(self, collection_name: str = "default", **kwargs):
        """Initialize the vector store.

        ``collection_name`` is accepted for API compatibility with the
        historical ChromaDB-based interface, but is not used — all chunk
        embeddings live in the single ``chunk_embeddings`` table.
        """
        self._sbert_model = None
        self._doc_count = 0

    def _get_sbert_model(self):
        if self._sbert_model is None:
            from backend.services.sbert_loader import get_sbert_model

            self._sbert_model = get_sbert_model()
        return self._sbert_model

    def _encode(self, text: str) -> list[float]:
        """Encode a single text string to a normalized embedding vector."""
        import numpy as np

        model = self._get_sbert_model()
        emb = model.encode([text], show_progress_bar=False)[0]
        emb = emb / np.linalg.norm(emb)
        return emb.tolist()

    async def add_documents(
        self,
        documents: list[str],
        metadatas: list[dict],
        ids: Optional[list[str]] = None,
    ) -> list[str]:
        """Embed documents (chunks) and persist to page_chunks + chunk_embeddings.

        Each document becomes one ``page_chunks`` row plus one
        ``chunk_embeddings`` row. The parent ``page_content`` row is
        resolved (or created) from ``metadata["source_url"]``. If the
        metadata dict lacks a ``source_url``, the document is treated as
        synthetic and a ``chunk://<chunk_id>`` placeholder is used.

        Returns list of chunk IDs (string form of page_chunk_id for
        backward compatibility with the historical interface that used
        12-char md5 hashes). Callers that need the stable deterministic
        hash can still compute it from source_url+chunk_index themselves.
        """
        if not documents:
            return []

        if ids is None:
            ids = [hashlib.md5(d.encode()).hexdigest()[:12] for d in documents]

        import numpy as np
        from backend.db import content_repo

        model = self._get_sbert_model()
        embeddings = model.encode(documents, show_progress_bar=False, batch_size=32)
        embeddings = embeddings / np.linalg.norm(embeddings, axis=1, keepdims=True)

        returned_ids: list[str] = []

        for i, doc in enumerate(documents):
            meta = metadatas[i] if i < len(metadatas) else {}
            source_url = meta.get("source_url") or f"chunk://{ids[i]}"
            source_title = meta.get("source_title", "") or ""
            section_title = meta.get("section_title", "") or None
            token_count = meta.get("token_count")

            # Resolve or create the canonical page_content row for the
            # source URL. The backfill semantics from Plan 01 ensure the
            # richer ``content_summary`` / ``tool_selected`` from any
            # future visit will update the canonical row appropriately.
            canonical = content_repo.get_or_create_content(
                source_url,
                content_summary=source_title or None,
            )

            # Insert the page_chunks row. Use the next sequential
            # chunk_index for this parent — multiple chunks per source
            # URL are the common case.
            page_chunk_id = _insert_page_chunk(
                page_content_id=canonical["id"],
                chunk_text=doc,
                section_title=section_title,
                token_count=token_count,
            )

            # Save the chunk embedding.
            embedding_repo.save_chunk_embedding(
                page_chunk_id=page_chunk_id,
                embedding=embeddings[i].tolist(),
            )

            returned_ids.append(str(page_chunk_id))

        self._doc_count += len(documents)
        return returned_ids

    async def query(
        self,
        query_text: str,
        n_results: int = 5,
        where: Optional[dict] = None,
    ) -> dict:
        """Query for similar chunks via pgvector cosine similarity.

        Returns a ChromaDB-compatible dict shape so existing callers (the
        CompendiumAgent search tool, any historical code) continue to work
        without changes:
        ``{ids: [[...]], documents: [[...]], metadatas: [[...]], distances: [[...]]}``

        The ``source_url`` in the returned metadata is now the clean
        canonical URL (no ``#chunk-`` suffix to strip) because chunks no
        longer abuse the URL field.
        """
        query_emb = self._encode(query_text)
        results = embedding_repo.find_similar_chunks(query_emb, top_k=n_results)

        # Filter by source_url if a ``where`` clause was provided. Kept
        # for ChromaDB API compatibility with older callers.
        if where and "source_url" in where:
            filter_val = where["source_url"]
            if isinstance(filter_val, dict) and "$in" in filter_val:
                allowed = list(filter_val["$in"])
                results = [r for r in results if r["url"] in allowed]
            elif isinstance(filter_val, str):
                results = [r for r in results if r["url"] == filter_val]

        ids = [[str(r["page_chunk_id"]) for r in results]]
        documents = [[r.get("chunk_text", "") or "" for r in results]]
        metadatas = [
            [
                {
                    "source_url": r["url"],
                    "source_title": "",
                    "section_title": r.get("section_title") or "",
                    "domain": r.get("domain", ""),
                    "page_content_id": r.get("page_content_id"),
                }
                for r in results
            ]
        ]
        distances = [[r["distance"] for r in results]]

        return {
            "ids": ids,
            "documents": documents,
            "metadatas": metadatas,
            "distances": distances,
        }

    async def delete(self, ids: list[str]) -> None:
        """Delete chunks (and their embeddings) by page_chunk_id.

        Cascade: deleting a page_chunks row automatically cascades to
        chunk_embeddings via the FK ON DELETE CASCADE.
        """
        if not ids:
            return
        # ids may be str-form of page_chunk_id (from add_documents), or
        # the legacy 12-char md5 hashes. We only support the new form.
        try:
            chunk_ids = [int(cid) for cid in ids]
        except ValueError:
            logger.warning(f"VectorStore.delete: received non-integer ids, ignoring: {ids}")
            return
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM page_chunks WHERE id = ANY(%s)",
                    (chunk_ids,),
                )

    def reset(self) -> None:
        """Delete all chunks and their embeddings.

        Only touches the chunk tables — page-level embeddings used by
        clustering are preserved.
        """
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM chunk_embeddings")
                cur.execute("DELETE FROM page_chunks")
        self._doc_count = 0

    @property
    def count(self) -> int:
        """Number of chunks currently in the store."""
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT COUNT(*) FROM page_chunks")
                return cur.fetchone()[0]


# =============================================================================
# Internal helpers
# =============================================================================


def _insert_page_chunk(
    page_content_id: int,
    chunk_text: str,
    section_title: Optional[str],
    token_count: Optional[int],
) -> int:
    """Insert a page_chunks row, auto-assigning the next chunk_index.

    Returns the new page_chunks.id.
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            # Determine next chunk_index for this parent (max + 1).
            cur.execute(
                "SELECT COALESCE(MAX(chunk_index) + 1, 0) FROM page_chunks "
                "WHERE page_content_id = %s",
                (page_content_id,),
            )
            next_idx = cur.fetchone()[0]

            cur.execute(
                """
                INSERT INTO page_chunks
                    (page_content_id, chunk_index, chunk_text, section_title, token_count)
                VALUES (%s, %s, %s, %s, %s)
                RETURNING id
                """,
                (page_content_id, next_idx, chunk_text, section_title, token_count),
            )
            return cur.fetchone()[0]
