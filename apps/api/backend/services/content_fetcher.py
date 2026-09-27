"""Content fetching service for Wikipedia, YouTube, Stack Overflow, and arXiv.

Provides async functions to extract structured content from platform URLs,
used by the browsing session analyzer to build journey summaries.
"""

import asyncio
import logging
import re
import urllib.parse
import xml.etree.ElementTree as ET
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import TYPE_CHECKING, AsyncIterator, Literal, Optional, Protocol, runtime_checkable

import httpx
import wikipediaapi
from pydantic import BaseModel, Field

from backend.services.arxiv_html_parser import (
    Section,
    arxiv_quality_gate,
    parse_ar5iv,
)
from backend.services.arxiv_pdf_parser import parse_pdf

if TYPE_CHECKING:
    # Type-only to avoid circular import: llm_service imports content_fetcher.
    from backend.services.llm_service import LLMService

logger = logging.getLogger(__name__)


@runtime_checkable
class _HasPrimaryText(Protocol):
    """Structural typing marker for content models that implement the contract.

    Every ``*Content`` Pydantic class in this module declares
    ``get_primary_text``; this Protocol exists so the factory dispatcher
    (``get_primary_text_from_dict``) can type-check its registry without
    requiring a common base class.
    """

    def get_primary_text(self) -> str: ...


from tenacity import (
    retry,
    retry_if_not_exception_type,
    stop_after_attempt,
    wait_exponential,
)
from youtube_transcript_api import YouTubeTranscriptApi

from backend.config.settings import settings
from backend.services.url_guard import (
    MAX_REDIRECTS,
    pinned_request_kwargs,
    resolve_public_url_async,
)


# =============================================================================
# Shared helpers
# =============================================================================


_HTML_TAG_RE = re.compile(r"<[^>]+>")
_WHITESPACE_RE = re.compile(r"\s+")


def _strip_html(text: str) -> str:
    """Remove HTML tags and collapse whitespace.

    Used by fetchers whose upstream sources return HTML (StackOverflow in
    particular). The strip happens in the fetcher's ``get_primary_text``
    method so all downstream consumers see clean prose — per the project
    convention that domain-specific text cleanup lives in the fetcher.
    """
    if not text:
        return ""
    cleaned = _HTML_TAG_RE.sub(" ", text)
    return _WHITESPACE_RE.sub(" ", cleaned).strip()


@asynccontextmanager
async def _client_or_default(
    client: Optional[httpx.AsyncClient],
) -> AsyncIterator[httpx.AsyncClient]:
    """Yield ``client`` when provided, otherwise create a one-shot client.

    Lets fetchers accept an injected client for testability while keeping
    the production call sites unchanged (`fetch_arxiv_paper(url)` still
    works without a client argument).
    """
    if client is not None:
        yield client
    else:
        async with httpx.AsyncClient(timeout=15.0) as new_client:
            yield new_client


# =============================================================================
# Pydantic Models
# =============================================================================


class WikipediaContent(BaseModel):
    """Content extracted from a Wikipedia article."""

    url: str
    title: str
    summary: str  # First paragraph
    full_text: str
    sections: list[dict]  # [{title, content}, ...]
    images: list[str]  # Image URLs
    categories: list[str]

    def get_primary_text(self) -> str:
        """Return the canonical text for embedding/retrieval.

        Wikipedia's ``full_text`` is the concatenated article body (minus
        boilerplate sections). Falls back to the lead ``summary`` if the
        full body is unavailable.
        """
        body = self.full_text or self.summary
        return f"{self.title}\n\n{body}".strip() if body else self.title


class YouTubeMetadata(BaseModel):
    """Metadata from a YouTube video."""

    url: str
    video_id: str
    title: str
    description: str
    channel: str
    duration_seconds: int
    transcript: Optional[str] = None  # If available

    def get_primary_text(self) -> str:
        """Return transcript if available, else fall back to description.

        Transcripts are the richest text signal for YouTube; descriptions
        are kept as a fallback since many videos (especially shorts) have
        no transcript available.
        """
        body = self.transcript or self.description
        return f"{self.title}\n\n{body}".strip() if body else self.title


class StackOverflowQuestion(BaseModel):
    """Content from a Stack Overflow question."""

    url: str
    question_id: int
    title: str
    body: str  # HTML body
    score: int
    answer_count: int
    tags: list[str]
    creation_date: str  # ISO 8601
    link: str
    owner_name: Optional[str] = None
    top_answer: Optional[str] = None  # Highest-voted answer body

    def get_primary_text(self) -> str:
        """Return title + HTML-stripped question body + top answer.

        The Stack Exchange API returns ``body`` and ``top_answer`` as raw
        HTML — stripping happens here so both clustering and RAG receive
        clean prose. The raw HTML remains in the stored ``fetched_content``
        JSONB for recovery/debugging purposes.
        """
        parts = [self.title]
        clean_body = _strip_html(self.body)
        if clean_body:
            parts.append(clean_body)
        if self.top_answer:
            clean_answer = _strip_html(self.top_answer)
            if clean_answer:
                parts.append(f"--- Top Answer ---\n{clean_answer}")
        return "\n\n".join(parts)


class ArxivPaper(BaseModel):
    """Metadata + (optionally) full-paper extraction from an arXiv paper.

    The four extraction fields (``body_text``, ``sections``,
    ``extraction_method``, ``extraction_warnings``) are populated by the
    ar5iv + PDF-fallback pipeline added 2026-05-03. Older captures and
    fallback failures store the abstract-only baseline (defaults below).
    Persisted via JSONB in ``page_content.fetched_content``; no DB
    migration required.
    """

    url: str
    paper_id: str  # e.g. "2301.12345v2"
    title: str
    abstract: str
    authors: list[str]
    categories: list[str]  # e.g. ["cs.CL", "cs.AI"]
    published: str  # ISO 8601
    pdf_url: str

    body_text: Optional[str] = None
    sections: Optional[list[Section]] = None
    extraction_method: Literal["ar5iv", "pdf", "abstract_only"] = "abstract_only"
    extraction_warnings: list[str] = Field(default_factory=list)

    def get_primary_text(self) -> str:
        """Return body when populated, else fall back to title + abstract.

        Body text supersedes the abstract because it carries the
        load-bearing detail (methods, results, numbers) the abstract
        only summarizes.
        """
        if self.body_text:
            return f"{self.title}\n\n{self.body_text}".strip()
        return f"{self.title}\n\n{self.abstract}".strip() if self.abstract else self.title


