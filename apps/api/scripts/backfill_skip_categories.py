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

BATCH_SIZE = 15
MAX_RETRIES = 2
ECHO_CHARS = 30
MAX_COST_USD = 0.50
TOOL_NAME = "classify_skip_reasons"

SELECT_REASONS_SQL = """
    SELECT skip_reasoning, count(*) AS pages
    FROM pages
    WHERE archive_reason = 'skip_gate' AND skip_category IS NULL
      AND skip_reasoning IS NOT NULL AND btrim(skip_reasoning) <> ''
    GROUP BY skip_reasoning
    ORDER BY count(*) DESC, skip_reasoning
"""
PER_USER_SQL = """
    SELECT user_id, count(*) FROM pages
    WHERE archive_reason = 'skip_gate' AND skip_category IS NULL
      AND skip_reasoning IS NOT NULL AND btrim(skip_reasoning) <> ''
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
                                "echo": {
                                    "type": "string",
                                    "description": (
                                        f"The first {ECHO_CHARS} characters of that reason, copied exactly"
                                    ),
                                },
                                "category": {
                                    "type": "string",
                                    "enum": list(SKIP_CATEGORY_IDS),
                                    "description": "\n".join(
                                        f"{cid}: {desc}" for cid, _label, desc in SKIP_CATEGORIES
                                    ),
                                },
                            },
                            "required": ["index", "category", "echo"],
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
        f"category, then call {TOOL_NAME} once with an entry for EVERY number "
        f"(do not omit any). For each entry also copy the first {ECHO_CHARS} "
        "characters of its reason into `echo`.\n\n"
        f"Categories:\n{cats}\n\nReasons:\n{numbered}"
    )


def reasons_in_prompt(prompt: str) -> list[str]:
    """Inverse of build_prompt's numbered list (used by tests and debugging)."""
    tail = prompt.split("Reasons:\n", 1)[1]
    return [line.split(". ", 1)[1] for line in tail.split("\n") if ". " in line]


def _valid_category(value: object) -> str | None:
    """A category id for a valid model answer, else None (no silent 'other')."""
    if not isinstance(value, str):
        return None
    v = value.strip().lower()
    if v in SKIP_CATEGORY_IDS:
        return v
    for cid, label, _ in SKIP_CATEGORIES:
        if v == label.lower():
            return cid
    return None


def _echo_matches(echo: object, reason: str) -> bool:
    if not isinstance(echo, str) or not echo.strip():
        return False
    norm = " ".join(reason.lower().split())
    return norm.startswith(" ".join(echo.lower().split()))


def parse_response(arguments: object, reasons: list[str]) -> list[str | None]:
    """Category per reason; None for anything missing, invalid, or echo-mismatched."""
    n = len(reasons)
    out: list[str | None] = [None] * n
    items = arguments.get("items") if isinstance(arguments, dict) else None
    if not isinstance(items, list):
        return out
    for it in items:
        if not isinstance(it, dict):
            continue
        idx = it.get("index")
        if isinstance(idx, bool) or not isinstance(idx, int) or not 0 <= idx < n:
            continue
        cat = _valid_category(it.get("category"))
        if cat is None or not _echo_matches(it.get("echo"), reasons[idx]):
            continue
        out[idx] = cat
    return out


def _add_usage(total: dict, usage: dict) -> None:
    for k in total:
        total[k] += usage[k]


