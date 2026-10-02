"""Backfill ``pages.skip_category`` for historical skip-gate archives.

Selects the DISTINCT ``skip_reasoning`` strings of ``skip_gate`` pages whose
category is NULL (all users), classifies them in small batches (BATCH_SIZE) with one LLM
tool call per batch plus bounded retries, writes a reviewable mapping file OUTSIDE the repo, and --
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
import os
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
    "AND skip_reasoning = %s"
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


PRECEDENCE_RULES = (
    "Precedence: if the reason names a specific kind of page (user-specific, "
    "profile, account, dashboard, settings, inbox; homepage or index; login, auth, "
    "sign-in; marketplace, product, store, pricing; search results including image "
    "search; map, location service, directions, form, editor or status tool; video; local file; "
    "error), choose that category even when it also says the page lacks "
    "substantive content. Use content_free_stub only when the reason names no more "
    "specific kind of page."
)

EXAMPLES = (
    ("Account settings page with nothing substantive", "user_specific"),
    ("Personal dashboard view, no real content to keep", "user_specific"),
    ("Route planner map page with no article content", "web_app"),
    ("Online form submission page, no substantive text", "web_app"),
    ("Image search results grid with no real content", "search_results"),
    ("Keyword search page listing hits, nothing substantive", "search_results"),
)


def build_prompt(reasons: list[str]) -> str:
    cats = "\n".join(f"- {cid}: {desc}" for cid, _label, desc in SKIP_CATEGORIES)
    numbered = "\n".join(f"{i}. {r}" for i, r in enumerate(reasons))
    examples = "\n".join(f'Example: "{r}" -> {c}' for r, c in EXAMPLES)
    return (
        "A page-skipping gate archived web pages and recorded a short free-text "
        "reason for each. Classify every numbered reason below into exactly one "
        f"category, then call {TOOL_NAME} once with an entry for EVERY number "
        f"(do not omit any). For each entry also copy the first {ECHO_CHARS} "
        "characters of its reason into `echo`.\n\n"
        f"{PRECEDENCE_RULES}\n\n{examples}\n\n"
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
    e = " ".join(echo.lower().split())
    return len(e) >= min(len(norm), ECHO_CHARS) - 3 and norm.startswith(e)


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
    for k, v in usage.items():
        total[k] = total.get(k, 0) + v


def _estimate_usage(llm, model: str, prompt: str, max_tokens: int) -> dict:
    """Usage for a call whose response never parsed: the prompt is billed, and a
    truncated answer hit the output cap. Cost uses the service's price table."""
    tin, tout = len(prompt) // 4, max_tokens
    calc = getattr(llm, "_calculate_cost", None)
    try:
        cost = float(calc(model, tin, tout)) if calc else 0.0
    except Exception:  # noqa: BLE001 - estimate only
        cost = 0.0
    return {"input_tokens": tin, "output_tokens": tout, "cost_usd": cost, "estimated_usd": cost}


def _merged_arguments(tool_calls) -> dict | None:
    """Merge the items of every classify_skip_reasons call."""
    if not tool_calls:
        return None
    items: list = []
    for tc in tool_calls:
        if tc.get("name") != TOOL_NAME:
            continue
        args = tc.get("arguments")
        if isinstance(args, dict) and isinstance(args.get("items"), list):
            items.extend(args["items"])
    return {"items": items}


async def _ask(llm, reasons: list[str], model: str, usage: dict) -> list[str | None]:
    """One LLM call; its usage is added to ``usage`` even when parsing fails."""
    prompt = build_prompt(reasons)
    max_tokens = 40 * len(reasons) + 100
    try:
        resp, tool_calls = await llm.select_tool(
            prompt=prompt,
            tools=[classify_tool()],
            model=model,
            temperature=0.0,
            max_tokens=max_tokens,
        )
    except json.JSONDecodeError:
        # Malformed/truncated tool-call JSON: billed but unusable. Treat as "no
        # answer" so the retry path re-asks for these items.
        log("malformed tool-call JSON; usage for this call is estimated; will retry the items")
        _add_usage(usage, _estimate_usage(llm, model, prompt, max_tokens))
        return [None] * len(reasons)
    _add_usage(
        usage,
        {
            "input_tokens": getattr(resp, "input_tokens", 0) or 0,
            "output_tokens": getattr(resp, "output_tokens", 0) or 0,
            "cost_usd": getattr(resp, "cost_usd", 0.0) or 0.0,
        },
    )
    return parse_response(_merged_arguments(tool_calls), reasons)


