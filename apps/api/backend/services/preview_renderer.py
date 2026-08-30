"""Render archived raw HTML into an iframe-safe preview document.

Pipeline:
    load page_content.raw_html
        → gunzip
        → rewrite <img src> to /captured-assets/<sha>.<ext> when a local
          copy exists
        → normalize <a href>: open-in-new-tab, make site-relative URLs
          absolute so clicks still resolve
        → bleach.clean with HTML allowlist (defense-in-depth beyond the
          iframe sandbox)
        → wrap in a minimal shell with per-site stylesheet links + a
          chrome-hider <style> block

The output is served by the /__preview Flask route and loaded into a
sandboxed iframe in the Dash right panel.
"""

from __future__ import annotations

import gzip
import logging
from urllib.parse import urljoin

import bleach
from bs4 import BeautifulSoup

from backend.db.connection import get_conn
from backend.services.content_extractor import extract_main_content
from backend.services.site_rules import rules_for

logger = logging.getLogger(__name__)


# bleach allowlist: permissive enough to keep article structure
# (tables, sup, blockquote, figure) but strict on anything that could
# execute or load external resources outside of what we explicitly
# handle via URL rewriting.
_ALLOWED_TAGS = frozenset(
    {
        "a",
        "abbr",
        "article",
        "aside",
        "b",
        "blockquote",
        "br",
        "caption",
        "cite",
        "code",
        "col",
        "colgroup",
        "dd",
        "del",
        "details",
        "dfn",
        "div",
        "dl",
        "dt",
        "em",
        "figcaption",
        "figure",
        "footer",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "header",
        "hr",
        "i",
        "img",
        "ins",
        "kbd",
        "li",
        # `link` kept so archived <link rel="stylesheet"> tags survive
        # sanitize. Href is rewritten to /captured-assets/... in the
        # rewrite pass — no external resources load.
        "link",
        "main",
        "mark",
        "nav",
        "ol",
        "p",
        "pre",
        "q",
        "s",
        "samp",
        "section",
        "small",
        "span",
        "strong",
        "sub",
        "summary",
        "sup",
        "table",
        "tbody",
        "td",
        "tfoot",
        "th",
        "thead",
        "time",
        "tr",
        "u",
        "ul",
        "var",
        "wbr",
    }
)

_ALLOWED_ATTRIBUTES = {
    "*": ["id", "class", "title", "lang", "dir", "role", "style"],
    "a": ["href", "target", "rel", "hreflang"],
    "img": ["src", "alt", "width", "height", "srcset", "loading"],
    "link": ["href", "rel", "type", "media"],
    "table": ["summary"],
    "td": ["colspan", "rowspan", "scope"],
    "th": ["colspan", "rowspan", "scope"],
    "col": ["span"],
    "colgroup": ["span"],
    "ol": ["start", "type"],
    "li": ["value"],
    "q": ["cite"],
    "blockquote": ["cite"],
    "time": ["datetime"],
}

# CSS at-rules + declarations kept through sanitize. bleach's default CSS
# sanitizer strips "dangerous" properties; allowing common layout and
# color props keeps archived Wikipedia tables/infoboxes looking sane.
_ALLOWED_CSS_PROPS = frozenset(
    {
        "background",
        "background-color",
        "background-image",
        "border",
        "border-bottom",
        "border-collapse",
        "border-color",
        "border-left",
        "border-radius",
        "border-right",
        "border-spacing",
        "border-style",
        "border-top",
        "border-width",
        "bottom",
        "box-shadow",
        "box-sizing",
        "clear",
        "color",
        "cursor",
        "display",
        "float",
        "font",
        "font-family",
        "font-size",
        "font-stretch",
        "font-style",
        "font-variant",
        "font-weight",
        "grid",
        "grid-area",
        "grid-auto-rows",
        "grid-column",
        "grid-gap",
        "grid-row",
        "grid-template",
        "grid-template-columns",
        "grid-template-rows",
        "height",
        "justify-content",
        "left",
        "letter-spacing",
        "line-height",
        "list-style",
        "list-style-position",
        "list-style-type",
        "margin",
        "margin-bottom",
        "margin-left",
        "margin-right",
        "margin-top",
        "max-height",
        "max-width",
        "min-height",
        "min-width",
        "opacity",
        "overflow",
        "overflow-wrap",
        "overflow-x",
        "overflow-y",
        "padding",
        "padding-bottom",
        "padding-left",
        "padding-right",
        "padding-top",
        "position",
        "right",
        "row-gap",
        "table-layout",
        "text-align",
        "text-decoration",
        "text-indent",
        "text-shadow",
        "text-transform",
        "top",
        "vertical-align",
        "visibility",
        "white-space",
        "width",
        "word-break",
        "word-spacing",
        "word-wrap",
        "writing-mode",
        "z-index",
    }
)


