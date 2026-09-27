"""Image asset archiver for raw-HTML previews.

After raw_html has been stored for a page_content row, this module
downloads each ``<img>`` it references, writes the bytes under
``data/captures/assets/user_<id>/<ab>/<sha>.<ext>`` (content-addressed
with a two-hex-char shard, partitioned by user per migration 031), and
links them to the owning row via ``captured_assets`` /
``page_content_assets``.

Dedup is by SHA-256 of content WITHIN a single user, so the same image
referenced from many articles by one user lives on disk once. An image
captured by two different users lives on disk twice -- explicit
tradeoff for the per-user backup/audit isolation the laptop-server
deployment needs.

Rate-limited at one request per second per host to stay polite with
upstream CDNs. Failures are logged and swallowed — partial asset
coverage never fails the caller.
"""

from __future__ import annotations

import asyncio
import gzip
import hashlib
import logging
import mimetypes
from collections import defaultdict
from pathlib import Path
from urllib.parse import urljoin, urlparse

import httpx
from bs4 import BeautifulSoup

from backend.db.connection import get_conn
from backend.services.url_guard import (
    MAX_REDIRECTS,
    UnsafeURLError,
    pinned_request_kwargs,
    resolve_public_url_async,
)

logger = logging.getLogger(__name__)

# data/captures/assets/user_<id>/ lives alongside the existing captures
# directory. Per-user subdirectory layout (migration 031) keeps personal
# and demo data on separate disk paths so the restic backup of personal
# data does not drag in demo bytes.
_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
_BASE_ASSETS_DIR = _PROJECT_ROOT / "data" / "captures" / "assets"


def _assets_dir_for_user(user_id: int) -> Path:
    return _BASE_ASSETS_DIR / f"user_{user_id}"

_USER_AGENT = (
    "traversal-discovery/0.1 "
    "(https://github.com/traversal-discovery; browsing session analyzer) "
    "asset-archiver"
)
_HOST_RATE_LIMIT_SECS = 1.0
_DOWNLOAD_TIMEOUT_SECS = 30.0
_MAX_BYTES_PER_ASSET = 15 * 1024 * 1024  # 15 MiB
_MAX_CONCURRENCY = 4
_MAX_ASSETS_PER_PAGE = 50

# Both images and stylesheets are archived. content-type is the
# discriminator — ``image/*`` for pictures, ``text/css`` for styles.
# CSS archival is what lets non-Wikipedia sources look like themselves
# in the preview iframe without us hot-linking to source CDNs.
_ALLOWED_CT_PREFIXES = ("image/", "text/css")


def extract_image_urls(html_bytes: bytes, base_url: str) -> list[str]:
    """Return unique absolute ``<img src>`` URLs referenced by the HTML."""
    soup = BeautifulSoup(html_bytes, "html.parser")
    seen: set[str] = set()
    urls: list[str] = []
    for img in soup.find_all("img"):
        raw_src = img.get("src")
        src = _as_str(raw_src)
        if not src:
            srcset = _as_str(img.get("srcset"))
            if srcset:
                src = srcset.split(",")[0].strip().split(" ")[0]
        if not src:
            continue
        absolute = urljoin(base_url, src)
        if absolute.startswith("data:"):
            continue
        if absolute in seen:
            continue
        seen.add(absolute)
        urls.append(absolute)
    return urls


def extract_stylesheet_urls(html_bytes: bytes, base_url: str) -> list[str]:
    """Return unique absolute ``<link rel="stylesheet" href="...">`` URLs.

    Ignores print-only stylesheets (``media="print"``) since the preview
    is screen-rendered. Data URIs skipped (already inline).
    """
    soup = BeautifulSoup(html_bytes, "html.parser")
    seen: set[str] = set()
    urls: list[str] = []
    for link in soup.find_all("link"):
        rel = _as_str(link.get("rel"))
        if "stylesheet" not in rel.lower():
            continue
        media = _as_str(link.get("media")).lower()
        if media and "print" in media and "screen" not in media and "all" not in media:
            continue
        href = _as_str(link.get("href"))
        if not href:
            continue
        absolute = urljoin(base_url, href)
        if absolute.startswith("data:"):
            continue
        if absolute in seen:
            continue
        seen.add(absolute)
        urls.append(absolute)
    return urls