async def _ask(llm, reasons: list[str], model: str) -> tuple[list[str | None], dict]:
    try:
        resp, tool_calls = await llm.select_tool(
            prompt=build_prompt(reasons), tools=[classify_tool()], model=model, temperature=0.0
        )
    except ValueError:
        # Malformed tool-call JSON (e.g. truncated output): treat as "no answer"
        # so the retry path re-asks for these items.
        log("malformed tool-call JSON; will retry the affected items")
        return [None] * len(reasons), {"input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0}
    usage = {
        "input_tokens": getattr(resp, "input_tokens", 0) or 0,
        "output_tokens": getattr(resp, "output_tokens", 0) or 0,
        "cost_usd": getattr(resp, "cost_usd", 0.0) or 0.0,
    }
    args = tool_calls[0]["arguments"] if tool_calls else None
    return parse_response(args, reasons), usage


async def classify_batch(
    llm, reasons: list[str], model: str
) -> tuple[list[str | None], dict, dict]:
    """Classify with retries for dropped items, then one call per leftover item.

    Returns (categories, usage, stats). A category stays None only if the model
    never produced a valid, echo-verified answer; it is NOT defaulted to 'other'.
    """
    cats: list[str | None] = [None] * len(reasons)
    usage = {"input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0}
    stats = {"retried": 0, "single": 0}

    def pending() -> list[int]:
        return [i for i, c in enumerate(cats) if c is None]

    for attempt in range(MAX_RETRIES + 1):
        todo = pending()
        if not todo:
            break
        got, u = await _ask(llm, [reasons[i] for i in todo], model)
        _add_usage(usage, u)
        for i, c in zip(todo, got):
            if c is not None:
                cats[i] = c
                if attempt > 0:
                    stats["retried"] += 1
    for i in pending():
        got, u = await _ask(llm, [reasons[i]], model)
        _add_usage(usage, u)
        if got[0] is not None:
            cats[i] = got[0]
            stats["single"] += 1
    return cats, usage, stats


def build_mapping(model: str, rows: list[tuple], cats: list[str | None]) -> dict:
    counts = {cid: {"reasons": 0, "pages": 0} for cid in SKIP_CATEGORY_IDS}
    items = []
    for (reason, pages), cat in zip(rows, cats):
        if cat is None:
            continue
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


async def classify_all(rows: list[tuple], model: str) -> tuple[list[str | None], dict, dict]:
    from backend.services.llm_service import LLMService

    llm = LLMService()
    cats: list[str | None] = []
    total = {"input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0}
    stats = {"retried": 0, "single": 0}
    chunks = list(batches(rows, BATCH_SIZE))
    for n, chunk in enumerate(chunks, 1):
        got, usage, st = await classify_batch(llm, [r for r, _ in chunk], model)
        cats.extend(got)
        _add_usage(total, usage)
        for k in stats:
            stats[k] += st[k]
        log(
            f"batch {n}/{len(chunks)}  classified {len(cats)}/{len(rows)}  "
            f"spend ${total['cost_usd']:.5f}"
        )
        if total["cost_usd"] > MAX_COST_USD:
            raise SystemExit(f"spend guard tripped (> ${MAX_COST_USD}); stopping")
    return cats, total, stats


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
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT count(*) FROM pages WHERE archive_reason = 'skip_gate' "
            "AND skip_category IS NULL "
            "AND (skip_reasoning IS NULL OR btrim(skip_reasoning) = '')"
        )
        print(f"pages with no reason text (left uncategorized): {cur.fetchone()[0]}")
    print(f"candidate pages by user: {dict(per_user)}")
    print(f"distinct reasons to classify: {len(rows)} ({-(-len(rows) // BATCH_SIZE)} batches)")
    if not rows:
        print("nothing to do")
        return 0

    cats, usage, stats = asyncio.run(classify_all(rows, TOOL_SELECTION_MODEL))
    mapping = build_mapping(TOOL_SELECTION_MODEL, rows, cats)
    mapping["cost_usd"] = usage["cost_usd"]
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(mapping, indent=1) + "\n")
    top_user = max(per_user, key=lambda x: x[1])[0] if per_user else 0
    record_cost(top_user, TOOL_SELECTION_MODEL, usage)
    print_summary(mapping)
    print(f"items resolved by retry: {stats['retried']}, single-call: {stats['single']}")
    unresolved = sum(1 for c in cats if c is None)
    if unresolved:
        print(f"unresolved (left uncategorized): {unresolved}")
    print(f"LLM spend: ${usage['cost_usd']:.5f}")
    print(f"mapping written: {out}")
    if args.apply:
        print(f"rows updated: {apply_mapping(mapping['items'])}")
    print("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