class RedditContent(BaseModel):
    """Content extracted from a Reddit post."""

    url: str
    post_id: str
    title: str
    subreddit: str
    selftext: str  # Post body (empty for link posts)
    score: int
    comment_count: int
    author: Optional[str] = None
    top_comments: list[str]  # Body text of top-level comments

    def get_primary_text(self) -> str:
        """Return title + post body + top 3 comments.

        Link posts have an empty ``selftext``; in that case the comments
        carry all the topical signal and the marker line is omitted. Only
        the first three comments are included — reddit's long-tail
        commentary tends to drift off-topic and introduces platform-specific
        noise that distorts SBERT embeddings.
        """
        parts = [self.title]
        if self.selftext:
            parts.append(self.selftext)
        if self.top_comments:
            comments = self.top_comments[:3]
            parts.append("--- Comments ---\n" + "\n\n".join(comments))
        return "\n\n".join(parts)

    def get_clustering_text(self) -> str:
        """Subreddit-prefixed title + post body, no comments.

        Comments carry conversational tone that embeds similarly across
        unrelated posts, causing false clustering by Reddit format rather
        than topic. The subreddit name is prepended as a strong topical
        anchor — SBERT encodes "r/chinesefood: Lo mein recipe?" very
        differently from "r/boardgames: deck box storage components".
        """
        parts = [f"r/{self.subreddit}: {self.title}"]
        if self.selftext:
            parts.append(self.selftext)
        return "\n\n".join(parts)


class GitHubRepoContent(BaseModel):
    """Content extracted from a GitHub repository page."""

    url: str
    owner: str
    repo: str
    description: str
    full_text: str  # README or issue/PR body
    topics: list[str]
    stars: int
    language: Optional[str] = None

    def get_primary_text(self) -> str:
        """Return repo description + README/issue body.

        The short description anchors the topic; ``full_text`` holds the
        README or issue body, which is where detailed signal lives.
        """
        parts = [f"{self.owner}/{self.repo}"]
        if self.description:
            parts.append(self.description)
        if self.full_text:
            parts.append(self.full_text)
        return "\n\n".join(parts)


class BGGGameContent(BaseModel):
    """Content extracted from a BoardGameGeek game/expansion page."""

    url: str
    bgg_id: int
    title: str
    description: str  # Full game description
    full_text: str  # Description + mechanics + categories
    year_published: Optional[int] = None
    min_players: Optional[int] = None
    max_players: Optional[int] = None
    playing_time: Optional[int] = None
    categories: list[str]
    mechanics: list[str]

    def get_primary_text(self) -> str:
        """Return title + full_text (description + mechanics + categories).

        ``full_text`` is already assembled at fetch time with all the
        topical signal. BGG currently falls back to Readability extraction
        (Cloudflare blocks direct API access), but this method is here for
        future-proofing if BGG access is restored.
        """
        return f"{self.title}\n\n{self.full_text}".strip() if self.full_text else self.title


class ExtractedContent(BaseModel):
    """Content extracted client-side via Readability.js or server-side via BeautifulSoup.

    Used for pages not covered by platform-specific fetchers (blogs, news, docs, etc.).
    """

    url: str
    title: Optional[str] = None
    text: str
    source: str = "content_script"  # "content_script" | "beautifulsoup" | "api"
    char_count: int

    def get_primary_text(self) -> str:
        """Return title + extracted body text.

        The generic fallback for pages without a domain-specific fetcher.
        Readability.js has already stripped obvious boilerplate at capture
        time; nothing further to do here.
        """
        if self.title and self.text:
            return f"{self.title}\n\n{self.text}"
        return self.text or self.title or ""


class GenericPageContent(BaseModel):
    """Server-side main-content extraction for arbitrary URLs via trafilatura.

    Stage 0 fallback for domains not in ``DOMAIN_TO_FETCHER``. Replaces the
    prior catchall path that required client-side ``extracted_text`` from
    the browser extension; works for direct curated URLs (e.g., demo
    seeding) where no extension capture exists.
    """

    url: str
    title: str = ""             # may be empty if the page has no <title>
    description: str = ""       # meta description, often empty
    full_text: str = ""         # trafilatura-extracted main body
    char_count: int = 0
    source: str = "trafilatura"

    def get_primary_text(self) -> str:
        """Return title + extracted body, mirroring ExtractedContent's contract."""
        if self.title and self.full_text:
            return f"{self.title}\n\n{self.full_text}"
        return self.full_text or self.description or self.title or ""


# =============================================================================
# Content-model factory / dispatcher
# =============================================================================
#
# Maps ``tool_selected`` (stored on page_content.tool_selected) to the
# Pydantic class that owns that content shape. Adding a new fetcher requires
# registering here so all downstream consumers (clustering embeddings, RAG
# chunker, Stage 0 summary builder) route through the same contract.
#
# Keys mirror the function names in DOMAIN_TO_FETCHER at backend/api/main.py.


# The registry value type is intentionally broad — each class is a
# BaseModel subclass whose instances also satisfy _HasPrimaryText. Pyright
# validates the method exists on each concrete class at the call site.
_CONTENT_CLASS_BY_TOOL: dict[str, type[BaseModel]] = {
    "fetch_wikipedia_content": WikipediaContent,
    "fetch_youtube_metadata": YouTubeMetadata,
    "fetch_stackoverflow_question": StackOverflowQuestion,
    "fetch_arxiv_paper": ArxivPaper,
    "fetch_reddit_content": RedditContent,
    "fetch_github_content": GitHubRepoContent,
    "fetch_bgg_content": BGGGameContent,  # reserved; not currently dispatched
    "fetch_generic_content": GenericPageContent,
    "get_extracted_content": ExtractedContent,
}


def get_primary_text_from_dict(
    tool_selected: Optional[str],
    content_dict: Optional[dict],
    for_clustering: bool = False,
) -> tuple[str, str]:
    """Resolve the primary embedding/retrieval text for a content dict.

    Returns a ``(text, source)`` pair where ``source`` is a short label
    identifying which code path produced the text — useful for diagnostics,
    audit logging, and the future ``sbert_text_source`` column (Plan 06).

    When *for_clustering* is True, prefers ``get_clustering_text()`` if the
    content class defines it (currently only ``RedditContent``). This strips
    domain-specific noise (e.g. Reddit comments) that helps retrieval but
    hurts topical clustering.

    Routing order:
    1. If ``tool_selected`` matches a known content class, validate the
       dict against it and call ``get_primary_text()`` (or
       ``get_clustering_text()`` if *for_clustering*).
    2. If validation fails OR the tool is unknown, fall back to a
       best-effort key scan that matches the legacy priority chain.
    3. If nothing readable is found, return the title alone (if present).
    4. If the dict is empty, return ``("", "empty")``.

    The fallback paths exist for resilience: old page_content rows written
    before this contract existed may have ``tool_selected IS NULL``, and
    Pydantic validation can fail if the schema has drifted. We never raise
    — the caller expects a string.
    """
    if not content_dict:
        return ("", "empty")

    # Happy path: typed class method.
    # The registry holds BaseModel subclasses, but each is also a
    # _HasPrimaryText (duck-typed). We start with `object` so Pyright's
    # isinstance() narrowing kicks in against the runtime_checkable Protocol.
    cls = _CONTENT_CLASS_BY_TOOL.get(tool_selected or "")
    if cls is not None:
        try:
            instance: object = cls.model_validate(content_dict)
            if isinstance(instance, _HasPrimaryText):
                # Use clustering-specific text if available and requested
                if for_clustering and hasattr(instance, "get_clustering_text"):
                    text = instance.get_clustering_text()  # type: ignore[attr-defined]
                    if text:
                        return (text, f"{cls.__name__}.get_clustering_text")
                text = instance.get_primary_text()
                if text:
                    return (text, f"{cls.__name__}.get_primary_text")
        except Exception:
            # Validation failed — fall through to key-scan fallback.
            # Likely cause: old row written against a different schema version.
            pass

    # Fallback 1: legacy key priority chain. Matches what _build_sbert_text
    # did before this contract existed — keeps old rows working.
    title = content_dict.get("title", "") or ""
    for key in ("full_text", "transcript", "body", "abstract", "text", "selftext"):
        val = content_dict.get(key)
        if val and isinstance(val, str):
            return (
                f"{title}\n\n{val}" if title else val,
                f"fallback:{key}",
            )

    # Fallback 2: title only
    if title:
        return (title, "fallback:title_only")

    return ("", "empty")


