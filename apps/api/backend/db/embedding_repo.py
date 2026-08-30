"""Repository for the page_embeddings table (pgvector)."""

from backend.db.connection import get_conn

DEFAULT_MODEL = "all-MiniLM-L6-v2"


def save_embedding(
    page_content_id: int,
    embedding: list[float],
    model_name: str = DEFAULT_MODEL,
) -> None:
    """Upsert an embedding for a page_content row."""
    vec_literal = "[" + ",".join(str(v) for v in embedding) + "]"
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO page_embeddings (page_content_id, model_name, embedding)
                VALUES (%s, %s, %s::vector)
                ON CONFLICT (page_content_id, model_name) DO UPDATE
                SET embedding = EXCLUDED.embedding,
                    computed_at = NOW()
                """,
                (page_content_id, model_name, vec_literal),
            )


def save_embeddings_bulk(
    rows: list[tuple[int, list[float]]],
    model_name: str = DEFAULT_MODEL,
) -> int:
    """Bulk upsert embeddings. Each row is (page_content_id, embedding_list).

    Returns count of rows upserted.
    """
    if not rows:
        return 0
    with get_conn() as conn:
        with conn.cursor() as cur:
            for content_id, emb in rows:
                vec_literal = "[" + ",".join(str(v) for v in emb) + "]"
                cur.execute(
                    """
                    INSERT INTO page_embeddings (page_content_id, model_name, embedding)
                    VALUES (%s, %s, %s::vector)
                    ON CONFLICT (page_content_id, model_name) DO UPDATE
                    SET embedding = EXCLUDED.embedding,
                        computed_at = NOW()
                    """,
                    (content_id, model_name, vec_literal),
                )
    return len(rows)


def get_embedding(
    page_content_id: int,
    model_name: str = DEFAULT_MODEL,
) -> list[float] | None:
    """Fetch an embedding by page_content_id. Returns None if not found."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT embedding::text FROM page_embeddings
                WHERE page_content_id = %s AND model_name = %s
                """,
                (page_content_id, model_name),
            )
            row = cur.fetchone()

    if row is None:
        return None

    # Parse pgvector text representation: "[0.1,0.2,...]"
    return [float(x) for x in row[0].strip("[]").split(",")]


def get_embeddings_for_content_ids(
    content_ids: list[int],
    model_name: str = DEFAULT_MODEL,
) -> dict[int, list[float]]:
    """Batch-fetch embeddings for multiple content IDs.

    Returns dict mapping content_id to embedding list.
    """
    if not content_ids:
        return {}

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT page_content_id, embedding::text FROM page_embeddings
                WHERE page_content_id = ANY(%s) AND model_name = %s
                """,
                (content_ids, model_name),
            )
            rows = cur.fetchall()

    result = {}
    for content_id, emb_text in rows:
        result[content_id] = [float(x) for x in emb_text.strip("[]").split(",")]
    return result


def get_all_embeddings_with_metadata(user_id: int) -> list[dict]:
    """All embeddings with page metadata + cluster assignment for UMAP viz.

    Returns list of dicts with: page_content_id, embedding (float list),
    url, title, domain, content_summary, cluster_slug, cluster_name.
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT pe.page_content_id, pe.embedding::text,
                       pc.url, pc.content_summary,
                       p.title, p.domain,
                       cl.cluster_slug, cl.cluster_name
                FROM page_embeddings pe
                JOIN page_content pc ON pe.page_content_id = pc.id
                JOIN pages p ON p.page_content_id = pc.id
                JOIN captures cap ON p.capture_id = cap.id
                LEFT JOIN page_clusters pcl ON pcl.page_id = p.id
                LEFT JOIN clusters cl ON pcl.cluster_id = cl.id
                    AND cl.recluster_run = (
                        SELECT rr.id FROM recluster_runs rr
                        WHERE rr.user_id = cap.user_id
                          AND rr.status = 'completed'
                        ORDER BY rr.completed_at DESC LIMIT 1
                    )
                WHERE cap.user_id = %s AND pe.model_name = %s
                """,
                (user_id, DEFAULT_MODEL),
            )
            rows = cur.fetchall()

    results = []
    for r in rows:
        emb_text = r[1]
        embedding = [float(x) for x in emb_text.strip("[]").split(",")]
        results.append(
            {
                "page_content_id": r[0],
                "embedding": embedding,
                "url": r[2],
                "content_summary": r[3],
                "title": r[4],
                "domain": r[5],
                "cluster_slug": r[6],
                "cluster_name": r[7],
            }
        )
    return results


