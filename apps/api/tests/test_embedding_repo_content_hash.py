"""DB-backed round trip of the content_hash stamp on both embedding caches."""

import pytest

from backend.db import content_repo, embedding_repo
from backend.db.connection import get_conn


def _pg_reachable() -> bool:
    try:
        from backend.config.settings import settings

        url = settings.test_database_url
        if not url.startswith("postgresql"):
            return False
        from psycopg2 import connect

        connect(url).close()
        return True
    except Exception:  # noqa: BLE001
        return False


pytestmark = pytest.mark.skipif(not _pg_reachable(), reason="Test PostgreSQL not reachable")


@pytest.fixture
def content_id():
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("TRUNCATE clustering_embeddings, page_embeddings, page_content CASCADE")
    return content_repo.get_or_create_content("https://alpha.example/hash", extracted_text="x")[
        "id"
    ]


def test_clustering_cache_hash_round_trip(content_id):
    key = "model-x@ctv2"
    vec = [0.1, 0.2, 0.3]
    embedding_repo.save_clustering_embeddings_bulk([(content_id, vec, "h1")], key)
    got = embedding_repo.get_clustering_embeddings([content_id], key, with_hashes=True)
    assert got[content_id][1] == "h1"
    assert embedding_repo.get_clustering_embeddings([content_id], key)[content_id] == pytest.approx(
        vec
    )
    # legacy 2-tuple: accepted, stores NULL (so the row reads as stale)
    embedding_repo.save_clustering_embeddings_bulk([(content_id, vec)], key)
    got = embedding_repo.get_clustering_embeddings([content_id], key, with_hashes=True)
    assert got[content_id][1] is None


def test_page_embeddings_hash_round_trip(content_id):
    vec = [0.5] * 384
    embedding_repo.save_embeddings_bulk([(content_id, vec, "h2")])
    got = embedding_repo.get_embeddings_for_content_ids([content_id], with_hashes=True)
    assert got[content_id][1] == "h2"
    embedding_repo.save_embeddings_bulk([(content_id, vec, "h3")])
    got = embedding_repo.get_embeddings_for_content_ids([content_id], with_hashes=True)
    assert got[content_id][1] == "h3"
    embedding_repo.save_embeddings_bulk([(content_id, vec)])
    assert (
        embedding_repo.get_embeddings_for_content_ids([content_id], with_hashes=True)[content_id][1]
        is None
    )
