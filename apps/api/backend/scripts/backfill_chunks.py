"""Backfill RAG chunks + embeddings for pages that were never indexed.

Lives in backend/scripts/ (not scripts/dev/) so it ships inside the deployed
image -- scripts/ is .dockerignored, backend/ is COPYed -- and can run in the
app container. Mirrors the bootstrap_user convention.

WHY
  Chunking runs once, at capture time (backend/api/main.py RAG block). An
  April-2026 failure window left many extension-captured pages with zero
  page_chunks/chunk_embeddings -- e.g. the "Head Space Studio" salon About page
  -- so the CompendiumAgent cannot retrieve them. The live pipeline now indexes
  reliably; this re-runs chunking+embedding over the backlog using the SAME
  chunker the pipeline uses.

WHAT
  For each page (ANY status by default; --active-only restricts to active) whose
  page_content has content but zero chunks, produce chunks with
  rag_pipeline._detect_chunker and write page_chunks + chunk_embeddings keyed to
  the KNOWN page_content_id. It does NOT call get_or_create_content, so existing
  content_summary / tool_selected are never touched, and no duplicate
  page_content rows can be created.

  DEFAULT SCOPE = everything -- the substrate for the two-tier search (a default
  active-scoped search_compendium + an opt-in full_search over all chunks); see
  docs/project-plans/_completed/2026-06-16-143832-two-tier-rag-search/.

  SEQUENCING: the all-statuses backfill is safe now that the default search is
  active-scoped (two-tier search shipped). --active-only remains a safe subset.

SAFETY
  - Dry-run by DEFAULT; pass --commit to write.
  - Idempotent: skips any page_content that already has >=1 chunk; each page's
    inserts are a single transaction (all-or-nothing).
  - Refuses --commit when REPRO_DSN is set (that env var is the read-only
    claude_ro tunnel -- writes would fail anyway).
  - Embeddings are L2-normalized to match existing chunk_embeddings rows.

RUN (on the server, inside the app container):
    docker compose -f docker/server/docker-compose.yml exec app \\
        python -m backend.scripts.backfill_chunks            # dry-run: report only
    docker compose -f docker/server/docker-compose.yml exec app \\
        python -m backend.scripts.backfill_chunks --commit   # write

READ-ONLY DRY-RUN from the laptop (via the compendium-ro tunnel):
    REPRO_DSN=postgresql://claude_ro@localhost:15432/traversal_discovery \\
        python -m backend.scripts.backfill_chunks
"""

import argparse
import os
import sys
import time

from backend.config.settings import settings
from backend.db.connection import get_conn, set_dsn_override
from backend.services.rag_pipeline import _detect_chunker

MODEL_NAME = "all-MiniLM-L6-v2"


def fetch_targets(user_id, limit, active_only):
    """Pages with content but no chunks, keyed by canonical page_content.

    Default scope is ALL statuses (chunk-everything). active_only restricts to
    pages whose effective status (COALESCE(human_status, status)) is 'active'.
    """
    if active_only:
        scope_clause = (
            "AND EXISTS (SELECT 1 FROM pages p WHERE p.page_content_id = pc.id "
            "            AND p.user_id = %s "
            "            AND COALESCE(p.human_status, p.status) = 'active') "
        )
    else:
        scope_clause = (
            "AND EXISTS (SELECT 1 FROM pages p WHERE p.page_content_id = pc.id "
            "            AND p.user_id = %s) "
        )
    sql = (
        "SELECT pc.id, pc.url, pc.fetched_content "
        "FROM page_content pc "
        "WHERE pc.fetched_content IS NOT NULL "
        + scope_clause
        + "AND NOT EXISTS (SELECT 1 FROM page_chunks ch WHERE ch.page_content_id = pc.id) "
        "ORDER BY pc.id"
    )
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(sql, (user_id,))
        rows = cur.fetchall()
    return rows[:limit] if limit else rows


