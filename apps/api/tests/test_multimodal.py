"""Tests for multimodal image fetching and vision analysis.

Milestone 8: Validate image filtering logic (pure unit tests) and
optionally test Wikipedia image fetching and GPT-4o vision (API tests).

Unit tests use no network calls. API tests are skipped when keys are missing.
"""

import os
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from backend.services.multimodal import (
    ImageDescription,
    WikiImage,
    fetch_wikipedia_images,
    is_boilerplate_image,
    is_refusal_description,
    is_svg,
    is_too_small,
    passes_image_filter,
)


# =============================================================================
# Category 1: Image Filtering — Pure Unit Tests (no network)
# =============================================================================


class TestIsBoilerplateImage:
    """Test boilerplate image detection."""

    def test_commons_logo_detected(self):
        assert is_boilerplate_image("File:Commons-logo.svg") is True

    def test_ambox_detected(self):
        assert is_boilerplate_image("File:Ambox_important.svg") is True

    def test_wiki_logo_detected(self):
        assert is_boilerplate_image("File:Wiki-logo.png") is True

    def test_portal_puzzle_detected(self):
        assert is_boilerplate_image("File:Portal-puzzle.svg") is True

    def test_flag_detected(self):
        assert is_boilerplate_image("File:Flag_of_France.svg") is True

    def test_disambig_detected(self):
        assert is_boilerplate_image("File:Disambig_grey.svg") is True

    def test_ooj_ui_detected(self):
        assert is_boilerplate_image("File:OOjs_UI_icon_edit.svg") is True

    def test_shackle_icon_detected(self):
        assert is_boilerplate_image("File:Semi-protection-shackle.svg") is True

    def test_real_photo_passes(self):
        assert is_boilerplate_image("File:Lucy_skeleton.jpg") is False

    def test_real_diagram_passes(self):
        assert is_boilerplate_image("File:Hominidae_cladogram.svg") is False

    def test_real_map_passes(self):
        assert is_boilerplate_image("File:Human_migration_map.png") is False


class TestIsTooSmall:
    """Test minimum dimension filtering."""

    def test_tiny_icon_rejected(self):
        assert is_too_small(20, 20) is True

    def test_narrow_rejected(self):
        assert is_too_small(100, 500) is True

    def test_short_rejected(self):
        assert is_too_small(500, 100) is True

    def test_exact_minimum_passes(self):
        assert is_too_small(200, 200) is False

    def test_large_image_passes(self):
        assert is_too_small(800, 600) is False


class TestIsSvg:
    """Test unconditional SVG rejection (GPT-4o does not support SVG)."""

    def test_svg_rejected(self):
        assert is_svg("image/svg+xml") is True

    def test_svg_diagram_also_rejected(self):
        """Even content SVGs are rejected — GPT-4o cannot process them."""
        assert is_svg("image/svg+xml") is True

    def test_jpeg_passes(self):
        assert is_svg("image/jpeg") is False

    def test_png_passes(self):
        assert is_svg("image/png") is False


class TestPassesImageFilter:
    """Test combined filter logic."""

    def test_good_photo_passes(self):
        assert passes_image_filter("File:Lucy_skeleton.jpg", 800, 600, "image/jpeg") is True

    def test_boilerplate_rejected(self):
        assert passes_image_filter("File:Commons-logo.svg", 300, 300, "image/svg+xml") is False

    def test_small_rejected(self):
        assert passes_image_filter("File:Nice_photo.jpg", 50, 50, "image/jpeg") is False

    def test_svg_icon_rejected(self):
        assert passes_image_filter("File:Site_logo.svg", 300, 300, "image/svg+xml") is False

    def test_svg_diagram_rejected(self):
        """Even content SVGs are rejected — GPT-4o cannot process SVG format."""
        assert passes_image_filter("File:Cladogram.svg", 500, 400, "image/svg+xml") is False


