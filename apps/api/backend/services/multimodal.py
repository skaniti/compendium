"""Multimodal image fetching and vision analysis service.

Milestone 8: Fetches images from Wikipedia articles via the MediaWiki API,
filters out boilerplate icons, and uses GPT-4o vision to generate
contextual image descriptions.
"""

import logging
import re
import httpx
from pydantic import BaseModel

from backend.services.llm_service import LLMResponse, LLMService

logger = logging.getLogger(__name__)

MEDIAWIKI_API = "https://en.wikipedia.org/w/api.php"
MEDIAWIKI_HEADERS = {
    "User-Agent": "traversal-discovery/0.1 (https://github.com/traversal-discovery; browsing session analyzer) python-httpx"
}

# Image titles matching these patterns are boilerplate, not article content
BOILERPLATE_PATTERNS = [
    re.compile(r"Commons-logo", re.IGNORECASE),
    re.compile(r"Ambox", re.IGNORECASE),
    re.compile(r"Wiki-logo", re.IGNORECASE),
    re.compile(r"Wiktionary-logo", re.IGNORECASE),
    re.compile(r"Wikisource-logo", re.IGNORECASE),
    re.compile(r"Wikiquote-logo", re.IGNORECASE),
    re.compile(r"Wikibooks-logo", re.IGNORECASE),
    re.compile(r"Wikinews-logo", re.IGNORECASE),
    re.compile(r"Wikiversity-logo", re.IGNORECASE),
    re.compile(r"Wikivoyage-logo", re.IGNORECASE),
    re.compile(r"Wikidata-logo", re.IGNORECASE),
    re.compile(r"Wikispecies-logo", re.IGNORECASE),
    re.compile(r"Edit-clear", re.IGNORECASE),
    re.compile(r"Question_book", re.IGNORECASE),
    re.compile(r"Symbol_", re.IGNORECASE),
    re.compile(r"Folder_Hexagonal", re.IGNORECASE),
    re.compile(r"Text-x-generic", re.IGNORECASE),
    re.compile(r"Crystal_Clear", re.IGNORECASE),
    re.compile(r"Gnome-", re.IGNORECASE),
    re.compile(r"Nuvola_", re.IGNORECASE),
    re.compile(r"Portal-puzzle", re.IGNORECASE),
    re.compile(r"Flag_of_", re.IGNORECASE),
    re.compile(r"Disambig", re.IGNORECASE),
    re.compile(r"Lock-", re.IGNORECASE),
    re.compile(r"OOjs_UI", re.IGNORECASE),
    re.compile(r"Increase2\.svg", re.IGNORECASE),
    re.compile(r"Decrease2\.svg", re.IGNORECASE),
    re.compile(r"Steady2\.svg", re.IGNORECASE),
    re.compile(r"Semi-protection-shackle", re.IGNORECASE),
]

# Minimum dimensions — skip tiny icons and badges
MIN_WIDTH = 200
MIN_HEIGHT = 200


# =============================================================================
# Models
# =============================================================================


class WikiImage(BaseModel):
    """An image from a Wikipedia article."""

    title: str
    url: str
    description_url: str
    width: int
    height: int
    mime_type: str
    thumb_url: str | None = None  # Wikimedia thumbnail variant (300px-wide), if requested


class ImageDescription(BaseModel):
    """GPT-4o vision description of an image in article context."""

    image_url: str
    description: str
    relevance: str
    content_type: str  # diagram, photo, map, chart, illustration, other


# =============================================================================
# Image Filtering
# =============================================================================


def is_boilerplate_image(title: str) -> bool:
    """Check if an image title matches known Wikipedia boilerplate patterns."""
    return any(p.search(title) for p in BOILERPLATE_PATTERNS)


def is_too_small(width: int, height: int) -> bool:
    """Check if image dimensions are below the minimum threshold."""
    return width < MIN_WIDTH or height < MIN_HEIGHT


def is_svg(mime_type: str) -> bool:
    """Reject all SVGs — GPT-4o vision does not support SVG format."""
    return mime_type == "image/svg+xml"


def passes_image_filter(title: str, width: int, height: int, mime_type: str) -> bool:
    """Return True if an image passes all quality filters."""
    if is_boilerplate_image(title):
        return False
    if is_too_small(width, height):
        return False
    if is_svg(mime_type):
        return False
    return True


# =============================================================================
# Wikipedia Image Fetching
# =============================================================================


