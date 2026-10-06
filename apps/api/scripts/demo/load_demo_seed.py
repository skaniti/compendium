"""Load the reviewed demo seed into the database (batch-07 Task 4).

Reads ``apps/api/data/demo-seed/demo_seed.json.gz`` — a portable export of
the demo compendium (158 pages, fully processed: summaries, chunks, chunk
+ page + clustering embeddings, clusters, superclusters, featured
singletons) — and inserts it under whichever user has ``role = 'demo'`` in
the target database (created by ``backend.scripts.bootstrap_user``).

Deliberately stdlib + psycopg2 only: no ``backend`` package imports, so
this runs fast and standalone without pulling in the FastAPI app's import
graph (torch/sentence-transformers/etc.). Connects directly via
``DATABASE_URL``.

Design:

- **Schema-version gate.** The seed's embedded manifest records the schema
  version it was exported at (a ``schema_migrations`` version string, e.g.
  ``"043_dq_run_kind_and_gate"``). Before touching any data, the loader
  compares the seed's migration number against the DB's own
  ``schema_migrations`` table and hard-fails if the DB hasn't caught up —
  loading columns the DB doesn't have yet would either error confusingly
  mid-transaction or silently drop data, neither of which is acceptable.

- **user_id remap.** Exactly 7 of the 16 tables carry a ``user_id`` column
  tied to the source deployment's demo user (id 153, per the manifest).
  Every row in those tables gets its ``user_id`` rewritten to whatever id
  the *target* database's demo user actually has (looked up by role, with
  the configured ``BOOTSTRAP_DEMO_EMAIL`` as a tie-breaker) — the source id
  is very unlikely to match a fresh clone's sequence-assigned id.

- **Exported ids preserved.** Every row keeps its exported numeric id
  (explicit-id insert) so cross-table foreign keys in the export stay
  valid without a remapping pass. This schema's identity columns are all
  plain SERIAL/BIGSERIAL (verified against every migration — no
  ``GENERATED ALWAYS AS IDENTITY`` column exists anywhere), so no
  ``OVERRIDING SYSTEM VALUE`` clause is needed or applicable; a plain
  explicit-id INSERT is accepted as-is. After each id-bearing table loads,
  its sequence is advanced to ``MAX(id)`` only when it is not already ahead;
  an already-ahead sequence is never touched (``setval`` is not called), so no
  sequence moves backwards and no issued id is reissued in a shared database.

- **Vector casts.** ``chunk_embeddings.embedding``, ``page_embeddings.embedding``,
  and ``clustering_embeddings.embedding`` arrive as bracket-text strings
  (Postgres's own vector literal format); those three columns are inserted
  with an explicit ``::vector`` cast.

- **BYTEA remap.** ``page_content.raw_html`` is BYTEA and can't survive a
  plain JSON round-trip; the export stores it as a base64 string under
  ``raw_html_b64``. The loader base64-decodes it back into the real
  ``raw_html`` column.

- **Idempotent.** If the resolved demo user already has any ``captures``
  or ``pages`` rows, a plain run logs "already seeded" and exits 0 without
  touching anything else. Safe to run on every container boot.

- **Seed version record.** Every load records ``seed_sha256()`` (the seed
  artifact + augment file bytes) in ``demo_seed_state`` (migration 048).

- **Augment ids are not preserved.** The synthetic augment pages are
  inserted with sequence-assigned ids (nothing references them; their
  hard-coded ids would collide with real pages in a shared database).

- **--replace.** Delete the demo account's rows (only those) and reload; no-op when the recorded sha matches; any seed id held by another account aborts the whole transaction (exit 2). A page_content row another account's page shares is kept, not re-inserted.

- **Single transaction.** All 16 tables load (or none do) — a failure
  partway through rolls back cleanly rather than leaving a half-seeded
  demo account.

Run manually (matches how ``docker/entrypoint.sh`` invokes it):

    DATABASE_URL=postgresql://tbd:tbd_local@localhost:5433/traversal_discovery \\
        python scripts/demo/load_demo_seed.py
"""

