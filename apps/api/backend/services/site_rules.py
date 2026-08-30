"""Per-site rules for the archived-HTML preview renderer.

Each entry provides two knobs that shape the iframe output for a given
host:

``stylesheet_links``
    URLs emitted as ``<link rel="stylesheet">`` in the preview shell.
    Lets the source site's own CSS do most of the visual work.
``hide_selectors``
    CSS selectors whose matched elements get ``display: none !important``
    via injected inline CSS. Used to suppress nav chrome that leaked
    into the archived HTML.

Add an entry when onboarding a new source. Domains not listed fall back
to empty defaults (no external CSS, no hidden selectors) which produces
an unstyled-but-readable rendering.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from urllib.parse import urlparse


@dataclass(frozen=True, slots=True)
class SiteRules:
    stylesheet_links: list[str] = field(default_factory=list)
    hide_selectors: list[str] = field(default_factory=list)
    # Selectors removed from the DOM before trafilatura extraction.
    # Used for sites where ambient chrome (e.g. Reddit's subreddit
    # sidebar) is text-heavy enough that the extractor would pick it
    # up as main content and miss the actual post/article.
    pre_extract_remove: list[str] = field(default_factory=list)


# Wikipedia: archived body comes from action=parse&prop=text, which is
# chrome-free already — but it ships WITHOUT any stylesheet, so the raw
# HTML looks unstyled unless we link back to MediaWiki's content CSS.
# The `only=styles` bundle returns only CSS (no JS), so the sandboxed
# iframe stays script-free.
_WIKIPEDIA_LOAD_PHP = (
    "https://en.wikipedia.org/w/load.php?"
    "lang=en&"
    "modules=site.styles|ext.cite.styles|"
    "mediawiki.skinning.content.parsoid|skins.vector.styles&"
    "only=styles&skin=vector-2022"
)

SITE_RULES: dict[str, SiteRules] = {
    "en.wikipedia.org": SiteRules(
        stylesheet_links=[_WIKIPEDIA_LOAD_PHP],
        hide_selectors=[
            # The parse API occasionally emits reference <cite> edit
            # links and navigation boxes — suppress so they don't stand
            # out in the preview chrome.
            ".mw-editsection",
            ".navbox",
            ".navbox-inner",
            ".printfooter",
        ],
    ),
    # old.reddit.com: we rewrite www → old at archive time. Old Reddit's
    # subreddit sidebar (rules, welcome text, flair descriptions) is
    # text-heavy enough that trafilatura's recall mode can mistake it
    # for the main post. Pre-stripping the sidebar makes the extractor
    # home in on the actual submission + top comments.
    "old.reddit.com": SiteRules(
        pre_extract_remove=[
            ".side",  # main subreddit sidebar wrapper
            ".sidecontentbox",  # moderators, related subs
            ".titlebox",  # sub name + join button
            "#header",  # site header / nav
            ".footer-parent",  # site footer
            ".promoted",  # promoted-post chrome
            ".infobar",  # "welcome to reddit" banners
        ],
    ),
}


def rules_for(source_url: str) -> SiteRules:
    """Return the SiteRules for the host of ``source_url`` or empty defaults."""
    host = (urlparse(source_url).netloc or "").lower()
    # Exact match first.
    if host in SITE_RULES:
        return SITE_RULES[host]
    # Wildcard suffix match — wikipedia subdomains reuse en.wikipedia rules.
    if host.endswith(".wikipedia.org"):
        return SITE_RULES.get("en.wikipedia.org", SiteRules())
    return SiteRules()
