"""Backfill ``pages.skip_category`` for historical skip-gate archives.

Selects the DISTINCT ``skip_reasoning`` strings of ``skip_gate`` pages whose
category is NULL (all users), classifies them in batches of 40 with one LLM
tool call per batch, writes a reviewable mapping file OUTSIDE the repo, and --
only with ``--apply`` -- updates the pages.

    cd apps/api
    python scripts/backfill_skip_categories.py --limit 40          # smoke
    python scripts/backfill_skip_categories.py                     # dry run + mapping
    python scripts/backfill_skip_categories.py --apply --mapping-in <file>

The mapping file contains the owner's skip reasons: it is never written inside
the git work tree (the script refuses such a path).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.db.connection import get_conn
from backend.services.skip_categories import (
    SKIP_CATEGORIES,
    SKIP_CATEGORY_IDS,
    SKIP_CATEGORY_LABELS,
    normalize_category,
)

BATCH_SIZE = 40
MAX_COST_USD = 0.50
TOOL_NAME = "classify_skip_reasons"

SELECT_REASONS_SQL = """
    SELECT skip_reasoning, count(*) AS pages
    FROM pages
    WHERE archive_reason = 'skip_gate' AND skip_category IS NULL
    GROUP BY skip_reasoning
    ORDER BY count(*) DESC, skip_reasoning
"""
PER_USER_SQL = """
    SELECT user_id, count(*) FROM pages
    WHERE archive_reason = 'skip_gate' AND skip_category IS NULL
    GROUP BY user_id ORDER BY user_id