async def get_extracted_content(
    url: str, extracted_text: Optional[str] = None, title: Optional[str] = None
) -> Optional[ExtractedContent]:
    """Return client-side extracted content for a URL.

    This is NOT a network call — the content was already captured by the extension
    and passed in via the session payload's extractedText field.
    """
    if not extracted_text:
        return None

    return ExtractedContent(
        url=url,
        title=title,
        text=extracted_text,
        source="content_script",
        char_count=len(extracted_text),
    )


# =============================================================================
# Custom Exceptions
# =============================================================================


class ContentFetchError(Exception):
    """Base exception for content fetching errors."""


class InvalidURLError(ContentFetchError):
    """Raised when a URL is not valid for the expected platform."""


class ResourceNotFoundError(ContentFetchError):
    """Raised when the requested resource does not exist."""


# =============================================================================
# URL Parsing Helpers
# =============================================================================


def _extract_wikipedia_title(url: str) -> str:
    """Extract the article title from a Wikipedia URL.

    Handles URL-encoded characters and anchor fragments.

    Args:
        url: A Wikipedia article URL.

    Returns:
        The decoded article title.

    Raises:
        InvalidURLError: If the URL does not contain /wiki/.
    """
    parsed = urllib.parse.urlparse(url)
    path = parsed.path

    if "/wiki/" not in path:
        raise InvalidURLError(f"Not a valid Wikipedia URL (missing /wiki/): {url}")

    # Extract everything after /wiki/
    title_encoded = path.split("/wiki/", 1)[1]

    # Strip any trailing slashes
    title_encoded = title_encoded.rstrip("/")

    # Decode URL-encoded characters (e.g., %20 -> space)
    title = urllib.parse.unquote(title_encoded)

    return title


def _extract_youtube_video_id(url: str) -> str:
    """Extract the video ID from various YouTube URL formats.

    Supported formats:
        - https://www.youtube.com/watch?v=VIDEO_ID
        - https://youtu.be/VIDEO_ID
        - https://www.youtube.com/embed/VIDEO_ID
        - https://www.youtube.com/shorts/VIDEO_ID

    Args:
        url: A YouTube video URL.

    Returns:
        The 11-character video ID.

    Raises:
        InvalidURLError: If no video ID can be extracted.
    """
    parsed = urllib.parse.urlparse(url)

    # Format: youtube.com/watch?v=VIDEO_ID
    if parsed.hostname in ("www.youtube.com", "youtube.com", "m.youtube.com"):
        if parsed.path == "/watch":
            query_params = urllib.parse.parse_qs(parsed.query)
            video_ids = query_params.get("v")
            if video_ids:
                return video_ids[0]

        # Format: youtube.com/embed/VIDEO_ID or youtube.com/shorts/VIDEO_ID
        match = re.match(r"^/(?:embed|shorts)/([a-zA-Z0-9_-]+)", parsed.path)
        if match:
            return match.group(1)

    # Format: youtu.be/VIDEO_ID
    if parsed.hostname in ("youtu.be", "www.youtu.be"):
        video_id = parsed.path.lstrip("/")
        if video_id:
            return video_id.split("/")[0]

    raise InvalidURLError(f"Could not extract YouTube video ID from URL: {url}")


def _extract_stackoverflow_question_id(url: str) -> int:
    """Extract the question ID from a Stack Overflow URL.

    Handles URLs like:
        https://stackoverflow.com/questions/11227809/why-is-processing-a-sorted-array-faster
        https://stackoverflow.com/q/927358

    Site-agnostic by design — every SE-family question URL uses the same
    `/questions/<id>/` or `/q/<id>` path shape regardless of which SE
    site (electronics, serverfault, etc.) hosts it.

    Args:
        url: A Stack Exchange question URL.

    Returns:
        The numeric question ID.

    Raises:
        InvalidURLError: If the /questions/ or /q/ pattern is not found.
    """
    parsed = urllib.parse.urlparse(url)
    match = re.search(r"/(?:questions|q)/(\d+)", parsed.path)
    if not match:
        raise InvalidURLError(f"Could not extract Stack Overflow question ID from URL: {url}")
    return int(match.group(1))


# Hostname -> SE API `site=` parameter for the SE-family sites we route.
# Exact-match dict; the *.stackexchange.com fallback is computed below.
# Add entries here when adding a new top-level SE-family site to
# DOMAIN_TO_FETCHER.
_SE_SPECIAL_HOSTS: dict[str, str] = {
    "stackoverflow.com": "stackoverflow",
    "meta.stackoverflow.com": "meta.stackoverflow",
    "serverfault.com": "serverfault",
    "superuser.com": "superuser",
    "askubuntu.com": "askubuntu",
    "mathoverflow.net": "mathoverflow.net",  # legacy domain, not *.stackexchange.com
}


def _extract_se_site(url: str) -> str:
    """Resolve the SE API site identifier from a question URL hostname.

    Pattern is uniform across SE-family sites:
    - top-level hosts (stackoverflow.com, serverfault.com, ...): see
      ``_SE_SPECIAL_HOSTS``
    - ``<name>.stackexchange.com`` -> the first label is the site id
      (e.g., electronics.stackexchange.com -> "electronics")

    Falls back to "stackoverflow" for unrecognized hosts so calls that
    previously worked under the hardcoded ``site=stackoverflow`` keep
    their prior semantics.
    """
    host = (urllib.parse.urlparse(url).hostname or "").lower()
    if host in _SE_SPECIAL_HOSTS:
        return _SE_SPECIAL_HOSTS[host]
    if host.endswith(".stackexchange.com"):
        return host.split(".", 1)[0]
    return "stackoverflow"


