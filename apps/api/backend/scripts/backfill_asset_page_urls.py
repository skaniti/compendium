"""Backfill page_content_assets.page_url for links the preview renderer cannot match.

``captured_assets`` is unique per (user_id, sha256), so a page can link a row whose
``source_url`` is a different URL for the same bytes than the one the page uses;
the renderer then cannot map the page's ``<img src>`` to the archived copy. The
archiver records the page's own URL in ``page_content_assets.page_url`` from
migration 060 on; this script recovers it for links made before that.

For every page_content with a link whose ``page_url`` is NULL and whose asset
``source_url`` does not appear among the page's own image/stylesheet URLs, it looks
for another ``captured_assets`` row (any account) with the SAME sha256 whose
``source_url`` IS one of the page's URLs, and records that URL. That is the
situation the 2026-10-08 cross-account repair left behind: the other account's rows
still hold the URL the page used. A link with no such row is counted as unresolved
and left NULL; re-running the archiver for that page (as
scripts/demo/backfill_assets.py does) fills it from a fresh download.

Dry run by default: prints what it would fill and writes nothing. Only NULL
``page_url`` values are ever written; resumable (a filled link is not selected again).

Usage (from apps/api, or /app in the API container):
    python -m backend.scripts.backfill_asset_page_urls           # dry run
    python -m backend.scripts.backfill_asset_page_urls --apply
"""

import argparse
import gzip
import logging
import sys
import zlib
from dataclasses import dataclass, field
from pathlib import Path

# repo root = two levels up (this file lives at backend/scripts/)
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.db.connection import get_conn
from backend.services.asset_archiver import extract_image_urls, extract_stylesheet_urls
from backend.services.site_rules import rules_for

TAG = "[backfill_asset_page_urls]"
PROGRESS_EVERY = 100
UNRESOLVED_SHOWN = 20

log = logging.getLogger("backfill_asset_page_urls")


@dataclass
class Stats:
    pages_scanned: int = 0
    pages_unreadable: int = 0  # raw_html would not gunzip
    links_filled: int = 0
    links_unresolved: int = 0
    unresolved: list[tuple[int, int]] = field(default_factory=list)  # (page_content_id, asset_id)


def _check_sees_all_rows(cur) -> None:
    """Row-level security on captured_assets would hide rows and make a run
    report nothing to fill (same guard as scripts/repair_cross_account_assets.py)."""
    cur.execute("SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user")
    row = cur.fetchone()
    if not row or not row[0]:
        raise RuntimeError(
            "the connected database role is neither superuser nor BYPASSRLS; row-level "
            "security could hide rows and the script would wrongly report nothing to fill"
        )


def _page_urls(raw_html_gz: bytes, base_url: str) -> list[str]:
    """Every URL the archiver would have requested for this page, absolute: the
    HTML's images and stylesheets in document order, then the site rules'
    stylesheet links (e.g. Wikipedia's load.php), which are not in the HTML."""
    raw = gzip.decompress(bytes(raw_html_gz))
    urls = extract_image_urls(raw, base_url) + extract_stylesheet_urls(raw, base_url)
    return urls + [u for u in rules_for(base_url).stylesheet_links if u not in urls]


