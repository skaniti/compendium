"""DB-backed tests for scripts/repair_cross_account_assets.py.

Builds a small cross-account scenario in the TEST database under throwaway
users (matched by email pattern, purged at setup and teardown) with a tmp_path
assets directory. ``only_users`` keeps the planner away from unrelated rows
other tests may have left in the shared test database.
"""
import hashlib
import uuid
from pathlib import Path

import psycopg2
import pytest

from backend.config.settings import settings
from backend.db import auth_repo, user_repo
from scripts import repair_cross_account_assets as rca
from scripts.demo import load_demo_seed as lds

DSN = settings.test_database_url
assert DSN.rstrip("/").endswith("_test"), "these tests delete rows; test DB only"

EMAIL_PATTERN = "repair-xacct-%@test.local"
URL_PREFIX = "repair-xacct-test/"
BYTES_A = b"\x89PNG-repair-test-asset-A"
BYTES_B = b"\x89PNG-repair-test-asset-B"


def _q(sql, args=()):
    conn = psycopg2.connect(DSN)
    try:
        with conn, conn.cursor() as cur:
            cur.execute(sql, args)
            return cur.fetchall() if cur.description else None
    finally:
        conn.close()


def _purge():
    ids = [r[0] for r in _q("SELECT id FROM users WHERE email LIKE %s", (EMAIL_PATTERN,))]
    if ids:
        _q("DELETE FROM pages WHERE user_id = ANY(%s)", (ids,))
        _q("DELETE FROM captures WHERE user_id = ANY(%s)", (ids,))
        _q("DELETE FROM captured_assets WHERE user_id = ANY(%s)", (ids,))
        _q("DELETE FROM users WHERE id = ANY(%s)", (ids,))
    _q("DELETE FROM page_content WHERE normalized_url LIKE %s "
       "AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.page_content_id = page_content.id)",
       (URL_PREFIX + "%",))


@pytest.fixture
def world(tmp_path):
    _purge()
    tag = uuid.uuid4().hex[:8]
    ids = {}
    for name in ("owner", "user", "other"):
        u = user_repo.create_user(f"repair-xacct-{name}-{tag}@test.local", name=name)
        ids[name] = u["id"]
    auth_repo.set_role(ids["owner"], "demo")
    ids["tag"] = tag
    ids["dir"] = tmp_path
    yield ids
    _purge()


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _capture(user_id):
    return _q(
        "INSERT INTO captures (user_id, capture_id, source, started_at, ended_at) "
        "VALUES (%s, %s, 'desktop_active', now(), now()) RETURNING id",
        (user_id, f"rx-{uuid.uuid4().hex[:20]}"),
    )[0][0]


def _page_content(world, label):
    n = f"{URL_PREFIX}{world['tag']}/{label}"
    return _q(
        "INSERT INTO page_content (url, normalized_url) VALUES (%s, %s) RETURNING id",
        ("https://" + n, n),
    )[0][0]


def _page(user_id, capture_id, pc_id):
    _q("INSERT INTO pages (capture_id, user_id, page_content_id, url, normalized_url) "
       "VALUES (%s, %s, %s, %s, %s)",
       (capture_id, user_id, pc_id, f"https://p/{uuid.uuid4().hex}", f"p/{uuid.uuid4().hex}"))


def _asset(user_id, data, assets_dir, *, write=True, rel=None,
           source_url="https://img.test/a.png"):
    sha = _sha(data)
    rel = rel or f"user_{user_id}/{sha[:2]}/{sha}.png"
    if write:
        (assets_dir / rel).parent.mkdir(parents=True, exist_ok=True)
        (assets_dir / rel).write_bytes(data)
    return _q(
        "INSERT INTO captured_assets (sha256, source_url, content_type, byte_size, "
        "file_path, user_id) VALUES (%s, %s, 'image/png', %s, %s, %s) "
        "RETURNING id",
        (sha, source_url, len(data), rel, user_id),
    )[0][0]


def _link(pc_id, asset_id):
    _q("INSERT INTO page_content_assets (page_content_id, asset_id) VALUES (%s, %s)",
       (pc_id, asset_id))