def _extract_arxiv_paper_id(url: str) -> str:
    """Extract the paper ID from an arXiv URL.

    Handles URLs like:
        https://arxiv.org/abs/2301.12345
        https://arxiv.org/pdf/2301.12345v2

    Args:
        url: An arXiv paper URL.

    Returns:
        The paper ID string (e.g., "2301.12345v2").

    Raises:
        InvalidURLError: If the /abs/ or /pdf/ pattern is not found.
    """
    parsed = urllib.parse.urlparse(url)
    match = re.search(r"/(?:abs|pdf)/(\d{4}\.\d{4,5}(?:v\d+)?)", parsed.path)
    if not match:
        raise InvalidURLError(f"Could not extract arXiv paper ID from URL: {url}")
    return match.group(1)


def _build_reddit_json_url(url: str) -> str:
    """Build the .json API URL from a Reddit URL.

    Strips query params and fragments, ensures trailing slash, appends .json.

    Args:
        url: A Reddit URL (post, subreddit, or search).

    Returns:
        The corresponding .json endpoint URL.
    """
    parsed = urllib.parse.urlparse(url)
    path = parsed.path.rstrip("/") + "/"
    return f"https://www.reddit.com{path}.json"


# =============================================================================
# Helper Utilities
# =============================================================================


def _parse_iso8601_duration(duration: str) -> int:
    """Convert an ISO 8601 duration string to total seconds.

    Examples:
        PT4M13S -> 253
        PT1H2M3S -> 3723
        PT30S -> 30

    Args:
        duration: An ISO 8601 duration string (e.g., "PT4M13S").

    Returns:
        Total duration in seconds.
    """
    match = re.match(
        r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?",
        duration,
    )
    if not match:
        return 0

    hours = int(match.group(1) or 0)
    minutes = int(match.group(2) or 0)
    seconds = int(match.group(3) or 0)

    return hours * 3600 + minutes * 60 + seconds


def _collect_sections(sections) -> list[dict]:
    """Recursively collect sections from a Wikipedia page.

    Args:
        sections: An iterable of WikipediaPage section objects.

    Returns:
        A flat list of dicts with 'title' and 'content' keys.
    """
    result = []
    for section in sections:
        result.append({"title": section.title, "content": section.text})
        result.extend(_collect_sections(section.sections))
    return result


# =============================================================================
# Content Fetchers
# =============================================================================


@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=2, max=10),
    retry=retry_if_not_exception_type(ContentFetchError),
    reraise=True,
)
async def fetch_wikipedia_content(
    url: str,
    llm: "LLMService | None" = None,
) -> WikipediaContent:
    """Fetch content from a Wikipedia article.

    Uses the wikipedia-api library to extract structured page content
    including sections, categories, and images. Handles disambiguation
    pages by noting them in the summary.

    When ``llm`` is provided, the function additionally fetches up to 3
    article images via the MediaWiki API, generates GPT-4o vision
    descriptions, and appends them as a synthetic "Image descriptions
    (AI-generated)" section so they enter the RAG chunker. The vision
    pass is best-effort: any failure is logged and the article is
    returned with text-only content (M8 multi-modality wiring).

    Args:
        url: A Wikipedia article URL.
        llm: Optional LLMService for vision; omit to skip the image pass.

    Returns:
        A WikipediaContent model with extracted page data.

    Raises:
        InvalidURLError: If the URL is not a valid Wikipedia URL.
        ResourceNotFoundError: If the article does not exist.
    """
    title = _extract_wikipedia_title(url)

    def _fetch() -> WikipediaContent:
        wiki = wikipediaapi.Wikipedia(
            user_agent="traversal-discovery/0.1",
            language="en",
        )
        page = wiki.page(title)

        if not page.exists():
            raise ResourceNotFoundError(f"Wikipedia article not found: {title}")

        # Check for disambiguation pages
        summary = page.summary
        is_disambiguation = any(
            "disambiguation" in cat_name.lower() for cat_name in page.categories.keys()
        )
        if is_disambiguation:
            summary = f"[Disambiguation page] {summary}"

        # Collect sections recursively
        sections = _collect_sections(page.sections)

        # Extract category names (strip "Category:" prefix)
        categories = [cat_name.replace("Category:", "") for cat_name in page.categories.keys()]

        # Extract image URLs via MediaWiki API (wikipedia-api lib doesn't expose images)
        images = []
        try:
            mw_headers = {
                "User-Agent": "traversal-discovery/0.1 (https://github.com/traversal-discovery; browsing session analyzer) python-httpx"
            }
            api_resp = httpx.get(
                "https://en.wikipedia.org/w/api.php",
                params={
                    "action": "query",
                    "titles": title,
                    "prop": "images",
                    "imlimit": "50",
                    "format": "json",
                },
                headers=mw_headers,
                timeout=10.0,
            )
            api_resp.raise_for_status()
            api_pages = api_resp.json().get("query", {}).get("pages", {})
            img_titles = []
            for p in api_pages.values():
                img_titles.extend(img["title"] for img in p.get("images", []))
            if img_titles:
                info_resp = httpx.get(
                    "https://en.wikipedia.org/w/api.php",
                    params={
                        "action": "query",
                        "titles": "|".join(img_titles[:50]),
                        "prop": "imageinfo",
                        "iiprop": "url",
                        "format": "json",
                    },
                    headers=mw_headers,
                    timeout=10.0,
                )
                info_resp.raise_for_status()
                for p in info_resp.json().get("query", {}).get("pages", {}).values():
                    for info in p.get("imageinfo", []):
                        if "url" in info:
                            images.append(info["url"])
        except Exception:
            pass  # Image extraction is non-critical; return empty list

        return WikipediaContent(
            url=url,
            title=page.title,
            summary=summary,
            full_text=page.text,
            sections=sections,
            images=images,
            categories=categories,
        )

    content = await asyncio.to_thread(_fetch)

    if llm is not None:
        try:
            from backend.services.multimodal import (
                describe_image_in_context,
                fetch_wikipedia_images,
                is_refusal_description,
            )

            wiki_images = await fetch_wikipedia_images(content.title, limit=3)
            if wiki_images:
                # Parallel vision calls; gather with return_exceptions so a single
                # failure doesn't tank the rest. Per-image timeouts are inherited
                # from describe_image_in_context's underlying httpx client.
                vision_results = await asyncio.gather(
                    *(
                        describe_image_in_context(
                            image_url=img.url,
                            article_title=content.title,
                            article_summary=content.summary[:500],
                            llm=llm,
                        )
                        for img in wiki_images
                    ),
                    return_exceptions=True,
                )
                described: list[str] = []
                refusals = 0
                for img, result in zip(wiki_images, vision_results):
                    if isinstance(result, BaseException):
                        logger.warning(
                            "Vision call failed for %s: %s", img.url, result
                        )
                        continue
                    desc, _ = result
                    if is_refusal_description(desc.description):
                        refusals += 1
                        logger.info(
                            "Vision refusal filtered for %s (description starts with first-person denial)",
                            img.url,
                        )
                        continue
                    # Embed image URL marker on its own line so the agent
                    # can parse it out for the chat-images strip without
                    # the LLM citing raw URLs in the answer body. Format:
                    # [image: <thumb_url> | source: <full_url>]
                    thumb = img.thumb_url or img.url
                    described.append(
                        f"Image ({desc.content_type}, relevance={desc.relevance}): "
                        f"{desc.description}\n"
                        f"[image: {thumb} | source: {img.url}]"
                    )
                if described:
                    images_block = "\n\n".join(described)
                    content.sections.append(
                        {
                            "title": "Image descriptions (AI-generated)",
                            "content": images_block,
                        }
                    )
                    content.full_text = (
                        f"{content.full_text}\n\n"
                        f"Image descriptions (AI-generated):\n\n{images_block}"
                    )
                    logger.info(
                        "Wikipedia multimodal: %d/%d image descriptions appended for %r (refusals filtered: %d)",
                        len(described),
                        len(wiki_images),
                        content.title,
                        refusals,
                    )
        except Exception as e:
            logger.warning(
                "Multimodal block failed for %r: %s", content.title, e
            )
            # Fall through with text-only content

    return content


