"""RAG (Retrieval-Augmented Generation) pipeline.

Content-aware document chunking, vector storage, and retrieval. Chunking
strategies extracted from notebooks/07_01_historical_browsing_analysis.ipynb
(validated on 2,216 chunks across 7 content types).

Use cases:
  1. RAG-enhanced compendium search / chatbot (planned)
  2. Cross-session knowledge retrieval
  3. Cluster identification support
"""

import hashlib
import logging
from typing import Callable, Optional
from urllib.parse import urlparse

from pydantic import BaseModel

from backend.db.vector_store import VectorStore

logger = logging.getLogger(__name__)


# =============================================================================
# Models
# =============================================================================


class DocumentChunk(BaseModel):
    """A chunk of document content for embedding."""

    chunk_id: str
    source_url: str
    source_title: str
    section_title: Optional[str]
    content: str
    token_count: int


class RetrievalResult(BaseModel):
    """Result from a similarity search."""

    chunk: DocumentChunk
    similarity_score: float


# =============================================================================
# Content-aware chunking (extracted from 07_01 notebook)
# =============================================================================


def _estimate_tokens(text: str) -> int:
    """Approximate token count: words / 0.75."""
    return int(len(text.split()) / 0.75)


def _make_chunk(
    source_url: str,
    source_title: str,
    section_title: str | None,
    content: str,
    chunk_idx: int,
) -> dict:
    """Create a DocumentChunk-compatible dict with MD5-based ID."""
    chunk_id = hashlib.md5(f"{source_url}:{chunk_idx}".encode()).hexdigest()[:12]
    return {
        "chunk_id": chunk_id,
        "source_url": source_url,
        "source_title": source_title,
        "section_title": section_title,
        "content": content.strip(),
        "token_count": _estimate_tokens(content),
    }


# Boilerplate MediaWiki sections that cluster by article structure, not topic.
STRUCTURAL_SECTIONS = {
    "external links",
    "see also",
    "references",
    "further reading",
    "notes",
    "bibliography",
    "sources",
    "citations",
    "works cited",
    "selected publications",
    "published works",
}


def chunk_wikipedia(url: str, data: dict) -> list[dict]:
    """One chunk per section, prepend article title for context.
    Skips structural/boilerplate sections that poison topic clustering."""
    title = data.get("title", "")
    chunks = []
    for i, section in enumerate(data.get("sections", [])):
        if section["title"].strip().lower() in STRUCTURAL_SECTIONS:
            continue
        text = section.get("content", "").strip()
        if len(text) < 50:
            continue
        content = f"{title} — {section['title']}\n\n{text}"
        chunks.append(_make_chunk(url, title, section["title"], content, i))
    if not chunks and data.get("summary"):
        chunks.append(_make_chunk(url, title, None, f"{title}\n\n{data['summary']}", 0))
    return chunks


def chunk_youtube(url: str, data: dict) -> list[dict]:
    """Chunk transcript by ~500-word windows with 50-word overlap."""
    title = data.get("title", "")
    transcript = data.get("transcript")
    if not transcript:
        desc = data.get("description", "")
        text = f"{title}\n\n{desc}".strip()
        if len(text) < 20:
            return []
        return [_make_chunk(url, title, None, text, 0)]

    words = transcript.split()
    window, overlap = 500, 50
    chunks = []
    for i, start in enumerate(range(0, len(words), window - overlap)):
        segment = " ".join(words[start : start + window])
        if len(segment) < 50:
            continue
        chunks.append(_make_chunk(url, title, f"transcript_segment_{i}", segment, i))
    return chunks