def build(world, *, write_source=True, source_bytes=BYTES_A, user_has_copy=False,
          copy_written=True, copy_url="https://img.test/a.png"):
    """Owner O (role demo) owns asset A; two page_contents used only by U link
    it, a third page_content used by O also links it. Returns ids."""
    o, u = world["owner"], world["user"]
    d = world["dir"]
    asset = _asset(o, BYTES_A, d, write=False)
    if write_source:
        rel = _q("SELECT file_path FROM captured_assets WHERE id = %s", (asset,))[0][0]
        (d / rel).parent.mkdir(parents=True, exist_ok=True)
        (d / rel).write_bytes(source_bytes)
    cap_o, cap_u = _capture(o), _capture(u)
    pc1, pc2, pc3 = (_page_content(world, n) for n in ("pc1", "pc2", "pc3"))
    _page(u, cap_u, pc1)
    _page(u, cap_u, pc2)
    _page(o, cap_o, pc3)
    for pc in (pc1, pc2, pc3):
        _link(pc, asset)
    own = (_asset(u, BYTES_A, d, write=copy_written, source_url=copy_url)
           if user_has_copy else None)
    return {"asset": asset, "pcs": (pc1, pc2, pc3), "own": own}


def tree(d: Path):
    return sorted(str(p.relative_to(d)) for p in d.rglob("*") if p.is_file())


def db_state(world):
    ids = [world["owner"], world["user"], world["other"]]
    return (
        _q("SELECT id, sha256, file_path, user_id FROM captured_assets "
           "WHERE user_id = ANY(%s) ORDER BY id", (ids,)),
        _q("SELECT pca.page_content_id, pca.asset_id FROM page_content_assets pca "
           "JOIN captured_assets a ON a.id = pca.asset_id WHERE a.user_id = ANY(%s) "
           "ORDER BY 1, 2", (ids,)),
    )


def run(world, *, do_apply, users=None, page_account=None):
    conn = psycopg2.connect(DSN)
    try:
        with conn.cursor() as cur:
            p = rca.plan(cur, world["dir"],
                         only_users=users or {world["owner"], world["user"]},
                         page_account=page_account)
            if do_apply and not p.problems:
                rca.apply(cur, p, world["dir"])
                conn.commit()
            else:
                conn.rollback()
        return p
    finally:
        conn.close()


def test_dry_run_writes_nothing(world):
    build(world)
    before_db, before_files = db_state(world), tree(world["dir"])
    p = run(world, do_apply=False)
    assert not p.problems
    stats = p.pairs[(world["owner"], world["user"])]
    assert (stats.links, stats.assets, stats.reused, stats.created, stats.copies) == (2, 1, 0, 1, 1)
    assert db_state(world) == before_db
    assert tree(world["dir"]) == before_files


def test_apply_creates_owned_copy_and_moves_only_user_links(world):
    b = build(world)
    o, u = world["owner"], world["user"]
    sha = _sha(BYTES_A)
    run(world, do_apply=True)
    rows = _q("SELECT id, user_id, file_path, source_url, content_type, byte_size "
              "FROM captured_assets WHERE sha256 = %s ORDER BY id", (sha,))
    assert [r[1] for r in rows] == [o, u]
    new = rows[1]
    assert new[2] == f"user_{u}/{sha[:2]}/{sha}.png"
    assert new[3:] == ("https://img.test/a.png", "image/png", len(BYTES_A))
    assert (world["dir"] / new[2]).read_bytes() == BYTES_A
    pc1, pc2, pc3 = b["pcs"]
    links = _q("SELECT page_content_id, asset_id FROM page_content_assets "
               "WHERE page_content_id = ANY(%s) ORDER BY 1", (list(b["pcs"]),))
    assert links == [(pc1, new[0]), (pc2, new[0]), (pc3, b["asset"])]
    assert rows[0][0] == b["asset"] and rows[0][2].startswith(f"user_{o}/")
    assert (world["dir"] / rows[0][2]).read_bytes() == BYTES_A