def render_archived_preview(page_content_id: int) -> tuple[str, int]:
    """Return (html_document, http_status) for the /__preview endpoint."""
    row = _load_page_content_row(page_content_id)
    if row is None:
        return ("Preview row not found.", 404)
    raw_html_gz, url = row["raw_html"], row["url"]
    if not raw_html_gz:
        return ("Preview: no archived HTML for this row.", 404)

    try:
        raw_html = gzip.decompress(bytes(raw_html_gz))
    except Exception as e:
        logger.exception("gunzip failed for pid=%d: %s", page_content_id, e)
        return ("Preview: archived HTML is corrupt.", 500)

    asset_map = _load_asset_map(page_content_id)
    local_css_urls = _load_local_stylesheet_urls(page_content_id)
    rewritten = _rewrite_and_sanitize(raw_html, url, asset_map)
    rules = rules_for(url)
    document = _wrap_in_shell(
        rewritten, rules,
        extra_stylesheets=local_css_urls,
        asset_map=asset_map,
    )
    return (document, 200)


def _load_page_content_row(page_content_id: int) -> dict | None:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT raw_html, url FROM page_content WHERE id = %s",
                (page_content_id,),
            )
            row = cur.fetchone()
    if not row:
        return None
    return {"raw_html": row[0], "url": row[1]}


def _load_asset_map(page_content_id: int) -> dict[str, str]:
    """Return {source_url: /captured-assets/<rel>} for linked assets."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT ca.source_url, ca.file_path
                FROM page_content_assets pca
                JOIN captured_assets ca ON ca.id = pca.asset_id
                WHERE pca.page_content_id = %s
                """,
                (page_content_id,),
            )
            rows = cur.fetchall()
    return {source_url: f"/captured-assets/{file_path}" for source_url, file_path in rows}


def _load_local_stylesheet_urls(page_content_id: int) -> list[str]:
    """Return the local /captured-assets paths of CSS files linked to this page.

    Used to re-inject site stylesheets in the preview shell — trafilatura
    extraction strips ``<head>`` and all ``<link>`` tags as non-content,
    so without re-adding them the preview renders without the source's
    visual identity.
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT ca.file_path
                FROM page_content_assets pca
                JOIN captured_assets ca ON ca.id = pca.asset_id
                WHERE pca.page_content_id = %s
                  AND ca.content_type LIKE 'text/css%%'
                ORDER BY ca.id
                """,
                (page_content_id,),
            )
            rows = cur.fetchall()
    return [f"/captured-assets/{file_path}" for (file_path,) in rows]


