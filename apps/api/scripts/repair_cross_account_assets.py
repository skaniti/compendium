"""Give each account its own copy of the assets its pages link (one-off repair).

Before migration 031, ``captured_assets`` was one global, sha256-keyed cache.
031 added ``user_id`` and backfilled it from ``page_content_assets -> pages``;
an asset linked from pages of two accounts was assigned to one of them by the
backfill's tie-break (see the migration's own NOTICE). Pages of the other
account then link an asset they do not own, with two consequences:

- ``GET /captured-assets/{rel}`` serves a file only to its owner, so those
  pages' previews 404;
- the demo seed loader's ``--replace`` (``_check_cascade_guards``) aborts,
  because deleting the demo account's assets would cascade-delete the other
  account's links.

This script finds every ``page_content_assets`` link whose page_content is used
by pages of exactly ONE account U while the linked asset belongs to another
account O. For each (asset, U) it reuses U's row with the same sha256 or
creates one: every column copied from O's row except ``id``, ``user_id`` and
``file_path`` (= ``user_<U>/<aa>/<sha><ext>``, with its own file, because the
serving route looks assets up by ``file_path`` alone). U's links are then
repointed at U's row. O's rows, O's files and every other link are untouched.
A page_content used by several accounts, none owning the asset, is skipped and
counted: the script never guesses an owner.

Deliberately stdlib + psycopg2 only (no ``backend`` imports); connects via
``DATABASE_URL``. Dry run by default.

    python scripts/repair_cross_account_assets.py [--apply] [--page-account ID] [--assets-dir PATH]

Run from ``apps/api`` (``/app`` in the API container). Exit 0 on success
(including nothing to repair), 1 when a pre-check fails or on error; nothing is
written in that case. Files are copied before the DB transaction commits, so a
failure after the copy step can leave unreferenced copies behind; they are
verified (not re-copied) on a rerun.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import re
import shutil
import sys
from dataclasses import dataclass, field
from pathlib import Path

import psycopg2
from psycopg2 import sql

# Same location asset_archiver writes to: <apps/api>/data/captures/assets.
DEFAULT_ASSETS_DIR = Path(__file__).resolve().parent.parent / "data" / "captures" / "assets"

TAG = "[repair_cross_account_assets]"
SHA_RE = re.compile(r"[0-9a-f]{64}")


@dataclass
class PairStats:
    links: int = 0
    assets: int = 0
    reused: int = 0
    created: int = 0
    copies: int = 0
    # Links moved onto a reused row whose source_url differs from the original
    # row's. The preview renderer maps {source_url: file} per page, so those
    # images fall back to their original URL. Cannot be fixed here
    # (UNIQUE (user_id, sha256)); reported only.
    lost_url: int = 0


@dataclass
class Item:
    """One (sha256, page account) repair unit."""
    asset_id: int
    owner: int
    user: int
    sha256: str
    existing_id: int | None  # the page account's row to reuse, if any
    new_file_path: str | None  # destination for a new row
    copy_file: bool = False


@dataclass
class Plan:
    items: list[Item] = field(default_factory=list)
    links: list[tuple[int, int, int, str]] = field(default_factory=list)  # (pc_id, asset_id, user, sha)
    pairs: dict[tuple[int, int], PairStats] = field(default_factory=dict)
    # Out-of-scope buckets: counted and reported, never repaired.
    skipped_multi: int = 0  # distinct page_content used by several accounts, none owning the asset
    shared_links: int = 0  # links from page_content used by the asset owner AND another account
    orphan_links: int = 0  # links from page_content with no pages / only NULL-user pages
    roles: dict[int, str | None] = field(default_factory=dict)  # account id -> users.role
    warnings: list[str] = field(default_factory=list)
    problems: list[str] = field(default_factory=list)

    @property
    def buckets_nonzero(self) -> bool:
        return bool(self.skipped_multi or self.shared_links or self.orphan_links)


def _columns(cur, table: str) -> list[str]:
    cur.execute(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_schema = current_schema() AND table_name = %s "
        "ORDER BY ordinal_position",
        (table,),
    )
    return [r[0] for r in cur.fetchall()]


def _file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def _check_sees_all_rows(cur) -> None:
    """Row-level security would hide rows and make a run report nothing to repair."""
    cur.execute("SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user")
    row = cur.fetchone()
    if not row or not row[0]:
        raise RuntimeError(
            "the connected database role is neither superuser nor BYPASSRLS; row-level "
            "security could hide rows and the script would wrongly report nothing to repair"
        )


def _inside(base: Path, path: Path) -> bool:
    try:
        path.resolve().relative_to(base.resolve())
    except ValueError:
        return False
    return True


def _find_links(cur, only_users: set[int] | None, page_account: int | None, result: Plan
                ) -> list[tuple[int, int, int, int]]:
    """Return candidate links [(page_content_id, asset_id, owner, page_account)]
    and fill the out-of-scope bucket counts on ``result``.

    Scope: ``only_users`` keeps links whose asset owner is in the set (and, for
    candidates, whose page account is too). ``page_account`` keeps only links
    whose page_content is used by that account; the orphan bucket has no page
    account, so it is not counted when ``page_account`` is given.
    """
    cur.execute(
        "WITH pc_users AS ("
        "  SELECT page_content_id, array_agg(DISTINCT user_id) AS users FROM pages "
        "  WHERE page_content_id IS NOT NULL AND user_id IS NOT NULL GROUP BY page_content_id) "
        "SELECT pca.page_content_id, pca.asset_id, a.user_id, pu.users "
        "FROM page_content_assets pca "
        "JOIN captured_assets a ON a.id = pca.asset_id "
        "LEFT JOIN pc_users pu ON pu.page_content_id = pca.page_content_id "
        "WHERE pu.users IS NULL OR NOT (a.user_id = ANY(pu.users)) "
        "   OR cardinality(pu.users) > 1 "
        "ORDER BY pca.page_content_id, pca.asset_id"
    )
    links: list[tuple[int, int, int, int]] = []
    skipped: set[int] = set()
    for pc_id, asset_id, owner, users in cur.fetchall():
        if only_users is not None and owner not in only_users:
            continue
        if users is None:
            if page_account is None:
                result.orphan_links += 1
            continue
        if page_account is not None and page_account not in users:
            continue
        if owner in users:
            if page_account is None or owner != page_account:
                result.shared_links += 1  # users has several accounts here, one is the owner
        elif len(users) == 1:
            if only_users is None or users[0] in only_users:
                links.append((pc_id, asset_id, owner, users[0]))
        elif only_users is None or any(u in only_users for u in users):
            skipped.add(pc_id)
    result.skipped_multi = len(skipped)
    return links


def plan(cur, assets_dir: Path, only_users: set[int] | None = None,
         page_account: int | None = None) -> Plan:
    """Compute and pre-check the repair. Writes nothing."""
    result = _plan(cur, assets_dir, only_users, page_account)
    ids = sorted({i for pair in result.pairs for i in pair})
    if ids:
        cur.execute("SELECT id, role FROM users WHERE id = ANY(%s)", (ids,))
        result.roles = dict(cur.fetchall())
    return result


def _plan(cur, assets_dir: Path, only_users: set[int] | None,
          page_account: int | None) -> Plan:
    _check_sees_all_rows(cur)
    result = Plan()
    links = _find_links(cur, only_users, page_account, result)
    if not links:
        return result

    asset_cols = _columns(cur, "captured_assets")
    cur.execute(
        "SELECT " + ", ".join(asset_cols) + " FROM captured_assets WHERE id = ANY(%s)",
        (sorted({asset_id for _, asset_id, _, _ in links}),),
    )
    sources = {row[asset_cols.index("id")]: dict(zip(asset_cols, row)) for row in cur.fetchall()}

    items: dict[tuple[str, int], Item] = {}
    existing: dict[tuple[str, int], tuple[int, str, str]] = {}  # -> (id, source_url, file_path)
    bad_assets: set[int] = set()
    for pc_id, asset_id, owner, user in links:
        src = sources[asset_id]
        sha = src["sha256"]
        if not SHA_RE.fullmatch(sha or ""):
            if asset_id not in bad_assets:
                bad_assets.add(asset_id)
                result.problems.append(f"asset {asset_id}: sha256 is not 64 lowercase hex chars")
            continue
        result.links.append((pc_id, asset_id, user, sha))
        key = (sha, user)  # two owners' copies of one binary share U's single row
        if key not in items:
            cur.execute(
                "SELECT id, source_url, file_path FROM captured_assets "
                "WHERE user_id = %s AND sha256 = %s",
                (user, sha),
            )
            hit = cur.fetchone()
            new_path = None
            if hit:
                existing[key] = hit
            else:
                ext = Path(src["file_path"]).suffix
                new_path = f"user_{user}/{sha[:2]}/{sha}{ext}"
            items[key] = Item(asset_id, owner, user, sha, hit[0] if hit else None, new_path)
        result.pairs.setdefault((owner, user), PairStats()).links += 1
    if not items:
        return result

    # Links to reused rows whose source_url differs (see PairStats.lost_url).
    owner_of = {(pc_id, asset_id): owner for pc_id, asset_id, owner, _ in links}
    for pc_id, asset_id, user, sha in result.links:
        row = existing.get((sha, user))
        if row and row[1] != sources[asset_id]["source_url"]:
            result.pairs[(owner_of[(pc_id, asset_id)], user)].lost_url += 1

    for (_, user), item in items.items():
        asset_id = item.asset_id
        stats = result.pairs[(item.owner, user)]
        stats.assets += 1
        if item.existing_id is not None:
            stats.reused += 1
            row = existing[(item.sha256, user)]
            reused_file = assets_dir / row[2]
            if not _inside(assets_dir, reused_file) or not reused_file.is_file():
                result.warnings.append(f"reused row {row[0]} file missing: {reused_file}")
            continue
        stats.created += 1
        src = sources[asset_id]
        src_file = assets_dir / src["file_path"]
        dest = assets_dir / item.new_file_path
        cur.execute("SELECT id FROM captured_assets WHERE file_path = %s", (item.new_file_path,))
        if cur.fetchone():
            result.problems.append(
                f"asset {asset_id}: a captured_assets row already uses {item.new_file_path}"
            )
        if not _inside(assets_dir, src_file):
            result.problems.append(f"asset {asset_id}: source path outside assets dir: {src_file}")
        elif not src_file.is_file():
            result.problems.append(f"asset {asset_id}: source file missing: {src_file}")
        elif _file_sha256(src_file) != item.sha256:
            result.problems.append(
                f"asset {asset_id}: source file does not match its sha256: {src_file}"
            )
        if not _inside(assets_dir, dest):
            result.problems.append(f"asset {asset_id}: destination outside assets dir: {dest}")
        elif dest.exists():
            if not dest.is_file() or _file_sha256(dest) != item.sha256:
                result.problems.append(
                    f"asset {asset_id}: destination exists with different bytes: {dest}"
                )
        else:
            item.copy_file = True
            stats.copies += 1
    result.items = list(items.values())
    return result


def _copy_verified(src: Path, dest: Path, sha: str) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(f".{dest.name}.tmp")
    try:
        shutil.copyfile(src, tmp)
        with open(tmp, "rb+") as fh:
            os.fsync(fh.fileno())
        os.replace(tmp, dest)
    finally:
        tmp.unlink(missing_ok=True)
    if _file_sha256(dest) != sha:
        # Safe to remove: a copy is only planned when dest did not exist.
        dest.unlink(missing_ok=True)
        raise RuntimeError(f"copied file does not match its sha256: {dest}")


def apply(cur, the_plan: Plan, assets_dir: Path) -> dict[str, int]:
    """Copy the files, then insert rows and move links in the cursor's
    transaction. The caller commits."""
    if the_plan.problems:
        raise RuntimeError("plan has pre-check problems; refusing to apply")
    asset_cols = _columns(cur, "captured_assets")
    link_cols = _columns(cur, "page_content_assets")
    copy_cols = [c for c in asset_cols if c != "id"]
    extra_link_cols = [c for c in link_cols if c not in ("page_content_id", "asset_id")]

    copied = 0
    for item in the_plan.items:
        if not item.copy_file:
            continue
        cur.execute("SELECT file_path FROM captured_assets WHERE id = %s", (item.asset_id,))
        _copy_verified(assets_dir / cur.fetchone()[0], assets_dir / item.new_file_path, item.sha256)
        copied += 1

    target: dict[tuple[str, int], int] = {}
    created = 0
    for item in the_plan.items:
        if item.existing_id is not None:
            target[(item.sha256, item.user)] = item.existing_id
            continue
        select_list = sql.SQL(", ").join(
            sql.Placeholder() if c in ("user_id", "file_path") else sql.Identifier(c)
            for c in copy_cols
        )
        values = [item.user if c == "user_id" else item.new_file_path
                  for c in copy_cols if c in ("user_id", "file_path")]
        cur.execute(
            sql.SQL("INSERT INTO captured_assets ({}) SELECT {} FROM captured_assets "
                    "WHERE id = %s RETURNING id").format(
                sql.SQL(", ").join(map(sql.Identifier, copy_cols)), select_list),
            values + [item.asset_id],
        )
        target[(item.sha256, item.user)] = cur.fetchone()[0]
        created += 1

    moved = 0
    link_select = sql.SQL(", ").join(
        [sql.Identifier("page_content_id"), sql.Placeholder()]
        + [sql.Identifier(c) for c in extra_link_cols]
    )
    link_insert_cols = sql.SQL(", ").join(
        map(sql.Identifier, ["page_content_id", "asset_id"] + extra_link_cols)
    )
    for pc_id, asset_id, user, sha in the_plan.links:
        cur.execute(
            sql.SQL("INSERT INTO page_content_assets ({}) SELECT {} FROM page_content_assets "
                    "WHERE page_content_id = %s AND asset_id = %s ON CONFLICT DO NOTHING").format(
                link_insert_cols, link_select),
            (target[(sha, user)], pc_id, asset_id),
        )
        cur.execute(
            "DELETE FROM page_content_assets WHERE page_content_id = %s AND asset_id = %s",
            (pc_id, asset_id),
        )
        moved += 1
    return {"files_copied": copied, "rows_created": created, "links_moved": moved}


def _acct(p: Plan, account_id: int) -> str:
    return f"{account_id} ({p.roles.get(account_id) or '?'})"


def _print_plan(p: Plan) -> None:
    for (owner, user), s in sorted(p.pairs.items()):
        line = (
            f"{TAG} asset owner {_acct(p, owner)} -> page account {_acct(p, user)}: links to move={s.links} "
            f"assets={s.assets} rows reused={s.reused} rows to create={s.created} "
            f"files to copy={s.copies} links_to_reused_rows_with_other_source_url={s.lost_url}"
        )
        if s.lost_url:
            line += " (these images will load from their original URL in previews)"
        print(line)
    for msg in p.warnings:
        print(f"{TAG} WARNING: {msg}")
    print(f"{TAG} not repaired: skipped page_content used by several accounts, none owning "
          f"the asset={p.skipped_multi}; links from page_content used by the asset owner and "
          f"another account={p.shared_links}; links from page_content with no pages={p.orphan_links}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Give each account its own copy of the assets its pages link.")
    parser.add_argument("--apply", action="store_true",
                        help="write the copies and repoint the links (default: dry run)")
    parser.add_argument("--assets-dir", type=Path, default=DEFAULT_ASSETS_DIR,
                        help=f"assets base directory (default: {DEFAULT_ASSETS_DIR})")
    parser.add_argument("--page-account", type=int, default=None, metavar="ID",
                        help="only repair links whose page_content is used by this account")
    parser.add_argument("--only-users", default=None, help=argparse.SUPPRESS)  # tests
    args = parser.parse_args(argv)
    only_users = {int(x) for x in args.only_users.split(",")} if args.only_users else None

    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        print(f"{TAG} DATABASE_URL is not set", file=sys.stderr)
        return 1
    print(f"{TAG} {'APPLY' if args.apply else 'dry run'}; assets dir {args.assets_dir}")
    conn = psycopg2.connect(dsn)
    try:
        with conn.cursor() as cur:
            p = plan(cur, args.assets_dir, only_users, args.page_account)
            _print_plan(p)
            if p.problems:
                conn.rollback()
                print(f"{TAG} ABORTED, nothing written:", file=sys.stderr)
                for msg in p.problems:
                    print(f"  - {msg}", file=sys.stderr)
                return 1
            if not p.links:
                conn.rollback()
                print(f"{TAG} nothing to repair"
                      + (" (but see the not-repaired counts above)" if p.buckets_nonzero else ""))
                return 0
            if not args.apply:
                conn.rollback()
                print(f"{TAG} DRY RUN -- nothing written (rerun with --apply)")
                return 0
            counts = apply(cur, p, args.assets_dir)
        conn.commit()
        print(f"{TAG} applied: files copied={counts['files_copied']} "
              f"rows created={counts['rows_created']} links moved={counts['links_moved']}")
        return 0
    except Exception as exc:  # noqa: BLE001 - report and roll back, whatever failed
        conn.rollback()
        print(f"{TAG} ERROR, rolled back: {exc}", file=sys.stderr)
        return 1
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
