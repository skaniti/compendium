"""Tests for RAG pipeline components.

Milestone 7: Validate chunking logic, VectorStore operations,
and retrieval with filtering.

Chunking tests are pure (no API calls). VectorStore/RAG tests require
OpenAI API key for embeddings and are skipped if unavailable.
"""

import pytest

from backend.config.settings import settings
from backend.services.rag_pipeline import (
    DocumentChunk,
    RAGPipeline,
    chunk_arxiv,
    chunk_generic,
    chunk_stackoverflow,
    chunk_wikipedia,
    chunk_youtube,
    _make_chunk,
)

has_openai = bool(settings.openai_api_key)


# =============================================================================
# Chunking tests (pure, no API calls)
# =============================================================================


class TestChunkWikipedia:
    def test_basic_sections(self):
        data = {
            "title": "Python (programming language)",
            "sections": [
                {
                    "title": "History",
                    "content": "Python was conceived in the late 1980s " * 10,
                },
                {
                    "title": "Design philosophy",
                    "content": "Python is a multi-paradigm language " * 10,
                },
            ],
        }
        chunks = chunk_wikipedia("https://en.wikipedia.org/wiki/Python", data)
        assert len(chunks) == 2
        assert chunks[0]["source_title"] == "Python (programming language)"
        assert chunks[0]["section_title"] == "History"
        assert "Python (programming language) — History" in chunks[0]["content"]

    def test_skips_structural_sections(self):
        data = {
            "title": "Test Article",
            "sections": [
                {"title": "Introduction", "content": "Some real content here " * 10},
                {"title": "See also", "content": "Link1, Link2 " * 10},
                {"title": "References", "content": "Ref1, Ref2 " * 10},
                {"title": "External links", "content": "http://example.com " * 10},
            ],
        }
        chunks = chunk_wikipedia("https://en.wikipedia.org/wiki/Test", data)
        assert len(chunks) == 1
        assert chunks[0]["section_title"] == "Introduction"

    def test_fallback_to_summary(self):
        data = {"title": "Stub Article", "summary": "A brief stub article summary " * 5}
        chunks = chunk_wikipedia("https://en.wikipedia.org/wiki/Stub", data)
        assert len(chunks) == 1
        assert "Stub Article" in chunks[0]["content"]

    def test_skips_short_sections(self):
        data = {
            "title": "Test",
            "sections": [{"title": "Tiny", "content": "Short."}],
        }
        chunks = chunk_wikipedia("https://en.wikipedia.org/wiki/Test", data)
        assert len(chunks) == 0


class TestChunkYouTube:
    def test_transcript_windowing(self):
        # Create a transcript longer than 500 words
        transcript = " ".join(f"word{i}" for i in range(1200))
        data = {"title": "Test Video", "transcript": transcript}
        chunks = chunk_youtube("https://youtube.com/watch?v=abc", data)
        assert len(chunks) >= 2
        assert chunks[0]["section_title"] == "transcript_segment_0"

    def test_no_transcript_uses_description(self):
        data = {"title": "Test Video", "description": "A video about testing " * 5}
        chunks = chunk_youtube("https://youtube.com/watch?v=abc", data)
        assert len(chunks) == 1
        assert "Test Video" in chunks[0]["content"]

    def test_no_content_returns_empty(self):
        data = {"title": "X"}
        chunks = chunk_youtube("https://youtube.com/watch?v=abc", data)
        assert len(chunks) == 0


class TestChunkStackOverflow:
    def test_question_and_answer(self):
        data = {
            "title": "How to parse JSON in Python?",
            "body": "<p>I need to parse a JSON string in Python.</p> " * 5,
            "top_answer": "<p>Use the json module: json.loads(s)</p> " * 5,
        }
        chunks = chunk_stackoverflow("https://stackoverflow.com/questions/123", data)
        assert len(chunks) == 2
        # HTML should be stripped
        assert "<p>" not in chunks[0]["content"]


class TestChunkArxiv:
    def test_abstract(self):
        data = {
            "title": "Attention Is All You Need",
            "abstract": "The dominant sequence transduction models " * 10,
        }
        chunks = chunk_arxiv("https://arxiv.org/abs/1706.03762", data)
        assert len(chunks) == 1
        assert chunks[0]["section_title"] == "abstract"


class TestChunkGeneric:
    def test_paragraph_merging(self):
        text = "\n".join(f"Paragraph {i} with enough words to matter. " * 5 for i in range(20))
        data = {"title": "Generic Page", "text": text}
        chunks = chunk_generic("https://example.com/page", data)
        assert len(chunks) >= 1
        assert all(c["token_count"] > 0 for c in chunks)