class TestIsRefusalDescription:
    """Test refusal-detection on vision-model output (M8 wiring)."""

    def test_empty_string_is_refusal(self):
        assert is_refusal_description("") is True

    def test_whitespace_only_is_refusal(self):
        assert is_refusal_description("   \n\t  ") is True

    def test_im_sorry_refusal_detected(self):
        assert (
            is_refusal_description(
                "I'm sorry, I can't help with identifying or describing people in images."
            )
            is True
        )

    def test_i_cannot_refusal_detected(self):
        assert is_refusal_description("I cannot identify the person in this image.") is True

    def test_i_cant_refusal_detected(self):
        assert is_refusal_description("I can't help with that request.") is True

    def test_i_am_unable_refusal_detected(self):
        assert is_refusal_description("I am unable to describe this image.") is True

    def test_im_unable_refusal_detected(self):
        assert is_refusal_description("I'm unable to identify individuals in photographs.") is True

    def test_sorry_i_refusal_detected(self):
        assert is_refusal_description("Sorry, I can't help with that.") is True

    def test_case_insensitive(self):
        assert is_refusal_description("I'M SORRY, I CAN'T DO THAT.") is True

    def test_leading_whitespace_tolerated(self):
        assert is_refusal_description("   I'm sorry, I cannot help.") is True

    def test_legitimate_third_person_description_passes(self):
        assert (
            is_refusal_description(
                "The image shows a chimpanzee walking through a forest."
            )
            is False
        )

    def test_legitimate_a_photograph_passes(self):
        assert (
            is_refusal_description("A photograph of an African elephant in profile.") is False
        )

    def test_diagram_description_passes(self):
        assert (
            is_refusal_description(
                "This cladogram depicts the phylogenetic relationships between great ape species."
            )
            is False
        )

    def test_first_person_in_middle_not_refusal(self):
        """First-person mid-sentence does not signal refusal -- only prefix matters."""
        assert (
            is_refusal_description(
                "The illustration shows a primate; I see a long tail typical of monkeys."
            )
            is False
        )


# =============================================================================
# Category 2: Wikipedia Image Fetching — Mocked API Tests
# =============================================================================


class TestFetchWikipediaImages:
    """Test image fetching with mocked HTTP responses."""

    @pytest.mark.asyncio
    async def test_returns_filtered_images(self):
        """Verify that boilerplate images are filtered out."""
        # Mock MediaWiki API responses
        images_response = {
            "query": {
                "pages": {
                    "123": {
                        "images": [
                            {"title": "File:Lucy_skeleton.jpg"},
                            {"title": "File:Commons-logo.svg"},
                            {"title": "File:Hominid_skull.png"},
                        ]
                    }
                }
            }
        }
        imageinfo_response = {
            "query": {
                "pages": {
                    "1": {
                        "title": "File:Lucy_skeleton.jpg",
                        "imageinfo": [
                            {
                                "url": "https://upload.wikimedia.org/lucy.jpg",
                                "descriptionurl": "https://commons.wikimedia.org/wiki/File:Lucy.jpg",
                                "width": 800,
                                "height": 600,
                                "mime": "image/jpeg",
                            }
                        ],
                    },
                    "2": {
                        "title": "File:Commons-logo.svg",
                        "imageinfo": [
                            {
                                "url": "https://upload.wikimedia.org/commons-logo.svg",
                                "descriptionurl": "",
                                "width": 300,
                                "height": 300,
                                "mime": "image/svg+xml",
                            }
                        ],
                    },
                    "3": {
                        "title": "File:Hominid_skull.png",
                        "imageinfo": [
                            {
                                "url": "https://upload.wikimedia.org/skull.png",
                                "descriptionurl": "",
                                "width": 500,
                                "height": 400,
                                "mime": "image/png",
                            }
                        ],
                    },
                }
            }
        }

        mock_responses = [
            MagicMock(
                status_code=200,
                json=MagicMock(return_value=images_response),
                raise_for_status=MagicMock(),
            ),
            MagicMock(
                status_code=200,
                json=MagicMock(return_value=imageinfo_response),
                raise_for_status=MagicMock(),
            ),
        ]

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(side_effect=mock_responses)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("backend.services.multimodal.httpx.AsyncClient", return_value=mock_client):
            images = await fetch_wikipedia_images("Hominidae")

        # Commons-logo should be filtered out
        assert len(images) == 2
        assert all(isinstance(img, WikiImage) for img in images)
        titles = [img.title for img in images]
        assert "File:Commons-logo.svg" not in titles
        assert "File:Lucy_skeleton.jpg" in titles
        assert "File:Hominid_skull.png" in titles

    @pytest.mark.asyncio
    async def test_empty_when_no_images(self):
        """Articles with no images return empty list."""
        empty_response = {"query": {"pages": {"123": {"images": []}}}}

        mock_client = AsyncMock()
        mock_resp = MagicMock(
            status_code=200,
            json=MagicMock(return_value=empty_response),
            raise_for_status=MagicMock(),
        )
        mock_client.get = AsyncMock(return_value=mock_resp)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("backend.services.multimodal.httpx.AsyncClient", return_value=mock_client):
            images = await fetch_wikipedia_images("Empty_Article")

        assert images == []

    @pytest.mark.asyncio
    async def test_respects_limit(self):
        """Verify limit parameter caps results."""
        images_response = {
            "query": {
                "pages": {"123": {"images": [{"title": f"File:Photo_{i}.jpg"} for i in range(10)]}}
            }
        }
        imageinfo_pages = {}
        for i in range(10):
            imageinfo_pages[str(i)] = {
                "title": f"File:Photo_{i}.jpg",
                "imageinfo": [
                    {
                        "url": f"https://upload.wikimedia.org/photo_{i}.jpg",
                        "descriptionurl": "",
                        "width": 800,
                        "height": 600,
                        "mime": "image/jpeg",
                    }
                ],
            }
        imageinfo_response = {"query": {"pages": imageinfo_pages}}

        mock_responses = [
            MagicMock(
                status_code=200,
                json=MagicMock(return_value=images_response),
                raise_for_status=MagicMock(),
            ),
            MagicMock(
                status_code=200,
                json=MagicMock(return_value=imageinfo_response),
                raise_for_status=MagicMock(),
            ),
        ]

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(side_effect=mock_responses)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("backend.services.multimodal.httpx.AsyncClient", return_value=mock_client):
            images = await fetch_wikipedia_images("Big_Article", limit=3)

        assert len(images) <= 3


