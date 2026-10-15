"""Pure unit tests for the pre-clustering filters (content dedup, min content)."""

from backend.services.clustering_service import (
    MIN_CONTENT_CHARS,
    ClusteringService,
    content_fingerprint,
)

LONG_A = "alpha body sentence. " * 20  # > 200 chars
LONG_B = "beta body sentence. " * 20


def _page(n, text=LONG_A, url=None, title="Synthetic page", summary="", **kw):
    url = url or f"https://alpha.example/doc/{n}"
    p = {
        "db_id": n,
        "url": url,
        "title": title,
        "domain": "alpha.example",
        "summary": summary,
        "full_content": {"full_text": text} if text else {},
        "page_content_id": 1000 + n,
        "tool_selected": None,
        "is_learning": None,
        "normalized_url": url,
    }
    p.update(kw)
    return p


def _filter(pages):
    return ClusteringService(user_id=1)._filter_clusterable_pages(pages)


def test_same_title_and_domain_different_text_both_survive():
    out, stats = _filter([_page(1, LONG_A), _page(2, LONG_B)])
    assert [p["db_id"] for p in out] == [1, 2]
    assert stats["excluded_content_dedup"] == 0


def test_revisions_of_one_url_with_different_text_survive():
    url = "https://alpha.example/doc/rev"
    out, _ = _filter([_page(1, LONG_A, url=url), _page(2, LONG_B, url=url)])
    assert len(out) == 2


def test_identical_text_under_different_urls_collapses():
    out, stats = _filter([_page(1, LONG_A), _page(2, "  " + LONG_A.upper() + " ", title="Other")])
    assert [p["db_id"] for p in out] == [1]
    assert stats["excluded_content_dedup"] == 1


def test_same_normalized_url_without_text_collapses():
    url = "https://alpha.example/empty"
    pages = [_page(i, text="", url=url, summary="A real summary.") for i in (1, 2)]
    out, stats = _filter(pages)
    assert [p["db_id"] for p in out] == [1]
    assert stats["excluded_content_dedup"] == 1


def test_thin_page_needs_real_summary():
    short = "x" * 150
    assert 150 < MIN_CONTENT_CHARS
    thin = _page(1, short)
    kept = _page(2, short + "y", summary="A genuine summary.")
    placeholder = _page(3, short + "z", summary="[redacted: sensitive-skip retention carve-out]")
    out, stats = _filter([thin, kept, placeholder])
    assert [p["db_id"] for p in out] == [2]
    assert stats["excluded_min_content"] == 2


def test_stats_keys_present():
    _, stats = _filter([_page(1)])
    for key in (
        "total_input",
        "excluded_boilerplate",
        "excluded_url_fallback",
        "excluded_duplicate",
        "excluded_title_dedup",
        "excluded_min_content",
        "excluded_content_dedup",
        "excluded_not_learning",
        "total_output",
    ):
        assert key in stats
    assert stats["total_output"] == 1


def test_fingerprint_normalises_and_handles_missing_text():
    a = _page(1, "Hello   World\n")
    b = _page(2, "hello world")
    assert content_fingerprint(a) == content_fingerprint(b)
    assert content_fingerprint(_page(3, text="")) is None
    c = _page(4, text="", content_level_summary="Some summary")
    assert content_fingerprint(c) is not None
