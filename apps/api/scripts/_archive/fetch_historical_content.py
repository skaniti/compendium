"""Retroactive content fetcher for historical browsing data.

Fetches page content for URLs in flat_pages.jsonl that were collected
before the extension had content extraction capability.

Uses:
- wikipedia-api for Wikipedia pages (structured, reliable)
- BeautifulSoup + httpx for other reachable sites (best-effort)

Output: data/experiments/clustering/page_content.jsonl
Each line: {"url": ..., "title": ..., "text": ..., "source": ..., "char_count": ...}
"""

import asyncio
import json
import re
import time
from pathlib import Path
from urllib.parse import urlparse

import httpx
import wikipediaapi
from bs4 import BeautifulSoup

PROJECT_ROOT = Path(__file__).resolve().parents[2]
FLAT_PAGES = PROJECT_ROOT / "data" / "experiments" / "clustering" / "flat_pages.jsonl"
OUT_CONTENT = PROJECT_ROOT / "data" / "experiments" / "clustering" / "page_content.jsonl"

MAX_CHARS = 10_000
HTTPX_TIMEOUT = 15.0  # seconds per request
CONCURRENT_LIMIT = 5  # max parallel fetches for non-wiki sites


# ---------------------------------------------------------------------------
# Wikipedia fetcher (synchronous, uses wikipedia-api)
# ---------------------------------------------------------------------------
_wiki = wikipediaapi.Wikipedia(
    user_agent="TraversalBasedDiscovery/0.2 (academic research project)",
    language="en",
)


def fetch_wikipedia(url: str) -> dict | None:
    """Fetch Wikipedia article content via the MediaWiki API."""
    parsed = urlparse(url)
    path = parsed.path

    # Extract article title from URL path
    # Handles /wiki/Article_Name and /wiki/Article_Name#Section
    if "/wiki/" not in path:
        return None

    title = path.split("/wiki/")[-1]
    # Remove URL encoding
    from urllib.parse import unquote

    title = unquote(title)
    # Remove fragment
    title = title.split("#")[0]

    if not title or title.startswith("Special:") or title.startswith("Wikipedia:"):
        return None

    try:
        page = _wiki.page(title)
        if not page.exists():
            return None

        text = page.text
        if not text or len(text) < 50:
            return None
    except Exception:
        return None

    # Truncate
    if len(text) > MAX_CHARS:
        text = text[:MAX_CHARS]

    return {
        "url": url,
        "title": page.title,
        "text": text,
        "source": "wikipedia_api",
        "char_count": len(text),
    }


# ---------------------------------------------------------------------------
# Generic fetcher (async, uses httpx + BeautifulSoup)
# ---------------------------------------------------------------------------
# Domains to skip (login pages, auth, APIs, binary content)
SKIP_DOMAINS = {
    "accounts.google.com",
    "account.samsung.com",
    "auth.wikimedia.org",
    "login.microsoftonline.com",
    "localhost",
    "chrome.google.com",
}

# Patterns that indicate non-content pages
SKIP_URL_PATTERNS = [
    r"/signin",
    r"/login",
    r"/auth",
    r"/oauth",
    r"/sso",
    r"/account",
    r"/cart",
    r"/checkout",
]


def should_skip_url(url: str) -> bool:
    """Check if a URL should be skipped (auth pages, APIs, etc.)."""
    parsed = urlparse(url)
    domain = parsed.netloc.lower()

    if domain in SKIP_DOMAINS:
        return True
    if any(re.search(pattern, parsed.path, re.IGNORECASE) for pattern in SKIP_URL_PATTERNS):
        return True
    # Skip non-HTTP
    if parsed.scheme not in ("http", "https"):
        return True
    # Skip empty or very short paths that are likely homepages with no real content
    if not parsed.path or parsed.path == "/":
        return True
    return False


def extract_text_bs4(html: str) -> str:
    """Extract clean text from HTML using BeautifulSoup."""
    soup = BeautifulSoup(html, "lxml")

    # Remove script, style, nav, footer, header, aside elements
    for tag in soup.find_all(
        [
            "script",
            "style",
            "nav",
            "footer",
            "header",
            "aside",
            "noscript",
            "iframe",
            "form",
        ]
    ):
        tag.decompose()

    # Try to find main content area first
    main = soup.find("main") or soup.find("article") or soup.find(attrs={"role": "main"})
    if main:
        text = main.get_text(separator="\n", strip=True)
    else:
        # Fall back to body
        body = soup.find("body")
        if body:
            text = body.get_text(separator="\n", strip=True)
        else:
            text = soup.get_text(separator="\n", strip=True)

    # Clean up: collapse multiple newlines, strip whitespace
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(r"[ \t]+", " ", text)
    text = text.strip()

    return text