# =============================================================================
# Category 3: Vision Analysis — Mocked LLM Tests
# =============================================================================


class TestDescribeImageInContext:
    """Test vision description with mocked LLM."""

    @pytest.mark.asyncio
    async def test_parses_structured_response(self):
        from backend.services.multimodal import describe_image_in_context
        from backend.services.llm_service import LLMResponse, LLMProvider

        mock_llm = AsyncMock()
        mock_llm.complete_vision = AsyncMock(
            return_value=LLMResponse(
                content=(
                    "DESCRIPTION: A photograph of the Lucy skeleton fossil.\n"
                    "TYPE: photo\n"
                    "RELEVANCE: high"
                ),
                model="gpt-4o",
                provider=LLMProvider.OPENAI,
                input_tokens=200,
                output_tokens=30,
                total_tokens=230,
                latency_ms=500.0,
            )
        )

        desc, resp = await describe_image_in_context(
            image_url="https://example.com/lucy.jpg",
            article_title="Lucy (hominid)",
            article_summary="Lucy is the common name for AL 288-1...",
            llm=mock_llm,
        )

        assert isinstance(desc, ImageDescription)
        assert desc.description == "A photograph of the Lucy skeleton fossil."
        assert desc.content_type == "photo"
        assert desc.relevance == "high"
        assert resp.total_tokens == 230

    @pytest.mark.asyncio
    async def test_fallback_on_unparseable_response(self):
        from backend.services.multimodal import describe_image_in_context
        from backend.services.llm_service import LLMResponse, LLMProvider

        mock_llm = AsyncMock()
        mock_llm.complete_vision = AsyncMock(
            return_value=LLMResponse(
                content="This image shows a skull fossil from Ethiopia.",
                model="gpt-4o",
                provider=LLMProvider.OPENAI,
                input_tokens=200,
                output_tokens=20,
                total_tokens=220,
                latency_ms=400.0,
            )
        )

        desc, resp = await describe_image_in_context(
            image_url="https://example.com/skull.jpg",
            article_title="Australopithecine",
            article_summary="Australopithecines are early hominids...",
            llm=mock_llm,
        )

        # Should use full content as description fallback
        assert "skull fossil" in desc.description
        assert desc.content_type == "other"
        assert desc.relevance == "medium"


# =============================================================================
# Category 4: Live API Tests — Skipped Without Keys
# =============================================================================


HAS_OPENAI_KEY = bool(os.environ.get("OPENAI_API_KEY"))


@pytest.mark.skipif(not HAS_OPENAI_KEY, reason="OPENAI_API_KEY not set")
class TestLiveAPIs:
    """Integration tests that hit real APIs. Run manually."""

    @pytest.mark.asyncio
    async def test_fetch_real_wikipedia_images(self):
        """Fetch images from a known Wikipedia article."""
        images = await fetch_wikipedia_images("Hominidae", limit=3)
        assert len(images) > 0
        assert all(img.url.startswith("https://") for img in images)
        assert all(img.width >= 200 and img.height >= 200 for img in images)

    @pytest.mark.asyncio
    async def test_complete_vision_real(self):
        """Run GPT-4o vision on a real image."""
        from backend.services.llm_service import LLMService
        from backend.services.multimodal import describe_image_in_context

        llm = LLMService()
        images = await fetch_wikipedia_images("Hominidae", limit=1)
        assert len(images) > 0

        desc, resp = await describe_image_in_context(
            image_url=images[0].url,
            article_title="Hominidae",
            article_summary="The Hominidae, whose members are known as great apes...",
            llm=llm,
        )

        assert len(desc.description) > 10
        assert desc.content_type in (
            "diagram",
            "photo",
            "map",
            "chart",
            "illustration",
            "other",
        )
        assert desc.relevance in ("high", "medium", "low")
        assert resp.input_tokens > 0
