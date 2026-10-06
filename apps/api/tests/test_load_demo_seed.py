"""DB-backed tests for scripts/demo/load_demo_seed.py (tailnet-owner-demo-split).

Uses a referentially-closed slice of the real seed with every id shifted by
OFFSET, loaded into throwaway demo/admin users in the TEST database, so the
explicit-id inserts never meet another test's rows. Setup and teardown purge
the throwaway users' rows (by email pattern) and orphaned OFFSET page_content.
"""
import copy
import uuid
from datetime import UTC, datetime, timedelta

import psycopg2
import pytest

from backend.config.settings import settings
from backend.db import auth_repo, user_repo
from scripts.demo import load_demo_seed as lds

OFFSET = 500_000_000
DSN = settings.test_database_url
assert DSN.rstrip("/").endswith("_test"), "these tests delete rows; test DB only"

ID_FIELDS = {
    "captures": ["id"],
    "page_content": ["id"],
    "pages": ["id", "capture_id", "page_content_id"],
    "recluster_runs": ["id"],
    "super_cluster_groups": ["id", "recluster_run"],
    "clusters": ["id", "recluster_run", "group_id"],
    "page_clusters": ["page_id", "cluster_id"],
    "cluster_edges": ["id", "recluster_run", "source_cluster", "target_cluster"],
    "featured_singletons": ["id", "page_id", "recluster_run"],
    "page_chunks": ["id", "page_content_id"],
    "chunk_embeddings": ["page_chunk_id"],
    "page_embeddings": ["page_content_id"],
    "clustering_embeddings": ["page_content_id"],
    "embedding_gists": ["page_content_id"],
    "captured_assets": ["id"],
    "page_content_assets": ["page_content_id", "asset_id"],
}
DEMO_TABLES = (
    "captures", "pages", "recluster_runs", "super_cluster_groups", "clusters",
    "featured_singletons", "captured_assets",
)


def _shift(v):
    return None if v is None else v + OFFSET


def subset_seed(data: dict, max_pages: int = 6) -> dict:
    pages = [p for p in data["pages"] if p["page_content_id"] is not None][:max_pages]
    page_ids = {p["id"] for p in pages}
    capture_ids = {p["capture_id"] for p in pages}
    pc_ids = {p["page_content_id"] for p in pages}
    page_clusters = [r for r in data["page_clusters"] if r["page_id"] in page_ids]
    cluster_ids = {r["cluster_id"] for r in page_clusters}
    clusters = [c for c in data["clusters"] if c["id"] in cluster_ids]
    group_ids = {c["group_id"] for c in clusters if c["group_id"] is not None}
    chunks = [c for c in data["page_chunks"] if c["page_content_id"] in pc_ids]
    chunk_ids = {c["id"] for c in chunks}
    pca = [r for r in data["page_content_assets"] if r["page_content_id"] in pc_ids]
    asset_ids = {r["asset_id"] for r in pca}

    def keep(table, pred):
        return [dict(r) for r in data[table] if pred(r)]

    out = {
        "manifest": data["manifest"],
        "captures": keep("captures", lambda r: r["id"] in capture_ids),
        "page_content": keep("page_content", lambda r: r["id"] in pc_ids),
        "pages": [dict(p) for p in pages],
        "recluster_runs": keep("recluster_runs", lambda r: True),
        "super_cluster_groups": keep("super_cluster_groups", lambda r: r["id"] in group_ids),
        "clusters": [dict(c) for c in clusters],
        "page_clusters": [dict(r) for r in page_clusters],
        "cluster_edges": keep(
            "cluster_edges",
            lambda r: r["source_cluster"] in cluster_ids and r["target_cluster"] in cluster_ids,
        ),
        "featured_singletons": keep("featured_singletons", lambda r: r["page_id"] in page_ids),
        "page_chunks": [dict(c) for c in chunks],
        "chunk_embeddings": keep("chunk_embeddings", lambda r: r["page_chunk_id"] in chunk_ids),
        "page_embeddings": keep("page_embeddings", lambda r: r["page_content_id"] in pc_ids),
        "clustering_embeddings": keep("clustering_embeddings", lambda r: r["page_content_id"] in pc_ids),
        "embedding_gists": keep("embedding_gists", lambda r: r["page_content_id"] in pc_ids),
        "captured_assets": keep("captured_assets", lambda r: r["id"] in asset_ids),
        "page_content_assets": [dict(r) for r in pca],
    }
    for table, fields in ID_FIELDS.items():
        for row in out[table]:
            for f in fields:
                row[f] = _shift(row[f])
    for row in out["page_content"]:
        row["normalized_url"] = f"seed-test/{row['id']}/{row['normalized_url']}"
    for row in out["captures"]:
        row["capture_id"] = f"seed-test-{row['id']}"
    return out


