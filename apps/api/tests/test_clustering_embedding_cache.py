"""Embedding-cache invalidation by content hash (migration 055).

Both caches (``page_embeddings`` for local SBERT, ``clustering_embeddings`` for
the OpenAI path) are keyed by page_content_id, so a re-fetched content row used
to keep serving its old vector. A cached row is now a hit only when its stored
``content_hash`` equals ``content_fingerprint(page)``; a NULL hash (legacy row)
is a miss. ``embedding_repo`` is replaced by in-memory dicts and the encoders
are stubbed: no DB, no network.
"""

import hashlib

import numpy as np
import pytest

from backend.config.settings import settings
from backend.db import embedding_repo, trends_repo
from backend.services.clustering_service import ClusteringService, content_fingerprint

OPENAI_DIM = 4
SBERT_DIM = 384


def _vec(text: str, dim: int) -> list[float]:
    seed = int.from_bytes(hashlib.sha256(text.encode()).digest()[:4], "big")
    return np.random.default_rng(seed).normal(size=dim).tolist()


def _page(n: int, text: str) -> dict:
    return {
        "db_id": n,
        "url": f"https://alpha.example/doc/{n}",
        "title": f"Synthetic page {n}",
        "domain": "alpha.example",
        "summary": f"Summary {n}.",
        "full_content": {},
        "content_extracted_text": text,
        "page_content_id": 100 + n,
        "tool_selected": None,
    }


class _Env:
    """In-memory caches + call recorders shared by both paths."""

    def __init__(self):
        self.store: dict[int, tuple[list[float], str | None]] = {}
        self.encoded: list[str] = []
        self.saved: list[tuple] = []


def _norm(v):
    a = np.asarray(v, dtype=float)
    return a / np.linalg.norm(a)


@pytest.fixture(params=["sbert", "openai"])
def env(request, monkeypatch):
    e = _Env()
    e.path = request.param
    e.dim = SBERT_DIM if request.param == "sbert" else OPENAI_DIM

    def get(content_ids, *args, with_hashes=False, **kw):
        assert with_hashes, "cache lookups must request the stored hash"
        return {c: e.store[c] for c in content_ids if c in e.store}

    def save(rows, *args, **kw):
        for row in rows:
            assert len(row) == 3, "cache writes must carry the content hash"
            e.saved.append(row)
            e.store[row[0]] = (row[1], row[2])
        return len(rows)

    monkeypatch.setattr(embedding_repo, "get_clustering_embeddings", get)
    monkeypatch.setattr(embedding_repo, "get_embeddings_for_content_ids", get)
    monkeypatch.setattr(embedding_repo, "save_clustering_embeddings_bulk", save)
    monkeypatch.setattr(embedding_repo, "save_embeddings_bulk", save)
    monkeypatch.setattr(trends_repo, "insert_cost_event", lambda **kw: None)
    monkeypatch.setattr(
        ClusteringService, "_save_sbert_text_audit", staticmethod(lambda rows: None)
    )

    if request.param == "sbert":
        monkeypatch.setattr(settings, "clustering_embedding_model", "all-MiniLM-L6-v2")

        class _Model:
            def encode(self, texts, show_progress_bar=False, batch_size=64):
                e.encoded.extend(texts)
                return np.array([_vec(t, SBERT_DIM) for t in texts])

        monkeypatch.setattr(ClusteringService, "_get_sbert_model", lambda self: _Model())
    else:
        monkeypatch.setattr(settings, "clustering_embedding_model", "text-embedding-3-small")
        monkeypatch.setattr(settings, "clustering_text_contract", "ctv2")

        class _Resp:
            def __init__(self, texts):
                class _Item:
                    def __init__(self, i, t):
                        self.index, self.embedding = i, _vec(t, OPENAI_DIM)

                class _Usage:
                    total_tokens = 10 * len(texts)

                self.data = [_Item(i, t) for i, t in enumerate(texts)]
                self.usage = _Usage()

        class _Client:
            def __init__(self, api_key=None):
                class _Emb:
                    @staticmethod
                    def create(model, input):
                        e.encoded.extend(input)
                        return _Resp(input)

                self.embeddings = _Emb()

        monkeypatch.setattr("openai.OpenAI", _Client)
    return e


def _run(pages):
    return ClusteringService(user_id=1)._compute_embeddings(pages)


def test_matching_hash_is_not_reencoded(env):
    pages = [_page(1, "alpha text one"), _page(2, "alpha text two")]
    first = _run(pages)
    assert len(env.encoded) == 2
    env.encoded.clear()
    env.saved.clear()
    second = _run(pages)
    assert env.encoded == [] and env.saved == []
    np.testing.assert_allclose(first, second)


def test_changed_content_is_reencoded_and_new_hash_saved(env):
    pages = [_page(1, "original text"), _page(2, "stable text")]
    _run(pages)
    env.encoded.clear()
    env.saved.clear()

    pages[0] = _page(1, "re-fetched, different text")  # same page_content_id
    result = _run(pages)

    assert len(env.encoded) == 1  # only the changed page
    assert [row[0] for row in env.saved] == [101]
    assert env.saved[0][2] == content_fingerprint(pages[0])
    assert env.store[101][1] == content_fingerprint(pages[0])
    assert env.store[101][1] != content_fingerprint(_page(1, "original text"))
    # the matrix carries the NEW vector, not the stale cached one
    np.testing.assert_allclose(result[0], _norm(env.store[101][0]))


def test_legacy_null_hash_row_is_reencoded(env):
    pages = [_page(1, "legacy text")]
    env.store[101] = (_vec("stale legacy vector", env.dim), None)
    _run(pages)
    assert len(env.encoded) == 1
    assert env.store[101][1] == content_fingerprint(pages[0])


def test_output_rows_follow_page_order_with_mixed_hits(env):
    pages = [_page(n, f"text number {n}") for n in (1, 2, 3, 4)]
    _run([pages[1], pages[3]])  # warm the cache for pages 2 and 4
    env.encoded.clear()
    result = _run(pages)
    assert len(env.encoded) == 2  # pages 1 and 3 only
    assert result.shape[0] == 4
    for i, page in enumerate(pages):
        cid = page["page_content_id"]
        np.testing.assert_allclose(result[i], _norm(env.store[cid][0]), atol=1e-9)
    # distinct pages -> distinct rows (guards against order mix-ups)
    assert len({tuple(np.round(r, 6)) for r in result}) == 4


def test_page_without_text_is_cached_after_first_run(env):
    page = _page(1, "")
    page["summary"] = "Only a page-level summary."
    _run([page])
    env.encoded.clear()
    _run([page])
    assert env.encoded == []  # stamped, so not re-embedded forever
