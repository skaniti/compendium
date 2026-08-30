"""Tests for the fetcher primary-text contract.

Every ``*Content`` Pydantic model in ``backend/services/content_fetcher.py``
must implement ``get_primary_text()``. The factory
``get_primary_text_from_dict(tool_selected, content_dict)`` routes by
tool name and falls back to a best-effort key scan for unknown tools.

These tests exist because the Reddit silent-failure bug (2026-04-04)
would have been caught by even a single test covering every fetcher. The
priority-chain approach in ``_build_sbert_text`` and ``chunk_generic``
missed Reddit because neither consumer had a test that iterated every
known content class. This file locks in that coverage.
"""

import pytest

from backend.services.content_fetcher import (
    ArxivPaper,
    BGGGameContent,
    ExtractedContent,
    GitHubRepoContent,
    RedditContent,
    StackOverflowQuestion,
    WikipediaContent,
    YouTubeMetadata,
    _strip_html,
    get_primary_text_from_dict,
)


# ── _strip_html ─────────────────────────────────────────────────────────────


class TestStripHtml:
    def test_strips_simple_tags(self):
        assert _strip_html("<p>hello</p>") == "hello"

    def test_strips_nested_tags(self):
        assert _strip_html("<div><p>a <strong>b</strong> c</p></div>") == "a b c"

    def test_strips_code_tags(self):
        assert (
            _strip_html("use <code>list.append()</code> not extend")
            == "use list.append() not extend"
        )

    def test_collapses_whitespace(self):
        assert _strip_html("a\n\n\n  b\t\t c") == "a b c"

    def test_empty_string_returns_empty(self):
        assert _strip_html("") == ""

    def test_no_tags_passes_through(self):
        assert _strip_html("plain text") == "plain text"


# ── Per-class get_primary_text ──────────────────────────────────────────────


class TestWikipediaContent:
    def test_full_text_preferred(self):
        w = WikipediaContent(
            url="u",
            title="Titanic",
            summary="A ship.",
            full_text="A British passenger liner that sank in 1912.",
            sections=[],
            images=[],
            categories=[],
        )
        text = w.get_primary_text()
        assert "Titanic" in text
        assert "sank in 1912" in text

    def test_falls_back_to_summary(self):
        w = WikipediaContent(
            url="u",
            title="Titanic",
            summary="A ship.",
            full_text="",
            sections=[],
            images=[],
            categories=[],
        )
        text = w.get_primary_text()
        assert "Titanic" in text
        assert "A ship" in text


class TestYouTubeMetadata:
    def test_transcript_preferred(self):
        y = YouTubeMetadata(
            url="u",
            video_id="v",
            title="T",
            description="D",
            channel="c",
            duration_seconds=60,
            transcript="This is the full transcript of the video.",
        )
        text = y.get_primary_text()
        assert "transcript" in text
        assert "description" not in text.lower() or "D" not in text

    def test_falls_back_to_description(self):
        y = YouTubeMetadata(
            url="u",
            video_id="v",
            title="T",
            description="This is the description.",
            channel="c",
            duration_seconds=60,
            transcript=None,
        )
        text = y.get_primary_text()
        assert "description" in text


class TestStackOverflowQuestion:
    def test_strips_html_from_body(self):
        s = StackOverflowQuestion(
            url="u",
            question_id=1,
            title="Q",
            body="<p>What is <code>append</code>?</p>",
            score=1,
            answer_count=1,
            tags=[],
            creation_date="2024-01-01",
            link="u",
        )
        text = s.get_primary_text()
        assert "<p>" not in text
        assert "<code>" not in text
        assert "append" in text

    def test_includes_top_answer_when_present(self):
        s = StackOverflowQuestion(
            url="u",
            question_id=1,
            title="Q",
            body="<p>body</p>",
            score=1,
            answer_count=1,
            tags=[],
            creation_date="2024-01-01",
            link="u",
            top_answer="<p>answer text</p>",
        )
        text = s.get_primary_text()
        assert "Top Answer" in text
        assert "answer text" in text
        assert "<p>" not in text


