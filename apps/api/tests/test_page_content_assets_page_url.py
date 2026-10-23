"""page_content_assets.page_url (migration 060): the URL a page used for an asset.

Covers the migration, the archiver filling the column (including the sha256-dedup
case that motivates it) and ``_load_asset_map`` seeing it. The renderer's own
output is covered in tests/test_api_preview.py::TestPreviewAssetPageUrl. Synthetic
data only; migrations are applied by the session fixture in conftest.py.
"""

import gzip
import hashlib
import pathlib
from unittest.mock import patch

import httpx
import pytest

from tests.test_repos import _pg_reachable

pytestmark = pytest.mark.skipif(
    not _pg_reachable(), reason="Test PostgreSQL not reachable"
)

from backend.db import content_repo, user_repo
from backend.db.connection import get_conn
from backend.services import asset_archiver
from backend.services.preview_renderer import _load_asset_map
from tests.test_url_guard import _PUBLIC

PNG = b"\x89PNG-page-url-test"
SHA = hashlib.sha256(PNG).hexdigest()
URL_FIRST = "https://cdn.example.test/first/pic.png"   # the row's source_url
URL_PAGE = "https://cdn.example.test/second/pic.png"   # what the page uses
BASE = "https://blog.example.test/post"


def _q(sql, args=()):
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(sql, args)
        return cur.fetchall() if cur.description else None


@pytest.fixture(autouse=True)
def _clean():
    _q("TRUNCATE page_content_assets, captured_assets, page_content, users CASCADE")
    yield


@pytest.fixture
def user():
    return user_repo.create_user("page-url@example.test", name="Page Url")


def _content(name="post"):
    return content_repo.get_or_create_content(f"https://blog.example.test/{name}")["id"]


def _asset(user_id, source_url=URL_FIRST, sha=SHA, rel="pic.png"):
    return _q(
        "INSERT INTO captured_assets (sha256, source_url, content_type, byte_size, "
        "file_path, user_id) VALUES (%s, %s, 'image/png', %s, %s, %s) RETURNING id",
        (sha, source_url, len(PNG), f"user_{user_id}/{sha[:2]}/{rel}", user_id),
    )[0][0]


def _page_urls(content_id):
    return dict(_q(
        "SELECT asset_id, page_url FROM page_content_assets WHERE page_content_id = %s",
        (content_id,),
    ))


class TestMigration060:
    def test_column_is_nullable_text(self):
        rows = _q(
            "SELECT data_type, is_nullable FROM information_schema.columns "
            "WHERE table_name = 'page_content_assets' AND column_name = 'page_url'"
        )
        assert rows == [("text", "YES")]

    def test_migration_is_idempotent(self):
        sql = (
            pathlib.Path(__file__).parent.parent
            / "backend" / "db" / "migrations" / "060_page_content_assets_page_url.sql"
        ).read_text()
        _q(sql)
        assert _q(
            "SELECT count(*) FROM information_schema.columns "
            "WHERE table_name = 'page_content_assets' AND column_name = 'page_url'"
        ) == [(1,)]


class TestLinkAssetsToPage:
    def test_records_the_page_url_per_asset(self, user):
        cid = _content()
        a1, a2 = _asset(user["id"]), _asset(user["id"], "https://cdn.example.test/b.png",
                                            sha="b" * 64, rel="b.png")
        asset_archiver._link_assets_to_page(cid, [(a1, URL_PAGE), (a2, "https://cdn.example.test/b.png")])
        assert _page_urls(cid) == {a1: URL_PAGE, a2: "https://cdn.example.test/b.png"}

    def test_relinking_fills_a_null_page_url_but_never_overwrites_one(self, user):
        cid = _content()
        legacy, kept = _asset(user["id"]), _asset(user["id"], "https://cdn.example.test/b.png",
                                                  sha="b" * 64, rel="b.png")
        _q("INSERT INTO page_content_assets (page_content_id, asset_id) VALUES (%s, %s)", (cid, legacy))
        _q("INSERT INTO page_content_assets (page_content_id, asset_id, page_url) VALUES (%s, %s, %s)",
           (cid, kept, "https://cdn.example.test/original.png"))
        asset_archiver._link_assets_to_page(
            cid, [(legacy, URL_PAGE), (kept, "https://cdn.example.test/other.png")]
        )
        assert _page_urls(cid) == {legacy: URL_PAGE, kept: "https://cdn.example.test/original.png"}

    def test_empty_list_is_a_no_op(self):
        asset_archiver._link_assets_to_page(_content(), [])