def _rewrite_and_sanitize(raw_html: bytes, base_url: str, asset_map: dict[str, str]) -> str:
    # Step 1: content extraction — strip site chrome (nav, header,
    # footer, sidebars) from non-Wikipedia sources via trafilatura.
    # Wikipedia is bypassed inside extract_main_content because its
    # action=parse HTML is already clean. ``is_usable`` is checked at
    # ingest time (and stored on page_content.raw_html_usable); here we
    # just take whatever the extractor returns and proceed with render.
    extracted_html, _usable = extract_main_content(raw_html, base_url)
    soup = BeautifulSoup(extracted_html, "html.parser")

    # <img>: rewrite src to local archive path when available.
    for img in soup.find_all("img"):
        src = _coerce_str(img.get("src"))
        if src:
            absolute = urljoin(base_url, src)
            local = asset_map.get(absolute)
            if local:
                img["src"] = local
            elif not absolute.startswith("data:"):
                img["src"] = absolute
        # srcset confuses things when src points local; drop it when we
        # have a local copy, otherwise leave as-is.
        if _coerce_str(img.get("src")).startswith("/captured-assets/"):
            if img.has_attr("srcset"):
                del img["srcset"]

    # <link rel="stylesheet">: rewrite href to local archive when we
    # captured the stylesheet at ingest. Missing-in-asset-map means we
    # drop the link entirely (better to render unstyled than leak the
    # user's IP to the source CDN). Non-stylesheet <link> tags (icons,
    # preload, etc.) are removed below by the decompose loop.
    for link in soup.find_all("link"):
        rel = _coerce_str(link.get("rel")).lower()
        if "stylesheet" not in rel:
            link.decompose()
            continue
        href = _coerce_str(link.get("href"))
        if not href:
            link.decompose()
            continue
        absolute = urljoin(base_url, href)
        local = asset_map.get(absolute)
        if local:
            link["href"] = local
        else:
            # No local copy archived → drop. The site_rules stylesheet
            # (e.g. Wikipedia's load.php) is injected separately in
            # _wrap_in_shell and is unaffected by this pass.
            link.decompose()

    # <a>: normalize href + force-open-in-new-tab so clicks in the
    # sandboxed iframe don't fight the sandbox with a top-level nav.
    for a in soup.find_all("a"):
        href = _coerce_str(a.get("href"))
        if not href:
            continue
        if href.startswith("#"):
            continue  # same-page fragment; leave alone
        absolute = urljoin(base_url, href)
        a["href"] = absolute
        a["target"] = "_blank"
        a["rel"] = "noopener noreferrer"

    # Strip scroll-forcing declarations from any element's inline
    # `style=""` attribute. Elements carrying inline height/max-height
    # caps combined with overflow:hidden produce a nested scrollable
    # region when the ambient stylesheet (e.g. Wikipedia's load.php)
    # applies a more-specific `.thumb { overflow: auto !important }`
    # rule — the inline height wins on specificity but the external
    # !important overflow flips it to scroll. Dropping the height
    # constraint at the source lets content flow naturally inside the
    # one-and-only iframe scroll surface.
    _strip_scroll_declarations(soup)

    # Strip <script> and <style> blocks up front — bleach would do it
    # but an explicit pass keeps the html cheaper to sanitize.
    for tag in soup.find_all(["script", "style", "noscript", "iframe"]):
        tag.decompose()

    pre_cleaned = str(soup)

    css_sanitizer = _build_css_sanitizer()
    sanitized = bleach.clean(
        pre_cleaned,
        tags=_ALLOWED_TAGS,
        attributes=_ALLOWED_ATTRIBUTES,
        css_sanitizer=css_sanitizer,
        strip=True,
        strip_comments=True,
    )
    return sanitized


def _build_css_sanitizer():
    try:
        from bleach.css_sanitizer import CSSSanitizer
    except Exception:  # bleach < 5 may not have CSSSanitizer
        return None
    return CSSSanitizer(allowed_css_properties=list(_ALLOWED_CSS_PROPS))


# Inline-style declarations to scrub from all elements before rendering
# into the iframe. Height/overflow/max-height create nested scroll
# regions when combined with a class-specific !important override from
# the loaded stylesheet. Width + min-width force tables and thumbnail
# wrappers wider than the preview pane, producing horizontal clipping.
_SCROLL_KILL_PROPS = frozenset(
    {
        "height",
        "max-height",
        "overflow",
        "overflow-x",
        "overflow-y",
        # Pixel-based positioning paired with stripped widths produces
        # misalignment (e.g. `left: -30px` that was meaningful inside a
        # 300px container makes no sense once the container is responsive).
        "position",
        "top",
        "left",
        "right",
        "bottom",
    }
)