def test_existing_user_row_is_reused(world):
    b = build(world, user_has_copy=True)
    before_files = tree(world["dir"])
    p = run(world, do_apply=True)
    stats = p.pairs[(world["owner"], world["user"])]
    assert (stats.reused, stats.created, stats.copies) == (1, 0, 0)
    assert tree(world["dir"]) == before_files
    assert _q("SELECT count(*) FROM captured_assets WHERE sha256 = %s",
              (_sha(BYTES_A),)) == [(2,)]
    assert _q("SELECT asset_id FROM page_content_assets WHERE page_content_id = ANY(%s) "
              "ORDER BY page_content_id", (list(b["pcs"][:2]),)) == [(b["own"],), (b["own"],)]


def test_multi_account_page_content_is_skipped_and_counted(world):
    b = build(world)
    pc_multi = _page_content(world, "multi")
    _page(world["user"], _capture(world["user"]), pc_multi)
    _page(world["other"], _capture(world["other"]), pc_multi)
    _link(pc_multi, b["asset"])
    p = run(world, do_apply=True)
    assert p.skipped_multi == 1
    assert _q("SELECT asset_id FROM page_content_assets WHERE page_content_id = %s",
              (pc_multi,)) == [(b["asset"],)]


def test_missing_source_file_aborts_and_writes_nothing(world):
    build(world, write_source=False)
    before_db, before_files = db_state(world), tree(world["dir"])
    p = run(world, do_apply=True)
    assert p.problems and any("missing" in m for m in p.problems)
    assert db_state(world) == before_db
    assert tree(world["dir"]) == before_files


def test_source_sha_mismatch_aborts_and_writes_nothing(world):
    build(world, source_bytes=BYTES_B)
    before_db, before_files = db_state(world), tree(world["dir"])
    p = run(world, do_apply=True)
    assert p.problems and any("sha256" in m for m in p.problems)
    assert db_state(world) == before_db
    assert tree(world["dir"]) == before_files


def test_conflicting_destination_file_aborts(world):
    build(world)
    sha = _sha(BYTES_A)
    dest = world["dir"] / f"user_{world['user']}/{sha[:2]}/{sha}.png"
    dest.parent.mkdir(parents=True)
    dest.write_bytes(BYTES_B)
    before_db = db_state(world)
    p = run(world, do_apply=True)
    assert p.problems
    assert dest.read_bytes() == BYTES_B
    assert db_state(world) == before_db


def test_matching_destination_file_is_not_recopied(world):
    build(world)
    sha = _sha(BYTES_A)
    dest = world["dir"] / f"user_{world['user']}/{sha[:2]}/{sha}.png"
    dest.parent.mkdir(parents=True)
    dest.write_bytes(BYTES_A)
    p = run(world, do_apply=False)
    assert not p.problems
    assert p.pairs[(world["owner"], world["user"])].copies == 0


def test_second_run_finds_nothing(world):
    build(world)
    run(world, do_apply=True)
    p = run(world, do_apply=True)
    assert not p.pairs and p.skipped_multi == 0 and not p.problems


def test_apply_clears_the_demo_loader_cascade_guard(world):
    build(world)
    o = world["owner"]
    conn = psycopg2.connect(DSN)
    try:
        with conn.cursor() as cur, pytest.raises(
            lds.CrossAccountRows, match="page_content_assets linking demo assets"
        ):
            lds._check_cascade_guards(cur, o)
        conn.rollback()
    finally:
        conn.close()
    run(world, do_apply=True)
    conn = psycopg2.connect(DSN)
    try:
        with conn.cursor() as cur:
            lds._check_cascade_guards(cur, o)
    finally:
        conn.close()


def _scope(world):
    return ["--only-users", f"{world['owner']},{world['user']}",
            "--page-account", str(world["user"]), "--assets-dir", str(world["dir"])]