@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=2, max=10),
    retry=retry_if_not_exception_type(ContentFetchError),
    reraise=True,
)
async def fetch_youtube_metadata(url: str) -> YouTubeMetadata:
    """Fetch metadata and optional transcript from a YouTube video.

    If a YouTube Data API key is configured, uses the official API for
    full metadata (title, description, channel, duration). Otherwise
    falls back to the noembed.com oEmbed endpoint for basic info.

    Transcript retrieval is always attempted via youtube-transcript-api.

    Args:
        url: A YouTube video URL.

    Returns:
        A YouTubeMetadata model with video information.

    Raises:
        InvalidURLError: If the URL is not a valid YouTube URL.
        ResourceNotFoundError: If the video does not exist.
    """
    video_id = _extract_youtube_video_id(url)

    title = ""
    description = ""
    channel = ""
    duration_seconds = 0

    async with httpx.AsyncClient(timeout=15.0) as client:
        if settings.youtube_api_key:
            # Official YouTube Data API
            api_url = (
                "https://www.googleapis.com/youtube/v3/videos"
                f"?part=snippet,contentDetails&id={video_id}"
                f"&key={settings.youtube_api_key}"
            )
            response = await client.get(api_url)
            response.raise_for_status()
            data = response.json()

            items = data.get("items", [])
            if not items:
                raise ResourceNotFoundError(f"YouTube video not found: {video_id}")

            snippet = items[0]["snippet"]
            content_details = items[0]["contentDetails"]

            title = snippet.get("title", "")
            description = snippet.get("description", "")
            channel = snippet.get("channelTitle", "")
            duration_seconds = _parse_iso8601_duration(content_details.get("duration", "PT0S"))
        else:
            # Fallback: noembed oEmbed endpoint
            noembed_url = (
                f"https://noembed.com/embed" f"?url=https://www.youtube.com/watch?v={video_id}"
            )
            response = await client.get(noembed_url)
            response.raise_for_status()
            data = response.json()

            title = data.get("title", "")
            channel = data.get("author_name", "")
            description = ""
            duration_seconds = 0

    # Attempt transcript retrieval (non-fatal if unavailable)
    transcript = None
    try:
        ytt_api = YouTubeTranscriptApi()
        fetched = await asyncio.to_thread(ytt_api.fetch, video_id)
        transcript = " ".join(snippet.text for snippet in fetched)
    except Exception:
        # Transcript unavailable — this is expected for many videos
        pass

    return YouTubeMetadata(
        url=url,
        video_id=video_id,
        title=title,
        description=description,
        channel=channel,
        duration_seconds=duration_seconds,
        transcript=transcript,
    )


@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=2, max=10),
    retry=retry_if_not_exception_type(ContentFetchError),
    reraise=True,
)
async def fetch_stackoverflow_question(url: str) -> StackOverflowQuestion:
    """Fetch content from a Stack Exchange question.

    Uses the Stack Exchange API v2.3 (unauthenticated, 300 req/day).
    Retrieves the question body and optionally the top-voted answer.
    Site-aware: routes to the correct SE site (stackoverflow, electronics,
    serverfault, etc.) based on the URL hostname via ``_extract_se_site``.

    Args:
        url: A Stack Exchange question URL (any site in the SE family).

    Returns:
        A StackOverflowQuestion model with extracted question data.

    Raises:
        InvalidURLError: If the URL is not a valid SE-family question URL.
        ResourceNotFoundError: If the question does not exist on its site.
    """
    question_id = _extract_stackoverflow_question_id(url)
    site = _extract_se_site(url)

    async with httpx.AsyncClient(timeout=15.0) as client:
        # Fetch question with body
        api_url = (
            f"https://api.stackexchange.com/2.3/questions/{question_id}"
            f"?site={site}&filter=withbody"
        )
        response = await client.get(api_url)
        response.raise_for_status()
        data = response.json()

        items = data.get("items", [])
        if not items:
            raise ResourceNotFoundError(
                f"Stack Exchange question not found on {site!r}: {question_id}"
            )

        question = items[0]

        # Convert Unix epoch to ISO 8601
        creation_epoch = question.get("creation_date", 0)
        creation_date = datetime.fromtimestamp(creation_epoch, tz=timezone.utc).isoformat()

        owner = question.get("owner", {})
        owner_name = owner.get("display_name") if owner else None

        # Fetch top answer if answers exist
        top_answer = None
        if question.get("answer_count", 0) > 0:
            answers_url = (
                f"https://api.stackexchange.com/2.3/questions/{question_id}/answers"
                f"?site={site}&filter=withbody&sort=votes&pagesize=1"
            )
            ans_response = await client.get(answers_url)
            ans_response.raise_for_status()
            ans_data = ans_response.json()
            ans_items = ans_data.get("items", [])
            if ans_items:
                top_answer = ans_items[0].get("body")

    return StackOverflowQuestion(
        url=url,
        question_id=question_id,
        title=question.get("title", ""),
        body=question.get("body", ""),
        score=question.get("score", 0),
        answer_count=question.get("answer_count", 0),
        tags=question.get("tags", []),
        creation_date=creation_date,
        link=question.get("link", ""),
        owner_name=owner_name,
        top_answer=top_answer,
    )


async def _fetch_arxiv_pdf(
    paper_id: str, client: httpx.AsyncClient
) -> Optional[bytes]:
    """Fetch the arXiv PDF for a paper, or None if unavailable.

    Same failure-tolerant semantics as ``fetch_arxiv_html_render`` —
    returns None on HTTP status != 200 or network/timeout errors so the
    caller can fall through to abstract-only.
    """
    pdf_url = f"https://arxiv.org/pdf/{paper_id}"
    try:
        response = await client.get(pdf_url, follow_redirects=True)
    except httpx.HTTPError:
        return None
    if response.status_code != 200:
        return None
    return response.content