class TestArxivPaper:
    def test_title_and_abstract(self):
        a = ArxivPaper(
            url="u",
            paper_id="2301.12345v1",
            title="Attention Is All You Need",
            abstract="We propose a new simple network architecture.",
            authors=[],
            categories=[],
            published="2023-01-01",
            pdf_url="",
        )
        text = a.get_primary_text()
        assert "Attention Is All You Need" in text
        assert "new simple network" in text


class TestRedditContent:
    """This is the class that the 2026-04-04 bug was silently breaking.
    These tests exist specifically to prevent regression."""

    def test_includes_selftext(self):
        r = RedditContent(
            url="u",
            post_id="p",
            title="How to winter-proof my cat",
            subreddit="cats",
            selftext="My cat hates the cold. Any advice?",
            score=1,
            comment_count=0,
            top_comments=[],
        )
        text = r.get_primary_text()
        assert "winter-proof" in text
        assert "cat hates the cold" in text

    def test_includes_top_comments_up_to_3(self):
        r = RedditContent(
            url="u",
            post_id="p",
            title="T",
            subreddit="s",
            selftext="body",
            score=1,
            comment_count=5,
            top_comments=["c1", "c2", "c3", "c4", "c5"],
        )
        text = r.get_primary_text()
        assert "c1" in text
        assert "c2" in text
        assert "c3" in text
        assert "c4" not in text  # only top 3
        assert "c5" not in text
        assert "--- Comments ---" in text

    def test_link_post_without_selftext(self):
        """Many Reddit posts are link posts with empty selftext — the
        comments carry the topical signal."""
        r = RedditContent(
            url="u",
            post_id="p",
            title="Cool article about physics",
            subreddit="physics",
            selftext="",
            score=1,
            comment_count=2,
            top_comments=["This is wrong because...", "OP is right though"],
        )
        text = r.get_primary_text()
        assert "Cool article" in text
        assert "This is wrong" in text
        assert "OP is right" in text

    def test_title_only_post(self):
        """Edge case: no selftext, no comments. Should not crash."""
        r = RedditContent(
            url="u",
            post_id="p",
            title="Just a title",
            subreddit="s",
            selftext="",
            score=0,
            comment_count=0,
            top_comments=[],
        )
        text = r.get_primary_text()
        assert text == "Just a title"


class TestGitHubRepoContent:
    def test_description_and_readme(self):
        g = GitHubRepoContent(
            url="u",
            owner="anthropic",
            repo="anthropic-sdk-python",
            description="Official Anthropic Python SDK",
            full_text="# Installation\n\npip install anthropic",
            topics=[],
            stars=100,
        )
        text = g.get_primary_text()
        assert "anthropic/anthropic-sdk-python" in text
        assert "Official" in text
        assert "pip install" in text


class TestBGGGameContent:
    def test_title_and_full_text(self):
        b = BGGGameContent(
            url="u",
            bgg_id=1,
            title="Wingspan",
            description="A bird engine-builder.",
            full_text="Wingspan is a competitive, medium-weight, card-driven, engine-building board game.",
            categories=[],
            mechanics=[],
        )
        text = b.get_primary_text()
        assert "Wingspan" in text
        assert "engine-building" in text


class TestExtractedContent:
    def test_title_and_text(self):
        e = ExtractedContent(
            url="u",
            title="Blog post title",
            text="Body content here.",
            char_count=18,
        )
        text = e.get_primary_text()
        assert "Blog post title" in text
        assert "Body content here" in text

    def test_text_only_when_title_none(self):
        e = ExtractedContent(url="u", title=None, text="Just body.", char_count=10)
        assert e.get_primary_text() == "Just body."


# ── Factory routing ─────────────────────────────────────────────────────────