from __future__ import annotations

import argparse
import base64
import gzip
import hashlib
import json
import os
import re
import sys
from pathlib import Path

import psycopg2
import psycopg2.extras
from psycopg2 import sql

SEED_PATH = Path(
    os.environ.get(
        "DEMO_SEED_PATH",
        str(Path(__file__).resolve().parents[2] / "data" / "demo-seed" / "demo_seed.json.gz"),
    )
)
AUGMENT_PATH = SEED_PATH.with_name("demo_seed_augment.json")

# FK-safe insert order per the load contract (batch-07 Task 4 export review).
INSERT_ORDER = [
    "captures",
    "page_content",
    "pages",
    "recluster_runs",
    "super_cluster_groups",
    "clusters",
    "page_clusters",
    "cluster_edges",
    "featured_singletons",
    "page_chunks",
    "chunk_embeddings",
    "page_embeddings",
    "clustering_embeddings",
    "embedding_gists",
    "captured_assets",
    "page_content_assets",
]

# Tables whose rows carry the source deployment's demo user_id (153 in the
# manifest) and need it rewritten to the target DB's actual demo user id.
# Verified against every migration that touches these 16 tables — no other
# table in the export has a user_id column.
USER_ID_TABLES = {
    "captures",
    "pages",
    "clusters",
    "recluster_runs",
    "super_cluster_groups",
    "featured_singletons",
    "captured_assets",
}

# Tables with a real SERIAL/BIGSERIAL `id` primary key — these get
# explicit-id inserts + a post-load setval(). The other 6 tables
# (page_clusters, chunk_embeddings, page_embeddings, clustering_embeddings,
# embedding_gists, page_content_assets) use composite PKs with no owned
# sequence to touch.
SEQUENCE_TABLES = {
    "captures",
    "page_content",
    "pages",
    "recluster_runs",
    "super_cluster_groups",
    "clusters",
    "cluster_edges",
    "featured_singletons",
    "page_chunks",
    "captured_assets",
}

# Columns that are pgvector `vector` type and need `::vector` on insert —
# the export stores them as bracket-text strings, not native arrays.
VECTOR_COLUMNS = {
    "chunk_embeddings": {"embedding"},
    "page_embeddings": {"embedding"},
    "clustering_embeddings": {"embedding"},
}

# Exported-column -> real-column remaps for values that can't survive a
# plain JSON round trip. page_content.raw_html is BYTEA; the export
# base64-encodes it as raw_html_b64.
B64_COLUMN_REMAP = {
    "page_content": {"raw_html_b64": "raw_html"},
}

# --replace (tailnet-owner-demo-split, 2026-10-06). Every DELETE is filtered
# by the resolved demo user id. Non-seed rows that can point at demo ids
# (no FK) go first; graph_cache is rebuilt on the next graph load.
DEMO_SCOPED_EXTRA_TABLES = (
    "graph_cache",
    "annotations",
    "entity_tags",
    "dq_recommendations",
    "dq_overrides",
    "dq_observations",
    "dq_runs",
)
# Seed tables with a user_id. Cascades take page_clusters, cluster_edges and
# page_content_assets; page_content (global, no user_id) is handled after.
DEMO_OWNED_SEED_TABLES = (
    "captures",
    "pages",
    "recluster_runs",
    "clusters",
    "super_cluster_groups",
    "featured_singletons",
    "captured_assets",
)
# Rows keyed by page_content_id that are skipped, not re-inserted, when their
# page_content row survives because another user's page still uses it.
PAGE_CONTENT_CHILD_TABLES = (
    "page_chunks",
    "page_embeddings",
    "clustering_embeddings",
    "embedding_gists",
)


class SeedCollision(RuntimeError):
    """A seed id is held by a row outside the demo account. The transaction
    is rolled back; nothing changed."""

    def __init__(self, table: str, ids: list[int]):
        self.table = table
        self.ids = list(ids)
        super().__init__(
            f"{table}: seed ids already held by rows outside the demo account: "
            f"{self.ids[:20]}"
        )