async def fetch_arxiv_html_render(
    paper_id: str, client: httpx.AsyncClient
) -> Optional[str]:
    """Fetch ar5iv's HTML render of an arXiv paper, or None if unavailable.

    Returns None on:
      - HTTP status != 200 (ar5iv has no render — typically pre-2007 or
        LaTeX-source-missing papers; clean 404 chain)
      - Network error / timeout (ar5iv is best-effort; the abstract is
        still available, so callers fall back rather than fail)

    Render *quality* is not validated here — degraded renders return 200
    with inline ``ltx_ERROR`` markers and require post-fetch inspection
    via the Phase 2 quality gate.
    """
    url = f"https://ar5iv.labs.arxiv.org/html/{paper_id}"
    try:
        response = await client.get(url, follow_redirects=True)
    except httpx.HTTPError:
        return None
    if response.status_code != 200:
        return None
    return response.text


# arxiv asks for >=3s between API calls (https://info.arxiv.org/help/api/tou.html).
# Sequential captures over many arxiv URLs (e.g. demo ingestion of the
# diffusion supercluster) will 429 without this throttle. Module-level
# state is process-scoped; each FastAPI worker enforces independently
# but production captures are sequential per the _capture_processing_semaphore.
import time as _time

_ARXIV_METADATA_MIN_INTERVAL = 3.0
_arxiv_metadata_last_call: float = 0.0
_arxiv_metadata_lock: Optional[asyncio.Lock] = None


async def _arxiv_metadata_throttle() -> None:
    """Enforce >=3s spacing on export.arxiv.org metadata calls."""
    global _arxiv_metadata_last_call, _arxiv_metadata_lock
    if _arxiv_metadata_lock is None:
        _arxiv_metadata_lock = asyncio.Lock()
    async with _arxiv_metadata_lock:
        elapsed = _time.monotonic() - _arxiv_metadata_last_call
        if elapsed < _ARXIV_METADATA_MIN_INTERVAL:
            await asyncio.sleep(_ARXIV_METADATA_MIN_INTERVAL - elapsed)
        _arxiv_metadata_last_call = _time.monotonic()


@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=2, max=10),
    retry=retry_if_not_exception_type(ContentFetchError),
    reraise=True,
)
async def fetch_arxiv_paper(
    url: str, *, client: Optional[httpx.AsyncClient] = None
) -> ArxivPaper:
    """Fetch metadata + (when available) full body for an arXiv paper.

    Two-stage extraction:
      1. arXiv Atom API for title / abstract / authors / categories /
         published / pdf_url.
      2. ar5iv (https://ar5iv.labs.arxiv.org) for the rendered LaTeX
         body, parsed into structured sections via ``parse_ar5iv``.

    When ar5iv is unavailable (404, network error, or render emits no
    parseable sections), the paper falls back to abstract-only with
    ``extraction_method="abstract_only"`` and a warning explaining why.
    The PDF fallback path will land in Phase 2.

    Args:
        url: An arXiv paper URL.
        client: Optional injected HTTP client (for testing). When None,
            a one-shot client is created for the call.

    Returns:
        An ArxivPaper model. Always populated for metadata fields;
        body_text/sections are populated only on successful ar5iv
        extraction.

    Raises:
        InvalidURLError: If the URL is not a valid arXiv URL.
        ResourceNotFoundError: If the paper does not exist on arXiv.
    """
    paper_id = _extract_arxiv_paper_id(url)

    async with _client_or_default(client) as c:
        await _arxiv_metadata_throttle()
        api_url = f"https://export.arxiv.org/api/query?id_list={paper_id}"
        response = await c.get(api_url)
        response.raise_for_status()
        atom_xml = response.text
        html_render = await fetch_arxiv_html_render(paper_id, c)
        extraction = await _resolve_extraction(paper_id, html_render, c)

    # Parse Atom XML (CPU-bound; no need to hold the client open)
    ns = {"atom": "http://www.w3.org/2005/Atom"}
    root = ET.fromstring(atom_xml)

    entries = root.findall("atom:entry", ns)
    if not entries:
        raise ResourceNotFoundError(f"arXiv paper not found: {paper_id}")

    entry = entries[0]

    # Normalize whitespace (arXiv XML often has embedded newlines)
    raw_title = entry.findtext("atom:title", default="", namespaces=ns)
    title = " ".join(raw_title.split())

    raw_abstract = entry.findtext("atom:summary", default="", namespaces=ns)
    abstract = " ".join(raw_abstract.split())

    authors = [
        author.findtext("atom:name", default="", namespaces=ns)
        for author in entry.findall("atom:author", ns)
    ]

    # Extract categories from <category term="cs.CL" />
    categories = [
        cat.get("term", "") for cat in entry.findall("atom:category", ns) if cat.get("term")
    ]

    published = entry.findtext("atom:published", default="", namespaces=ns)

    # Build PDF URL from paper ID
    pdf_url = f"https://arxiv.org/pdf/{paper_id}"

    # Phase 2: ar5iv -> quality gate -> PDF fallback -> abstract_only chain
    body_text, sections, extraction_method, extraction_warnings = extraction

    return ArxivPaper(
        url=url,
        paper_id=paper_id,
        title=title,
        abstract=abstract,
        authors=authors,
        categories=categories,
        published=published,
        pdf_url=pdf_url,
        body_text=body_text,
        sections=sections,
        extraction_method=extraction_method,
        extraction_warnings=extraction_warnings,
    )


async def _resolve_extraction(
    paper_id: str,
    html: Optional[str],
    client: httpx.AsyncClient,
) -> tuple[
    Optional[str],
    Optional[list[Section]],
    Literal["ar5iv", "pdf", "abstract_only"],
    list[str],
]:
    """Run the ar5iv -> quality gate -> PDF fallback -> abstract_only chain.

    Each fallthrough adds a structured warning naming the trigger so
    downstream auditing (which paper came through which path) reads
    the warnings list.
    """
    # Stage 1: try ar5iv
    ar5iv_warnings: list[str] = []
    if html is None:
        ar5iv_warnings.append("ar5iv: render not available")
        logger.info(
            "arxiv extraction fallthrough: paper_id=%s stage=ar5iv reason=no_render",
            paper_id,
        )
    else:
        parsed = parse_ar5iv(html)
        if arxiv_quality_gate(parsed) == "accept":
            warnings: list[str] = []
            if parsed.error_count:
                warnings.append(f"ar5iv: {parsed.error_count} ltx_ERROR markers")
            logger.info(
                "arxiv extraction success: paper_id=%s method=ar5iv sections=%d errors=%d",
                paper_id,
                len(parsed.sections),
                parsed.error_count,
            )
            return parsed.body_text, parsed.sections, "ar5iv", warnings
        reason = (
            f"ar5iv: gate fall_through (sections={len(parsed.sections)}, "
            f"errors={parsed.error_count})"
        )
        ar5iv_warnings.append(reason)
        logger.info(
            "arxiv extraction fallthrough: paper_id=%s stage=ar5iv reason=gate_fall_through",
            paper_id,
        )

    # Stage 2: try PDF
    pdf_bytes = await _fetch_arxiv_pdf(paper_id, client)
    if pdf_bytes is None:
        ar5iv_warnings.append("pdf: fetch failed")
        logger.info(
            "arxiv extraction fallthrough: paper_id=%s stage=pdf reason=fetch_failed",
            paper_id,
        )
        return None, None, "abstract_only", ar5iv_warnings

    # parse_pdf is sync + CPU-bound; run in thread pool to avoid blocking
    parsed_pdf = await asyncio.to_thread(parse_pdf, pdf_bytes)
    if arxiv_quality_gate(parsed_pdf) == "accept":
        warnings = list(ar5iv_warnings)
        if parsed_pdf.error_count:
            warnings.append(f"pdf: {parsed_pdf.error_count} parse errors")
        logger.info(
            "arxiv extraction success: paper_id=%s method=pdf sections=%d errors=%d",
            paper_id,
            len(parsed_pdf.sections),
            parsed_pdf.error_count,
        )
        return parsed_pdf.body_text, parsed_pdf.sections, "pdf", warnings

    # Stage 3: both failed
    ar5iv_warnings.append(
        f"pdf: gate fall_through (sections={len(parsed_pdf.sections)}, "
        f"errors={parsed_pdf.error_count})"
    )
    logger.info(
        "arxiv extraction fallthrough: paper_id=%s stage=pdf reason=gate_fall_through",
        paper_id,
    )
    return None, None, "abstract_only", ar5iv_warnings