class TestArchiverRecordsPageUrl:
    @staticmethod
    def _html(*srcs):
        return gzip.compress(
            b"<html><body>" + b"".join(f'<img src="{s}">'.encode() for s in srcs) + b"</body></html>"
        )

    async def _archive(self, user_id, cid, html, tmp_path):
        real = httpx.AsyncClient

        def spy(*args, **kwargs):
            kwargs["transport"] = httpx.MockTransport(
                lambda request: httpx.Response(200, content=PNG, headers={"content-type": "image/png"})
            )
            return real(*args, **kwargs)

        with patch("socket.getaddrinfo", return_value=_PUBLIC), patch.object(
            asset_archiver, "_BASE_ASSETS_DIR", tmp_path
        ), patch.object(asset_archiver, "_HOST_RATE_LIMIT_SECS", 0), patch("httpx.AsyncClient", spy):
            return await asset_archiver.archive_assets_for_page(cid, html, BASE, user_id)

    @pytest.mark.asyncio
    async def test_deduped_asset_links_with_the_url_this_page_used(self, user, tmp_path):
        """Same bytes already archived from another URL: the link row must carry
        THIS page's URL so the renderer can match its <img src>."""
        existing = _asset(user["id"], URL_FIRST)
        cid = _content()
        n = await self._archive(user["id"], cid, self._html(URL_PAGE), tmp_path)
        assert n == 1
        assert _page_urls(cid) == {existing: URL_PAGE}
        assert _q("SELECT count(*) FROM captured_assets") == [(1,)]
        # the renderer's map now resolves the page's URL AND the row's own source_url
        amap = _load_asset_map(cid, lambda p: "signed:" + p)
        assert amap[URL_PAGE] == amap[URL_FIRST] == f"signed:user_{user['id']}/{SHA[:2]}/pic.png"

    @pytest.mark.asyncio
    async def test_new_asset_records_its_own_url(self, user, tmp_path):
        cid = _content()
        await self._archive(user["id"], cid, self._html(URL_FIRST), tmp_path)
        (aid, source_url), = _q("SELECT id, source_url FROM captured_assets")
        assert source_url == URL_FIRST
        assert _page_urls(cid) == {aid: URL_FIRST}

    @pytest.mark.asyncio
    async def test_rearchiving_fills_links_made_before_the_column(self, user, tmp_path):
        existing = _asset(user["id"], URL_FIRST)
        cid = _content()
        _q("INSERT INTO page_content_assets (page_content_id, asset_id) VALUES (%s, %s)", (cid, existing))
        await self._archive(user["id"], cid, self._html(URL_PAGE), tmp_path)
        assert _page_urls(cid) == {existing: URL_PAGE}


