"""Build shelves from existing page labels and draw the blind audit sample.

Proposal #3's evaluation plan (b): draw 100 random active "keep" pages and show,
for each, the page (title, URL), the proposed shelf and the current cluster
name, in two columns whose order is randomised per row. The owner marks each
column "right" or "wrong" without knowing which column is which; a separate key
file records the order. ``--score`` reads the marked sheet back and reports the
two right-rates against the acceptance rule (shelf >= 0.80 right and >= 0.20
above the current clusters).

Dry run by default: no database write and no model call. Shelves are built in
memory from the existing labels (subtopic strings are embedded with the
configured clustering embedder; a string that would have asked the model "same
shelf?" is counted and, in the dry run, becomes its own shelf). ``--apply``
persists the shelves (one model call per ambiguous string, cost events
recorded) and draws the sample from the persisted shelves; ``--maintain`` also
runs one merge/split pass first. Neither needs ``LABEL_FIRST_ENABLED``, so the
audit can happen before the flag is turned on.

The sheet and the key contain real page titles and URLs: ``--out`` must be
outside the repository, an existing file is never overwritten without
``--overwrite`` (it may hold the owner's marks), and nothing but counts is
printed.

Usage:
    python -m backend.scripts.shelf_audit_sample --user-id 1 --out ~/audit/sample.csv
    python -m backend.scripts.shelf_audit_sample --user-id 1 --out ~/audit/sample.xlsx --apply
    python -m backend.scripts.shelf_audit_sample --score ~/audit/sample.csv --key ~/audit/sample.key.csv
"""

from __future__ import annotations

import argparse
import csv
import random
import sys
from dataclasses import dataclass
from functools import partial
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

SAMPLE_SIZE = 100
ACCEPT_RIGHT_RATE = 0.80
ACCEPT_LIFT = 0.20
NO_CLUSTER = "(not in any cluster)"
MARKS = ("right", "wrong")
SHEET_HEADER = ["item", "title", "url", "grouping_a", "grouping_b", "a_mark", "b_mark"]
KEY_HEADER = [
    "item",
    "page_content_id",
    "a_is",
    "shelf_name",
    "shelf_category",
    "shelf_pages",
    "cluster_name",
    "mode",
]
_RIGHT = {"right", "r", "y", "yes", "1", "true", "ok", "x"}
_WRONG = {"wrong", "w", "n", "no", "0", "false"}


@dataclass
class Candidate:
    """One active page, represented by its latest visit, with its current cluster."""

    content_id: int
    title: str
    url: str
    domain: str
    cluster_name: str | None
    label: dict


@dataclass
class Shelved:
    candidate: Candidate
    shelf_name: str
    shelf_category: str
    shelf_pages: int


# -- paths ------------------------------------------------------------------


def repo_root() -> Path:
    """The git checkout this file lives in (``apps/api`` when there is no ``.git``)."""
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / ".git").exists():
            return parent
    return here.parents[2]


def check_output_path(path: Path, *, overwrite: bool) -> Path:
    """Resolve ``path``; refuse a location inside the repo or an existing file."""
    resolved = path.expanduser().resolve()
    root = repo_root()
    if resolved == root or root in resolved.parents:
        raise ValueError(f"{resolved} is inside the repository; the sample holds real page data")
    if resolved.suffix.lower() not in {".csv", ".xlsx"}:
        raise ValueError("output must end in .csv or .xlsx")
    if resolved.exists() and not overwrite:
        raise ValueError(f"{resolved} exists (it may hold marks); pass --overwrite to replace it")
    if not resolved.parent.is_dir():
        raise ValueError(f"directory {resolved.parent} does not exist")
    return resolved


def default_key_path(out: Path) -> Path:
    return out.with_name(out.stem + ".key.csv")


# -- data -------------------------------------------------------------------


def fetch_candidates(user_id: int) -> list[Candidate]:
    """Active labelled pages of the user, one per content row, with the cluster of the latest run."""
    from backend.db import page_label_repo
    from backend.db.connection import get_conn

    sql = f"""
        WITH run AS (
            SELECT id FROM recluster_runs
             WHERE user_id = %s AND status = 'completed'
             ORDER BY completed_at DESC LIMIT 1
        )
        SELECT DISTINCT ON (p.page_content_id)
               p.page_content_id, COALESCE(p.title, ''), p.url, COALESCE(p.domain, ''),
               cl.cluster_name
          FROM pages p
          LEFT JOIN page_clusters pc ON pc.page_id = p.id
          LEFT JOIN clusters cl ON cl.id = pc.cluster_id AND cl.recluster_run = (SELECT id FROM run)
         WHERE p.user_id = %s AND p.page_content_id IS NOT NULL AND {page_label_repo._ACTIVE_SQL}
         ORDER BY p.page_content_id, (cl.cluster_name IS NULL), p.visited_at DESC NULLS LAST, p.id DESC
    """
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(sql, (user_id, user_id))
        rows = cur.fetchall()
    labels = page_label_repo.get_labels([r[0] for r in rows])
    return [Candidate(r[0], r[1], r[2], r[3], r[4], labels[r[0]]) for r in rows if r[0] in labels]