def test_main_defaults_to_dry_run(world, monkeypatch, capsys):
    build(world)
    before_db, before_files = db_state(world), tree(world["dir"])
    monkeypatch.setenv("DATABASE_URL", DSN)
    code = rca.main(_scope(world))
    out = capsys.readouterr().out
    assert code == 0
    assert "DRY RUN -- nothing written (rerun with --apply)" in out
    assert db_state(world) == before_db
    assert tree(world["dir"]) == before_files


def test_main_apply_commits(world, monkeypatch, capsys):
    b = build(world)
    monkeypatch.setenv("DATABASE_URL", DSN)
    assert rca.main(["--apply", *_scope(world)]) == 0
    assert "applied:" in capsys.readouterr().out
    # visible from a fresh connection: the CLI committed
    rows = _q("SELECT user_id FROM captured_assets WHERE sha256 = %s ORDER BY id", (_sha(BYTES_A),))
    assert rows == [(world["owner"],), (world["user"],)]
    assert _q("SELECT count(*) FROM page_content_assets WHERE asset_id = %s", (b["asset"],)) == [(1,)]
    assert rca.main(_scope(world)) == 0
    assert "nothing to repair" in capsys.readouterr().out


def test_main_failure_exits_1_and_writes_nothing(world, monkeypatch, capsys):
    build(world)
    monkeypatch.setenv("DATABASE_URL", DSN)
    before_db = db_state(world)
    args = _scope(world)
    args[args.index("--assets-dir") + 1] = str(world["dir"] / "nope")
    assert rca.main(["--apply", *args]) == 1
    assert db_state(world) == before_db
    capsys.readouterr()


def test_page_account_filter_repairs_only_that_direction(world):
    build(world)  # owner's asset on user-only pages
    o, u = world["owner"], world["user"]
    rev_asset = _asset(u, BYTES_B, world["dir"])  # user's asset on owner-only pages
    rev_pc = _page_content(world, "rev")
    _page(o, _capture(o), rev_pc)
    _link(rev_pc, rev_asset)
    both = run(world, do_apply=False)
    assert set(both.pairs) == {(o, u), (u, o)}
    p = run(world, do_apply=True, page_account=u)
    assert set(p.pairs) == {(o, u)}
    assert _q("SELECT asset_id FROM page_content_assets WHERE page_content_id = %s",
              (rev_pc,)) == [(rev_asset,)]
    assert _q("SELECT count(*) FROM captured_assets WHERE sha256 = %s", (_sha(BYTES_A),)) == [(2,)]


def test_links_to_reused_rows_with_other_source_url_are_counted(world):
    build(world, user_has_copy=True, copy_url="https://img.test/other.png")
    p = run(world, do_apply=False)
    assert p.pairs[(world["owner"], world["user"])].lost_url == 2


def test_same_source_url_reuse_counts_no_lost_urls(world):
    build(world, user_has_copy=True)
    assert run(world, do_apply=False).pairs[(world["owner"], world["user"])].lost_url == 0


def test_out_of_scope_buckets_are_counted_not_repaired(world):
    b = build(world)
    o, other = world["owner"], world["other"]
    shared = _page_content(world, "shared")
    _page(o, _capture(o), shared)
    _page(other, _capture(other), shared)
    orphan = _page_content(world, "orphan")
    _link(shared, b["asset"])
    _link(orphan, b["asset"])
    p = run(world, do_apply=True, users={o, world["user"], other})
    assert (p.shared_links, p.orphan_links, p.skipped_multi) == (1, 1, 0)
    assert p.buckets_nonzero
    assert sorted(r[0] for r in _q(
        "SELECT page_content_id FROM page_content_assets WHERE asset_id = %s",
        (b["asset"],))) == sorted([b["pcs"][2], shared, orphan])


def test_missing_file_of_reused_row_warns_but_still_moves_links(world):
    b = build(world, user_has_copy=True, copy_written=False)
    p = run(world, do_apply=True)
    assert not p.problems
    assert any(w.startswith(f"reused row {b['own']} file missing") for w in p.warnings)
    assert _q("SELECT asset_id FROM page_content_assets WHERE page_content_id = %s",
              (b["pcs"][0],)) == [(b["own"],)]