class TestBackfillAssetPageUrls:
    """backend/scripts/backfill_asset_page_urls.py: recover page_url for links that
    the 2026-10-08 cross-account repair moved onto a row with another source_url."""

    @pytest.fixture
    def bf(self):
        from backend.scripts import backfill_asset_page_urls

        return backfill_asset_page_urls

    @pytest.fixture
    def other_user(self):
        return user_repo.create_user("page-url-other@example.test", name="Other")

    def _page(self, *srcs, name="post"):
        cid = _content(name)
        html = b"<html><body>" + b"".join(f'<img src="{s}">'.encode() for s in srcs) + b"</body></html>"
        content_repo.update_content(cid, raw_html=gzip.compress(html), raw_html_usable=True)
        return cid

    def _run(self, bf, *, apply):
        with get_conn() as conn, conn.cursor() as cur:
            return bf.backfill(cur, apply=apply)

    def _repaired_link(self, user, other_user, cid):
        """The post-repair shape: this account's row (source_url URL_FIRST) is linked
        and the other account's row (source_url = what the page used) still exists."""
        mine = _asset(user["id"], URL_FIRST)
        _asset(other_user["id"], URL_PAGE)
        _q("INSERT INTO page_content_assets (page_content_id, asset_id) VALUES (%s, %s)", (cid, mine))
        return mine

    def test_recovers_the_url_from_another_accounts_row(self, bf, user, other_user):
        cid = self._page(URL_PAGE)
        mine = self._repaired_link(user, other_user, cid)
        stats = self._run(bf, apply=True)
        assert (stats.links_filled, stats.links_unresolved) == (1, 0)
        assert _page_urls(cid) == {mine: URL_PAGE}
        assert _load_asset_map(cid, lambda p: p)[URL_PAGE].endswith("pic.png")

    def test_dry_run_counts_and_writes_nothing(self, bf, user, other_user):
        cid = self._page(URL_PAGE)
        mine = self._repaired_link(user, other_user, cid)
        stats = self._run(bf, apply=False)
        assert stats.links_filled == 1
        assert _page_urls(cid) == {mine: None}

    def test_second_run_finds_nothing_left(self, bf, user, other_user):
        cid = self._page(URL_PAGE)
        self._repaired_link(user, other_user, cid)
        self._run(bf, apply=True)
        stats = self._run(bf, apply=True)
        assert (stats.links_filled, stats.links_unresolved, stats.pages_scanned) == (0, 0, 0)

    def test_link_whose_source_url_the_page_already_uses_is_left_alone(self, bf, user):
        cid = self._page(URL_FIRST)
        mine = _asset(user["id"], URL_FIRST)
        _q("INSERT INTO page_content_assets (page_content_id, asset_id) VALUES (%s, %s)", (cid, mine))
        stats = self._run(bf, apply=True)
        assert (stats.links_filled, stats.links_unresolved) == (0, 0)
        assert _page_urls(cid) == {mine: None}

    def test_link_with_no_other_row_holding_the_page_url_is_reported_unresolved(self, bf, user):
        cid = self._page(URL_PAGE)
        mine = _asset(user["id"], URL_FIRST)
        _q("INSERT INTO page_content_assets (page_content_id, asset_id) VALUES (%s, %s)", (cid, mine))
        stats = self._run(bf, apply=True)
        assert (stats.links_filled, stats.links_unresolved) == (0, 1)
        assert stats.unresolved == [(cid, mine)]
        assert _page_urls(cid) == {mine: None}

    def test_a_row_with_another_sha_is_not_a_match(self, bf, user, other_user):
        cid = self._page(URL_PAGE)
        mine = _asset(user["id"], URL_FIRST)
        _asset(other_user["id"], URL_PAGE, sha="c" * 64, rel="c.png")  # same URL, other bytes
        _q("INSERT INTO page_content_assets (page_content_id, asset_id) VALUES (%s, %s)", (cid, mine))
        stats = self._run(bf, apply=True)
        assert (stats.links_filled, stats.links_unresolved) == (0, 1)
        assert _page_urls(cid) == {mine: None}

    def test_an_existing_page_url_is_never_overwritten(self, bf, user, other_user):
        cid = self._page(URL_PAGE)
        mine = self._repaired_link(user, other_user, cid)
        _q("UPDATE page_content_assets SET page_url = %s WHERE page_content_id = %s",
           ("https://cdn.example.test/set.png", cid))
        stats = self._run(bf, apply=True)
        assert stats.links_filled == 0
        assert _page_urls(cid) == {mine: "https://cdn.example.test/set.png"}

    def test_main_defaults_to_dry_run(self, bf, user, other_user, capsys):
        cid = self._page(URL_PAGE)
        mine = self._repaired_link(user, other_user, cid)
        assert bf.main([]) == 0
        out = capsys.readouterr().out
        assert "DRY RUN" in out and "links filled=1" in out
        assert _page_urls(cid) == {mine: None}
        assert bf.main(["--apply"]) == 0
        assert _page_urls(cid) == {mine: URL_PAGE}