_VERSION_NUM_RE = re.compile(r"^(\d+)")


def fail(message: str) -> None:
    print(f"[load_demo_seed] ERROR: {message}", file=sys.stderr)
    sys.exit(1)


def _numeric_prefix(version: str) -> int:
    m = _VERSION_NUM_RE.match(version)
    if not m:
        fail(f"cannot parse a numeric prefix from migration version {version!r}")
    return int(m.group(1))  # type: ignore[union-attr]


def _check_schema_version(cur, manifest_schema_version: str) -> None:
    cur.execute("SELECT version FROM schema_migrations")
    applied = [row[0] for row in cur.fetchall()]
    if not applied:
        fail(
            "schema_migrations is empty — run migrations "
            "(`python -m backend.db.migrate`) before loading the demo seed."
        )
    max_applied = max(_numeric_prefix(v) for v in applied)
    seed_version = _numeric_prefix(manifest_schema_version)
    if seed_version > max_applied:
        fail(
            f"demo seed requires schema version {manifest_schema_version!r} "
            f"(migration {seed_version:03d}) but this database has only "
            f"applied through migration {max_applied:03d}. Run "
            "`python -m backend.db.migrate` to bring the schema up to date, "
            "then re-run the loader."
        )
    print(
        f"[load_demo_seed] schema check OK — seed requires >= migration "
        f"{seed_version:03d}, DB has applied through {max_applied:03d}"
    )


def _resolve_demo_user_id(cur, demo_email: str) -> int:
    cur.execute("SELECT id, email FROM users WHERE role = 'demo'")
    rows = cur.fetchall()
    if not rows:
        fail(
            "no user with role='demo' found. Run "
            "`python -m backend.scripts.bootstrap_user` first (SEED_DEMO=1 "
            "in docker/entrypoint.sh does this automatically, ahead of this "
            "loader, on every boot)."
        )
    if len(rows) == 1:
        return rows[0][0]
    for user_id, email in rows:
        if email == demo_email:
            return user_id
    fail(
        f"multiple users have role='demo' and none match "
        f"BOOTSTRAP_DEMO_EMAIL={demo_email!r} — cannot disambiguate which "
        "one to seed."
    )
    raise AssertionError("unreachable")  # fail() always exits


def _already_seeded(cur, demo_user_id: int) -> bool:
    cur.execute(
        "SELECT EXISTS(SELECT 1 FROM captures WHERE user_id = %s) "
        "OR EXISTS(SELECT 1 FROM pages WHERE user_id = %s)",
        (demo_user_id, demo_user_id),
    )
    return bool(cur.fetchone()[0])


def _transform_row(
    table: str, row: dict, demo_user_id: int, source_user_id: int
) -> dict:
    """Apply the table's column/value remaps; return column -> bound value."""
    remap = B64_COLUMN_REMAP.get(table, {})
    out: dict = {}
    for key, value in row.items():
        if key in remap:
            column = remap[key]
            value = psycopg2.Binary(base64.b64decode(value)) if value is not None else None
        else:
            column = key
        out[column] = value
    if table in USER_ID_TABLES and out.get("user_id") == source_user_id:
        out["user_id"] = demo_user_id
    return out