def subset_augment(rows: list[dict], subset: dict, n: int = 4) -> list[dict]:
    target = subset["captures"][0]["id"]
    picked = [dict(r) for r in rows[:n]]
    for r in picked:
        r["id"] = _shift(r["id"])
        r["capture_id"] = target
    return picked


def _q(sql, args=()):
    conn = psycopg2.connect(DSN)
    try:
        with conn, conn.cursor() as cur:
            cur.execute(sql, args)
            return cur.fetchall() if cur.description else None
    finally:
        conn.close()


SEED_TEST_EMAILS = ("seed-demo-%@test.local", "seed-admin-%@test.local")


def _purge_seed_test_rows():
    """Remove everything this module ever created, including leftovers of an
    aborted earlier run: rows owned by its throwaway users (matched by email
    pattern), the users themselves, and page_content in the OFFSET range that
    no page references any more."""
    ids = [r[0] for r in _q(
        "SELECT id FROM users WHERE email LIKE %s OR email LIKE %s", SEED_TEST_EMAILS)]
    if ids:
        _q("DELETE FROM captures WHERE user_id = ANY(%s)", (ids,))
        _q("DELETE FROM pages WHERE user_id = ANY(%s)", (ids,))
        _q("DELETE FROM captured_assets WHERE user_id = ANY(%s)", (ids,))
        _q("DELETE FROM users WHERE id = ANY(%s)", (ids,))
    _q("DELETE FROM page_content pc WHERE pc.id >= %s AND pc.id < %s "
       "AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.page_content_id = pc.id)",
       (OFFSET, OFFSET + 1_000_000))


def _sha(user_id):
    return _q("SELECT seed_sha256 FROM demo_seed_state WHERE user_id = %s", (user_id,))


def demo_fingerprint(user_id: int, seed: dict) -> dict:
    fp = {
        t: _q(f"SELECT count(*) FROM {t} WHERE user_id = %s", (user_id,))[0][0]
        for t in DEMO_TABLES
    }
    fp["page_clusters"] = _q(
        "SELECT count(*) FROM page_clusters pc JOIN pages p ON p.id = pc.page_id "
        "WHERE p.user_id = %s",
        (user_id,),
    )[0][0]
    fp["page_chunks"] = _q(
        "SELECT count(DISTINCT c.id) FROM page_chunks c "
        "JOIN pages p ON p.page_content_id = c.page_content_id WHERE p.user_id = %s",
        (user_id,),
    )[0][0]
    fp["cluster_names"] = _q(
        "SELECT cluster_name FROM clusters WHERE user_id = %s ORDER BY cluster_name",
        (user_id,),
    )
    fp["seed_page_ids"] = _q(
        "SELECT id FROM pages WHERE user_id = %s AND id = ANY(%s) ORDER BY id",
        (user_id, [p["id"] for p in seed["pages"]]),
    )
    return fp


def admin_snapshot(admin_id: int) -> dict:
    return {
        "captures": _q("SELECT * FROM captures WHERE user_id = %s ORDER BY id", (admin_id,)),
        "pages": _q("SELECT * FROM pages WHERE user_id = %s ORDER BY id", (admin_id,)),
        "page_content": _q(
            "SELECT pc.id, pc.normalized_url, pc.extracted_text FROM page_content pc "
            "JOIN pages p ON p.page_content_id = pc.id WHERE p.user_id = %s ORDER BY pc.id",
            (admin_id,),
        ),
    }


