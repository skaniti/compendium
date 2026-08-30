"""Cheap unit tests for the embedding-gist backfill script (sc-followups task 2).

Scope is deliberately narrow: slice math and CLI arg plumbing only. The
script's DB/LLM-touching paths (_load_missing_pages, main_async's
asyncio.gather loop, the cost event) are exercised end-to-end in task 3's
real backfill run, not unit-tested here -- mocking the whole ClusteringService
+ embedding_repo + trends_repo chain would mostly test the mocks.
"""

from backend.scripts.backfill_embedding_gists import (
    DEFAULT_CONCURRENCY,
    SLICE_SIZE,
    _build_parser,
    _chunk,
)


# ── _chunk (slice math) ──────────────────────────────────────────────────


def test_chunk_empty_list():
    assert _chunk([], 16) == []


def test_chunk_exact_multiple():
    items = list(range(32))
    chunks = _chunk(items, 16)
    assert chunks == [list(range(16)), list(range(16, 32))]


def test_chunk_with_remainder():
    items = list(range(35))
    chunks = _chunk(items, 16)
    assert [len(c) for c in chunks] == [16, 16, 3]
    assert sum(chunks, []) == items


def test_chunk_smaller_than_size():
    items = list(range(5))
    assert _chunk(items, 16) == [items]


def test_slice_size_matches_gist_batch_size():
    # Each slice must correspond to exactly one internal LLM batch call
    # inside ClusteringService._generate_embedding_gists -- otherwise
    # --concurrency wouldn't bound concurrent LLM calls the way the docs
    # (and the task brief's progress-line example) describe.
    from backend.services.clustering_service import GIST_BATCH_SIZE

    assert SLICE_SIZE == GIST_BATCH_SIZE


# ── CLI arg plumbing ─────────────────────────────────────────────────────


def test_parser_defaults():
    args = _build_parser().parse_args([])
    assert args.user_id is None
    assert args.concurrency == DEFAULT_CONCURRENCY
    assert args.dry_run is False


def test_parser_dry_run_flag():
    args = _build_parser().parse_args(["--dry-run"])
    assert args.dry_run is True


def test_parser_user_id_and_concurrency_overrides():
    args = _build_parser().parse_args(
        ["--user-id", "152", "--concurrency", "4"]
    )
    assert args.user_id == 152
    assert args.concurrency == 4