def shelvable(candidates: list[Candidate]) -> list[Candidate]:
    """Same rule as ``shelf_service.assign_all_unshelved``: labelled, not excluded, has a subtopic."""
    from backend.services import shelf_service

    return [
        c
        for c in candidates
        if not shelf_service._excluded(c.label) and (c.label.get("subtopic") or "").strip()
    ]


def build_shelves_in_memory(
    candidates: list[Candidate], embed, config=None
) -> tuple[list[Shelved], dict]:
    """Dry-run canonicalisation: shelves in a ``MemoryShelfStore``, no model call.

    ``embed(list[str]) -> matrix``. Strings in the ask band are counted in
    ``stats["ask_band"]`` and become their own shelf.
    """
    from backend.services import shelf_service as ss

    config = config or ss.ShelfConfig.from_settings()
    store = ss.MemoryShelfStore(0)
    stats = {"ask_band": 0}

    def count_and_decline(subtopic: str, shelf: dict) -> bool:
        stats["ask_band"] += 1
        return False

    canon = ss.ShelfCanonicaliser(ss.ShelfIndex(), embed, count_and_decline, config, store)
    items = sorted(((c.content_id, c.label) for c in candidates), key=lambda t: t[0])
    results = canon.assign_many(items)
    by_id = {c.content_id: c for c in candidates}
    sizes: dict[int, int] = {}
    for r in results.values():
        sizes[r.shelf_id] = sizes.get(r.shelf_id, 0) + 1
    out = [
        Shelved(
            by_id[cid],
            store.shelves[r.shelf_id]["name"],
            store.shelves[r.shelf_id]["category"],
            sizes[r.shelf_id],
        )
        for cid, r in sorted(results.items())
    ]
    stats["shelves"] = len(sizes)
    return out, stats


def persisted_shelves(user_id: int, candidates: list[Candidate]) -> list[Shelved]:
    """The shelf each candidate is on in the database (pages without a shelf row are left out)."""
    from backend.db import shelf_repo

    shelves = {s["id"]: s for s in shelf_repo.get_shelves(user_id)}
    placed = shelf_repo.get_shelf_pages(user_id)
    sizes: dict[int, int] = {}
    for sid in placed.values():
        sizes[sid] = sizes.get(sid, 0) + 1
    return [
        Shelved(
            c,
            shelves[placed[c.content_id]]["name"],
            shelves[placed[c.content_id]]["category"],
            sizes[placed[c.content_id]],
        )
        for c in candidates
        if c.content_id in placed and placed[c.content_id] in shelves
    ]


# -- sample -----------------------------------------------------------------


def draw_sample(pool: list[Shelved], n: int = SAMPLE_SIZE, seed: int = 0, mode: str = "dry-run"):
    """``(sheet_rows, key_rows)``: ``n`` random keep pages with randomised A/B order.

    Only pages labelled ``knowledge_value == "keep"`` are drawn. The same pool and
    seed always give the same sample and the same A/B order.
    """
    keep = sorted(
        (s for s in pool if s.candidate.label.get("knowledge_value") == "keep"),
        key=lambda s: s.candidate.content_id,
    )
    rng = random.Random(seed)
    picked = rng.sample(keep, min(n, len(keep)))
    sheet, key = [], []
    for i, s in enumerate(picked, start=1):
        cluster = s.candidate.cluster_name or NO_CLUSTER
        a_is_shelf = rng.random() < 0.5
        a, b = (s.shelf_name, cluster) if a_is_shelf else (cluster, s.shelf_name)
        sheet.append([i, s.candidate.title, s.candidate.url, a, b, "", ""])
        key.append(
            [
                i,
                s.candidate.content_id,
                "shelf" if a_is_shelf else "cluster",
                s.shelf_name,
                s.shelf_category,
                s.shelf_pages,
                cluster,
                mode,
            ]
        )
    return sheet, key


# -- files ------------------------------------------------------------------


