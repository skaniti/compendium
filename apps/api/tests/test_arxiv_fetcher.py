"""Tests for the arXiv fetcher's full-paper extraction (Phase 1).

Covers:
  - ArxivPaper extension fields (body_text, sections, extraction_method,
    extraction_warnings)
  - get_primary_text fallback chain (body -> title+abstract)
  - fetch_arxiv_html_render HTTP behavior (200 / 404 / redirect chain)
  - fetch_arxiv_paper end-to-end with mocked Atom + ar5iv responses
"""

from pathlib import Path

import httpx
import pytest

from backend.services.arxiv_html_parser import Section
from backend.services.content_fetcher import ArxivPaper


FIXTURES = Path(__file__).parent / "fixtures" / "arxiv"


def _make_paper(
    *,
    body_text: str | None = None,
    sections: list[Section] | None = None,
    extraction_method: str = "abstract_only",
    extraction_warnings: list[str] | None = None,
) -> ArxivPaper:
    return ArxivPaper(
        url="https://arxiv.org/abs/2104.08821",
        paper_id="2104.08821",
        title="SimCSE: Simple Contrastive Learning of Sentence Embeddings",
        abstract="A short abstract about contrastive sentence embeddings.",
        authors=["Tianyu Gao", "Xingcheng Yao", "Danqi Chen"],
        categories=["cs.CL"],
        published="2021-04-18T00:00:00Z",
        pdf_url="https://arxiv.org/pdf/2104.08821",
        body_text=body_text,
        sections=sections,
        extraction_method=extraction_method,  # type: ignore[arg-type]
        extraction_warnings=extraction_warnings or [],
    )


class TestArxivPaperExtensionFields:
    def test_accepts_extraction_fields(self):
        paper = _make_paper(
            body_text="The full body text.",
            sections=[Section(name="Introduction", level=1, text="Intro paragraph.")],
            extraction_method="ar5iv",
            extraction_warnings=[],
        )
        assert paper.body_text == "The full body text."
        sections = paper.sections
        assert sections is not None
        assert sections[0].name == "Introduction"
        assert paper.extraction_method == "ar5iv"
        assert paper.extraction_warnings == []

    def test_defaults_to_abstract_only(self):
        # Backward-compat: existing call sites that don't pass the new
        # fields still construct a valid ArxivPaper, defaulted to the
        # abstract-only path.
        paper = _make_paper()
        assert paper.body_text is None
        assert paper.sections is None
        assert paper.extraction_method == "abstract_only"
        assert paper.extraction_warnings == []


class TestArxivPaperGetPrimaryText:
    def test_prefers_body_text_when_populated(self):
        paper = _make_paper(
            body_text="Full body content with methods and results.",
            extraction_method="ar5iv",
        )
        text = paper.get_primary_text()
        assert "Full body content" in text
        assert paper.title in text
        # When body is populated, the abstract is NOT included (body
        # supersedes — RAG indexes the richer signal).
        assert paper.abstract not in text

    def test_falls_back_to_abstract_when_body_missing(self):
        paper = _make_paper()  # no body_text
        text = paper.get_primary_text()
        assert paper.title in text
        assert paper.abstract in text


class TestFetchArxivHtmlRender:
    @pytest.mark.asyncio
    async def test_returns_html_on_200(self):
        from backend.services.content_fetcher import fetch_arxiv_html_render

        fixture_html = (FIXTURES / "2104.08821.html").read_text(encoding="utf-8")
        captured_urls: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            captured_urls.append(str(request.url))
            return httpx.Response(200, content=fixture_html.encode("utf-8"))

        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=transport) as client:
            result = await fetch_arxiv_html_render("2104.08821", client)

        assert result is not None
        assert len(result) > 100_000
        assert "ar5iv.labs.arxiv.org/html/2104.08821" in captured_urls[0]

    @pytest.mark.asyncio
    async def test_returns_none_on_404(self):
        from backend.services.content_fetcher import fetch_arxiv_html_render

        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(404)

        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=transport) as client:
            result = await fetch_arxiv_html_render("0001.00001", client)

        assert result is None

    @pytest.mark.asyncio
    async def test_returns_none_on_network_error(self):
        from backend.services.content_fetcher import fetch_arxiv_html_render

        def handler(_request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("simulated connection failure")

        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=transport) as client:
            result = await fetch_arxiv_html_render("2104.08821", client)

        assert result is None