def _load_table(
    cur, table: str, rows: list[dict], demo_user_id: int, source_user_id: int
) -> int:
    if not rows:
        return 0

    vector_cols = VECTOR_COLUMNS.get(table, set())
    # Every row in a given table shares the same key set (verified at
    # seed-review time) — take column order from the first row.
    columns = list(_transform_row(table, rows[0], demo_user_id, source_user_id).keys())
    col_list = ", ".join(f'"{c}"' for c in columns)
    template = "(" + ", ".join(
        (f"%s::vector" if c in vector_cols else "%s") for c in columns
    ) + ")"

    values = []
    expected_keys = set(columns)
    for raw_row in rows:
        row = _transform_row(table, raw_row, demo_user_id, source_user_id)
        if set(row.keys()) != expected_keys:
            raise ValueError(
                f"{table}: ragged row — keys {sorted(set(row) ^ expected_keys)} "
                "differ from the first row's; refusing to load a seed whose "
                "rows would silently NULL or drop columns"
            )
        tup = []
        for c in columns:
            v = row.get(c)
            if isinstance(v, (dict, list)):
                v = psycopg2.extras.Json(v)
            tup.append(v)
        values.append(tuple(tup))

    insert_sql = f"INSERT INTO {table} ({col_list}) VALUES %s"
    psycopg2.extras.execute_values(cur, insert_sql, values, template=template, page_size=500)
    return len(values)


def _reset_sequence(cur, table: str) -> None:
    """Advance the table's id sequence to MAX(id) when -- and only when -- it
    is not already ahead. When it is ahead (a database other users share,
    possibly with a live API issuing ids concurrently) setval is never called,
    so no sequence moves backwards and no issued id is reissued."""
    cur.execute("SELECT pg_get_serial_sequence(%s, 'id')", (table,))
    schema, name = cur.fetchone()[0].split(".", 1)
    schema, name = schema.strip('"'), name.strip('"')
    cur.execute(
        sql.SQL(
            "SELECT setval(%s, m) FROM (SELECT MAX(id) AS m FROM {table}) s "
            "WHERE m IS NOT NULL AND m >= (SELECT last_value FROM {seq})"
        ).format(table=sql.Identifier(table), seq=sql.Identifier(schema, name)),
        (f"{schema}.{name}",),
    )


def _load_augment(cur, rows: list[dict], demo_user_id: int, source_user_id: int) -> int:
    """Insert the synthetic augment pages (D10 c-1), if any.

    Archived / skipped / pending pages attached to the seed's captures so the
    Pipeline dev view has a skip population. Temporary until the
    demo-seed-maturity re-export replaces the seed.

    Their exported ids are DROPPED (tailnet-owner-demo-split, 2026-10-06):
    nothing references an augment page, and the hard-coded ids (13076+)
    would collide with real pages in a database other users share. The
    pages sequence assigns fresh ones.
    """
    fresh = [{k: v for k, v in row.items() if k != "id"} for row in rows]
    n = _load_table(cur, "pages", fresh, demo_user_id, source_user_id)
    if n:
        _reset_sequence(cur, "pages")
    print(f"[load_demo_seed] augment: inserted {n} synthetic pages")
    return n


def read_seed(seed_path: Path = SEED_PATH) -> dict:
    with gzip.open(seed_path, "rt", encoding="utf-8") as f:
        data = json.load(f)
    if not data.get("manifest"):
        fail("seed file has no 'manifest' key — not a valid demo seed export")
    return data


def read_augment_rows(augment_path: Path = AUGMENT_PATH) -> list[dict]:
    if not augment_path.exists():
        return []
    return json.loads(augment_path.read_text(encoding="utf-8"))["pages"]


def seed_sha256(seed_path: Path = SEED_PATH, augment_path: Path = AUGMENT_PATH) -> str:
    """Identity of the seed being loaded: the seed artifact's bytes plus the
    augment file's (when present). Recorded per demo account in
    demo_seed_state so --replace can tell "nothing changed" from "reload"."""
    h = hashlib.sha256(seed_path.read_bytes())
    if augment_path.exists():
        h.update(b"\x00augment\x00")
        h.update(augment_path.read_bytes())
    return h.hexdigest()


def _recorded_sha(cur, demo_user_id: int) -> str | None:
    cur.execute("SELECT seed_sha256 FROM demo_seed_state WHERE user_id = %s", (demo_user_id,))
    row = cur.fetchone()
    return row[0] if row else None