async def classify_batch(
    llm, reasons: list[str], model: str, usage: dict | None = None
) -> tuple[list[str | None], dict, dict]:
    """Classify with retries for dropped items, then one call per leftover item.

    ``usage`` (optional) is an accumulator updated after every call, so spend is
    never lost if a later call raises. Returns (categories, usage, stats). A
    category stays None only if the model never produced a valid, echo-verified
    answer; it is NOT defaulted to 'other'.
    """
    cats: list[str | None] = [None] * len(reasons)
    if usage is None:
        usage = {"input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0, "estimated_usd": 0.0}
    stats = {"retried": 0, "single": 0}

    def pending() -> list[int]:
        return [i for i, c in enumerate(cats) if c is None]

    for attempt in range(MAX_RETRIES + 1):
        todo = pending()
        if not todo:
            break
        got = await _ask(llm, [reasons[i] for i in todo], model, usage)
        for i, c in zip(todo, got):
            if c is not None:
                cats[i] = c
                if attempt > 0:
                    stats["retried"] += 1
    for i in pending():
        got = await _ask(llm, [reasons[i]], model, usage)
        if got[0] is not None:
            cats[i] = got[0]
            stats["single"] += 1
    return cats, usage, stats


_CUT_MARKERS = (" url clues", " -- ")


def normalize_key(reason: str) -> str:
    """Grouping key: lowercase, cut at clue/aside markers, collapse spaces, strip
    trailing punctuation."""
    k = " ".join(reason.lower().split())
    for marker in _CUT_MARKERS:
        i = k.find(marker)
        if i != -1:
            k = k[:i]
    return k.rstrip(" .,;:!?-")


def group_reasons(rows: list[tuple]) -> list[dict]:
    """Group near-duplicate reasons; the most frequent member represents the group."""
    groups: dict[str, dict] = {}
    for i, (reason, pages) in enumerate(rows):
        g = groups.setdefault(normalize_key(reason), {"members": [], "rep_i": i})
        g["members"].append(i)
        if pages > rows[g["rep_i"]][1]:
            g["rep_i"] = i
    return [
        {"key": k, "rep": rows[g["rep_i"]][0], "members": g["members"]} for k, g in groups.items()
    ]


def mixed_prefix_groups(items: list[dict]) -> list[dict]:
    """Prefixes (first two words of the normalized key) whose items got >1 category."""
    by_prefix: dict[str, dict[str, int]] = {}
    for it in items:
        prefix = " ".join(normalize_key(it["reason"]).split()[:2])
        cats = by_prefix.setdefault(prefix, {})
        cats[it["category"]] = cats.get(it["category"], 0) + it["pages"]
    return [{"prefix": p, "pages_by_category": c} for p, c in by_prefix.items() if len(c) > 1]


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
        "mixed_prefix_groups": mixed_prefix_groups(items),
    }


def _ancestor_with_dot_git(path: Path) -> Path | None:
    """Nearest ancestor (or self) holding a ``.git`` entry (dir or file), if any."""
    for d in (path, *path.parents):
        if (d / ".git").exists():
            return d
    return None


def _repo_root() -> Path | None:
    """Root of the repo this script lives in. Without a git binary (the hosted API
    container) fall back to a ``.git`` walk, which may find none (None). Any other
    probe failure fails closed."""
    here = Path(__file__).resolve().parent
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            cwd=here,
            capture_output=True,
            text=True,
            check=True,
            timeout=15,
        ).stdout.strip()
    except FileNotFoundError:
        return _ancestor_with_dot_git(here)
    except (OSError, subprocess.SubprocessError) as e:
        raise SystemExit(f"cannot determine the git work tree ({e}); refusing") from e
    return Path(out).resolve()


def _inside_git_work_tree(directory: Path) -> bool:
    try:
        r = subprocess.run(
            ["git", "-C", str(directory), "rev-parse", "--show-toplevel"],
            capture_output=True,
            text=True,
            check=False,
            timeout=15,
            env={**os.environ, "LC_ALL": "C"},
        )
    except FileNotFoundError:
        # No git binary: look for a .git entry on the way up instead.
        return _ancestor_with_dot_git(directory) is not None
    except (OSError, subprocess.SubprocessError) as e:
        raise SystemExit(f"git probe failed ({e}); refusing") from e
    if r.returncode == 0:
        return True
    if "not a git repository" in r.stderr.lower():
        return False
    raise SystemExit(f"git probe failed ({r.stderr.strip()[:80]}); refusing")


def check_outside_repo(path: Path) -> None:
    """Refuse a mapping path inside ANY git work tree (lexically, via symlinks, or
    through its nearest existing directory). Fails closed on probe errors."""
    root = _repo_root()
    lexical = Path(os.path.abspath(os.path.expanduser(path)))
    resolved = lexical.resolve()
    if root is not None:
        for p in (lexical, resolved):
            if p.is_relative_to(root):
                raise SystemExit(f"refusing mapping path inside the git work tree: {p}")
    anc = resolved
    while not anc.is_dir() and anc != anc.parent:
        anc = anc.parent  # existing file or missing path: probe its parent directory
    if _inside_git_work_tree(anc):
        raise SystemExit(f"refusing mapping path inside a git work tree: {resolved}")