@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=2, max=10),
    retry=retry_if_not_exception_type(ContentFetchError),
    reraise=True,
)
async def fetch_reddit_content(url: str) -> RedditContent:
    """Fetch content from a Reddit post via the public JSON API.

    Appends .json to the post URL to get structured data without
    authentication. Extracts post body and top-level comments.

    Args:
        url: A Reddit post URL (must contain /comments/).

    Returns:
        A RedditContent model with post and comment data.

    Raises:
        InvalidURLError: If the URL is not a Reddit post URL.
        ResourceNotFoundError: If the post does not exist or returns no data.
    """
    parsed = urllib.parse.urlparse(url)
    if "/comments/" not in parsed.path:
        raise InvalidURLError(f"Not a Reddit post URL (missing /comments/): {url}")

    json_url = _build_reddit_json_url(url)

    async with httpx.AsyncClient(timeout=15.0) as client:
        response = await client.get(
            json_url,
            headers={"User-Agent": "traversal-discovery/0.1"},
        )
        if response.status_code == 404:
            raise ResourceNotFoundError(f"Reddit post not found: {url}")
        response.raise_for_status()
        data = response.json()

    # Reddit JSON returns [post_listing, comments_listing]
    if not isinstance(data, list) or len(data) < 2:
        raise ResourceNotFoundError(f"Unexpected Reddit JSON structure for: {url}")

    post_children = data[0].get("data", {}).get("children", [])
    if not post_children:
        raise ResourceNotFoundError(f"No post data in Reddit response: {url}")

    post = post_children[0].get("data", {})
    post_id = post.get("name", "")  # e.g. "t3_lsf994"

    # Collect top-level comments (skip "[deleted]" and AutoModerator)
    comment_children = data[1].get("data", {}).get("children", [])
    top_comments = []
    for child in comment_children[:10]:
        if child.get("kind") != "t1":
            continue
        comment_data = child.get("data", {})
        body = comment_data.get("body", "")
        author = comment_data.get("author", "")
        if body and author not in ("[deleted]", "AutoModerator"):
            top_comments.append(body)
        if len(top_comments) >= 5:
            break

    return RedditContent(
        url=url,
        post_id=post_id,
        title=post.get("title", ""),
        subreddit=post.get("subreddit", ""),
        selftext=post.get("selftext", ""),
        score=post.get("score", 0),
        comment_count=post.get("num_comments", 0),
        author=post.get("author"),
        top_comments=top_comments,
    )


# =============================================================================
# GitHub API Fetcher
# =============================================================================


def _extract_github_owner_repo(url: str) -> tuple[str, str]:
    """Extract owner/repo from a GitHub URL.

    Raises:
        InvalidURLError: If the URL is not a valid GitHub repo URL.
    """
    parsed = urllib.parse.urlparse(url)
    parts = [p for p in parsed.path.strip("/").split("/") if p]
    if len(parts) < 2:
        raise InvalidURLError(f"Not a GitHub repo URL: {url}")
    return parts[0], parts[1]


@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=2, max=10),
    retry=retry_if_not_exception_type(ContentFetchError),
    reraise=True,
)
async def fetch_github_content(url: str) -> GitHubRepoContent:
    """Fetch content from a GitHub repository page.

    Uses the GitHub REST API (unauthenticated, 60 req/hr) to retrieve
    repo metadata and README content.

    Args:
        url: A GitHub repository URL.

    Returns:
        A GitHubRepoContent model with repo metadata and README text.

    Raises:
        InvalidURLError: If the URL is not a valid GitHub repo URL.
        ResourceNotFoundError: If the repo does not exist.
    """
    owner, repo = _extract_github_owner_repo(url)
    headers = {
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "traversal-discovery/0.1",
    }

    async with httpx.AsyncClient(timeout=15.0) as client:
        # Fetch repo metadata
        repo_resp = await client.get(
            f"https://api.github.com/repos/{owner}/{repo}",
            headers=headers,
        )
        if repo_resp.status_code == 404:
            raise ResourceNotFoundError(f"GitHub repo not found: {owner}/{repo}")
        repo_resp.raise_for_status()
        repo_data = repo_resp.json()

        # Fetch README
        readme_text = ""
        readme_resp = await client.get(
            f"https://api.github.com/repos/{owner}/{repo}/readme",
            headers={**headers, "Accept": "application/vnd.github.v3.raw"},
        )
        if readme_resp.status_code == 200:
            readme_text = readme_resp.text

    description = repo_data.get("description") or ""
    topics = repo_data.get("topics") or []
    stars = repo_data.get("stargazers_count", 0)
    language = repo_data.get("language")

    full_text = readme_text if readme_text else description

    return GitHubRepoContent(
        url=url,
        owner=owner,
        repo=repo,
        description=description,
        full_text=full_text,
        topics=topics,
        stars=stars,
        language=language,
    )


# =============================================================================
# BoardGameGeek XML API Fetcher
# =============================================================================


def _extract_bgg_id(url: str) -> int:
    """Extract the BGG game/expansion ID from a URL.

    Handles: /boardgame/12345/name, /boardgameexpansion/12345/name

    Raises:
        InvalidURLError: If the URL doesn't contain a valid BGG ID.
    """
    match = re.search(r"/(?:boardgame|boardgameexpansion)/(\d+)", url)
    if not match:
        raise InvalidURLError(f"Not a BGG game URL: {url}")
    return int(match.group(1))