def test_planned_path_already_used_by_a_row_aborts(world):
    build(world)
    sha = _sha(BYTES_A)
    _asset(world["other"], BYTES_B, world["dir"], write=False,
           rel=f"user_{world['user']}/{sha[:2]}/{sha}.png")
    before_db, before_files = db_state(world), tree(world["dir"])
    p = run(world, do_apply=True)
    assert any("already uses" in m for m in p.problems)
    assert db_state(world) == before_db
    assert tree(world["dir"]) == before_files


def test_two_owners_same_sha_merge_into_one_row(world):
    b = build(world)
    o, u, other = world["owner"], world["user"], world["other"]
    twin = _asset(other, BYTES_A, world["dir"])
    both = _page_content(world, "both")
    _page(u, _capture(u), both)
    _link(both, b["asset"])
    _link(both, twin)  # both repoint to U's one row: second insert hits ON CONFLICT
    p = run(world, do_apply=True, users={o, u, other})
    assert not p.problems
    mine = _q("SELECT id FROM captured_assets WHERE user_id = %s AND sha256 = %s",
              (u, _sha(BYTES_A)))
    assert len(mine) == 1
    assert _q("SELECT asset_id FROM page_content_assets WHERE page_content_id = %s",
              (both,)) == [(mine[0][0],)]
    assert tree(world["dir"]).count(f"user_{u}/{_sha(BYTES_A)[:2]}/{_sha(BYTES_A)}.png") == 1


def test_bad_sha_and_paths_outside_assets_dir_abort(world):
    b = build(world)
    _q("UPDATE captured_assets SET sha256 = %s WHERE id = %s", ("A" * 64, b["asset"]))
    p = run(world, do_apply=True)
    assert any("64 lowercase hex" in m for m in p.problems)
    _q("UPDATE captured_assets SET sha256 = %s, file_path = '../escape.png' WHERE id = %s",
       (_sha(BYTES_A), b["asset"]))
    (world["dir"].parent / "escape.png").write_bytes(BYTES_A)
    p = run(world, do_apply=True)
    assert any("outside assets dir" in m for m in p.problems)


def test_role_that_cannot_bypass_rls_is_rejected():
    class Cur:
        def execute(self, *a): pass
        def fetchone(self): return (False,)
    with pytest.raises(RuntimeError, match="BYPASSRLS"):
        rca.plan(Cur(), Path("."))


def test_pair_lines_show_account_roles(world, capsys):
    build(world)
    p = run(world, do_apply=False)
    rca._print_plan(p)
    o, u = world["owner"], world["user"]
    assert f"asset owner {o} (demo) -> page account {u} (user):" in capsys.readouterr().out
    assert rca._acct(rca.Plan(), 999) == "999 (?)"


def test_shared_bucket_ignores_links_the_page_account_owns(world):
    o, u = world["owner"], world["user"]
    own = _asset(u, BYTES_B, world["dir"])
    shared = _page_content(world, "shared-u")
    _page(o, _capture(o), shared)
    _page(u, _capture(u), shared)
    _link(shared, own)  # asset owned by U, page_content used by O and U
    assert run(world, do_apply=False).shared_links == 1
    assert run(world, do_apply=False, page_account=u).shared_links == 0


def test_failed_post_copy_verification_removes_the_bad_destination(world, monkeypatch):
    build(world)
    sha = _sha(BYTES_A)
    dest = world["dir"] / f"user_{world['user']}/{sha[:2]}/{sha}.png"
    conn = psycopg2.connect(DSN)
    try:
        with conn.cursor() as cur:
            p = rca.plan(cur, world["dir"], only_users={world["owner"], world["user"]})
            assert not p.problems
            monkeypatch.setattr(rca, "_file_sha256", lambda path: "0" * 64)
            with pytest.raises(RuntimeError, match="does not match"):
                rca.apply(cur, p, world["dir"])
        conn.rollback()
    finally:
        conn.close()
    assert not dest.exists()
    assert not list(dest.parent.glob(".*.tmp"))
    monkeypatch.undo()
    assert not run(world, do_apply=True).problems  # a rerun is not blocked
