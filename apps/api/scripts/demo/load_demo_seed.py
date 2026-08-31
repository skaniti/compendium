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
  its sequence is fast-forwarded via ``setval(..., MAX(id))`` so the next
  *application* insert doesn't collide with a seeded id.

- **Vector casts.** ``chunk_embeddings.embedding``, ``page_embeddings.embedding``,
  and ``clustering_embeddings.embedding`` arrive as bracket-text strings
  (Postgres's own vector literal format); those three columns are inserted
  with an explicit ``::vector`` cast.

- **BYTEA remap.** ``page_content.raw_html`` is BYTEA and can't survive a
  plain JSON round-trip; the export stores it as a base64 string under
  ``raw_html_b64``. The loader base64-decodes it back into the real
  ``raw_html`` column.

- **Idempotent.** If the resolved demo user already has any ``captures``
  or ``pages`` rows, the loader logs "already seeded" and exits 0 without
  touching anything else. Safe to run on every container boot.

- **Single transaction.** All 16 tables load (or none do) — a failure
  partway through rolls back cleanly rather than leaving a half-seeded
  demo account.

Run manually (matches how ``docker/entrypoint.sh`` invokes it):

    DATABASE_URL=postgresql://tbd:tbd_local@localhost:5433/traversal_discovery \\
        python scripts/demo/load_demo_seed.py
"""

from __future__ import annotations

import base64
import gzip
import json
import os
import re
import sys
from pathlib import Path

import psycopg2
import psycopg2.extras

SEED_PATH = Path(
    os.environ.get(
        "DEMO_SEED_PATH",
        str(Path(__file__).resolve().parents[2] / "data" / "demo-seed" / "demo_seed.json.gz"),
    )
)

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


def _resolve_demo_user_id(cur) -> int:
    demo_email = os.environ.get("BOOTSTRAP_DEMO_EMAIL", "demo@traversal.local")
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

    sql = f"INSERT INTO {table} ({col_list}) VALUES %s"
    psycopg2.extras.execute_values(cur, sql, values, template=template, page_size=500)
    return len(values)


def _reset_sequence(cur, table: str) -> None:
    cur.execute(
        f"SELECT setval(pg_get_serial_sequence(%s, 'id'), "
        f"COALESCE((SELECT MAX(id) FROM {table}), 1))",
        (table,),
    )


def main() -> int:
    if not SEED_PATH.exists():
        fail(f"seed artifact not found at {SEED_PATH}")

    print(f"[load_demo_seed] reading {SEED_PATH} ...")
    with gzip.open(SEED_PATH, "rt", encoding="utf-8") as f:
        data = json.load(f)

    manifest = data.get("manifest")
    if not manifest:
        fail("seed file has no 'manifest' key — not a valid demo seed export")
    schema_version = manifest["schema_version"]
    source_user_id = manifest.get("source_demo_user_id", 153)
    print(
        f"[load_demo_seed] manifest: schema_version={schema_version!r} "
        f"export_date={manifest.get('export_date')!r} "
        f"source_demo_user_id={source_user_id}"
    )

    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        fail("DATABASE_URL is not set")

    conn = psycopg2.connect(dsn)
    counts: dict[str, int] = {}
    try:
        conn.autocommit = False
        with conn.cursor() as cur:
            _check_schema_version(cur, schema_version)

            demo_user_id = _resolve_demo_user_id(cur)
            print(f"[load_demo_seed] target demo user id = {demo_user_id}")

            if _already_seeded(cur, demo_user_id):
                print(
                    "[load_demo_seed] demo user already has captures/pages "
                    "— already seeded, exiting"
                )
                conn.rollback()
                return 0

            print(
                f"[load_demo_seed] loading seed data "
                f"(source user_id {source_user_id} -> {demo_user_id}) ..."
            )
            for table in INSERT_ORDER:
                rows = data.get(table, [])
                n = _load_table(cur, table, rows, demo_user_id, source_user_id)
                counts[table] = n
                if table in SEQUENCE_TABLES and n:
                    _reset_sequence(cur, table)
                print(f"  {table:24s} {n:6d} rows loaded")

        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    print("[load_demo_seed] done. Per-table summary:")
    for table in INSERT_ORDER:
        print(f"  {table:24s} {counts.get(table, 0):6d}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
