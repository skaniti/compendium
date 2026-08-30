"""Raw HTML archiver — fetches + gzips source HTML for preview archival.

Runs as a best-effort peer to the structured content fetcher in the phase-2
background enrichment path. Failures here never block the structured
extraction; they just leave ``page_content.raw_html`` null, which the
right-sidebar preview detects and falls back to plaintext rendering.

For Wikipedia URLs we call the MediaWiki ``action=parse&prop=text`` API,
which returns the article body HTML only — no header/nav/footer chrome —
so the later per-site chrome-hider stays trivial. For other domains we
fetch the URL directly.
"""

from __future__ import annotations

import gzip
import logging
from dataclasses import dataclass
from urllib.parse import urlparse, urlunparse

import httpx

from backend.services.content_fetcher import _extract_wikipedia_title

logger = logging.getLogger(__name__)

_USER_AGENT = (
    "traversal-discovery/0.1 "
    "(https://github.com/traversal-discovery; browsing session analyzer) "
    "python-httpx"
)
_HTTP_TIMEOUT_SECS = 15.0
_MEDIAWIKI_API = "https://en.wikipedia.org/w/api.php"
# Skip archival when the response body is obviously not HTML or is huge;
# 10 MiB covers all reasonable article pages without letting a rogue
# response bloat the DB.
_MAX_HTML_BYTES = 10 * 1024 * 1024


@dataclass(slots=True)
class RawHtmlArtifact:
    """Gzipped HTML + content-type, ready for page_content persistence."""

    gzipped: bytes
    content_type: str


async def archive_raw_html(url: str) -> RawHtmlArtifact | None:
    """Fetch source HTML for a captured URL, return gzipped.

    Returns None on any failure (timeout, non-HTML content-type, 4xx/5xx,
    oversized body) so callers can treat archival as best-effort.
    """
    try:
        if _is_wikipedia(url):
            html_bytes, content_type = await _fetch_wikipedia_body_html(url)
        else:
            html_bytes, content_type = await _fetch_generic(url)
    except httpx.HTTPStatusError as e:
        # Auth walls and missing pages are expected for user-private URLs
        # (claude.ai chats, gmail, doordash, GitHub PR pages, etc.). Surface
        # them at DEBUG so the noise floor stays manageable.
        if e.response.status_code in (401, 403, 404):
            logger.debug("raw_html archive skipped (%d) for %s", e.response.status_code, url)
        else:
            logger.warning("raw_html archive failed for %s: %s", url, e)
        return None
    except Exception as e:
        logger.warning("raw_html archive failed for %s: %s", url, e)
        return None

    if not html_bytes:
        return None
    if len(html_bytes) > _MAX_HTML_BYTES:
        logger.warning(
            "raw_html skip %s: response %d bytes exceeds cap %d",
            url,
            len(html_bytes),
            _MAX_HTML_BYTES,
        )
        return None

    return RawHtmlArtifact(
        gzipped=gzip.compress(html_bytes, compresslevel=6),
        content_type=content_type,
    )


def _is_wikipedia(url: str) -> bool:
    host = (urlparse(url).netloc or "").lower()
    return host.endswith(".wikipedia.org") or host == "wikipedia.org"


async def _fetch_wikipedia_body_html(url: str) -> tuple[bytes, str]:
    """Fetch the chrome-free article body via MediaWiki's parse API."""
    title = _extract_wikipedia_title(url)
    async with httpx.AsyncClient(
        timeout=_HTTP_TIMEOUT_SECS,
        headers={"User-Agent": _USER_AGENT},
    ) as client:
        resp = await client.get(
            _MEDIAWIKI_API,
            params={
                "action": "parse",
                "page": title,
                "prop": "text",
                "format": "json",
                "formatversion": "2",
                "redirects": "1",
            },
        )
        resp.raise_for_status()
        data = resp.json()
    html_text = data.get("parse", {}).get("text", "") or ""
    return html_text.encode("utf-8"), "text/html; charset=utf-8"


# Sites whose canonical URL is a JS-rendered SPA but which expose a
# server-rendered mirror on a different host. Mapping applied before
# the generic fetch so archival grabs content the iframe can actually
# render without running JS.
_URL_REWRITES: dict[str, str] = {
    "www.reddit.com": "old.reddit.com",
    "reddit.com": "old.reddit.com",
    "new.reddit.com": "old.reddit.com",
}


def _rewritten_url(url: str) -> str:
    """Return ``url`` with its host remapped per ``_URL_REWRITES``.

    Preserves the path, query string, and fragment — we only swap the
    netloc. Leaves URLs untouched when no rewrite entry matches.
    """
    parsed = urlparse(url)
    target = _URL_REWRITES.get((parsed.netloc or "").lower())
    if target is None:
        return url
    return urlunparse(parsed._replace(netloc=target))


async def _fetch_generic(url: str) -> tuple[bytes, str]:
    """GET the URL and return body bytes iff content-type is HTML-ish."""
    fetch_url = _rewritten_url(url)
    if fetch_url != url:
        logger.info("raw_html URL rewrite: %s → %s", url, fetch_url)
    async with httpx.AsyncClient(
        timeout=_HTTP_TIMEOUT_SECS,
        headers={"User-Agent": _USER_AGENT},
        follow_redirects=True,
    ) as client:
        resp = await client.get(fetch_url)
        resp.raise_for_status()
    content_type = resp.headers.get("content-type", "text/html")
    if "html" not in content_type.lower():
        return b"", content_type
    return resp.content, content_type