async def fetch_wikipedia_images(
    title: str, limit: int = 5, thumb_width: int = 300
) -> list[WikiImage]:
    """Fetch article images from Wikipedia via the MediaWiki API.

    Two-step process:
    1. Get image titles from the article (prop=images)
    2. Resolve titles to URLs and metadata (prop=imageinfo, with thumb)

    Args:
        title: Wikipedia article title (e.g., "Hominidae").
        limit: Maximum number of images to return after filtering.
        thumb_width: Width in pixels of the thumbnail variant to request
            via ``iiurlwidth``. The API populates ``thumburl`` alongside
            the full ``url`` so callers can render small previews without
            constructing thumbnail URLs themselves.

    Returns:
        List of WikiImage models, filtered and capped at limit. Each has
        ``thumb_url`` populated when MediaWiki returned one (it falls back
        to the full URL for some edge cases).
    """
    async with httpx.AsyncClient(timeout=15.0, headers=MEDIAWIKI_HEADERS) as client:
        # Step 1: Get image titles for the article
        params = {
            "action": "query",
            "titles": title,
            "prop": "images",
            "imlimit": "50",
            "format": "json",
        }
        resp = await client.get(MEDIAWIKI_API, params=params)
        resp.raise_for_status()
        data = resp.json()

        pages = data.get("query", {}).get("pages", {})
        image_titles = []
        for page in pages.values():
            for img in page.get("images", []):
                image_titles.append(img["title"])

        if not image_titles:
            return []

        # Step 2: Resolve image titles to URLs + metadata + thumb URL.
        # iiurlwidth populates `thumburl` on each imageinfo entry; without
        # it we'd have to construct thumbnail URLs from the full path,
        # which is brittle (different naming for SVG-rasterized thumbs).
        params = {
            "action": "query",
            "titles": "|".join(image_titles[:50]),
            "prop": "imageinfo",
            "iiprop": "url|size|mime",
            "iiurlwidth": str(thumb_width),
            "format": "json",
        }
        resp = await client.get(MEDIAWIKI_API, params=params)
        resp.raise_for_status()
        data = resp.json()

        images = []
        for page in data.get("query", {}).get("pages", {}).values():
            info_list = page.get("imageinfo", [])
            if not info_list:
                continue
            info = info_list[0]
            img_title = page.get("title", "")
            width = info.get("width", 0)
            height = info.get("height", 0)
            mime = info.get("mime", "")

            if not passes_image_filter(img_title, width, height, mime):
                continue

            images.append(
                WikiImage(
                    title=img_title,
                    url=info["url"],
                    description_url=info.get("descriptionurl", ""),
                    width=width,
                    height=height,
                    mime_type=mime,
                    thumb_url=info.get("thumburl") or info["url"],
                )
            )

        return images[:limit]


# =============================================================================
# Vision Analysis
# =============================================================================


# GPT-4o vision occasionally refuses to describe an image (most commonly when
# it identifies a person and declines to identify them). Real Wikipedia image
# descriptions never start with first-person "I" -- they use third-person
# ("The image shows..."). Refusals always start first-person + denial language.
# Prefix-anchored matching keeps this conservative: false-positives would need
# a real description to start with one of these exact phrases, which GPT-4o's
# style guide effectively rules out.
_REFUSAL_PREFIXES = (
    "i'm sorry",
    "i am sorry",
    "sorry, i",
    "i cannot",
    "i can't",
    "i can not",
    "i'm unable",
    "i am unable",
    "i won't",
    "i will not",
    "i'm not able",
    "i am not able",
)


def is_refusal_description(text: str) -> bool:
    """Detect vision-model refusal text (e.g., refused person identification).

    Returns True for empty/whitespace-only text and for descriptions that
    start with any first-person denial prefix in ``_REFUSAL_PREFIXES``.
    Used by the Wikipedia fetcher to drop refusal chunks before they enter
    the compendium, where they would otherwise show up as cite-able RAG
    chunks containing only an apology.
    """
    if not text or not text.strip():
        return True
    head = text.strip().lower()
    return any(head.startswith(prefix) for prefix in _REFUSAL_PREFIXES)


async def describe_image_in_context(
    image_url: str,
    article_title: str,
    article_summary: str,
    llm: LLMService,
    model: str = "gpt-4o",
    detail: str = "low",
) -> tuple[ImageDescription, LLMResponse]:
    """Use GPT-4o vision to describe an image in its article context.

    Args:
        image_url: Direct URL to the image.
        article_title: Wikipedia article title for context.
        article_summary: First paragraph of the article.
        llm: LLMService instance.
        model: Vision-capable model to use.
        detail: Image detail level ("low" = 85 tokens, "high" = variable).

    Returns:
        Tuple of (ImageDescription, LLMResponse with token/cost metrics).
    """
    prompt = (
        f'You are analyzing an image from the Wikipedia article "{article_title}".\n\n'
        f"Article summary: {article_summary[:500]}\n\n"
        "Describe this image in 2-3 sentences. Then classify it as one of: "
        "diagram, photo, map, chart, illustration, other.\n"
        "Finally, rate its relevance to understanding the article on a scale: "
        "high, medium, low.\n\n"
        "Respond in this exact format:\n"
        "DESCRIPTION: <your description>\n"
        "TYPE: <content_type>\n"
        "RELEVANCE: <high|medium|low>"
    )

    response = await llm.complete_vision(
        prompt=prompt,
        image_urls=[image_url],
        model=model,
        detail=detail,
    )

    # Parse structured response
    content = response.content
    description = ""
    content_type = "other"
    relevance = "medium"

    for line in content.split("\n"):
        line = line.strip()
        if line.startswith("DESCRIPTION:"):
            description = line[len("DESCRIPTION:") :].strip()
        elif line.startswith("TYPE:"):
            content_type = line[len("TYPE:") :].strip().lower()
        elif line.startswith("RELEVANCE:"):
            relevance = line[len("RELEVANCE:") :].strip().lower()

    # Fallback: if parsing failed, use entire content as description
    if not description:
        description = content

    img_desc = ImageDescription(
        image_url=image_url,
        description=description,
        relevance=relevance,
        content_type=content_type,
    )

    return img_desc, response