# Width-family props stripped only from block/container elements —
# never from <img>/<video>/<canvas> where intrinsic sizing depends on
# the declared dimensions.
_WIDTH_KILL_PROPS = frozenset(
    {
        "width",
        "min-width",
    }
)

_WIDTH_PRESERVE_TAGS = frozenset(
    {
        "img",
        "video",
        "canvas",
        "svg",
        "iframe",
        "embed",
        "object",
        "source",
        "picture",
    }
)


_CONTAINER_TAGS = frozenset(
    {
        "div",
        "table",
        "td",
        "th",
        "tr",
        "tbody",
        "thead",
        "tfoot",
        "section",
        "article",
        "aside",
        "nav",
        "figure",
        "figcaption",
        "ul",
        "ol",
        "li",
        "dl",
        "dt",
        "dd",
        "blockquote",
        "pre",
        "span",
        "a",
    }
)


def _strip_scroll_declarations(soup) -> None:
    """Remove layout-forcing declarations from every element's style attr
    AND inject ``max-width: 100%`` on every container element (even those
    without any inline style) so that no element can exceed its parent's
    width.

    The inline ``max-width: 100%`` wins every CSS specificity battle at
    (1,0,0,0) — the only way to reliably beat class-specific rules from
    externally-loaded stylesheets like Wikipedia's ``load.php``.
    """
    # Pass 1: scrub existing inline styles.
    for el in soup.find_all(style=True):
        raw_style = _coerce_str(el.get("style"))
        if not raw_style:
            continue
        tag = (el.name or "").lower()
        strip_widths = tag not in _WIDTH_PRESERVE_TAGS
        kept_decls: list[str] = []
        for decl in raw_style.split(";"):
            decl = decl.strip()
            if not decl or ":" not in decl:
                continue
            prop, _, _val = decl.partition(":")
            prop_lc = prop.strip().lower()
            if prop_lc in _SCROLL_KILL_PROPS:
                continue
            if strip_widths and prop_lc in _WIDTH_KILL_PROPS:
                continue
            kept_decls.append(decl)
        if kept_decls:
            el["style"] = "; ".join(kept_decls)
        else:
            del el["style"]

    # Pass 2: inject max-width:100% on ALL container elements.
    # This is the nuclear option that guarantees no element overflows
    # its parent regardless of stylesheet rules. Images/video/canvas
    # are handled by the CSS <style> block with their own max-width
    # + height:auto rule.
    for el in soup.find_all(_container_tag_filter):
        existing = _coerce_str(el.get("style"))
        mw_decl = "max-width: 100%"
        if existing:
            if "max-width" not in existing.lower():
                el["style"] = existing.rstrip("; ") + "; " + mw_decl
        else:
            el["style"] = mw_decl


def _container_tag_filter(tag) -> bool:
    return tag.name is not None and tag.name.lower() in _CONTAINER_TAGS


def _coerce_str(value) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, (list, tuple)):
        return str(value[0]) if value else ""
    return str(value)