async def fetch_generic(url: str, client: httpx.AsyncClient) -> dict | None:
    """Fetch and extract text from a generic web page."""
    if should_skip_url(url):
        return None

    try:
        response = await client.get(url, follow_redirects=True)
        if response.status_code != 200:
            return None

        content_type = response.headers.get("content-type", "")
        if "text/html" not in content_type:
            return None

        text = extract_text_bs4(response.text)
        if len(text) < 50:
            return None

        if len(text) > MAX_CHARS:
            text = text[:MAX_CHARS]

        return {
            "url": url,
            "title": "",  # Will be filled from flat_pages data
            "text": text,
            "source": "beautifulsoup",
            "char_count": len(text),
        }
    except (httpx.HTTPError, httpx.InvalidURL, Exception):
        return None


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
async def main():
    # Load unique URLs from flat pages
    urls_seen = set()
    url_titles = {}  # url -> title

    with open(FLAT_PAGES) as f:
        for line in f:
            page = json.loads(line)
            url = page["url"]
            if url not in urls_seen:
                urls_seen.add(url)
                url_titles[url] = page.get("title", "")

    print(f"Unique URLs to fetch: {len(urls_seen)}")

    # Separate Wikipedia URLs from others
    wiki_urls = []
    generic_urls = []
    for url in urls_seen:
        domain = urlparse(url).netloc.lower()
        if "wikipedia.org" in domain:
            wiki_urls.append(url)
        else:
            generic_urls.append(url)

    print(f"  Wikipedia: {len(wiki_urls)}")
    print(f"  Generic:   {len(generic_urls)}")

    results = {}

    # Fetch Wikipedia pages (synchronous, rate-limited)
    print(f"\nFetching {len(wiki_urls)} Wikipedia pages...")
    wiki_ok = 0
    for i, url in enumerate(wiki_urls):
        content = fetch_wikipedia(url)
        if content:
            results[url] = content
            wiki_ok += 1
        if (i + 1) % 20 == 0:
            print(f"  {i + 1}/{len(wiki_urls)} done ({wiki_ok} ok)")
            time.sleep(0.5)  # Be polite to Wikipedia API

    print(f"  Wikipedia: {wiki_ok}/{len(wiki_urls)} fetched")

    # Fetch generic pages (async, concurrent)
    print(f"\nFetching {len(generic_urls)} generic pages...")
    sem = asyncio.Semaphore(CONCURRENT_LIMIT)

    async with httpx.AsyncClient(
        timeout=HTTPX_TIMEOUT,
        headers={"User-Agent": "TraversalBasedDiscovery/0.2 (academic research)"},
        verify=False,  # Some sites have cert issues
    ) as client:

        async def fetch_with_sem(url):
            async with sem:
                return url, await fetch_generic(url, client)

        tasks = [fetch_with_sem(url) for url in generic_urls]
        generic_ok = 0
        for i, coro in enumerate(asyncio.as_completed(tasks)):
            url, content = await coro
            if content:
                content["title"] = url_titles.get(url, "")
                results[url] = content
                generic_ok += 1
            if (i + 1) % 50 == 0:
                print(f"  {i + 1}/{len(generic_urls)} done ({generic_ok} ok)")

    print(f"  Generic: {generic_ok}/{len(generic_urls)} fetched")

    # Write results
    print(f"\nTotal pages with content: {len(results)}/{len(urls_seen)}")

    with open(OUT_CONTENT, "w", encoding="utf-8") as f:
        for url in urls_seen:
            if url in results:
                f.write(json.dumps(results[url], ensure_ascii=False) + "\n")

    print(f"Wrote {OUT_CONTENT}")

    # Summary
    sources = {}
    for r in results.values():
        src = r["source"]
        sources[src] = sources.get(src, 0) + 1
    print(f"\nBy source: {sources}")
    char_counts = [r["char_count"] for r in results.values()]
    if char_counts:
        print(
            f"Char counts: min={min(char_counts)}, median={sorted(char_counts)[len(char_counts)//2]}, max={max(char_counts)}"
        )


if __name__ == "__main__":
    asyncio.run(main())