def find_similar(
    query_embedding: list[float],
    top_k: int = 10,
    model_name: str = DEFAULT_MODEL,
) -> list[dict]:
    """Find the most similar page_content rows by cosine distance.

    Returns list of dicts with 'page_content_id', 'distance', 'similarity'.
    Ordered by similarity descending (most similar first).

    Note: operates over page_embeddings (one-embedding-per-page, used by
    clustering). For RAG retrieval (chunk-level search) use
    ``find_similar_chunks`` instead.
    """
    vec_literal = "[" + ",".join(str(v) for v in query_embedding) + "]"
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT pe.page_content_id,
                       pe.embedding <=> %s::vector AS distance,
                       pc.url,
                       pc.content_summary
                FROM page_embeddings pe
                JOIN page_content pc ON pe.page_content_id = pc.id
                WHERE pe.model_name = %s
                ORDER BY pe.embedding <=> %s::vector ASC
                LIMIT %s
                """,
                (vec_literal, model_name, vec_literal, top_k),
            )
            rows = cur.fetchall()

    return [
        {
            "page_content_id": r[0],
            "distance": r[1],
            "similarity": 1.0 - r[1],  # cosine distance → similarity
            "url": r[2],
            "content_summary": r[3],
        }
        for r in rows
    ]


# =============================================================================
# chunk_embeddings — RAG retrieval storage
# =============================================================================
#
# page_embeddings stores one vector per canonical page (used by clustering).
# chunk_embeddings stores many vectors per page — one per passage — used by
# the RAG search feature. The two tables are kept separate because their
# consumers have different semantics: clustering wants topic centroids,
# retrieval wants quotable passages. See Plan 02 for the full rationale.


def save_chunk_embedding(
    page_chunk_id: int,
    embedding: list[float],
    model_name: str = DEFAULT_MODEL,
) -> None:
    """Upsert an embedding for a single page_chunks row."""
    vec_literal = "[" + ",".join(str(v) for v in embedding) + "]"
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO chunk_embeddings (page_chunk_id, model_name, embedding)
                VALUES (%s, %s, %s::vector)
                ON CONFLICT (page_chunk_id, model_name) DO UPDATE
                SET embedding = EXCLUDED.embedding,
                    computed_at = NOW()
                """,
                (page_chunk_id, model_name, vec_literal),
            )


def save_chunk_embeddings_bulk(
    rows: list[tuple[int, list[float]]],
    model_name: str = DEFAULT_MODEL,
) -> int:
    """Bulk upsert chunk embeddings. Each row is (page_chunk_id, embedding_list).

    Returns count of rows upserted.
    """
    if not rows:
        return 0
    with get_conn() as conn:
        with conn.cursor() as cur:
            for chunk_id, emb in rows:
                vec_literal = "[" + ",".join(str(v) for v in emb) + "]"
                cur.execute(
                    """
                    INSERT INTO chunk_embeddings (page_chunk_id, model_name, embedding)
                    VALUES (%s, %s, %s::vector)
                    ON CONFLICT (page_chunk_id, model_name) DO UPDATE
                    SET embedding = EXCLUDED.embedding,
                        computed_at = NOW()
                    """,
                    (chunk_id, model_name, vec_literal),
                )
    return len(rows)


