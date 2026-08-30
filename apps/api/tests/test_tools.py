"""Tests for tool calling implementation.

Milestone 5: Validate URL parsing, content fetching, tool schema structure,
tool execution routing, and LLM tool-calling flows for both OpenAI and Anthropic.

These tests use mocks — no real API calls or network requests are made.
"""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from backend.services.content_fetcher import (
    ArxivPaper,
    ContentFetchError,
    InvalidURLError,
    ResourceNotFoundError,
    StackOverflowQuestion,
    WikipediaContent,
    YouTubeMetadata,
    _extract_arxiv_paper_id,
    _extract_stackoverflow_question_id,
    _extract_wikipedia_title,
    _extract_youtube_video_id,
    _parse_iso8601_duration,
    fetch_arxiv_paper,
    fetch_stackoverflow_question,
    fetch_wikipedia_content,
    fetch_youtube_metadata,
)
from backend.services.llm_service import (
    CONTENT_TOOLS,
    TOOL_FUNCTIONS,
    LLMProvider,
    LLMResponse,
    LLMService,
    _execute_tool,
)


# =============================================================================
# Helpers
# =============================================================================


async def _mock_to_thread(func, *args, **kwargs):
    """Replace asyncio.to_thread with a synchronous call for testing."""
    return func(*args, **kwargs)


# =============================================================================
# Category 1: URL Parsing (10 tests)
# =============================================================================