def _wrap_in_shell(
    body_html: str,
    rules,
    *,
    extra_stylesheets: list[str] | None = None,
    asset_map: dict[str, str] | None = None,
) -> str:
    """Wrap sanitized body in a minimal HTML document.

    ``rules.stylesheet_links`` feed per-site CSS from site_rules (e.g.
    Wikipedia's load.php). ``extra_stylesheets`` are the locally-archived
    CSS files for this specific page_content row (injected after the
    per-site rules so source-specific styling wins on the cascade).
    ``asset_map`` rewrites ``rules.stylesheet_links`` through the
    page's archived-asset table so same-origin /captured-assets paths
    win over external URLs (Edge Tracking Prevention silently blocks
    cross-origin subframe loads -- 2026-05-08 demo testing).
    ``rules.hide_selectors`` get joined into a ``display:none`` block.
    """
    site_map: dict[str, str] = asset_map if asset_map is not None else {}
    # Rewrite per-site links through the asset map; emitted URLs are
    # the local archive when available, the external URL when not.
    per_site_hrefs: list[str] = [
        site_map[href] if href in site_map else href
        for href in rules.stylesheet_links
    ]
    # Drop any per-page CSS URL that's already been emitted as a per-site
    # link -- avoids the same stylesheet loading twice (browsers dedupe
    # by request URL, but the redundant <link> tag is noise).
    site_set = set(per_site_hrefs)
    archived_hrefs = [
        href for href in (extra_stylesheets or []) if href not in site_set
    ]
    per_site_links = [
        f'<link rel="stylesheet" href="{_escape_attr(href)}"/>' for href in per_site_hrefs
    ]
    archived_links = [
        f'<link rel="stylesheet" href="{_escape_attr(href)}"/>' for href in archived_hrefs
    ]
    # Per-site first, then per-page archived — later rules win cascade
    # ties, so source-specific styles override generic ones.
    link_tags = "\n".join(per_site_links + archived_links)
    hide_css = ""
    if rules.hide_selectors:
        joined = ", ".join(rules.hide_selectors)
        hide_css = f"<style>{joined} {{ display: none !important; }}</style>"

    return (
        "<!DOCTYPE html>\n"
        '<html lang="en"><head>\n'
        '<meta charset="UTF-8"/>\n'
        '<meta name="viewport" content="width=device-width,initial-scale=1"/>\n'
        "<title>Preview</title>\n"
        f"{link_tags}\n"
        f"{hide_css}\n"
        "<style>\n"
        # Provide a baseline so unstyled pages don't render as raw HTML.
        # MediaWiki's CSS overrides these for Wikipedia.
        "body { margin: 16px; font-family: sans-serif; color: #202122; "
        "background: #fff; font-size: 14px; line-height: 1.6; "
        "word-wrap: break-word; overflow-wrap: break-word; }\n"
        "table { border-collapse: collapse; }\n"
        # Flatten nested scroll regions — the iframe is the only
        # scrollable surface we want. MediaWiki (and other sources)
        # ship CSS rules that cap element heights + set overflow-y:auto
        # on infoboxes, synonym subpanels, subspecies blocks, etc.,
        # producing a double-scrollbar UX in the preview.
        "body div, body table, body td, body section, body article, "
        "body aside, body nav { "
        "max-height: none !important; overflow-y: visible !important; }\n"
        # Responsive fit — Wikipedia's CSS sets fixed pixel widths on
        # infoboxes and thumbnails (e.g. `.infobox { width: 22em }`)
        # that overflow narrow preview panes. Force everything to
        # shrink to available width so content is never clipped.
        "body img, body video, body canvas, body svg { "
        "max-width: 100% !important; height: auto !important; }\n"
        "body table, body figure, body .thumb, body .thumbinner, "
        "body .mw-default-size { "
        "max-width: 100% !important; box-sizing: border-box !important; }\n"
        "body .infobox, body table.infobox { "
        "width: auto !important; max-width: 100% !important; "
        "float: none !important; margin: 0 auto 1em auto !important; }\n"
        # Center image wrappers whose fixed inline width was stripped —
        # without this, thumbnail divs expand to image natural width
        # and shift left past the container edge.
        "body .noresize, body .thumbinner, body .thumbimage, "
        "body .center, body .mw-file-description { "
        "display: block !important; max-width: 100% !important; "
        "margin-left: auto !important; margin-right: auto !important; }\n"
        # Allow long unbreakable tokens (URLs, taxon names) to wrap
        # rather than overflow horizontally.
        "body * { overflow-wrap: break-word !important; }\n"
        "</style>\n"
        "</head><body>\n"
        f"{body_html}\n"
        "</body></html>\n"
    )


def _escape_attr(s: str) -> str:
    return s.replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;").replace(">", "&gt;")