def chunk_stackoverflow(url: str, data: dict) -> list[dict]:
    """One chunk for question body, one for top answer.

    HTML stripping happens in ``StackOverflowQuestion.get_primary_text``
    (the fetcher owns domain-specific cleanup). We call into it to get a
    single clean string, then split on the ``--- Top Answer ---`` marker
    to produce two chunks for finer-grained retrieval.
    """
    from backend.services.content_fetcher import _strip_html

    title = data.get("title", "")
    chunks: list[dict] = []

    # Question body (first chunk). Use the fetcher's strip helper to keep
    # cleanup logic in one place.
    body = data.get("body", "")
    if len(body) > 50:
        clean_body = _strip_html(body)
        if clean_body:
            chunks.append(_make_chunk(url, title, "question", f"{title}\n\n{clean_body}", 0))

    # Top answer (second chunk) if present.
    answer = data.get("top_answer", "")
    if answer and len(answer) > 50:
        clean_answer = _strip_html(answer)
        if clean_answer:
            chunks.append(_make_chunk(url, title, "top_answer", clean_answer, 1))

    return chunks


def chunk_reddit(url: str, data: dict) -> list[dict]:
    """Reddit posts: title + selftext + top comments as one or more chunks.

    Short posts (most of Reddit) emit a single chunk. Long posts (rare —
    AskHistorians-style deep dives, multi-paragraph selftexts) split via
    the generic paragraph-merge path so retrieval can target a specific
    section of the discussion.

    Previously there was no Reddit chunker and ``_detect_chunker`` fell
    through to ``chunk_generic``, which looked for ``text``/``summary``/
    ``abstract`` keys that Reddit doesn't emit — every Reddit page produced
    zero chunks and was invisible to search. Fixed here.
    """
    from backend.services.content_fetcher import RedditContent

    try:
        content = RedditContent.model_validate(data)
    except Exception:
        return []

    full_text = content.get_primary_text()
    if not full_text or len(full_text) < 50:
        return []

    # Short path: single chunk.
    words = full_text.split()
    if len(words) <= 500:
        return [_make_chunk(url, content.title, None, full_text, 0)]

    # Long path: split into ~500-word chunks, preserve paragraph boundaries.
    paragraphs = [p.strip() for p in full_text.split("\n") if p.strip()]
    chunks: list[dict] = []
    current: list[str] = []
    current_words = 0
    for para in paragraphs:
        para_words = len(para.split())
        if current_words + para_words > 500 and current:
            chunks.append(_make_chunk(url, content.title, None, "\n\n".join(current), len(chunks)))
            current = [para]
            current_words = para_words
        else:
            current.append(para)
            current_words += para_words
    if current:
        chunks.append(_make_chunk(url, content.title, None, "\n\n".join(current), len(chunks)))
    return chunks


def chunk_arxiv(url: str, data: dict) -> list[dict]:
    """Abstract as one chunk."""
    title = data.get("title", "")
    abstract = data.get("abstract", "")
    if len(abstract) < 50:
        return []
    return [_make_chunk(url, title, "abstract", f"{title}\n\n{abstract}", 0)]


def chunk_generic(url: str, data: dict) -> list[dict]:
    """Split by paragraphs, merge short ones until ~500 words.

    Routes through ``get_primary_text_from_dict`` so fetchers without a
    dedicated chunker (future domains, edge cases) still benefit from the
    fetcher-owned text contract. Falls back to the legacy key chain only
    when ``tool_selected`` is unknown.
    """
    from backend.services.content_fetcher import get_primary_text_from_dict

    title = data.get("title", "")
    # No tool_selected here — rag_pipeline is called per-URL during Stage 0
    # where the tool name isn't threaded through. get_primary_text_from_dict
    # falls through to its key-scan when tool_selected is None, which is
    # exactly what chunk_generic used to do manually.
    text, source = get_primary_text_from_dict(None, data)
    if not text or len(text) < 50:
        return []
    logger.debug(f"chunk_generic: url={url} text_source={source}")

    paragraphs = [p.strip() for p in text.split("\n") if p.strip()]
    chunks: list[dict] = []
    current: list[str] = []
    current_words = 0

    for para in paragraphs:
        para_words = len(para.split())
        if current_words + para_words > 500 and current:
            chunks.append(_make_chunk(url, title, None, "\n\n".join(current), len(chunks)))
            current = [para]
            current_words = para_words
        else:
            current.append(para)
            current_words += para_words

    if current:
        chunks.append(_make_chunk(url, title, None, "\n\n".join(current), len(chunks)))

    return chunks