def write_page(pcid, chunks, model):
    """Embed + insert all chunks for one page in a single transaction.

    Idempotency guard: re-checks for existing chunks inside the txn and skips
    if any appeared since the target was fetched. Returns chunks written.
    """
    import numpy as np

    texts = [c["content"] for c in chunks]
    embs = model.encode(texts, show_progress_bar=False, batch_size=32)
    embs = embs / np.linalg.norm(embs, axis=1, keepdims=True)
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT 1 FROM page_chunks WHERE page_content_id = %s LIMIT 1", (pcid,))
        if cur.fetchone():
            return 0
        for idx, (c, emb) in enumerate(zip(chunks, embs)):
            cur.execute(
                "INSERT INTO page_chunks "
                "(page_content_id, chunk_index, chunk_text, section_title, token_count) "
                "VALUES (%s, %s, %s, %s, %s) RETURNING id",
                (pcid, idx, c["content"], c.get("section_title"), c.get("token_count")),
            )
            chunk_id = cur.fetchone()[0]
            vec = "[" + ",".join(str(v) for v in emb.tolist()) + "]"
            cur.execute(
                "INSERT INTO chunk_embeddings (page_chunk_id, model_name, embedding) "
                "VALUES (%s, %s, %s::vector) ON CONFLICT (page_chunk_id, model_name) DO NOTHING",
                (chunk_id, MODEL_NAME, vec),
            )
    return len(chunks)


def main():
    ap = argparse.ArgumentParser(description="Backfill RAG chunks for unindexed pages.")
    ap.add_argument("--commit", action="store_true", help="actually write (default: dry-run)")
    ap.add_argument("--user", type=int, default=152, help="user_id to backfill (default 152)")
    ap.add_argument("--limit", type=int, default=0, help="cap pages processed (0 = all)")
    ap.add_argument(
        "--active-only",
        action="store_true",
        help="restrict to active pages (default: ALL statuses -- the chunk-everything substrate)",
    )
    args = ap.parse_args()

    dsn = os.environ.get("REPRO_DSN")
    if dsn:
        set_dsn_override(dsn)
    db = (dsn or settings.database_url).split("@")[-1]
    mode = "COMMIT (writing)" if args.commit else "DRY-RUN (no writes)"
    print(f"[backfill] mode={mode}  db={db}  user={args.user}", flush=True)

    if args.commit and dsn:
        print(
            "[backfill] REFUSING --commit with REPRO_DSN set (read-only tunnel). "
            "Run in the app container WITHOUT REPRO_DSN.",
            flush=True,
        )
        sys.exit(2)

    scope = "active-only" if args.active_only else "ALL statuses (chunk-everything)"
    targets = fetch_targets(args.user, args.limit, args.active_only)
    print(
        f"[backfill] scope={scope}  candidates: {len(targets)} page_content rows "
        f"with content and 0 chunks",
        flush=True,
    )
    if args.commit and not args.active_only:
        print(
            "[backfill] NOTE: all-statuses commit indexes archived/excluded pages too. "
            "Safe now that the default search is active-scoped (two-tier search shipped).",
            flush=True,
        )

    model = None
    if args.commit:
        from backend.services import sbert_loader

        print("[backfill] loading SBERT encoder...", flush=True)
        model = sbert_loader.get_sbert_model()

    t0 = time.perf_counter()
    pages_ok = total_chunks = thin = 0
    for n, (pcid, url, fc) in enumerate(targets, 1):
        try:
            chunks = _detect_chunker(url)(url, fc or {})
        except Exception as e:  # noqa: BLE001
            print(f"  [warn] pc={pcid} chunker error: {e!r}", flush=True)
            chunks = []
        if not chunks:
            thin += 1
        else:
            pages_ok += 1
            total_chunks += len(chunks)
            if args.commit:
                write_page(pcid, chunks, model)
        if n % 50 == 0 or n == len(targets):
            print(
                f"  [{n}/{len(targets)}] pages_with_chunks={pages_ok} "
                f"chunks={total_chunks} thin={thin} ({time.perf_counter() - t0:.0f}s)",
                flush=True,
            )

    verb_pages = "got" if args.commit else "would get"
    verb_chunks = "written" if args.commit else "that would be created"
    print(f"\n[backfill] {mode} complete:", flush=True)
    print(f"  pages that {verb_pages} chunks                 : {pages_ok}", flush=True)
    print(f"  total chunks {verb_chunks} : {total_chunks}", flush=True)
    print(f"  pages producing 0 chunks (thin/JS, skipped) : {thin}", flush=True)
    if not args.commit:
        print(
            "[backfill] DRY-RUN only -- re-run with --commit in the app container to write.",
            flush=True,
        )


if __name__ == "__main__":
    main()