def find_similar_chunks(
    query_embedding: list[float],
    top_k: int = 10,
    model_name: str = DEFAULT_MODEL,
    user_id: int | None = None,
    active_only: bool = False,
) -> list[dict]:
    """Find the most similar page_chunks by cosine distance (RAG retrieval path).

    Returns list of dicts with the chunk text, its parent page metadata, and
    the similarity score. Ordered by similarity descending.

    The return shape is intentionally compatible with ``find_similar``'s
    existing consumers (url, content_summary, similarity) so downstream
    callers can switch over without signature changes. ``content_summary``
    is populated with the chunk text (truncated to 300 chars for display).

    Scoping (two-tier search): pass ``user_id`` to restrict to that user's
    pages (the chunk tables carry no user_id; enforced via EXISTS on ``pages``).
    With ``active_only=True`` (the default search_compendium scope) results are
    further limited to effectively-active pages (COALESCE(human_status,status)
    = 'active'); ``full_search`` passes ``active_only=False``. Defaults
    (user_id=None, active_only=False) preserve the original unscoped behavior.
    """
    vec_literal = "[" + ",".join(str(v) for v in query_embedding) + "]"
    clauses = ["ce.model_name = %s"]
    params: list = [vec_literal, model_name]
    if user_id is not None:
        if active_only:
            clauses.append(
                "EXISTS (SELECT 1 FROM pages p WHERE p.page_content_id = pc.id "
                "AND p.user_id = %s AND COALESCE(p.human_status, p.status) = 'active')"
            )
        else:
            clauses.append(
                "EXISTS (SELECT 1 FROM pages p WHERE p.page_content_id = pc.id "
                "AND p.user_id = %s)"
            )
        params.append(user_id)
    params += [vec_literal, top_k]
    where_sql = " AND ".join(clauses)
    with get_conn() as conn:
        with conn.cursor() as cur:
            # IVFFlat probes tuning. The chunk_embeddings index is
            # idx_chunk_embeddings_ivfflat (lists=100). pgvector's default
            # ivfflat.probes=1 means each query scans only one of the 100
            # partitions -- ~1% of the corpus -- which at our scale
            # (~2K chunks) collapses recall to near-random results: the
            # query's own chunks are reachable but related chunks in
            # other partitions are invisible. Verified 2026-04-29 against
            # a self-similarity recall test on a seed topic's chunks --
            # probes=1 returned 1 of 6 same-topic chunks in top-12 (the
            # query itself) plus 11 unrelated chunks; probes=20 returned
            # 4 of 6 plus topical neighbours.
            #
            # 20 ≈ 20% of lists, gives strong recall with execution time
            # still ~17ms. Long-term plan: migrate the index to HNSW for
            # this corpus size (HNSW doesn't have a probes knob and gives
            # better recall+speed below ~100K vectors). Tracked separately.
            cur.execute("SET ivfflat.probes = 20")
            cur.execute(
                """
                SELECT ce.page_chunk_id,
                       ce.embedding <=> %s::vector AS distance,
                       pc.url,
                       pc.domain,
                       pch.chunk_text,
                       pch.section_title,
                       pch.page_content_id
                FROM chunk_embeddings ce
                JOIN page_chunks pch ON ce.page_chunk_id = pch.id
                JOIN page_content pc ON pch.page_content_id = pc.id
                WHERE {where_sql}
                ORDER BY ce.embedding <=> %s::vector ASC
                LIMIT %s
                """.format(where_sql=where_sql),
                tuple(params),
            )
            rows = cur.fetchall()

    return [
        {
            "page_chunk_id": r[0],
            "distance": r[1],
            "similarity": 1.0 - r[1],
            "url": r[2],
            "domain": r[3],
            "chunk_text": r[4],
            "section_title": r[5],
            "page_content_id": r[6],
            # Back-compat alias so find_similar-style consumers still work:
            # content_summary = first 300 chars of the chunk passage.
            "content_summary": (r[4] or "")[:300],
        }
        for r in rows
    ]