"""
UPDATE_SQL = (
    "UPDATE pages SET skip_category = %s "
    "WHERE archive_reason = 'skip_gate' AND skip_category IS NULL "
    "AND skip_reasoning IS NOT DISTINCT FROM %s"
)


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def batches(items: list, size: int = BATCH_SIZE):
    for i in range(0, len(items), size):
        yield items[i : i + size]


def classify_tool() -> dict:
    return {
        "type": "function",
        "function": {
            "name": TOOL_NAME,
            "description": "Assign one category to each numbered skip reason.",
            "parameters": {
                "type": "object",
                "properties": {
                    "items": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "index": {"type": "integer", "description": "The reason's number"},
                                "category": {
                                    "type": "string",
                                    "enum": list(SKIP_CATEGORY_IDS),
                                    "description": "\n".join(
                                        f"{cid}: {desc}" for cid, _label, desc in SKIP_CATEGORIES
                                    ),
                                },
                            },
                            "required": ["index", "category"],
                        },
                    }
                },
                "required": ["items"],
            },
        },
    }


def build_prompt(reasons: list[str]) -> str:
    cats = "\n".join(f"- {cid}: {desc}" for cid, _label, desc in SKIP_CATEGORIES)
    numbered = "\n".join(f"{i}. {r}" for i, r in enumerate(reasons))
    return (
        "A page-skipping gate archived web pages and recorded a short free-text "
        "reason for each. Classify every numbered reason below into exactly one "
        f"category, then call {TOOL_NAME} once with an entry for every number.\n\n"
        f"Categories:\n{cats}\n\nReasons:\n{numbered}"
    )


def parse_response(arguments: object, n: int) -> list[str]:
    """Category per index 0..n-1; missing/invalid/out-of-range -> ``other``."""
    out = ["other"] * n
    items = arguments.get("items") if isinstance(arguments, dict) else None
    if not isinstance(items, list):
        return out
    for it in items:
        if not isinstance(it, dict):
            continue
        idx = it.get("index")
        if isinstance(idx, bool) or not isinstance(idx, int) or not 0 <= idx < n:
            continue
        out[idx] = normalize_category(it.get("category"))
    return out


async def classify_batch(llm, reasons: list[str], model: str) -> tuple[list[str], dict]:
    resp, tool_calls = await llm.select_tool(
        prompt=build_prompt(reasons), tools=[classify_tool()], model=model, temperature=0.0
    )
    usage = {
        "input_tokens": getattr(resp, "input_tokens", 0) or 0,
        "output_tokens": getattr(resp, "output_tokens", 0) or 0,
        "cost_usd": getattr(resp, "cost_usd", 0.0) or 0.0,
    }
    args = tool_calls[0]["arguments"] if tool_calls else None
    return parse_response(args, len(reasons)), usage


def build_mapping(model: str, rows: list[tuple], cats: list[str]) -> dict:
    counts = {cid: {"reasons": 0, "pages": 0} for cid in SKIP_CATEGORY_IDS}
    items = []
    for (reason, pages), cat in zip(rows, cats):
        items.append({"reason": reason, "category": cat, "pages": pages})
        counts[cat]["reasons"] += 1
        counts[cat]["pages"] += pages
    return {
        "generated_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "model": model,
        "counts_by_category": counts,
        "items": items,
    }


def _repo_root() -> Path | None:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            cwd=Path(__file__).resolve().parent,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        return Path(out).resolve()
    except Exception:  # noqa: BLE001 - no git means no repo to be inside
        return None


def check_outside_repo(path: Path) -> None:
    root = _repo_root()
    p = path.expanduser().resolve()
    if root is not None and p.is_relative_to(root):
        raise SystemExit(f"refusing mapping path inside the git work tree: {p}")


def default_mapping_path() -> Path:
    ts = datetime.now(UTC).astimezone().strftime("%Y-%m-%d-%H%M%S")
    return Path.home() / ".local/share/compendium" / f"skip-category-mapping-{ts}.json"


def load_mapping(path: Path) -> list[dict]:
    data = json.loads(Path(path).read_text())
    return [
        {
            "reason": it.get("reason"),
            "category": normalize_category(it.get("category")),
            "pages": it.get("pages", 0),
        }
        for it in data["items"]
    ]


def select_reasons(limit: int | None) -> tuple[list[tuple], list[tuple]]:
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(SELECT_REASONS_SQL)
        rows = [(r, int(n)) for r, n in cur.fetchall()]
        cur.execute(PER_USER_SQL)
        per_user = [(u, int(n)) for u, n in cur.fetchall()]
    return (rows[:limit] if limit else rows), per_user


def apply_mapping(items: list[dict]) -> int:
    """One UPDATE per mapping item, all in one transaction. Returns rows updated."""
    total = 0
    with get_conn() as conn, conn.cursor() as cur:
        for it in items:
            cur.execute(UPDATE_SQL, (normalize_category(it["category"]), it["reason"]))
            total += cur.rowcount
    return total


def print_summary(mapping: dict) -> None:
    print(f"{'category':<22}{'distinct reasons':>18}{'pages':>10}")
    for cid in SKIP_CATEGORY_IDS:
        c = mapping["counts_by_category"][cid]
        print(f"{SKIP_CATEGORY_LABELS[cid]:<22}{c['reasons']:>18}{c['pages']:>10}")


def record_cost(user_id: int, model: str, usage: dict) -> None:
    try:
        from backend.db import trends_repo

        trends_repo.insert_cost_event(
            user_id=user_id,
            event_type="skip_category_backfill",
            model=model,
            input_tokens=usage["input_tokens"],
            output_tokens=usage["output_tokens"],
            cost_usd=usage["cost_usd"],
        )
    except Exception as e:  # noqa: BLE001 - cost bookkeeping is best-effort
        log(f"cost event insert failed: {e}")


async def classify_all(rows: list[tuple], model: str) -> tuple[list[str], dict]:
    from backend.services.llm_service import LLMService

    llm = LLMService()
    cats: list[str] = []
    total = {"input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0}
    chunks = list(batches(rows, BATCH_SIZE))
    for n, chunk in enumerate(chunks, 1):
        reasons = [r if r is not None else "" for r, _ in chunk]
        got, usage = await classify_batch(llm, reasons, model)
        # NULL/empty reasons carry no signal; never spend a guess on them.
        cats.extend("other" if not r else c for r, c in zip(reasons, got))
        for k in total:
            total[k] += usage[k]
        log(
            f"batch {n}/{len(chunks)}  classified {len(cats)}/{len(rows)}  spend ${total['cost_usd']:.5f}"
        )
        if total["cost_usd"] > MAX_COST_USD:
            raise SystemExit(f"spend guard tripped (> ${MAX_COST_USD}); stopping")
    return cats, total


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--dry-run", action="store_true", help="default: classify + write mapping only")
    ap.add_argument("--apply", action="store_true", help="write categories to the pages table")
    ap.add_argument("--mapping-out", type=Path, default=None)
    ap.add_argument(
        "--mapping-in", type=Path, default=None, help="apply a reviewed mapping, no LLM"
    )
    ap.add_argument(
        "--limit", type=int, default=None, help="classify only the N most common reasons"
    )
    args = ap.parse_args(argv)

    print("skip-category backfill: start")
    if args.mapping_in:
        items = load_mapping(args.mapping_in)
        print(f"loaded {len(items)} mapping items from the reviewed file")
        if not args.apply:
            print("dry run: nothing written (add --apply)")
            return 0
        print(f"rows updated: {apply_mapping(items)}")
        print("done")
        return 0

    out = (args.mapping_out or default_mapping_path()).expanduser()
    check_outside_repo(out)

    from backend.api.main import TOOL_SELECTION_MODEL

    rows, per_user = select_reasons(args.limit)
    print(f"candidate pages by user: {dict(per_user)}")
    print(f"distinct reasons to classify: {len(rows)} ({-(-len(rows) // BATCH_SIZE)} batches)")
    if not rows:
        print("nothing to do")
        return 0

    cats, usage = asyncio.run(classify_all(rows, TOOL_SELECTION_MODEL))
    mapping = build_mapping(TOOL_SELECTION_MODEL, rows, cats)
    mapping["cost_usd"] = usage["cost_usd"]
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(mapping, indent=1) + "\n")
    top_user = max(per_user, key=lambda x: x[1])[0] if per_user else 0
    record_cost(top_user, TOOL_SELECTION_MODEL, usage)
    print_summary(mapping)
    print(f"LLM spend: ${usage['cost_usd']:.5f}")
    print(f"mapping written: {out}")
    if args.apply:
        print(f"rows updated: {apply_mapping(mapping['items'])}")
    print("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