class TestFactoryRouting:
    def test_reddit_happy_path(self):
        data = {
            "url": "u",
            "post_id": "p",
            "title": "Reddit title",
            "subreddit": "s",
            "selftext": "Reddit body",
            "score": 1,
            "comment_count": 0,
            "top_comments": [],
        }
        text, source = get_primary_text_from_dict("fetch_reddit_content", data)
        assert "Reddit title" in text
        assert "Reddit body" in text
        assert source == "RedditContent.get_primary_text"

    def test_wikipedia_happy_path(self):
        data = {
            "url": "u",
            "title": "W",
            "summary": "s",
            "full_text": "Full wiki text.",
            "sections": [],
            "images": [],
            "categories": [],
        }
        text, source = get_primary_text_from_dict("fetch_wikipedia_content", data)
        assert "Full wiki text" in text
        assert source == "WikipediaContent.get_primary_text"

    def test_unknown_tool_falls_back_to_full_text(self):
        data = {"title": "T", "full_text": "Long form content."}
        text, source = get_primary_text_from_dict(None, data)
        assert "Long form content" in text
        assert source == "fallback:full_text"

    def test_unknown_tool_falls_back_to_body(self):
        data = {"title": "T", "body": "Body content."}
        text, source = get_primary_text_from_dict("unknown_tool", data)
        assert "Body content" in text
        assert source == "fallback:body"

    def test_fallback_includes_selftext_key(self):
        """Regression guard: ensure the fallback scan covers 'selftext'
        so that old Reddit rows (written before Plan 01 when tool_selected
        was inconsistent) still resolve to something useful instead of the
        URL-path-fallback branch."""
        data = {"title": "T", "selftext": "Reddit post body"}
        text, source = get_primary_text_from_dict(None, data)
        assert "Reddit post body" in text
        assert source == "fallback:selftext"

    def test_empty_dict_returns_empty(self):
        assert get_primary_text_from_dict(None, {}) == ("", "empty")

    def test_none_dict_returns_empty(self):
        assert get_primary_text_from_dict("any", None) == ("", "empty")

    def test_title_only_fallback(self):
        text, source = get_primary_text_from_dict(None, {"title": "Only the title"})
        assert text == "Only the title"
        assert source == "fallback:title_only"

    def test_malformed_dict_validation_failure_falls_through(self):
        """If the dict doesn't match the registered class's schema,
        validation fails and we fall through to the legacy key scan."""
        # "fetch_reddit_content" expects post_id/subreddit/etc. — missing them
        # should cause Pydantic validation to fail, but the function should
        # still return something useful from the fallback.
        data = {"title": "T", "full_text": "Recovered via fallback."}
        text, source = get_primary_text_from_dict("fetch_reddit_content", data)
        assert "Recovered via fallback" in text
        assert source.startswith("fallback:")


# ── Contract completeness (regression guard) ────────────────────────────────


class TestContractCompleteness:
    """Every *Content class in content_fetcher.py must implement
    get_primary_text() and be registered in _CONTENT_CLASS_BY_TOOL."""

    CONTENT_CLASSES = [
        WikipediaContent,
        YouTubeMetadata,
        StackOverflowQuestion,
        ArxivPaper,
        RedditContent,
        GitHubRepoContent,
        BGGGameContent,
        ExtractedContent,
    ]

    @pytest.mark.parametrize("cls", CONTENT_CLASSES)
    def test_every_class_implements_method(self, cls):
        assert hasattr(cls, "get_primary_text"), f"{cls.__name__} missing get_primary_text"
        assert callable(getattr(cls, "get_primary_text"))

    def test_every_class_is_in_registry(self):
        from backend.services.content_fetcher import _CONTENT_CLASS_BY_TOOL

        registered_classes = set(_CONTENT_CLASS_BY_TOOL.values())
        for cls in self.CONTENT_CLASSES:
            assert (
                cls in registered_classes
            ), f"{cls.__name__} is not registered in _CONTENT_CLASS_BY_TOOL"