class TestFetchArxivPaperEndToEnd:
    """End-to-end integration with mocked Atom + ar5iv responses."""

    _ATOM_XML = b"""<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>SimCSE: Simple Contrastive Learning of Sentence Embeddings</title>
    <summary>An abstract about contrastive sentence embeddings.</summary>
    <published>2021-04-18T00:00:00Z</published>
    <author><name>Tianyu Gao</name></author>
    <author><name>Xingcheng Yao</name></author>
    <author><name>Danqi Chen</name></author>
    <category term="cs.CL"/>
  </entry>
</feed>"""

    @pytest.mark.asyncio
    async def test_populates_body_when_ar5iv_succeeds(self):
        from backend.services.content_fetcher import fetch_arxiv_paper

        fixture_html = (FIXTURES / "2104.08821.html").read_text(encoding="utf-8")

        def handler(request: httpx.Request) -> httpx.Response:
            url = str(request.url)
            if "export.arxiv.org" in url:
                return httpx.Response(200, content=self._ATOM_XML)
            if "ar5iv.labs.arxiv.org" in url:
                return httpx.Response(200, content=fixture_html.encode("utf-8"))
            return httpx.Response(404)

        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=transport) as client:
            paper = await fetch_arxiv_paper(
                "https://arxiv.org/abs/2104.08821",
                client=client,
            )

        assert paper.extraction_method == "ar5iv"
        assert paper.body_text is not None and len(paper.body_text) > 10_000
        sections = paper.sections
        assert sections is not None and len(sections) > 0
        # get_primary_text should return body, not abstract
        primary = paper.get_primary_text()
        assert "abstract" not in primary.lower()[:200] or len(primary) > 10_000

    @pytest.mark.asyncio
    async def test_abstract_only_when_ar5iv_and_pdf_both_fail(self):
        from backend.services.content_fetcher import fetch_arxiv_paper

        captured_urls: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            url = str(request.url)
            captured_urls.append(url)
            if "export.arxiv.org" in url:
                return httpx.Response(200, content=self._ATOM_XML)
            return httpx.Response(404)  # ar5iv 404 AND pdf 404

        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=transport) as client:
            paper = await fetch_arxiv_paper(
                "https://arxiv.org/abs/2104.08821",
                client=client,
            )

        assert paper.extraction_method == "abstract_only"
        assert paper.body_text is None
        assert paper.sections is None
        # Both ar5iv and pdf fetches were attempted and both failed
        assert any("ar5iv.labs.arxiv.org" in u for u in captured_urls)
        assert any("arxiv.org/pdf" in u for u in captured_urls)
        # Warnings name both fallthrough reasons
        joined = " ".join(paper.extraction_warnings).lower()
        assert "ar5iv" in joined and "pdf" in joined

    @pytest.mark.asyncio
    async def test_falls_back_to_pdf_when_ar5iv_unavailable(self):
        # Slow: triggers Docling PDF conversion (cached after first call).
        from backend.services.content_fetcher import fetch_arxiv_paper

        pdf_bytes = (FIXTURES / "2104.08821.pdf").read_bytes()

        def handler(request: httpx.Request) -> httpx.Response:
            url = str(request.url)
            if "export.arxiv.org" in url:
                return httpx.Response(200, content=self._ATOM_XML)
            if "ar5iv.labs.arxiv.org" in url:
                return httpx.Response(404)  # no ar5iv render
            if "arxiv.org/pdf" in url:
                return httpx.Response(200, content=pdf_bytes)
            return httpx.Response(404)

        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=transport) as client:
            paper = await fetch_arxiv_paper(
                "https://arxiv.org/abs/2104.08821",
                client=client,
            )

        assert paper.extraction_method == "pdf"
        assert paper.body_text is not None and len(paper.body_text) > 10_000
        sections = paper.sections
        assert sections is not None and len(sections) > 0
        # Warning explains why ar5iv didn't get used
        joined = " ".join(paper.extraction_warnings).lower()
        assert "ar5iv" in joined

