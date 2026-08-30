"""Main-content extraction for multi-source previews.

Wraps trafilatura to strip site chrome (headers, navs, sidebars,
footers) from arbitrary server-rendered HTML. Returns the extracted
article body plus a usability flag that distinguishes real content
from JS-rendered skeletons and auth-walled stubs.

Wikipedia bypass: pages fetched via MediaWiki's ``action=parse`` API
are already chrome-free, so skipping extraction preserves the
infobox/hatnote/synonyms structure that trafilatura would aggressively
prune.
"""

from __future__ import annotations

import logging
import re
from urllib.parse import urlparse

import trafilatura
from bs4 import BeautifulSoup

from backend.services.site_rules import rules_for

logger = logging.getLogger(__name__)


# Hosts whose stored HTML came from a rewritten URL (e.g. www.reddit.com
# was fetched as old.reddit.com). The lookup in site_rules needs the
# rewritten host to find the matching pre-extract rules; this map tells
# us which host's rules apply to which stored URL.
_EXTRACTION_HOST_REMAP = {
    "www.reddit.com": "old.reddit.com",
    "reddit.com": "old.reddit.com",
    "new.reddit.com": "old.reddit.com",
}


def _effective_url(source_url: str) -> str:
    """Return the URL whose host matches the archived HTML's actual source.

    Used to look up per-site extraction rules — if we fetched
    old.reddit.com but the user captured www.reddit.com, rules_for()
    should still return the old.reddit entry.
    """
    from urllib.parse import urlparse, urlunparse

    parsed = urlparse(source_url)
    host = (parsed.netloc or "").lower()
    target = _EXTRACTION_HOST_REMAP.get(host)
    if target is None:
        return source_url
    return urlunparse(parsed._replace(netloc=target))


# Text-content threshold below which we treat the page as unusable
# (JS skeleton, auth wall, 404 stub, etc.). 200 chars ≈ two sentences,
# well below any real article but above every empty-shell case we've
# measured.
_USABILITY_MIN_CHARS = 200

# Hosts for which trafilatura is counterproductive — their server-side
# output is already clean article body, and extraction would prune
# load-bearing structure (infobox tables, taxonomy rows, etc.).
_EXTRACTION_BYPASS_SUFFIXES = ("wikipedia.org",)


def extract_main_content(
    raw_html: bytes, source_url: str, *, min_chars: int = _USABILITY_MIN_CHARS
) -> tuple[str, bool]:
    """Return (extracted_html, is_usable) for the preview pipeline.

    * Wikipedia URLs: returns the input HTML untouched, ``is_usable=True``.
    * Other sources: runs trafilatura; returns the extracted body HTML
      if text length ≥ ``min_chars``, else returns the original HTML
      with ``is_usable=False`` so the Dash renderer falls through to
      the plaintext branch.
    """
    if not raw_html:
        return ("", False)

    if _should_bypass(source_url):
        text_length = _estimate_text_length(raw_html)
        return (_as_str(raw_html), text_length >= min_chars)

    # Pre-extraction scrub: drop DOM nodes that would confuse
    # trafilatura (e.g. Reddit's subreddit sidebar). Rules keyed by
    # the effective host (see _effective_url — handles Reddit's
    # www→old rewrite).
    effective_url = _effective_url(source_url)
    rules = rules_for(effective_url)
    if rules.pre_extract_remove:
        raw_html = _prune_html(raw_html, rules.pre_extract_remove)

    # Two-pass extraction. Precision mode first (tight, clean output
    # suitable for articles like blogs/docs). If that yields too little
    # text — common on Reddit threads, forums, and comment-heavy sites
    # where precision over-prunes — retry with recall mode to keep more
    # structural content.
    extracted_html = _extract(raw_html, source_url, favor_precision=True)
    text_length = _estimate_text_length(extracted_html.encode("utf-8") if extracted_html else b"")
    if text_length < min_chars:
        recall_html = _extract(raw_html, source_url, favor_precision=False)
        recall_len = _estimate_text_length(recall_html.encode("utf-8") if recall_html else b"")
        if recall_len > text_length:
            extracted_html = recall_html
            text_length = recall_len

    if not extracted_html:
        return (_as_str(raw_html), False)

    is_usable = text_length >= min_chars
    if not is_usable:
        logger.info(
            "raw_html unusable for %s (extracted %d chars < %d)",
            source_url,
            text_length,
            min_chars,
        )
    return (extracted_html, is_usable)


def _prune_html(raw_html: bytes, selectors: list[str]) -> bytes:
    """Remove DOM nodes matching ``selectors`` from raw HTML.

    Returns the modified HTML as UTF-8 bytes. Failures fall back to
    returning the input unchanged — extraction still runs, just with
    the un-pruned HTML.
    """
    try:
        soup = BeautifulSoup(raw_html, "html.parser")
        for sel in selectors:
            for el in soup.select(sel):
                el.decompose()
        return str(soup).encode("utf-8")
    except Exception as e:
        logger.warning("pre-extract prune failed: %s", e)
        return raw_html


def _extract(raw_html: bytes, source_url: str, *, favor_precision: bool) -> str | None:
    """Single trafilatura call with the specified precision/recall bias."""
    try:
        return trafilatura.extract(
            raw_html,
            url=source_url,
            output_format="html",
            include_links=True,
            include_images=True,
            include_tables=True,
            favor_precision=favor_precision,
            favor_recall=not favor_precision,
            with_metadata=False,
        )
    except Exception as e:
        logger.warning(
            "trafilatura extract failed (%s) for %s: %s",
            "precision" if favor_precision else "recall",
            source_url,
            e,
        )
        return None


def _should_bypass(source_url: str) -> bool:
    host = (urlparse(source_url).netloc or "").lower()
    return any(host == suf or host.endswith("." + suf) for suf in _EXTRACTION_BYPASS_SUFFIXES)


_WHITESPACE_RE = re.compile(r"\s+")


def _estimate_text_length(html_bytes: bytes) -> int:
    """Rough visible-text length estimate via BeautifulSoup.get_text()."""
    try:
        soup = BeautifulSoup(html_bytes, "html.parser")
        # Drop script/style content before measuring — those contribute
        # to file size but not visible text.
        for tag in soup(["script", "style", "noscript"]):
            tag.decompose()
        text = soup.get_text(separator=" ", strip=True)
        return len(_WHITESPACE_RE.sub(" ", text).strip())
    except Exception:
        return 0


def _as_str(raw: bytes | str) -> str:
    if isinstance(raw, str):
        return raw
    try:
        return raw.decode("utf-8", errors="replace")
    except Exception:
        return raw.decode("latin-1", errors="replace")


def is_usable(raw_html: bytes, source_url: str, *, min_chars: int = _USABILITY_MIN_CHARS) -> bool:
    """Lightweight usability check without returning extracted HTML.

    Used by the post-migrate re-evaluation script to populate the
    ``raw_html_usable`` column without the cost of keeping the full
    extracted body.
    """
    _html, usable = extract_main_content(raw_html, source_url, min_chars=min_chars)
    return usable