class TestURLParsing:
    """Tests for URL parsing helper functions."""

    # ---- Wikipedia ----

    def test_wikipedia_standard_url(self):
        """Standard Wikipedia URL extracts title correctly."""
        result = _extract_wikipedia_title("https://en.wikipedia.org/wiki/Black_hole")
        assert result == "Black_hole"

    def test_wikipedia_encoded_url(self):
        """URL-encoded Wikipedia title is decoded properly."""
        result = _extract_wikipedia_title("https://en.wikipedia.org/wiki/Schr%C3%B6dinger%27s_cat")
        assert result == "Schrödinger's_cat"

    def test_wikipedia_with_anchor(self):
        """Anchor fragments are stripped from the title."""
        result = _extract_wikipedia_title(
            "https://en.wikipedia.org/wiki/Python_(programming_language)#History"
        )
        assert result == "Python_(programming_language)"

    def test_wikipedia_invalid_url(self):
        """Non-Wikipedia URL raises InvalidURLError."""
        with pytest.raises(InvalidURLError, match="missing /wiki/"):
            _extract_wikipedia_title("https://example.com/not-wiki")

    # ---- YouTube ----

    def test_youtube_watch_url(self):
        """Standard watch?v= URL extracts video ID."""
        result = _extract_youtube_video_id("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
        assert result == "dQw4w9WgXcQ"

    def test_youtube_short_url(self):
        """youtu.be short URL extracts video ID."""
        result = _extract_youtube_video_id("https://youtu.be/dQw4w9WgXcQ")
        assert result == "dQw4w9WgXcQ"

    def test_youtube_embed_url(self):
        """Embed URL extracts video ID."""
        result = _extract_youtube_video_id("https://www.youtube.com/embed/dQw4w9WgXcQ")
        assert result == "dQw4w9WgXcQ"

    def test_youtube_shorts_url(self):
        """Shorts URL extracts video ID."""
        result = _extract_youtube_video_id("https://www.youtube.com/shorts/dQw4w9WgXcQ")
        assert result == "dQw4w9WgXcQ"

    def test_youtube_invalid_url(self):
        """Non-YouTube URL raises InvalidURLError."""
        with pytest.raises(InvalidURLError, match="Could not extract YouTube"):
            _extract_youtube_video_id("https://example.com/not-youtube")

    # ---- Stack Overflow ----

    def test_stackoverflow_standard_url(self):
        """Standard Stack Overflow URL extracts question ID."""
        result = _extract_stackoverflow_question_id(
            "https://stackoverflow.com/questions/11227809/why-is-processing-a-sorted-array-faster"
        )
        assert result == 11227809

    def test_stackoverflow_short_url(self):
        """Short /q/ Stack Overflow URL extracts question ID."""
        result = _extract_stackoverflow_question_id("https://stackoverflow.com/q/927358")
        assert result == 927358

    def test_stackoverflow_invalid_url(self):
        """Non-Stack Overflow URL raises InvalidURLError."""
        with pytest.raises(InvalidURLError, match="Could not extract Stack Overflow"):
            _extract_stackoverflow_question_id("https://example.com/not-stackoverflow")

    # ---- arXiv ----

    def test_arxiv_abs_url(self):
        """arXiv /abs/ URL extracts paper ID."""
        result = _extract_arxiv_paper_id("https://arxiv.org/abs/1706.03762")
        assert result == "1706.03762"

    def test_arxiv_pdf_url_with_version(self):
        """arXiv /pdf/ URL with version suffix extracts full paper ID."""
        result = _extract_arxiv_paper_id("https://arxiv.org/pdf/2005.11401v2")
        assert result == "2005.11401v2"

    def test_arxiv_invalid_url(self):
        """Non-arXiv URL raises InvalidURLError."""
        with pytest.raises(InvalidURLError, match="Could not extract arXiv"):
            _extract_arxiv_paper_id("https://example.com/not-arxiv")


# =============================================================================
# Category 2: ISO 8601 Duration Parsing (3 tests)
# =============================================================================


class TestDurationParsing:
    """Tests for _parse_iso8601_duration helper."""

    def test_minutes_and_seconds(self):
        """PT4M13S converts to 253 seconds."""
        assert _parse_iso8601_duration("PT4M13S") == 253

    def test_hours_minutes_seconds(self):
        """PT1H2M3S converts to 3723 seconds."""
        assert _parse_iso8601_duration("PT1H2M3S") == 3723

    def test_seconds_only(self):
        """PT30S converts to 30 seconds."""
        assert _parse_iso8601_duration("PT30S") == 30


# =============================================================================
# Category 3: Content Fetchers with Mocks (9 tests)
# =============================================================================


class TestWikipediaFetcher:
    """Tests for fetch_wikipedia_content with mocked wikipedia-api."""

    @pytest.mark.asyncio
    @patch(
        "backend.services.content_fetcher.asyncio.to_thread",
        side_effect=_mock_to_thread,
    )
    @patch("backend.services.content_fetcher.wikipediaapi")
    @patch("backend.services.content_fetcher.httpx")
    async def test_fetch_success(self, mock_httpx, mock_wikiapi, _mock_thread):
        """Successful fetch returns WikipediaContent with correct fields."""
        # Build mock page
        mock_page = MagicMock()
        mock_page.exists.return_value = True
        mock_page.title = "Black hole"
        mock_page.summary = "A black hole is a region of spacetime."
        mock_page.text = "Full article text about black holes."
        mock_page.sections = []
        mock_page.categories = {
            "Category:Astrophysics": MagicMock(),
            "Category:General relativity": MagicMock(),
        }

        mock_wiki_instance = MagicMock()
        mock_wiki_instance.page.return_value = mock_page
        mock_wikiapi.Wikipedia.return_value = mock_wiki_instance

        # Mock MediaWiki API for image extraction
        images_resp = MagicMock()
        images_resp.json.return_value = {
            "query": {"pages": {"1": {"images": [{"title": "File:Blackhole.jpg"}]}}}
        }
        info_resp = MagicMock()
        info_resp.json.return_value = {
            "query": {
                "pages": {
                    "1": {
                        "title": "File:Blackhole.jpg",
                        "imageinfo": [{"url": "https://upload.wikimedia.org/blackhole.jpg"}],
                    }
                }
            }
        }
        mock_httpx.get.side_effect = [images_resp, info_resp]

        result = await fetch_wikipedia_content("https://en.wikipedia.org/wiki/Black_hole")

        assert isinstance(result, WikipediaContent)
        assert result.title == "Black hole"
        assert result.summary == "A black hole is a region of spacetime."
        assert result.full_text == "Full article text about black holes."
        assert "Astrophysics" in result.categories
        assert "https://upload.wikimedia.org/blackhole.jpg" in result.images

    @pytest.mark.asyncio
    @patch(
        "backend.services.content_fetcher.asyncio.to_thread",
        side_effect=_mock_to_thread,
    )
    @patch("backend.services.content_fetcher.wikipediaapi")
    async def test_fetch_not_found(self, mock_wikiapi, _mock_thread):
        """Non-existent page raises ResourceNotFoundError."""
        mock_page = MagicMock()
        mock_page.exists.return_value = False

        mock_wiki_instance = MagicMock()
        mock_wiki_instance.page.return_value = mock_page
        mock_wikiapi.Wikipedia.return_value = mock_wiki_instance

        with pytest.raises(ResourceNotFoundError, match="not found"):
            await fetch_wikipedia_content("https://en.wikipedia.org/wiki/Nonexistent_Article_XYZ")

    @pytest.mark.asyncio
    @patch(
        "backend.services.content_fetcher.asyncio.to_thread",
        side_effect=_mock_to_thread,
    )
    @patch("backend.services.content_fetcher.wikipediaapi")
    async def test_fetch_disambiguation(self, mock_wikiapi, _mock_thread):
        """Disambiguation page summary is prefixed with '[Disambiguation page]'."""
        mock_page = MagicMock()
        mock_page.exists.return_value = True
        mock_page.title = "Mercury"
        mock_page.summary = "Mercury may refer to:"
        mock_page.text = "Mercury may refer to: ..."
        mock_page.sections = []
        mock_page.categories = {
            "Category:Disambiguation pages": MagicMock(),
        }
        mock_page.images = {}

        mock_wiki_instance = MagicMock()
        mock_wiki_instance.page.return_value = mock_page
        mock_wikiapi.Wikipedia.return_value = mock_wiki_instance

        result = await fetch_wikipedia_content("https://en.wikipedia.org/wiki/Mercury")

        assert result.summary.startswith("[Disambiguation page]")
        assert "Mercury may refer to:" in result.summary


class TestYouTubeFetcher:
    """Tests for fetch_youtube_metadata with mocked HTTP and transcript APIs."""

    @pytest.mark.asyncio
    @patch(
        "backend.services.content_fetcher.asyncio.to_thread",
        side_effect=_mock_to_thread,
    )
    @patch("backend.services.content_fetcher.YouTubeTranscriptApi")
    @patch("backend.services.content_fetcher.settings")
    async def test_fetch_with_oembed_fallback(self, mock_settings, mock_ytt_class, _mock_thread):
        """When no API key is set, uses noembed.com and fetches transcript."""
        mock_settings.youtube_api_key = None

        # Mock transcript
        mock_snippet = MagicMock()
        mock_snippet.text = "Hello world"
        mock_fetched_transcript = MagicMock()
        mock_fetched_transcript.__iter__ = MagicMock(return_value=iter([mock_snippet]))
        mock_ytt_instance = MagicMock()
        mock_ytt_instance.fetch.return_value = mock_fetched_transcript
        mock_ytt_class.return_value = mock_ytt_instance

        # Mock httpx.AsyncClient for noembed call
        mock_response = MagicMock()
        mock_response.raise_for_status = MagicMock()
        mock_response.json.return_value = {
            "title": "Test Video",
            "author_name": "Test Channel",
        }

        mock_client = AsyncMock()
        mock_client.get.return_value = mock_response
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch(
            "backend.services.content_fetcher.httpx.AsyncClient",
            return_value=mock_client,
        ):
            result = await fetch_youtube_metadata("https://www.youtube.com/watch?v=dQw4w9WgXcQ")

        assert isinstance(result, YouTubeMetadata)
        assert result.video_id == "dQw4w9WgXcQ"
        assert result.title == "Test Video"
        assert result.channel == "Test Channel"
        assert result.description == ""
        assert result.duration_seconds == 0
        assert result.transcript == "Hello world"

    @pytest.mark.asyncio
    @patch(
        "backend.services.content_fetcher.asyncio.to_thread",
        side_effect=_mock_to_thread,
    )
    @patch("backend.services.content_fetcher.YouTubeTranscriptApi")
    @patch("backend.services.content_fetcher.settings")
    async def test_fetch_transcript_unavailable(self, mock_settings, mock_ytt_class, _mock_thread):
        """When transcript fetch fails, transcript is None (not an error)."""
        mock_settings.youtube_api_key = None

        # Mock transcript to raise
        mock_ytt_instance = MagicMock()
        mock_ytt_instance.fetch.side_effect = Exception("Transcript unavailable")
        mock_ytt_class.return_value = mock_ytt_instance

        # Mock httpx.AsyncClient for noembed call
        mock_response = MagicMock()
        mock_response.raise_for_status = MagicMock()
        mock_response.json.return_value = {
            "title": "No Transcript Video",
            "author_name": "Channel",
        }

        mock_client = AsyncMock()
        mock_client.get.return_value = mock_response
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch(
            "backend.services.content_fetcher.httpx.AsyncClient",
            return_value=mock_client,
        ):
            result = await fetch_youtube_metadata("https://www.youtube.com/watch?v=abc123xyz00")

        assert result.transcript is None
        assert result.title == "No Transcript Video"

    @pytest.mark.asyncio
    @patch(
        "backend.services.content_fetcher.asyncio.to_thread",
        side_effect=_mock_to_thread,
    )
    @patch("backend.services.content_fetcher.YouTubeTranscriptApi")
    @patch("backend.services.content_fetcher.settings")
    async def test_fetch_with_api_key(self, mock_settings, mock_ytt_class, _mock_thread):
        """When API key is set, uses YouTube Data API and parses ISO 8601 duration."""
        mock_settings.youtube_api_key = "test_api_key"

        # Mock transcript
        mock_snippet = MagicMock()
        mock_snippet.text = "transcript text"
        mock_fetched_transcript = MagicMock()
        mock_fetched_transcript.__iter__ = MagicMock(return_value=iter([mock_snippet]))
        mock_ytt_instance = MagicMock()
        mock_ytt_instance.fetch.return_value = mock_fetched_transcript
        mock_ytt_class.return_value = mock_ytt_instance

        # Mock httpx.AsyncClient for YouTube Data API call
        mock_response = MagicMock()
        mock_response.raise_for_status = MagicMock()
        mock_response.json.return_value = {
            "items": [
                {
                    "snippet": {
                        "title": "API Video Title",
                        "description": "A great video.",
                        "channelTitle": "API Channel",
                    },
                    "contentDetails": {
                        "duration": "PT10M30S",
                    },
                }
            ]
        }

        mock_client = AsyncMock()
        mock_client.get.return_value = mock_response
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch(
            "backend.services.content_fetcher.httpx.AsyncClient",
            return_value=mock_client,
        ):
            result = await fetch_youtube_metadata("https://www.youtube.com/watch?v=dQw4w9WgXcQ")

        assert result.title == "API Video Title"
        assert result.description == "A great video."
        assert result.channel == "API Channel"
        assert result.duration_seconds == 630  # 10*60 + 30
        assert result.transcript == "transcript text"


class TestStackOverflowFetcher:
    """Tests for fetch_stackoverflow_question with mocked httpx."""

    @pytest.mark.asyncio
    async def test_fetch_success(self):
        """Successful fetch returns StackOverflowQuestion with top answer."""
        mock_question_response = MagicMock()
        mock_question_response.raise_for_status = MagicMock()
        mock_question_response.json.return_value = {
            "items": [
                {
                    "question_id": 11227809,
                    "title": "Why is processing a sorted array faster?",
                    "body": "<p>Question body HTML</p>",
                    "score": 27000,
                    "answer_count": 26,
                    "tags": ["java", "performance", "branch-prediction"],
                    "creation_date": 1340805542,
                    "link": "https://stackoverflow.com/questions/11227809",
                    "owner": {"display_name": "GManNickG"},
                }
            ]
        }

        mock_answer_response = MagicMock()
        mock_answer_response.raise_for_status = MagicMock()
        mock_answer_response.json.return_value = {
            "items": [{"body": "<p>Branch prediction explanation</p>"}]
        }

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(side_effect=[mock_question_response, mock_answer_response])
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch(
            "backend.services.content_fetcher.httpx.AsyncClient",
            return_value=mock_client,
        ):
            result = await fetch_stackoverflow_question(
                "https://stackoverflow.com/questions/11227809/why-is-processing-a-sorted-array-faster"
            )

        assert isinstance(result, StackOverflowQuestion)
        assert result.question_id == 11227809
        assert result.title == "Why is processing a sorted array faster?"
        assert result.score == 27000
        assert result.owner_name == "GManNickG"
        assert result.top_answer == "<p>Branch prediction explanation</p>"
        assert "java" in result.tags

    @pytest.mark.asyncio
    async def test_fetch_no_answers(self):
        """Question with no answers returns top_answer=None."""
        mock_response = MagicMock()
        mock_response.raise_for_status = MagicMock()
        mock_response.json.return_value = {
            "items": [
                {
                    "question_id": 99999,
                    "title": "Unanswered question",
                    "body": "<p>Body</p>",
                    "score": 1,
                    "answer_count": 0,
                    "tags": ["python"],
                    "creation_date": 1700000000,
                    "link": "https://stackoverflow.com/questions/99999",
                    "owner": {"display_name": "user123"},
                }
            ]
        }

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=mock_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch(
            "backend.services.content_fetcher.httpx.AsyncClient",
            return_value=mock_client,
        ):
            result = await fetch_stackoverflow_question(
                "https://stackoverflow.com/questions/99999/unanswered"
            )

        assert result.top_answer is None
        assert result.answer_count == 0

    @pytest.mark.asyncio
    async def test_fetch_not_found(self):
        """Empty items list raises ResourceNotFoundError."""
        mock_response = MagicMock()
        mock_response.raise_for_status = MagicMock()
        mock_response.json.return_value = {"items": []}

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=mock_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch(
            "backend.services.content_fetcher.httpx.AsyncClient",
            return_value=mock_client,
        ):
            with pytest.raises(ResourceNotFoundError, match="not found"):
                await fetch_stackoverflow_question(
                    "https://stackoverflow.com/questions/0/nonexistent"
                )

    @pytest.mark.asyncio
    async def test_fetch_missing_owner(self):
        """Question without owner returns owner_name=None."""
        mock_response = MagicMock()
        mock_response.raise_for_status = MagicMock()
        mock_response.json.return_value = {
            "items": [
                {
                    "question_id": 12345,
                    "title": "No owner question",
                    "body": "<p>Body</p>",
                    "score": 5,
                    "answer_count": 0,
                    "tags": ["python"],
                    "creation_date": 1700000000,
                    "link": "https://stackoverflow.com/questions/12345",
                }
            ]
        }

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=mock_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch(
            "backend.services.content_fetcher.httpx.AsyncClient",
            return_value=mock_client,
        ):
            result = await fetch_stackoverflow_question(
                "https://stackoverflow.com/questions/12345/no-owner"
            )

        assert result.owner_name is None


class TestArxivFetcher:
    """Tests for fetch_arxiv_paper with mocked httpx."""

    _SAMPLE_ATOM_XML = """<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Attention Is All You Need</title>
    <summary>The dominant sequence transduction models are based on complex
recurrent or convolutional neural networks.</summary>
    <author><name>Ashish Vaswani</name></author>
    <author><name>Noam Shazeer</name></author>
    <category term="cs.CL" />
    <category term="cs.AI" />
    <published>2017-06-12T00:00:00Z</published>
  </entry>
</feed>"""

    _EMPTY_FEED_XML = """<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
</feed>"""

    @pytest.mark.asyncio
    async def test_fetch_success(self):
        """Successful fetch returns ArxivPaper with all fields populated."""
        mock_response = MagicMock()
        mock_response.raise_for_status = MagicMock()
        mock_response.text = self._SAMPLE_ATOM_XML

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=mock_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch(
            "backend.services.content_fetcher.httpx.AsyncClient",
            return_value=mock_client,
        ):
            result = await fetch_arxiv_paper("https://arxiv.org/abs/1706.03762")

        assert isinstance(result, ArxivPaper)
        assert result.paper_id == "1706.03762"
        assert result.title == "Attention Is All You Need"
        assert "Ashish Vaswani" in result.authors
        assert "Noam Shazeer" in result.authors
        assert "cs.CL" in result.categories
        assert "cs.AI" in result.categories
        assert result.pdf_url == "https://arxiv.org/pdf/1706.03762"

    @pytest.mark.asyncio
    async def test_fetch_not_found(self):
        """Empty feed raises ResourceNotFoundError."""
        mock_response = MagicMock()
        mock_response.raise_for_status = MagicMock()
        mock_response.text = self._EMPTY_FEED_XML

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=mock_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch(
            "backend.services.content_fetcher.httpx.AsyncClient",
            return_value=mock_client,
        ):
            with pytest.raises(ResourceNotFoundError, match="not found"):
                await fetch_arxiv_paper("https://arxiv.org/abs/9999.99999")

    @pytest.mark.asyncio
    async def test_version_suffix_preserved(self):
        """Paper ID with version suffix is preserved in result."""
        mock_response = MagicMock()
        mock_response.raise_for_status = MagicMock()
        mock_response.text = self._SAMPLE_ATOM_XML

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=mock_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch(
            "backend.services.content_fetcher.httpx.AsyncClient",
            return_value=mock_client,
        ):
            result = await fetch_arxiv_paper("https://arxiv.org/abs/2005.11401v2")

        assert result.paper_id == "2005.11401v2"
        assert result.pdf_url == "https://arxiv.org/pdf/2005.11401v2"

    @pytest.mark.asyncio
    async def test_whitespace_normalization(self):
        """Embedded newlines in title and abstract are normalized."""
        mock_response = MagicMock()
        mock_response.raise_for_status = MagicMock()
        mock_response.text = self._SAMPLE_ATOM_XML

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=mock_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch(
            "backend.services.content_fetcher.httpx.AsyncClient",
            return_value=mock_client,
        ):
            result = await fetch_arxiv_paper("https://arxiv.org/abs/1706.03762")

        # The sample XML has a newline in the abstract — should be normalized
        assert "\n" not in result.title
        assert "\n" not in result.abstract
        assert "complex recurrent" in result.abstract


# =============================================================================
# Category 4: Tool Schema Validation (4 tests)
# =============================================================================


class TestToolSchemas:
    """Tests for CONTENT_TOOLS schema structure."""

    def test_content_tools_count(self):
        """CONTENT_TOOLS contains exactly 5 tool definitions (4 platform + 1 generic)."""
        assert len(CONTENT_TOOLS) == 5

    def test_tool_schema_structure(self):
        """Each tool has 'type': 'function' and nested function spec."""
        for tool in CONTENT_TOOLS:
            assert tool["type"] == "function"
            func = tool["function"]
            assert "name" in func
            assert "description" in func
            assert "parameters" in func
            assert isinstance(func["description"], str)
            assert len(func["description"]) > 0

    def test_tool_names_match_functions(self):
        """Every tool name in CONTENT_TOOLS exists in TOOL_FUNCTIONS."""
        tool_names = {t["function"]["name"] for t in CONTENT_TOOLS}
        function_names = set(TOOL_FUNCTIONS.keys())
        assert tool_names == function_names

    def test_tool_parameters_require_url(self):
        """Each tool requires a 'url' parameter."""
        for tool in CONTENT_TOOLS:
            params = tool["function"]["parameters"]
            assert "url" in params["properties"]
            assert "url" in params["required"]


# =============================================================================
# Category 5: Tool Executor (4 tests)
# =============================================================================


class TestToolExecutor:
    """Tests for _execute_tool routing and error handling."""

    @pytest.mark.asyncio
    async def test_execute_wikipedia_tool(self):
        """Wikipedia tool routes to fetch_wikipedia_content and returns JSON."""
        mock_fetch = AsyncMock()
        mock_content = WikipediaContent(
            url="https://en.wikipedia.org/wiki/Test",
            title="Test",
            summary="A test article.",
            full_text="Full text.",
            sections=[],
            images=[],
            categories=["Testing"],
        )
        mock_fetch.return_value = mock_content

        with patch.dict(TOOL_FUNCTIONS, {"fetch_wikipedia_content": mock_fetch}):
            result = await _execute_tool(
                "fetch_wikipedia_content",
                {"url": "https://en.wikipedia.org/wiki/Test"},
            )

        parsed = json.loads(result)
        assert parsed["title"] == "Test"
        assert parsed["summary"] == "A test article."
        mock_fetch.assert_awaited_once_with(url="https://en.wikipedia.org/wiki/Test")

    @pytest.mark.asyncio
    async def test_execute_youtube_tool(self):
        """YouTube tool routes to fetch_youtube_metadata and returns JSON."""
        mock_fetch = AsyncMock()
        mock_meta = YouTubeMetadata(
            url="https://www.youtube.com/watch?v=abc",
            video_id="abc",
            title="YT Test",
            description="desc",
            channel="Chan",
            duration_seconds=120,
            transcript="hello",
        )
        mock_fetch.return_value = mock_meta

        with patch.dict(TOOL_FUNCTIONS, {"fetch_youtube_metadata": mock_fetch}):
            result = await _execute_tool(
                "fetch_youtube_metadata",
                {"url": "https://www.youtube.com/watch?v=abc"},
            )

        parsed = json.loads(result)
        assert parsed["title"] == "YT Test"
        assert parsed["video_id"] == "abc"

    @pytest.mark.asyncio
    async def test_execute_unknown_tool(self):
        """Unknown tool name returns JSON error, not an exception."""
        result = await _execute_tool("nonexistent_tool", {"url": "http://x.com"})
        parsed = json.loads(result)
        assert "error" in parsed
        assert "Unknown tool" in parsed["error"]

    @pytest.mark.asyncio
    async def test_execute_tool_with_fetch_error(self):
        """ContentFetchError is caught and returned as JSON error."""
        mock_fetch = AsyncMock(side_effect=ContentFetchError("Page not found"))

        with patch.dict(TOOL_FUNCTIONS, {"fetch_wikipedia_content": mock_fetch}):
            result = await _execute_tool(
                "fetch_wikipedia_content",
                {"url": "https://en.wikipedia.org/wiki/Missing"},
            )

        parsed = json.loads(result)
        assert "error" in parsed
        assert "Page not found" in parsed["error"]


# =============================================================================
# Category 6: LLM Tool Calling with Mocks (6 tests)
# =============================================================================


class TestLLMToolCalling:
    """Tests for complete_with_tools with mocked LLM clients."""

    # ---- Fixtures ----

    @pytest.fixture
    def llm_service(self):
        """Create an LLMService with mocked clients."""
        with patch("backend.services.llm_service.settings") as mock_settings:
            mock_settings.has_openai = False
            mock_settings.has_anthropic = False
            mock_settings.has_huggingface = False
            mock_settings.default_inference_model = "gpt-4o"
            service = LLMService()
        return service

    # ---- OpenAI tests ----

    @pytest.mark.asyncio
    async def test_openai_no_tool_calls(self, llm_service):
        """OpenAI response without tool_calls returns (response, None)."""
        # Build mock response
        mock_message = MagicMock()
        mock_message.content = "Here is my answer."
        mock_message.tool_calls = None

        mock_usage = MagicMock()
        mock_usage.prompt_tokens = 50
        mock_usage.completion_tokens = 20

        mock_choice = MagicMock()
        mock_choice.message = mock_message

        mock_response = MagicMock()
        mock_response.choices = [mock_choice]
        mock_response.usage = mock_usage

        mock_openai_client = AsyncMock()
        mock_openai_client.chat.completions.create = AsyncMock(return_value=mock_response)
        llm_service._openai_client = mock_openai_client

        response, tool_calls = await llm_service._complete_with_tools_openai(
            prompt="What is a black hole?",
            tools=CONTENT_TOOLS,
            model="gpt-4o",
        )

        assert isinstance(response, LLMResponse)
        assert response.content == "Here is my answer."
        assert response.input_tokens == 50
        assert response.output_tokens == 20
        assert tool_calls is None

    @pytest.mark.asyncio
    @patch("backend.services.llm_service._execute_tool", new_callable=AsyncMock)
    async def test_openai_with_tool_call(self, mock_exec_tool, llm_service):
        """OpenAI response with tool_calls executes tool and makes follow-up call."""
        from openai.types.chat import ChatCompletionMessageToolCall
        from openai.types.chat.chat_completion_message_tool_call import Function

        # First response: tool call
        mock_tc = ChatCompletionMessageToolCall(
            id="call_abc123",
            type="function",
            function=Function(
                name="fetch_wikipedia_content",
                arguments='{"url": "https://en.wikipedia.org/wiki/Test"}',
            ),
        )

        mock_message_1 = MagicMock()
        mock_message_1.content = None
        mock_message_1.tool_calls = [mock_tc]

        mock_usage_1 = MagicMock()
        mock_usage_1.prompt_tokens = 100
        mock_usage_1.completion_tokens = 30

        mock_choice_1 = MagicMock()
        mock_choice_1.message = mock_message_1

        mock_response_1 = MagicMock()
        mock_response_1.choices = [mock_choice_1]
        mock_response_1.usage = mock_usage_1

        # Mock tool execution result
        mock_exec_tool.return_value = json.dumps({"title": "Test", "summary": "A test article."})

        # Second response: final answer
        mock_message_2 = MagicMock()
        mock_message_2.content = "Based on the article, Test is about testing."

        mock_usage_2 = MagicMock()
        mock_usage_2.prompt_tokens = 200
        mock_usage_2.completion_tokens = 25

        mock_choice_2 = MagicMock()
        mock_choice_2.message = mock_message_2

        mock_response_2 = MagicMock()
        mock_response_2.choices = [mock_choice_2]
        mock_response_2.usage = mock_usage_2

        mock_openai_client = AsyncMock()
        mock_openai_client.chat.completions.create = AsyncMock(
            side_effect=[mock_response_1, mock_response_2]
        )
        llm_service._openai_client = mock_openai_client

        response, tool_calls = await llm_service._complete_with_tools_openai(
            prompt="Tell me about the Test article.",
            tools=CONTENT_TOOLS,
            model="gpt-4o",
        )

        assert response.content == "Based on the article, Test is about testing."
        assert tool_calls is not None
        assert len(tool_calls) == 1
        assert tool_calls[0]["name"] == "fetch_wikipedia_content"
        assert tool_calls[0]["id"] == "call_abc123"
        mock_exec_tool.assert_awaited_once()

    # ---- Anthropic tests ----

    @pytest.mark.asyncio
    async def test_anthropic_no_tool_calls(self, llm_service):
        """Anthropic response with only text blocks returns (response, None)."""
        mock_text_block = MagicMock()
        mock_text_block.type = "text"
        mock_text_block.text = "Here is my Anthropic answer."

        mock_usage = MagicMock()
        mock_usage.input_tokens = 40
        mock_usage.output_tokens = 15

        mock_response = MagicMock()
        mock_response.content = [mock_text_block]
        mock_response.usage = mock_usage

        mock_anthropic_client = AsyncMock()
        mock_anthropic_client.messages.create = AsyncMock(return_value=mock_response)
        llm_service._anthropic_client = mock_anthropic_client

        response, tool_calls = await llm_service._complete_with_tools_anthropic(
            prompt="What is a black hole?",
            tools=CONTENT_TOOLS,
            model="claude-sonnet-4-5-20250514",
        )

        assert isinstance(response, LLMResponse)
        assert response.content == "Here is my Anthropic answer."
        assert response.provider == LLMProvider.ANTHROPIC
        assert tool_calls is None

    @pytest.mark.asyncio
    @patch("backend.services.llm_service._execute_tool", new_callable=AsyncMock)
    async def test_anthropic_with_tool_call(self, mock_exec_tool, llm_service):
        """Anthropic response with tool_use blocks executes tool and follows up."""
        # First response: tool_use block
        mock_tool_block = MagicMock()
        mock_tool_block.type = "tool_use"
        mock_tool_block.name = "fetch_youtube_metadata"
        mock_tool_block.input = {"url": "https://www.youtube.com/watch?v=abc"}
        mock_tool_block.id = "toolu_abc123"

        mock_usage_1 = MagicMock()
        mock_usage_1.input_tokens = 80
        mock_usage_1.output_tokens = 40

        mock_response_1 = MagicMock()
        mock_response_1.content = [mock_tool_block]
        mock_response_1.usage = mock_usage_1

        # Mock tool execution
        mock_exec_tool.return_value = json.dumps({"title": "YT Video", "video_id": "abc"})

        # Second response: text block
        mock_text_block = MagicMock()
        mock_text_block.type = "text"
        mock_text_block.text = "The video is about YT Video."

        mock_usage_2 = MagicMock()
        mock_usage_2.input_tokens = 150
        mock_usage_2.output_tokens = 20

        mock_response_2 = MagicMock()
        mock_response_2.content = [mock_text_block]
        mock_response_2.usage = mock_usage_2

        mock_anthropic_client = AsyncMock()
        mock_anthropic_client.messages.create = AsyncMock(
            side_effect=[mock_response_1, mock_response_2]
        )
        llm_service._anthropic_client = mock_anthropic_client

        response, tool_calls = await llm_service._complete_with_tools_anthropic(
            prompt="Tell me about this YouTube video.",
            tools=CONTENT_TOOLS,
            model="claude-sonnet-4-5-20250514",
        )

        assert response.content == "The video is about YT Video."
        assert tool_calls is not None
        assert len(tool_calls) == 1
        assert tool_calls[0]["name"] == "fetch_youtube_metadata"
        assert tool_calls[0]["id"] == "toolu_abc123"
        mock_exec_tool.assert_awaited_once()

    # ---- HuggingFace error ----

    @pytest.mark.asyncio
    async def test_huggingface_raises_error(self, llm_service):
        """HuggingFace provider raises ValueError for tool calling."""
        with pytest.raises(ValueError, match="does not support tool calling"):
            await llm_service.complete_with_tools(
                prompt="Test prompt",
                tools=CONTENT_TOOLS,
                model="mistralai/Mistral-7B-Instruct-v0.3",
            )

    # ---- Token tracking ----

    @pytest.mark.asyncio
    @patch("backend.services.llm_service._execute_tool", new_callable=AsyncMock)
    async def test_token_tracking_across_calls(self, mock_exec_tool, llm_service):
        """Input and output tokens accumulate across both API calls."""
        from openai.types.chat import ChatCompletionMessageToolCall
        from openai.types.chat.chat_completion_message_tool_call import Function

        # First call: 100 input, 30 output
        mock_tc = ChatCompletionMessageToolCall(
            id="call_tok1",
            type="function",
            function=Function(
                name="fetch_wikipedia_content",
                arguments='{"url": "https://en.wikipedia.org/wiki/Token"}',
            ),
        )

        mock_msg_1 = MagicMock()
        mock_msg_1.content = None
        mock_msg_1.tool_calls = [mock_tc]

        mock_usage_1 = MagicMock()
        mock_usage_1.prompt_tokens = 100
        mock_usage_1.completion_tokens = 30

        mock_choice_1 = MagicMock()
        mock_choice_1.message = mock_msg_1

        mock_resp_1 = MagicMock()
        mock_resp_1.choices = [mock_choice_1]
        mock_resp_1.usage = mock_usage_1

        mock_exec_tool.return_value = json.dumps({"title": "Token"})

        # Second call: 250 input, 50 output
        mock_msg_2 = MagicMock()
        mock_msg_2.content = "Final answer about tokens."

        mock_usage_2 = MagicMock()
        mock_usage_2.prompt_tokens = 250
        mock_usage_2.completion_tokens = 50

        mock_choice_2 = MagicMock()
        mock_choice_2.message = mock_msg_2

        mock_resp_2 = MagicMock()
        mock_resp_2.choices = [mock_choice_2]
        mock_resp_2.usage = mock_usage_2

        mock_openai_client = AsyncMock()
        mock_openai_client.chat.completions.create = AsyncMock(
            side_effect=[mock_resp_1, mock_resp_2]
        )
        llm_service._openai_client = mock_openai_client

        response, _ = await llm_service._complete_with_tools_openai(
            prompt="Tell me about tokens.",
            tools=CONTENT_TOOLS,
            model="gpt-4o",
        )

        # Tokens should be accumulated: 100+250=350 input, 30+50=80 output
        assert response.input_tokens == 350
        assert response.output_tokens == 80
        assert response.total_tokens == 430


# =============================================================================
# Live Anthropic API Tests — Skipped Without Key
# =============================================================================

from backend.config.settings import settings as _settings

HAS_ANTHROPIC_KEY = _settings.has_anthropic


@pytest.mark.skipif(not HAS_ANTHROPIC_KEY, reason="ANTHROPIC_API_KEY not set")
class TestAnthropicLiveAPI:
    """Integration tests that hit the real Anthropic API.

    Uses claude-haiku-4-5 to keep costs minimal (~$0.001/call).
    """

    MODEL = "claude-haiku-4-5-20251001"

    @pytest.fixture
    def llm(self):
        return LLMService()

    @pytest.mark.asyncio
    async def test_basic_completion(self, llm):
        """Basic text generation returns a well-formed LLMResponse."""
        response = await llm.complete(
            prompt="What is 2 + 2? Reply with just the number.",
            model=self.MODEL,
            max_tokens=32,
        )

        assert isinstance(response, LLMResponse)
        assert response.provider == LLMProvider.ANTHROPIC
        assert response.model == self.MODEL
        assert "4" in response.content
        assert response.input_tokens > 0
        assert response.output_tokens > 0
        assert response.total_tokens == response.input_tokens + response.output_tokens
        assert response.latency_ms > 0
        assert response.cost_usd > 0

    @pytest.mark.asyncio
    async def test_completion_with_system_prompt(self, llm):
        """System prompt is handled correctly (separate kwarg, not in messages)."""
        response = await llm.complete(
            prompt="What do you do?",
            model=self.MODEL,
            system_prompt="You are a pirate. Always respond in pirate speak.",
            max_tokens=100,
        )

        assert isinstance(response, LLMResponse)
        assert response.provider == LLMProvider.ANTHROPIC
        assert len(response.content) > 0

    @pytest.mark.asyncio
    async def test_select_tool_wikipedia_url(self, llm):
        """Given a Wikipedia URL, Claude selects the wikipedia fetcher tool."""
        response, tool_calls = await llm.select_tool(
            prompt="Fetch content from https://en.wikipedia.org/wiki/Black_hole",
            tools=CONTENT_TOOLS,
            model=self.MODEL,
        )

        assert isinstance(response, LLMResponse)
        assert response.provider == LLMProvider.ANTHROPIC
        assert tool_calls is not None
        assert len(tool_calls) >= 1
        assert tool_calls[0]["name"] == "fetch_wikipedia_content"
        assert (
            "black_hole" in tool_calls[0]["arguments"]["url"].lower()
            or "Black_hole" in tool_calls[0]["arguments"]["url"]
        )

    @pytest.mark.asyncio
    async def test_select_tool_youtube_url(self, llm):
        """Given a YouTube URL, Claude selects the youtube fetcher tool."""
        response, tool_calls = await llm.select_tool(
            prompt="Get info about https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            tools=CONTENT_TOOLS,
            model=self.MODEL,
        )

        assert tool_calls is not None
        assert tool_calls[0]["name"] == "fetch_youtube_metadata"

    @pytest.mark.asyncio
    async def test_cost_tracking(self, llm):
        """Cost is calculated using Anthropic pricing from MODEL_PRICING."""
        response = await llm.complete(
            prompt="Say hello.",
            model=self.MODEL,
            max_tokens=16,
        )

        # Haiku pricing: $0.0008/1K input, $0.004/1K output
        expected_cost = (response.input_tokens * 0.0008 + response.output_tokens * 0.004) / 1000
        assert abs(response.cost_usd - expected_cost) < 1e-9

    @pytest.mark.asyncio
    async def test_model_alias_resolution(self, llm):
        """Model aliases resolve to full Anthropic model IDs."""
        response = await llm.complete(
            prompt="Say yes.",
            model="claude-3.5-haiku",  # alias for claude-haiku-4-5-20251001
            max_tokens=8,
        )

        assert response.provider == LLMProvider.ANTHROPIC
        assert response.model == "claude-haiku-4-5-20251001"