def _fill_page(cur, content_id: int, base_url: str, raw_html_gz: bytes, apply: bool,
               stats: Stats) -> None:
    page_urls = _page_urls(raw_html_gz, base_url)
    cur.execute(
        "SELECT pca.asset_id, ca.sha256, ca.source_url, pca.page_url "
        "FROM page_content_assets pca JOIN captured_assets ca ON ca.id = pca.asset_id "
        "WHERE pca.page_content_id = %s ORDER BY pca.asset_id",
        (content_id,),
    )
    links = cur.fetchall()
    # A page URL some link already explains (its row's source_url, or a page_url) is matched.
    matched = {url for _, _, source_url, page_url in links for url in (source_url, page_url) if url}
    open_links = [(aid, sha) for aid, sha, source_url, page_url in links
                  if page_url is None and source_url not in page_urls]
    unmatched = [u for u in page_urls if u not in matched]
    if not open_links:
        return

    by_sha: dict[str, list[str]] = {}
    if unmatched:
        cur.execute(
            "SELECT source_url, sha256 FROM captured_assets "
            "WHERE source_url = ANY(%s) AND sha256 = ANY(%s)",
            (unmatched, sorted({sha for _, sha in open_links})),
        )
        for source_url, sha in cur.fetchall():
            by_sha.setdefault(sha, []).append(source_url)

    claimed: set[str] = set()
    for aid, sha in open_links:
        # first of the page's own URLs (document order) that a same-bytes row holds
        url = next((u for u in unmatched if u in by_sha.get(sha, ()) and u not in claimed), None)
        if url is None:
            stats.links_unresolved += 1
            stats.unresolved.append((content_id, aid))
            continue
        claimed.add(url)
        stats.links_filled += 1
        if apply:
            cur.execute(
                "UPDATE page_content_assets SET page_url = %s "
                "WHERE page_content_id = %s AND asset_id = %s AND page_url IS NULL",
                (url, content_id, aid),
            )


def backfill(cur, *, apply: bool) -> Stats:
    """Scan every page_content with a NULL page_url link; write only when ``apply``.

    The caller owns the transaction (commit after, roll back on error).
    """
    _check_sees_all_rows(cur)
    stats = Stats()
    cur.execute(
        "SELECT DISTINCT pc.id FROM page_content pc "
        "JOIN page_content_assets pca ON pca.page_content_id = pc.id "
        "WHERE pca.page_url IS NULL AND pc.raw_html IS NOT NULL ORDER BY pc.id"
    )
    ids = [r[0] for r in cur.fetchall()]
    print(f"{TAG} {len(ids)} page_content rows have a link without page_url", flush=True)
    for n, content_id in enumerate(ids, 1):
        cur.execute("SELECT url, raw_html FROM page_content WHERE id = %s", (content_id,))
        url, raw_html = cur.fetchone()
        try:
            _fill_page(cur, content_id, url, raw_html, apply, stats)
        except (OSError, EOFError, zlib.error):  # gzip.BadGzipFile is an OSError
            stats.pages_unreadable += 1
        stats.pages_scanned += 1
        if n % PROGRESS_EVERY == 0:
            print(f"{TAG} {n}/{len(ids)} pages scanned, filled so far={stats.links_filled}, "
                  f"unresolved so far={stats.links_unresolved}", flush=True)
    return stats


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--apply", action="store_true",
                    help="write the recovered page_url values (default: dry run)")
    args = ap.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    print(f"{TAG} {'APPLY' if args.apply else 'DRY RUN'}", flush=True)
    try:
        with get_conn() as conn, conn.cursor() as cur:
            stats = backfill(cur, apply=args.apply)
    except Exception as exc:  # noqa: BLE001 - report and exit non-zero, whatever failed
        print(f"{TAG} ERROR, nothing written: {exc}", file=sys.stderr)
        return 1

    print(f"{TAG} pages scanned={stats.pages_scanned} (unreadable html={stats.pages_unreadable}) "
          f"links filled={stats.links_filled} unresolved={stats.links_unresolved}")
    if stats.unresolved:
        shown = ", ".join(f"page_content {p} asset {a}" for p, a in stats.unresolved[:UNRESOLVED_SHOWN])
        more = len(stats.unresolved) - UNRESOLVED_SHOWN
        print(f"{TAG} unresolved (no other row holds the page's URL for these bytes; re-run the "
              f"archiver for them): {shown}" + (f" ... and {more} more" if more > 0 else ""))
    print(f"{TAG} {'applied' if args.apply else 'dry run, nothing written (rerun with --apply)'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