@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=2, max=10),
    retry=retry_if_not_exception_type(ContentFetchError),
    reraise=True,
)
async def fetch_bgg_content(url: str) -> BGGGameContent:
    """Fetch content from a BoardGameGeek game or expansion page.

    Uses the BGG XML API v2 to retrieve structured game data including
    description, mechanics, categories, and player counts.

    Args:
        url: A BGG game or expansion URL.

    Returns:
        A BGGGameContent model with game metadata.

    Raises:
        InvalidURLError: If the URL doesn't contain a valid BGG game ID.
        ResourceNotFoundError: If the game does not exist.
    """
    bgg_id = _extract_bgg_id(url)

    async with httpx.AsyncClient(timeout=15.0) as client:
        api_url = f"https://boardgamegeek.com/xmlapi2/thing" f"?id={bgg_id}&stats=1"
        response = await client.get(
            api_url,
            headers={"User-Agent": "traversal-discovery/0.1"},
        )
        if response.status_code == 404:
            raise ResourceNotFoundError(f"BGG game not found: {bgg_id}")
        response.raise_for_status()

    root = ET.fromstring(response.text)
    item = root.find("item")
    if item is None:
        raise ResourceNotFoundError(f"No item data in BGG response for ID {bgg_id}")

    # Title (primary name)
    title = ""
    for name_el in item.findall("name"):
        if name_el.get("type") == "primary":
            title = name_el.get("value", "")
            break

    # Description (HTML entities decoded by XML parser)
    raw_desc = item.findtext("description") or ""
    # Strip HTML tags that BGG sometimes includes
    description = re.sub(r"<[^>]+>", "", raw_desc).strip()

    # Numeric fields
    year_el = item.find("yearpublished")
    year = int(year_el.get("value", "0")) if year_el is not None else None

    minp_el = item.find("minplayers")
    min_players = int(minp_el.get("value", "0")) if minp_el is not None else None

    maxp_el = item.find("maxplayers")
    max_players = int(maxp_el.get("value", "0")) if maxp_el is not None else None

    time_el = item.find("playingtime")
    playing_time = int(time_el.get("value", "0")) if time_el is not None else None

    # Categories and mechanics from <link> elements
    categories = [
        link.get("value", "")
        for link in item.findall("link")
        if link.get("type") == "boardgamecategory"
    ]
    mechanics = [
        link.get("value", "")
        for link in item.findall("link")
        if link.get("type") == "boardgamemechanic"
    ]

    # Build full_text for embedding/search
    parts = [f"{title} ({year})" if year else title]
    if description:
        parts.append(description)
    if mechanics:
        parts.append(f"Mechanics: {', '.join(mechanics)}")
    if categories:
        parts.append(f"Categories: {', '.join(categories)}")
    if min_players and max_players:
        parts.append(f"Players: {min_players}-{max_players}")
    if playing_time:
        parts.append(f"Playing time: {playing_time} minutes")
    full_text = "\n\n".join(parts)

    return BGGGameContent(
        url=url,
        bgg_id=bgg_id,
        title=title,
        description=description,
        full_text=full_text,
        year_published=year if year else None,
        min_players=min_players if min_players else None,
        max_players=max_players if max_players else None,
        playing_time=playing_time if playing_time else None,
        categories=categories,
        mechanics=mechanics,
    )


# =============================================================================
# Generic Readability-style fetcher (Stage 0 fallback for unknown domains)
# =============================================================================


def _trafilatura_extract(html: str, url: str) -> dict[str, str]:
    """CPU-bound trafilatura extraction; offloaded via asyncio.to_thread.

    Returns dict with title / description / body keys. Empty strings when a
    field can't be extracted -- never raises so callers can surface partial
    extractions for borderline pages (e.g., paginated tutorial sites).
    """
    import trafilatura
    try:
        body = trafilatura.extract(
            html,
            url=url,
            include_comments=False,
            include_tables=False,
            favor_recall=True,
        ) or ""
    except Exception:
        body = ""
    title = ""
    description = ""
    try:
        meta = trafilatura.extract_metadata(html)
        if meta is not None:
            title = (getattr(meta, "title", None) or "").strip()
            description = (getattr(meta, "description", None) or "").strip()
    except Exception:
        pass
    return {"title": title, "description": description, "body": body}


async def fetch_generic_content(url: str) -> GenericPageContent:
    """Fetch + extract main content from an arbitrary URL via trafilatura.

    Used as the Stage 0 fallback when ``DOMAIN_TO_FETCHER`` has no entry
    for the URL's domain. trafilatura is the strongest single-library
    Python option for boilerplate-stripped main-content extraction across
    a wide variety of page shapes (blogs, docs, tutorials, primary-source
    text dumps).

    Raises:
        InvalidURLError: If the URL response is not text/html.
        ContentFetchError: On non-2xx responses, empty body, or a redirect
            chain that loops or exceeds MAX_REDIRECTS.
        UnsafeURLError: If the URL -- or any hop it redirects through --
            uses a non-http(s) scheme or resolves to a non-public address.
            See backend/services/url_guard.py; the pipeline's per-page
            handler records this as a page-level error and moves on.
    """
    # Use a plausible-browser UA. Some sites (notably StackExchange family)
    # 403 anything that announces itself as a bot, even with a contact URL.
    # Trade-off acknowledged: friendlier UA reads less honest, but the
    # alternative is curated public-content pages we are explicitly told
    # exist getting silently dropped from the demo.
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        ),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    }
    # Redirects are followed MANUALLY so every hop can be re-validated. With
    # follow_redirects=True httpx validates nothing after the first request,
    # so a public URL redirecting to 127.0.0.1 or 169.254.169.254 would sail
    # through a front-door check -- the classic bypass of guards applied only
    # to the URL the user submitted.
    async with httpx.AsyncClient(timeout=20.0, follow_redirects=False) as client:
        current = url
        for _ in range(MAX_REDIRECTS + 1):
            pinned = await resolve_public_url_async(current)
            pinned_url, pinned_headers, extensions = pinned_request_kwargs(pinned, headers)
            response = await client.get(pinned_url, headers=pinned_headers, extensions=extensions)
            if not response.is_redirect:
                break
            location = response.headers.get("location")
            if not location:
                raise ContentFetchError(
                    f"Generic fetcher: redirect with no Location header at {current}"
                )
            # Relative Locations are legal; resolve against the current URL.
            current = str(httpx.URL(current).join(location))
        else:
            raise ContentFetchError(
                f"Generic fetcher: more than {MAX_REDIRECTS} redirects from {url}"
            )

        response.raise_for_status()
        ctype = response.headers.get("content-type", "").lower()
        if "html" not in ctype and "xml" not in ctype:
            raise InvalidURLError(
                f"Generic fetcher requires text/html; got {ctype!r} for {url}"
            )
        html = response.text

    extracted = await asyncio.to_thread(_trafilatura_extract, html, url)
    body = extracted["body"] or ""
    if not body and not extracted["title"]:
        raise ContentFetchError(f"Generic fetcher: no extractable content at {url}")

    return GenericPageContent(
        url=url,
        title=extracted["title"],
        description=extracted["description"],
        full_text=body,
        char_count=len(body),
    )