def _record_sha(cur, demo_user_id: int, seed_sha: str) -> None:
    cur.execute(
        "INSERT INTO demo_seed_state (user_id, seed_sha256, loaded_at) "
        "VALUES (%s, %s, now()) ON CONFLICT (user_id) DO UPDATE "
        "SET seed_sha256 = EXCLUDED.seed_sha256, loaded_at = now()",
        (demo_user_id, seed_sha),
    )


def _delete_demo_rows(cur, demo_user_id: int) -> dict[str, int]:
    deleted: dict[str, int] = {}
    cur.execute(
        "SELECT DISTINCT page_content_id FROM pages "
        "WHERE user_id = %s AND page_content_id IS NOT NULL",
        (demo_user_id,),
    )
    page_content_ids = [r[0] for r in cur.fetchall()]
    for table in DEMO_SCOPED_EXTRA_TABLES + DEMO_OWNED_SEED_TABLES:
        cur.execute(f"DELETE FROM {table} WHERE user_id = %s", (demo_user_id,))
        deleted[table] = cur.rowcount
    # page_content is global: drop only rows the demo used that no remaining
    # page (another user's) still points at. Cascades take chunks, chunk
    # embeddings, page embeddings, clustering embeddings, gists and asset links.
    cur.execute(
        "DELETE FROM page_content pc WHERE pc.id = ANY(%s) "
        "AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.page_content_id = pc.id)",
        (page_content_ids,),
    )
    deleted["page_content"] = cur.rowcount
    return deleted


def _shared_page_content(cur, page_content_rows: list[dict]) -> set[int]:
    """Seed page_content rows already present with the SAME id and URL are
    shared with another user's page: keep them (skip the insert). Any other
    clash on id or URL is a collision."""
    if not page_content_rows:
        return set()
    url_by_id = {r["id"]: r["normalized_url"] for r in page_content_rows}
    cur.execute(
        "SELECT id, normalized_url FROM page_content "
        "WHERE id = ANY(%s) OR normalized_url = ANY(%s)",
        (list(url_by_id), list(url_by_id.values())),
    )
    shared: set[int] = set()
    conflicts: list[int] = []
    for pc_id, url in cur.fetchall():
        if url_by_id.get(pc_id) == url:
            shared.add(pc_id)
        else:
            conflicts.append(pc_id)
    if conflicts:
        raise SeedCollision("page_content", sorted(conflicts))
    return shared


def _rows_for(table: str, data: dict, shared: set[int], skipped_chunks: set[int]) -> list[dict]:
    rows = data.get(table, [])
    if table == "page_content":
        return [r for r in rows if r["id"] not in shared]
    if table in PAGE_CONTENT_CHILD_TABLES:
        return [r for r in rows if r["page_content_id"] not in shared]
    if table == "chunk_embeddings":
        return [r for r in rows if r["page_chunk_id"] not in skipped_chunks]
    return rows


def _check_collisions(cur, data: dict, shared: set[int], skipped_chunks: set[int]) -> None:
    for table in INSERT_ORDER:
        if table not in SEQUENCE_TABLES or table == "page_content":
            continue
        ids = [r["id"] for r in _rows_for(table, data, shared, skipped_chunks)]
        if not ids:
            continue
        cur.execute(f"SELECT id FROM {table} WHERE id = ANY(%s) ORDER BY id LIMIT 20", (ids,))
        hits = [r[0] for r in cur.fetchall()]
        if hits:
            raise SeedCollision(table, hits)


def _load_all(cur, data: dict, augment_rows: list[dict], demo_user_id: int,
              source_user_id: int) -> dict[str, int]:
    shared = _shared_page_content(cur, data.get("page_content", []))
    skipped_chunks = {
        c["id"] for c in data.get("page_chunks", []) if c["page_content_id"] in shared
    }
    _check_collisions(cur, data, shared, skipped_chunks)
    counts: dict[str, int] = {}
    for table in INSERT_ORDER:
        rows = _rows_for(table, data, shared, skipped_chunks)
        n = _load_table(cur, table, rows, demo_user_id, source_user_id)
        counts[table] = n
        if table in SEQUENCE_TABLES and n:
            _reset_sequence(cur, table)
        print(f"  {table:24s} {n:6d} rows loaded")
        if table == "pages":
            counts["pages"] += _load_augment(cur, augment_rows, demo_user_id, source_user_id)
    counts["shared_page_content"] = len(shared)
    return counts