def write_table(
    path: Path, header: list[str], rows: list[list], *, marks_cols: tuple[int, ...] = ()
) -> None:
    """CSV, or XLSX (header frozen, wide columns, right/wrong drop-down on ``marks_cols``)."""
    if path.suffix.lower() == ".csv":
        with path.open("w", newline="", encoding="utf-8") as fh:
            w = csv.writer(fh)
            w.writerow(header)
            w.writerows(rows)
        return
    from openpyxl import Workbook
    from openpyxl.utils import get_column_letter
    from openpyxl.worksheet.datavalidation import DataValidation

    wb = Workbook()
    ws = wb.active
    ws.title = "audit"
    ws.append(header)
    for r in rows:
        ws.append(r)
    ws.freeze_panes = "A2"
    for idx, name in enumerate(header, start=1):
        ws.column_dimensions[get_column_letter(idx)].width = 48 if name in {"title", "url"} else 28
    if marks_cols and rows:
        dv = DataValidation(type="list", formula1='"right,wrong"', allow_blank=True)
        ws.add_data_validation(dv)
        for col in marks_cols:
            letter = get_column_letter(col + 1)
            dv.add(f"{letter}2:{letter}{len(rows) + 1}")
    wb.save(path)


def read_table(path: Path) -> tuple[list[str], list[list]]:
    if path.suffix.lower() == ".csv":
        with path.open(newline="", encoding="utf-8-sig") as fh:
            rows = list(csv.reader(fh))
    else:
        from openpyxl import load_workbook

        ws = load_workbook(path, read_only=True, data_only=True).active
        rows = [["" if v is None else str(v) for v in r] for r in ws.iter_rows(values_only=True)]
    return (rows[0], rows[1:]) if rows else ([], [])


# -- scoring ----------------------------------------------------------------


def _mark(value) -> str | None:
    text = str(value or "").strip().lower()
    if text in _RIGHT:
        return "right"
    if text in _WRONG:
        return "wrong"
    return None


def score_marks(sheet_rows: list[list], key_rows: list[list]) -> dict:
    """Right-rates of the shelf and the current cluster from a marked sheet and its key."""
    a_is = {str(k[0]): k[2] for k in key_rows}
    tally = {"shelf": [0, 0], "cluster": [0, 0]}  # [right, marked]
    for row in sheet_rows:
        item = str(row[0])
        if item not in a_is:
            continue
        sides = (("a", row[5] if len(row) > 5 else ""), ("b", row[6] if len(row) > 6 else ""))
        for side, raw in sides:
            m = _mark(raw)
            if m is None:
                continue
            which = a_is[item] if side == "a" else ("cluster" if a_is[item] == "shelf" else "shelf")
            tally[which][1] += 1
            tally[which][0] += m == "right"
    rate = {k: (v[0] / v[1] if v[1] else None) for k, v in tally.items()}
    out = {
        "shelf_right": tally["shelf"][0],
        "shelf_marked": tally["shelf"][1],
        "cluster_right": tally["cluster"][0],
        "cluster_marked": tally["cluster"][1],
        "shelf_rate": rate["shelf"],
        "cluster_rate": rate["cluster"],
        "items": len(key_rows),
        "complete": tally["shelf"][1] == len(key_rows) == tally["cluster"][1],
    }
    if rate["shelf"] is not None and rate["cluster"] is not None:
        out["lift"] = rate["shelf"] - rate["cluster"]
        out["accept"] = (
            rate["shelf"] >= ACCEPT_RIGHT_RATE
            and out["lift"] >= ACCEPT_LIFT - 1e-9
            and out["complete"]
        )
    else:
        out["lift"] = None
        out["accept"] = False
    return out


def format_score(s: dict) -> str:
    def pct(x):
        return "n/a" if x is None else f"{x:.2f}"

    lines = [
        f"Items in key        : {s['items']}",
        f"Label-first shelf   : {s['shelf_right']}/{s['shelf_marked']} right  (rate {pct(s['shelf_rate'])})",
        f"Current clusters    : {s['cluster_right']}/{s['cluster_marked']} right  (rate {pct(s['cluster_rate'])})",
        f"Lift (shelf - clust): {pct(s['lift'])}",
        f"Rule                : shelf >= {ACCEPT_RIGHT_RATE:.2f} and lift >= {ACCEPT_LIFT:.2f}, all items marked",
    ]
    if not s["complete"]:
        lines.append("NOT COMPLETE: some items are unmarked; the verdict below is provisional.")
    lines.append("Verdict             : " + ("ACCEPT" if s["accept"] else "NOT ACCEPTED"))
    return "\n".join(lines)


# -- main -------------------------------------------------------------------