class TestMakeChunk:
    def test_deterministic_id(self):
        c1 = _make_chunk("http://a.com", "Title", None, "content", 0)
        c2 = _make_chunk("http://a.com", "Title", None, "content", 0)
        assert c1["chunk_id"] == c2["chunk_id"]

    def test_different_index_different_id(self):
        c1 = _make_chunk("http://a.com", "Title", None, "content", 0)
        c2 = _make_chunk("http://a.com", "Title", None, "content", 1)
        assert c1["chunk_id"] != c2["chunk_id"]

    def test_validates_as_document_chunk(self):
        c = _make_chunk("http://a.com", "Title", "Section", "content here " * 10, 0)
        doc = DocumentChunk(**c)
        assert doc.chunk_id == c["chunk_id"]
        assert doc.token_count > 0


# =============================================================================
# VectorStore + RAG tests (require OpenAI API key for embeddings)
# =============================================================================


@pytest.mark.skipif(not has_openai, reason="OpenAI API key not configured")
class TestVectorStore:
    @pytest.fixture
    def store(self, tmp_path):
        from backend.db.vector_store import VectorStore

        s = VectorStore(collection_name="test_collection", persist_dir=str(tmp_path))
        s.reset()
        yield s
        s.reset()

    @pytest.mark.asyncio
    async def test_add_and_query(self, store):
        ids = await store.add_documents(
            documents=[
                "Python is a programming language",
                "Cats are furry animals",
                "Machine learning uses data",
            ],
            metadatas=[
                {"source_url": "test://programming"},
                {"source_url": "test://animals"},
                {"source_url": "test://ml"},
            ],
        )
        assert len(ids) == 3
        assert store.count == 3

        results = await store.query("coding in Python", n_results=2)
        assert len(results["ids"][0]) == 2
        # The Python doc should be most similar
        assert results["metadatas"][0][0]["source_url"] == "test://programming"

    @pytest.mark.asyncio
    async def test_delete(self, store):
        # After Plan 02, chunks are keyed on page_chunks.id (integer), not
        # user-supplied string IDs. add_documents returns the new IDs as
        # stringified integers; delete() accepts that form.
        ids = await store.add_documents(
            documents=["doc one", "doc two"],
            metadatas=[{"source_url": "test://doc1"}, {"source_url": "test://doc2"}],
        )
        assert store.count == 2
        assert len(ids) == 2
        await store.delete([ids[0]])
        assert store.count == 1

    @pytest.mark.asyncio
    async def test_reset(self, store):
        await store.add_documents(documents=["test"], metadatas=[{"k": "v"}])
        assert store.count == 1
        store.reset()
        assert store.count == 0


@pytest.mark.skipif(not has_openai, reason="OpenAI API key not configured")
class TestRAGPipeline:
    @pytest.fixture
    def rag(self, tmp_path):
        pipeline = RAGPipeline(collection_name="test_rag", persist_dir=str(tmp_path))
        pipeline.store.reset()
        yield pipeline
        pipeline.store.reset()

    @pytest.mark.asyncio
    async def test_add_and_retrieve_wikipedia(self, rag):
        wiki_data = {
            "title": "Neural network",
            "sections": [
                {
                    "title": "Overview",
                    "content": "A neural network is a machine learning model " * 15,
                },
                {
                    "title": "History",
                    "content": "Neural networks were first proposed in the 1940s " * 15,
                },
            ],
        }
        ids = await rag.add_document(
            "https://en.wikipedia.org/wiki/Neural_network",
            wiki_data,
        )
        assert len(ids) == 2

        results = await rag.retrieve("machine learning models", top_k=2)
        assert len(results) == 2
        # The "Overview" section (about ML models) should rank above "History" (about 1940s)
        assert results[0].similarity_score > results[1].similarity_score
        assert results[0].similarity_score > 0.2

    @pytest.mark.asyncio
    async def test_retrieve_with_filter(self, rag):
        wiki1 = {
            "title": "Python",
            "sections": [{"title": "Intro", "content": "Python is a programming language " * 15}],
        }
        wiki2 = {
            "title": "Java",
            "sections": [{"title": "Intro", "content": "Java is a programming language " * 15}],
        }
        url1 = "https://en.wikipedia.org/wiki/Python"
        url2 = "https://en.wikipedia.org/wiki/Java"
        await rag.add_document(url1, wiki1)
        await rag.add_document(url2, wiki2)

        # Filter to only Python page
        results = await rag.retrieve("programming", top_k=5, filter_urls=[url1])
        assert all(r.chunk.source_url == url1 for r in results)