def _insert_admin(seed, admin_id, *, capture_id, page_id, page_content_id,
                  new_page_content=False):
    cap = dict(seed["captures"][0])
    cap.update(id=capture_id, user_id=admin_id, capture_id=f"admin-{capture_id}")
    page = dict(seed["pages"][0])
    page.update(id=page_id, capture_id=capture_id, user_id=admin_id,
                page_content_id=page_content_id)
    for key in ("url", "normalized_url"):
        if key in page:
            page[key] = f"https://admin.test/{page_id}"
    conn = psycopg2.connect(DSN)
    try:
        with conn, conn.cursor() as cur:
            if new_page_content:
                pc = dict(seed["page_content"][0])
                pc.update(id=page_content_id,
                          url=f"https://admin.test/pc/{page_content_id}",
                          normalized_url=f"admin.test/pc/{page_content_id}")
                lds._load_table(cur, "page_content", [pc], admin_id, -1)
            lds._load_table(cur, "captures", [cap], admin_id, -1)
            lds._load_table(cur, "pages", [page], admin_id, -1)
    finally:
        conn.close()


@pytest.fixture(scope="module")
def full_seed():
    return lds.read_seed(lds.SEED_PATH)


@pytest.fixture(scope="module")
def full_augment():
    return lds.read_augment_rows(lds.AUGMENT_PATH)


@pytest.fixture
def seed(full_seed):
    return subset_seed(full_seed)


@pytest.fixture
def augment(full_augment, seed):
    return subset_augment(full_augment, seed)


@pytest.fixture
def users():
    _purge_seed_test_rows()
    tag = uuid.uuid4().hex[:8]
    demo_email = f"seed-demo-{tag}@test.local"
    demo = user_repo.create_user(demo_email, name="seed demo")
    admin = user_repo.create_user(f"seed-admin-{tag}@test.local", name="seed admin")
    auth_repo.set_role(demo["id"], "demo")
    auth_repo.set_role(admin["id"], "admin")
    yield {"demo": demo["id"], "admin": admin["id"], "demo_email": demo_email}
    _purge_seed_test_rows()


def _load(seed, augment, users, sha="sha-a", **kw):
    return lds.run(DSN, data=seed, augment_rows=augment, seed_sha=sha,
                   demo_email=users["demo_email"], **kw)


def test_first_load_inserts_the_slice_and_records_the_sha(seed, augment, users):
    result = _load(seed, augment, users)
    assert result["action"] == "loaded"
    ins = result["inserted"]
    assert ins["captures"] == len(seed["captures"])
    assert ins["clusters"] == len(seed["clusters"])
    assert ins["pages"] == len(seed["pages"]) + len(augment)
    assert _sha(users["demo"]) == [("sha-a",)]
    assert demo_fingerprint(users["demo"], seed)["pages"] == len(seed["pages"]) + len(augment)


def test_a_second_plain_run_is_already_seeded(seed, augment, users):
    _load(seed, augment, users)
    assert _load(seed, augment, users, sha="sha-b")["action"] == "already_seeded"
    assert _sha(users["demo"]) == [("sha-a",)]


def test_augment_pages_get_fresh_ids(seed, augment, users):
    taken = augment[0]["id"]
    _insert_admin(seed, users["admin"], capture_id=OFFSET + 990_001, page_id=taken,
                  page_content_id=OFFSET + 990_002, new_page_content=True)
    result = _load(seed, augment, users)
    assert result["inserted"]["pages"] == len(seed["pages"]) + len(augment)
    owners = _q("SELECT user_id FROM pages WHERE id = %s", (taken,))
    assert owners == [(users["admin"],)]


def test_dry_run_first_load_writes_nothing(seed, augment, users):
    result = _load(seed, augment, users, dry_run=True)
    assert result["action"] == "loaded" and result["dry_run"] is True
    assert demo_fingerprint(users["demo"], seed)["captures"] == 0
    assert _sha(users["demo"]) == []


def test_reset_sequence_never_moves_backwards(seed, augment, users):
    current = _q("SELECT last_value FROM captures_id_seq")[0][0]
    ahead = max(current, max(c["id"] for c in seed["captures"])) + 1000
    _q("SELECT setval('captures_id_seq', %s)", (ahead,))
    _load(seed, augment, users)
    assert _q("SELECT last_value FROM captures_id_seq") == [(ahead,)]