def get_chunks_for_page(page_content_id: int) -> list[dict]:
    """Return all chunks for a given canonical page_content row.

    Used by the migration script and for future "show me what was indexed
    for this page" debug views. Ordered by chunk_index.
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, chunk_index, chunk_text, section_title, token_count
                FROM page_chunks
                WHERE page_content_id = %s
                ORDER BY chunk_index
                """,
                (page_content_id,),
            )
            rows = cur.fetchall()

    return [
        {
            "id": r[0],
            "chunk_index": r[1],
            "chunk_text": r[2],
            "section_title": r[3],
            "token_count": r[4],
        }
        for r in rows
    ]


# =============================================================================
# clustering_embeddings — model/contract-versioned clustering cache
# =============================================================================
#
# Cache for the clustering pipeline's gated embedding upgrade (migration 035).
# Unlike page_embeddings (hard-typed vector(384), IVFFlat-indexed for
# find_similar), this table is dimension-flexible and seq-scan only. model_key
# encodes model AND text-contract version, e.g. 'text-embedding-3-small@ctv2'.


def get_clustering_embeddings(
    content_ids: list[int],
    model_key: str,
) -> dict[int, list[float]]:
    """Batch-fetch clustering-cache embeddings for one model_key.

    Returns {page_content_id: embedding_list} for the rows that exist.
    """
    if not content_ids:
        return {}
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT page_content_id, embedding::text FROM clustering_embeddings
                WHERE page_content_id = ANY(%s) AND model_key = %s
                """,
                (content_ids, model_key),
            )
            rows = cur.fetchall()
    return {
        content_id: [float(x) for x in emb_text.strip("[]").split(",")]
        for content_id, emb_text in rows
    }


def save_clustering_embeddings_bulk(
    rows: list[tuple[int, list[float]]],
    model_key: str,
) -> int:
    """Bulk upsert clustering-cache embeddings for one model_key.

    Each row is (page_content_id, embedding_list). Dimension is recorded from
    the vectors themselves. Returns count of rows upserted.
    """
    if not rows:
        return 0
    with get_conn() as conn:
        with conn.cursor() as cur:
            for content_id, emb in rows:
                vec_literal = "[" + ",".join(str(v) for v in emb) + "]"
                cur.execute(
                    """
                    INSERT INTO clustering_embeddings
                        (page_content_id, model_key, dim, embedding)
                    VALUES (%s, %s, %s, %s::vector)
                    ON CONFLICT (page_content_id, model_key) DO UPDATE
                    SET embedding = EXCLUDED.embedding,
                        dim = EXCLUDED.dim,
                        computed_at = NOW()
                    """,
                    (content_id, model_key, len(emb), vec_literal),
                )
    return len(rows)


# =============================================================================
# embedding_gists — per-page LLM gists for the ctv3 clustering-text register
# =============================================================================
#
# Cache for migration 039's gated ctv3 embedding-text contract (sc-followups
# 2026-07-16). Keyed by prompt_key (mirrors clustering_embeddings.model_key)
# so a prompt revision regenerates without schema surgery.


def get_embedding_gists(
    page_content_ids: list[int], prompt_key: str
) -> dict[int, str]:
    """{page_content_id: gist} for cached gists under this prompt version."""
    if not page_content_ids:
        return {}
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT page_content_id, gist FROM embedding_gists
                WHERE page_content_id = ANY(%s) AND prompt_key = %s
                """,
                (page_content_ids, prompt_key),
            )
            rows = cur.fetchall()
    return {r[0]: r[1] for r in rows}


def upsert_embedding_gists(rows: list[tuple[int, str]], prompt_key: str) -> None:
    """Insert-or-replace (page_content_id, gist) pairs for a prompt version."""
    if not rows:
        return
    with get_conn() as conn:
        with conn.cursor() as cur:
            for pcid, gist in rows:
                cur.execute(
                    """
                    INSERT INTO embedding_gists (page_content_id, prompt_key, gist)
                    VALUES (%s, %s, %s)
                    ON CONFLICT (page_content_id, prompt_key)
                    DO UPDATE SET gist = EXCLUDED.gist, computed_at = now()
                    """,
                    (pcid, prompt_key, gist),
                )