def write_mapping(out: Path, mapping: dict) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(json.dumps(mapping, indent=1) + "\n")
    os.chmod(out, 0o600)


def default_mapping_path() -> Path:
    ts = datetime.now(UTC).astimezone().strftime("%Y-%m-%d-%H%M%S")
    return Path.home() / ".local/share/compendium" / f"skip-category-mapping-{ts}.json"


def load_mapping(path: Path) -> list[dict]:
    """Load a reviewed mapping; any null/blank reason or invalid category aborts."""
    data = json.loads(Path(path).read_text())
    out = []
    for n, it in enumerate(data["items"]):
        reason = it.get("reason")
        cat = _valid_category(it.get("category"))
        if not isinstance(reason, str) or not reason.strip():
            raise SystemExit(f"mapping item {n}: blank or missing reason")
        if cat is None:
            raise SystemExit(f"mapping item {n}: invalid category")
        out.append({"reason": reason, "category": cat, "pages": it.get("pages", 0)})
    return out


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
            metadata={
                "estimated_usd": usage.get("estimated_usd", 0.0),
                "actual_usd": usage["cost_usd"] - usage.get("estimated_usd", 0.0),
            },
        )
    except Exception as e:  # noqa: BLE001 - cost bookkeeping is best-effort
        log(f"cost event insert failed: {e}")


async def classify_all(
    rows: list[tuple], model: str, user_id: int | None = None
) -> tuple[list[str | None], dict, dict, int]:
    """Classify one representative per near-duplicate group; members inherit it.

    Spend so far is recorded as a cost event even if the guard trips or the API
    errors (when ``user_id`` is given)."""
    from backend.services.llm_service import LLMService

    llm = LLMService()
    groups = group_reasons(rows)
    reps = [g["rep"] for g in groups]
    rep_cats: list[str | None] = []
    total = {"input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0, "estimated_usd": 0.0}
    stats = {"retried": 0, "single": 0}
    chunks = list(batches(reps, BATCH_SIZE))
    try:
        for n, chunk in enumerate(chunks, 1):
            got, _, st = await classify_batch(llm, chunk, model, total)
            rep_cats.extend(got)
            for k in stats:
                stats[k] += st[k]
            log(
                f"batch {n}/{len(chunks)}  classified {len(rep_cats)}/{len(reps)}  "
                f"spend ${total['cost_usd']:.5f}"
            )
            if total["cost_usd"] > MAX_COST_USD:
                raise SystemExit(f"spend guard tripped (> ${MAX_COST_USD}); stopping")
    finally:
        if user_id is not None and (total["input_tokens"] or total["cost_usd"]):
            record_cost(user_id, model, total)
    cats: list[str | None] = [None] * len(rows)
    for g, c in zip(groups, rep_cats):
        for i in g["members"]:
            cats[i] = c
    return cats, total, stats, len(groups)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument(
        "--dry-run", action="store_true", help="default: classify + write mapping only"
    )
    mode.add_argument("--apply", action="store_true", help="write categories to the pages table")
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

    top_user = max(per_user, key=lambda x: x[1])[0] if per_user else 0
    cats, usage, stats, ngroups = asyncio.run(
        classify_all(rows, TOOL_SELECTION_MODEL, user_id=top_user)
    )
    mapping = build_mapping(TOOL_SELECTION_MODEL, rows, cats)
    mapping["cost_usd"] = usage["cost_usd"]
    write_mapping(out, mapping)
    print_summary(mapping)
    print(f"groups classified: {ngroups} (of {len(rows)} distinct reasons)")
    mixed = mapping["mixed_prefix_groups"]
    print(f"mixed-prefix groups: {len(mixed)}")
    for g in mixed:
        print(f"  {g['prefix']!r}: {g['pages_by_category']}")
    print(f"items resolved by retry: {stats['retried']}, single-call: {stats['single']}")
    unresolved = sum(1 for c in cats if c is None)
    if unresolved:
        print(f"unresolved (left uncategorized): {unresolved}")
    est = usage.get("estimated_usd", 0.0)
    est_note = f" (includes ~${est:.5f} estimated)" if est else ""
    print(f"LLM spend: ${usage['cost_usd']:.5f}{est_note}")
    print(f"mapping written: {out}")
    if args.apply:
        print(f"rows updated: {apply_mapping(mapping['items'])}")
    print("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