def _as_str(value) -> str:
    """Coerce a BeautifulSoup attribute value to a plain string.

    BS4 returns ``AttributeValueList`` for multi-valued attrs (e.g. class);
    for ``src`` this effectively never happens in real HTML, but we guard
    so a malformed doc never crashes the archiver.
    """
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, (list, tuple)):
        return str(value[0]) if value else ""
    return str(value)


async def archive_assets_for_page(
    page_content_id: int,
    gzipped_html: bytes,
    base_url: str,
    user_id: int,
) -> int:
    """Download + link every ``<img>`` referenced by this page's HTML.

    Returns the number of assets successfully linked (new + existing).
    Caps per-page downloads at ``_MAX_ASSETS_PER_PAGE`` to avoid runaway
    ingestion on image-heavy pages.

    ``user_id`` is passed explicitly rather than read from the RLS thread-
    local because this function runs inside an asyncio background task
    where the thread-local may have been overwritten by a later request.
    """
    _assets_dir_for_user(user_id).mkdir(parents=True, exist_ok=True)

    try:
        raw_html = gzip.decompress(gzipped_html)
    except Exception as e:
        logger.warning("asset archive: gunzip failed for pid=%d: %s", page_content_id, e)
        return 0

    image_urls = extract_image_urls(raw_html, base_url)
    stylesheet_urls = extract_stylesheet_urls(raw_html, base_url)
    # Per-site stylesheet links come from site_rules (e.g. Wikipedia's
    # load.php) and are NOT in the archived raw_html — Wikipedia's
    # action=parse&prop=text strips <head> entirely. Inject them here so
    # they archive same-origin like the page's own assets; otherwise the
    # preview shell's <link rel=stylesheet> falls back to the external
    # URL, which Edge Tracking Prevention silently blocks inside the
    # iframe (subframe-context third-party rule). Surfaced 2026-05-08
    # in demo curation testing.
    from backend.services.site_rules import rules_for
    site_stylesheets = list(rules_for(base_url).stylesheet_links)
    # Both asset types share rate limits + SHA dedup + on-disk layout.
    # Cap images at _MAX_ASSETS_PER_PAGE (runaway-image pages like
    # photo galleries); stylesheets are few and cheap, take them all.
    urls = image_urls[:_MAX_ASSETS_PER_PAGE] + stylesheet_urls + site_stylesheets
    # Dedupe while preserving order — site_rules and extract_stylesheet_urls
    # could surface the same URL on rare pages.
    seen_urls: set[str] = set()
    deduped: list[str] = []
    for u in urls:
        if u not in seen_urls:
            seen_urls.add(u)
            deduped.append(u)
    urls = deduped
    if not urls:
        return 0

    by_host: dict[str, list[str]] = defaultdict(list)
    for u in urls:
        host = (urlparse(u).netloc or "").lower()
        by_host[host].append(u)

    sem = asyncio.Semaphore(_MAX_CONCURRENCY)

    async def _run_host(host: str, host_urls: list[str]) -> list[int]:
        # follow_redirects=False -- _ensure_asset follows redirects manually
        # so every hop can be guarded and pinned, same as the page fetcher.
        async with httpx.AsyncClient(
            timeout=_DOWNLOAD_TIMEOUT_SECS,
            headers={"User-Agent": _USER_AGENT},
            follow_redirects=False,
        ) as client:
            asset_ids: list[int] = []
            for i, u in enumerate(host_urls):
                async with sem:
                    aid = await _ensure_asset(client, u, user_id)
                if aid is not None:
                    asset_ids.append(aid)
                if i < len(host_urls) - 1:
                    await asyncio.sleep(_HOST_RATE_LIMIT_SECS)
            return asset_ids

    per_host_results = await asyncio.gather(
        *[_run_host(h, u) for h, u in by_host.items()],
        return_exceptions=True,
    )
    asset_ids: list[int] = []
    for res in per_host_results:
        if isinstance(res, BaseException):
            logger.warning("asset host batch raised: %s", res)
            continue
        asset_ids.extend(res)

    if asset_ids:
        _link_assets_to_page(page_content_id, asset_ids)
    logger.info(
        "assets archived for pid=%d: %d linked (of %d refs)",
        page_content_id,
        len(asset_ids),
        len(urls),
    )
    return len(asset_ids)