def run(dsn: str, *, data: dict, augment_rows: list[dict], seed_sha: str,
        demo_email: str, replace: bool = False, dry_run: bool = False) -> dict:
    """Load ``data`` into the demo account, in one transaction.

    Returns ``{"demo_user_id", "dry_run", "action", "inserted"}`` where
    ``action`` is ``"loaded"``, ``"already_seeded"``, ``"replaced"`` or
    ``"up_to_date"``. Replace deletes only rows owned by the demo account,
    then reloads; a ``SeedCollision`` rolls back everything. A dry run does all
    the work inside the transaction, then rolls it back.
    """
    manifest = data["manifest"]
    source_user_id = manifest.get("source_demo_user_id", 153)
    conn = psycopg2.connect(dsn)
    try:
        conn.autocommit = False
        with conn.cursor() as cur:
            _check_schema_version(cur, manifest["schema_version"])
            demo_user_id = _resolve_demo_user_id(cur, demo_email)
            result: dict = {"demo_user_id": demo_user_id, "dry_run": dry_run}
            if replace:
                if _recorded_sha(cur, demo_user_id) == seed_sha:
                    conn.rollback()
                    return {**result, "action": "up_to_date"}
                result["action"] = "replaced"
                result["deleted"] = _delete_demo_rows(cur, demo_user_id)
            else:
                if _already_seeded(cur, demo_user_id):
                    conn.rollback()
                    return {**result, "action": "already_seeded"}
                result["action"] = "loaded"
            result["inserted"] = _load_all(cur, data, augment_rows, demo_user_id, source_user_id)
            _record_sha(cur, demo_user_id, seed_sha)
        if dry_run:
            conn.rollback()
        else:
            conn.commit()
        return result
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _print_summary(result: dict) -> None:
    print(f"[load_demo_seed] action={result['action']} demo_user_id={result['demo_user_id']}")
    for label in ("deleted", "inserted"):
        counts = result.get(label)
        if counts:
            print(f"[load_demo_seed] {label}:")
            for table, n in counts.items():
                print(f"  {table:24s} {n:6d}")
    if result.get("dry_run"):
        print("[load_demo_seed] DRY RUN -- rolled back; no rows changed (id sequences may have advanced)")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Load the demo seed into the demo account.")
    parser.add_argument("--dry-run", action="store_true",
                        help="do the work inside a transaction, print the counts, then roll back")
    parser.add_argument("--replace", action="store_true",
                        help="swap the demo account's rows for the current seed when it changed")
    args = parser.parse_args(argv)

    if not SEED_PATH.exists():
        fail(f"seed artifact not found at {SEED_PATH}")
    print(f"[load_demo_seed] reading {SEED_PATH} ...")
    data = read_seed(SEED_PATH)
    manifest = data["manifest"]
    print(
        f"[load_demo_seed] manifest: schema_version={manifest['schema_version']!r} "
        f"export_date={manifest.get('export_date')!r} "
        f"source_demo_user_id={manifest.get('source_demo_user_id', 153)}"
    )
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        fail("DATABASE_URL is not set")
    try:
        result = run(
            dsn,
            data=data,
            augment_rows=read_augment_rows(AUGMENT_PATH),
            seed_sha=seed_sha256(SEED_PATH, AUGMENT_PATH),
            demo_email=os.environ.get("BOOTSTRAP_DEMO_EMAIL", "demo@traversal.local"),
            replace=args.replace,
            dry_run=args.dry_run,
        )
    except SeedCollision as exc:
        print(f"[load_demo_seed] ABORTED, nothing changed: {exc}", file=sys.stderr)
        return 2
    _print_summary(result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