# Domain → chunker mapping (mirrors DOMAIN_TO_FETCHER in main.py)
CHUNKER_MAP: dict[str, Callable] = {
    "wikipedia.org": chunk_wikipedia,
    "youtube.com": chunk_youtube,
    "youtu.be": chunk_youtube,
    "stackoverflow.com": chunk_stackoverflow,
    "arxiv.org": chunk_arxiv,
    "reddit.com": chunk_reddit,
}


def _detect_chunker(url: str) -> Callable:
    """Match URL hostname to the appropriate chunker function."""
    hostname = urlparse(url).hostname or ""
    for domain_key, chunker in CHUNKER_MAP.items():
        if domain_key in hostname:
            return chunker
    return chunk_generic


# =============================================================================
# RAG Pipeline
# =============================================================================


class RAGPipeline:
    """RAG pipeline for grounding LLM responses in retrieved content.

    Indexes page content as embeddings in pgvector for semantic retrieval.
    Used for RAG-enhanced search and future chatbot queries.
    """

    def __init__(
        self,
        collection_name: str = "traversal_documents",
        persist_dir: str | None = None,
    ):
        """Initialize the RAG pipeline with a VectorStore backend."""
        self.store = VectorStore(collection_name=collection_name)

    async def add_document(
        self,
        url: str,
        content_dict: dict,
        metadata: dict | None = None,
    ) -> list[str]:
        """Chunk a fetched content dict and store embeddings.

        Args:
            url: Source URL of the page.
            content_dict: Raw content dict from a content fetcher.
            metadata: Extra metadata to attach to each chunk.

        Returns:
            List of chunk IDs that were stored.
        """
        chunker = _detect_chunker(url)
        chunks = chunker(url, content_dict)
        if not chunks:
            logger.debug(f"No chunks produced for {url}")
            return []

        documents = [c["content"] for c in chunks]
        ids = [c["chunk_id"] for c in chunks]
        metadatas = [
            {
                "source_url": c["source_url"],
                "source_title": c["source_title"],
                "section_title": c.get("section_title") or "",
                "token_count": c["token_count"],
                **(metadata or {}),
            }
            for c in chunks
        ]

        await self.store.add_documents(documents=documents, metadatas=metadatas, ids=ids)
        logger.info(f"Indexed {len(chunks)} chunks from {url}")
        return ids

    async def retrieve(
        self,
        query: str,
        top_k: int = 5,
        filter_urls: list[str] | None = None,
    ) -> list[RetrievalResult]:
        """Retrieve relevant chunks for a query.

        Args:
            query: Search query text.
            top_k: Number of results.
            filter_urls: If set, only return chunks from these source URLs.

        Returns:
            List of RetrievalResult sorted by similarity (highest first).
        """
        where = None
        if filter_urls:
            if len(filter_urls) == 1:
                where = {"source_url": filter_urls[0]}
            else:
                where = {"source_url": {"$in": filter_urls}}

        results = await self.store.query(
            query_text=query,
            n_results=top_k,
            where=where,
        )

        retrieval_results = []
        for i, doc_id in enumerate(results["ids"][0]):
            meta = results["metadatas"][0][i]
            distance = results["distances"][0][i]
            # pgvector cosine distance: 0 = identical, 1 = orthogonal
            similarity = 1.0 - distance

            chunk = DocumentChunk(
                chunk_id=doc_id,
                source_url=meta.get("source_url", ""),
                source_title=meta.get("source_title", ""),
                section_title=meta.get("section_title") or None,
                content=results["documents"][0][i],
                token_count=meta.get("token_count", 0),
            )
            retrieval_results.append(RetrievalResult(chunk=chunk, similarity_score=similarity))

        return retrieval_results