def _confirm(n_items: int) -> bool:
    if not sys.stdin.isatty():
        print("stdin is not a TTY: refusing to apply without --yes", file=sys.stderr)
        return False
    return input(
        f"Write shelves for {n_items} labelled pages to the database now? [y/N] "
    ).strip().lower() in {"y", "yes"}


def run_sample(args) -> int:
    out = check_output_path(Path(args.out), overwrite=args.overwrite)
    key_out = check_output_path(
        Path(args.key_out) if args.key_out else default_key_path(out), overwrite=args.overwrite
    )
    if key_out == out:
        raise ValueError("--key-out must differ from --out")

    candidates = fetch_candidates(args.user_id)
    pool_in = shelvable(candidates)
    keep = sum(1 for c in pool_in if c.label.get("knowledge_value") == "keep")
    print(f"Active labelled pages : {len(candidates)}")
    print(f"Shelvable (not excluded): {len(pool_in)}  of which keep: {keep}")
    if keep == 0:
        print("No keep pages with labels; run the label backfill first.", file=sys.stderr)
        return 2

    if args.apply:
        from backend.db import shelf_repo
        from backend.services import shelf_service

        placed = shelf_repo.get_shelf_pages(args.user_id)
        unshelved = sum(1 for c in pool_in if c.content_id not in placed)
        print(f"Not yet shelved       : {unshelved}")
        if not args.yes and not _confirm(unshelved):
            print("Aborted; nothing written.")
            return 1
        res = shelf_service.assign_all_unshelved(args.user_id, force=True)
        print(f"Shelved: {res}")
        if args.maintain:
            print(f"Merge/split pass: {shelf_service.weekly_maintenance(args.user_id, force=True)}")
        pool = persisted_shelves(args.user_id, pool_in)
        mode, shelves_n = "applied", len({s.shelf_name for s in pool})
        ask_band = None
    else:
        from backend.services import text_embedder

        pool, stats = build_shelves_in_memory(
            pool_in, partial(text_embedder.embed_texts, user_id=None)
        )
        mode, shelves_n, ask_band = "dry-run", stats["shelves"], stats["ask_band"]
        print(
            "Dry run: no database write, no model call (strings are embedded with the clustering embedder)."
        )

    print(
        f"Shelves               : {shelves_n}"
        + (f"  (ask-band strings not asked: {ask_band})" if ask_band is not None else "")
    )
    sheet, key = draw_sample(pool, args.n, args.seed, mode)
    write_table(out, SHEET_HEADER, sheet, marks_cols=(5, 6))
    write_table(key_out, KEY_HEADER, key)
    in_cluster = sum(1 for k in key if k[6] != NO_CLUSTER)
    print(
        f"Sample                : {len(sheet)} pages ({in_cluster} in a current cluster, {len(sheet) - in_cluster} not)"
    )
    print(f"Sheet : {out}\nKey   : {key_out}  (keep it away from whoever marks the sheet)")
    return 0


def run_score(args) -> int:
    sheet_path = Path(args.score).expanduser()
    key_path = Path(args.key).expanduser()
    _, sheet_rows = read_table(sheet_path)
    _, key_rows = read_table(key_path)
    result = score_marks(sheet_rows, key_rows)
    print(format_score(result))
    return 0 if result["accept"] else 4


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--user-id", type=int, help="user whose pages are audited")
    ap.add_argument("--out", help="sheet path (.csv or .xlsx), outside the repository")
    ap.add_argument("--key-out", help="key path (.csv); default: <out>.key.csv")
    ap.add_argument("--n", type=int, default=SAMPLE_SIZE, help="sample size (default 100)")
    ap.add_argument("--seed", type=int, default=0, help="sampling seed (default 0)")
    ap.add_argument("--apply", action="store_true", help="persist shelves (model calls, DB writes)")
    ap.add_argument(
        "--maintain", action="store_true", help="with --apply: run one merge/split pass first"
    )
    ap.add_argument("--yes", action="store_true", help="skip the confirmation prompt")
    ap.add_argument("--overwrite", action="store_true", help="replace existing sheet/key files")
    ap.add_argument("--score", help="marked sheet to score (needs --key)")
    ap.add_argument("--key", help="key file for --score")
    args = ap.parse_args(argv)

    if args.score:
        if not args.key:
            ap.error("--score needs --key")
        return run_score(args)
    if args.user_id is None or not args.out:
        ap.error("--user-id and --out are required (or use --score/--key)")
    if args.maintain and not args.apply:
        ap.error("--maintain needs --apply")
    try:
        return run_sample(args)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