async def _ensure_asset(client: httpx.AsyncClient, url: str, user_id: int) -> int | None:
    """Download one asset if not already stored; return its id or None.

    These URLs come straight out of captured page HTML -- user-supplied,
    same as the page itself -- so they get the same SSRF treatment as
    fetch_generic_content: each redirect hop is resolved, checked, and
    pinned (see backend/services/url_guard.py) rather than handing the
    hostname back to httpx for a second, independent resolution.

    A refusal (non-public hop, or a chain longer than MAX_REDIRECTS) is
    logged at warning level with the hop's HOST ONLY, never the full URL
    -- these are pages a user browsed, and the archiver's contract is
    best-effort: one refused asset must never fail the page.
    """
    existing = _get_asset_id_by_source_url(url, user_id)
    if existing is not None:
        return existing

    current = url
    resp: httpx.Response | None = None
    try:
        for _ in range(MAX_REDIRECTS + 1):
            pinned = await resolve_public_url_async(current)
            pinned_url, headers, extensions = pinned_request_kwargs(pinned, {})
            resp = await client.get(pinned_url, headers=headers, extensions=extensions)
            if not resp.is_redirect:
                break
            location = resp.headers.get("location")
            if not location:
                logger.warning(
                    "asset fetch refused for host %s: redirect with no location",
                    urlparse(current).hostname,
                )
                return None
            current = str(httpx.URL(current).join(location))
        else:
            logger.warning(
                "asset fetch refused for host %s: more than %d redirects",
                urlparse(url).hostname,
                MAX_REDIRECTS,
            )
            return None
    except UnsafeURLError as e:
        logger.warning("asset fetch refused for host %s: %s", urlparse(current).hostname, e)
        return None

    try:
        resp.raise_for_status()
    except Exception as e:
        logger.warning("asset fetch failed %s: %s", url, e)
        return None

    content_type = (
        resp.headers.get("content-type", "application/octet-stream").split(";")[0].strip().lower()
    )
    if not any(content_type.startswith(p) for p in _ALLOWED_CT_PREFIXES):
        return None
    data = resp.content
    if len(data) > _MAX_BYTES_PER_ASSET:
        logger.warning("asset too large %s (%d bytes)", url, len(data))
        return None

    sha = hashlib.sha256(data).hexdigest()
    existing = _get_asset_id_by_sha(sha, user_id)
    if existing is not None:
        # Content already on disk; no need to rewrite.
        return existing

    ext = _guess_extension(url, content_type)
    rel_path = f"user_{user_id}/{sha[:2]}/{sha}{ext}"
    abs_path = _BASE_ASSETS_DIR / rel_path
    abs_path.parent.mkdir(parents=True, exist_ok=True)
    if not abs_path.exists():
        abs_path.write_bytes(data)
    return _insert_asset(
        sha=sha,
        source_url=url,
        content_type=content_type,
        byte_size=len(data),
        file_path=rel_path,
        user_id=user_id,
    )


def _guess_extension(url: str, content_type: str) -> str:
    path = urlparse(url).path
    if "." in path:
        tail = path.rsplit(".", 1)[-1].lower().split("?")[0]
        if 1 < len(tail) <= 5 and tail.isalnum():
            return "." + tail
    return mimetypes.guess_extension(content_type) or ""


def _get_asset_id_by_sha(sha: str, user_id: int) -> int | None:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id FROM captured_assets WHERE user_id = %s AND sha256 = %s",
                (user_id, sha),
            )
            row = cur.fetchone()
    return row[0] if row else None


def _get_asset_id_by_source_url(url: str, user_id: int) -> int | None:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id FROM captured_assets "
                "WHERE user_id = %s AND source_url = %s LIMIT 1",
                (user_id, url),
            )
            row = cur.fetchone()
    return row[0] if row else None


def _insert_asset(
    *,
    sha: str,
    source_url: str,
    content_type: str,
    byte_size: int,
    file_path: str,
    user_id: int,
) -> int:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO captured_assets
                    (user_id, sha256, source_url, content_type, byte_size, file_path)
                VALUES (%s, %s, %s, %s, %s, %s)
                ON CONFLICT (user_id, sha256) DO UPDATE SET sha256 = EXCLUDED.sha256
                RETURNING id
                """,
                (user_id, sha, source_url, content_type, byte_size, file_path),
            )
            row = cur.fetchone()
            conn.commit()
    return row[0]


def _link_assets_to_page(page_content_id: int, asset_ids: list[int]) -> None:
    if not asset_ids:
        return
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.executemany(
                """
                INSERT INTO page_content_assets (page_content_id, asset_id)
                VALUES (%s, %s)
                ON CONFLICT DO NOTHING
                """,
                [(page_content_id, aid) for aid in asset_ids],
            )
            conn.commit()
