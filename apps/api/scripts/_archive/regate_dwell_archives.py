"""Re-gate pages archived by the original dwell-time skip gate.

The March 2026 skip gate cited dwell time in its verdicts. Every gate prompt
since v2 judges on content and URL only, so those verdicts would not be made
today. This script re-runs the production gate (``skip_gate_v2_3``, same model
and tools as ``backend/api/main.py``) on the affected archived pages.

Default is a dry run that writes nothing. With ``--apply``:
  * INCLUDE verdict -> reasoning + processing_depth rewrite (one transaction),
    then ``page_repo.restore_page``
  * SKIP verdict    -> stays archived, reasoning rewritten

restore_page only flips status/archive_reason, and trends_repo's skip queries
filter on processing_depth alone, so a restored page left at 'skipped' would
keep counting as a skip. On INCLUDE this script therefore sets
processing_depth='processed' when the page has chunk embeddings, else NULL
(the legacy_active / needs-reprocess state). The rewrite runs BEFORE the
restore so a failure between them leaves a visibly re-gated archived row.

INCLUDE verdicts reached on an empty snippet (no page_content or no readable
text) are title-only guesses: they are listed, not restored, unless
--allow-title-only is given.

Usage:
    python scripts/_archive/regate_dwell_archives.py --user-id N [--apply] [--limit N]
        [--reason-pattern '%dwell%']
"""

import argparse
import asyncio
import sys
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.db import page_repo
from backend.db.connection import get_conn, set_current_user_id

PROMPT_NAME = "skip_gate_v2_3"
DEFAULT_PATTERN = "%dwell%"

SELECT_SQL = """
    SELECT p.id, p.title, p.url, p.skip_reasoning, p.page_content_id,
           pc.fetched_content, pc.tool_selected
    FROM pages p
    LEFT JOIN page_content pc ON pc.id = p.page_content_id
    WHERE p.user_id = %s AND p.status = 'archived'
      AND p.archive_reason = 'skip_gate' AND p.skip_reasoning ILIKE %s
      AND p.skip_reasoning NOT ILIKE 're-gated%%'
    ORDER BY p.id
"""

EMBED_SQL = """
    SELECT EXISTS (
        SELECT 1 FROM page_chunks c
        JOIN chunk_embeddings e ON e.page_chunk_id = c.id
        WHERE c.page_content_id = %s
    )
"""


def select_pages(user_id: int, pattern: str, limit: int | None = None) -> list[dict]:
    sql = SELECT_SQL + (" LIMIT %s" if limit is not None else "")
    params = (user_id, pattern) + ((limit,) if limit is not None else ())
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(sql, params)
        cols = [
            "id", "title", "url", "skip_reasoning", "page_content_id",
            "fetched_content", "tool_selected",
        ]  # fmt: skip
        return [dict(zip(cols, row)) for row in cur.fetchall()]


def has_embeddings(page_content_id: int | None) -> bool:
    if page_content_id is None:
        return False
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(EMBED_SQL, (page_content_id,))
        return bool(cur.fetchone()[0])


def write_regate(
    page_id: int, reasoning: str, processing_depth: str | None, *, set_depth: bool
) -> None:
    """Rewrite skip_reasoning (and optionally processing_depth) in ONE transaction."""
    with get_conn() as conn, conn.cursor() as cur:
        if set_depth:
            cur.execute(
                "UPDATE pages SET skip_reasoning = %s, processing_depth = %s WHERE id = %s",
                (reasoning, processing_depth, page_id),
            )
        else:
            cur.execute("UPDATE pages SET skip_reasoning = %s WHERE id = %s", (reasoning, page_id))


def build_snippet(page: dict) -> str:
    """Same snippet the pipeline gives the gate: first 500 chars of primary text."""
    from backend.services.content_fetcher import get_primary_text_from_dict

    text, _ = get_primary_text_from_dict(page.get("tool_selected"), page.get("fetched_content"))
    return (text or "")[:500]


async def gate_verdict(page: dict, snippet: str) -> tuple[str, str, dict]:
    """Run the production skip gate once.

    Returns (``include``|``skip``, reasoning, usage) where usage carries model,
    input_tokens, output_tokens and cost_usd for the cost event.
    """
    from backend.api.main import TOOL_SELECTION_MODEL
    from backend.prompts.templates import get_prompt
    from backend.services.llm_service import PAGE_PROCESSING_TOOLS, LLMService

    prompt = get_prompt(
        PROMPT_NAME,
        title=page.get("title") or "Unknown",
        url=page["url"],
        domain=urlparse(page["url"]).hostname or "unknown",
        snippet_len=str(len(snippet)),
        snippet=snippet,
    )
    resp, tool_calls = await LLMService().select_tool(
        prompt=prompt, tools=PAGE_PROCESSING_TOOLS, model=TOOL_SELECTION_MODEL, temperature=0.0
    )
    usage = {
        "model": TOOL_SELECTION_MODEL,
        "input_tokens": getattr(resp, "input_tokens", 0) or 0,
        "output_tokens": getattr(resp, "output_tokens", 0) or 0,
        "cost_usd": getattr(resp, "cost_usd", 0.0) or 0.0,
    }
    if not tool_calls:
        # Pipeline treats "no tool call" as processed (include).
        return "include", "", usage
    tc = tool_calls[0]
    args = tc["arguments"]
    reasoning = args.get("reasoning") or args.get("reason", "")
    return ("skip" if tc["name"] == "skip_page" else "include"), reasoning, usage


def record_cost(user_id: int, usage: dict) -> None:
    """Mirror main.py's skip-gate cost event; never abort the page on failure."""
    try:
        from backend.db import trends_repo

        trends_repo.insert_cost_event(
            user_id=user_id,
            event_type="regate",
            model=usage["model"],
            input_tokens=usage["input_tokens"],
            output_tokens=usage["output_tokens"],
            cost_usd=usage["cost_usd"],
        )
    except Exception as exc:  # noqa: BLE001 - cost bookkeeping is best-effort
        print(f"    (cost event failed: {type(exc).__name__})")


def _one_line(text: str | None, n: int) -> str:
    return " ".join((text or "").split())[:n]


def run(
    user_id: int, pattern: str, apply: bool, limit: int | None, allow_title_only: bool = False
) -> dict:
    mode = "APPLY" if apply else "DRY RUN"
    print(
        f"[regate] start: user={user_id} pattern={pattern!r} limit={limit} mode={mode} "
        f"allow_title_only={allow_title_only}"
    )
    set_current_user_id(user_id)
    pages = select_pages(user_id, pattern, limit)
    if limit is not None:
        pages = pages[:limit]
    print(f"[regate] selected {len(pages)} page(s)")

    tally = {"include": 0, "skip": 0, "error": 0, "no_content": 0}
    needs_reprocess: list[int] = []
    title_only: list[int] = []
    errors: list[tuple[int, str]] = []
    today = datetime.now().astimezone().date().isoformat()

    for page in pages:
        pid = page["id"]
        try:
            snippet = build_snippet(page)
            verdict, reasoning, usage = asyncio.run(gate_verdict(page, snippet))
            empty = not snippet
            if empty:
                tally["no_content"] += 1
            embedded = None
            depth_note = ""
            if verdict == "include":
                embedded = has_embeddings(page.get("page_content_id"))
                depth = "processed" if embedded else None
                depth_note = f" | depth->{depth or 'NULL'}"
                if not embedded:
                    needs_reprocess.append(pid)
            hold = verdict == "include" and empty and not allow_title_only
            flags = ""
            if empty:
                flags += " [title-only]"
            if hold:
                title_only.append(pid)
                flags += " [HOLD: not restored]"
            if embedded is False:
                flags += " [needs reprocess]"
            print(
                f"  {pid} | {_one_line(page.get('title'), 50)} | snippet={len(snippet)} | "
                f"old: {_one_line(page.get('skip_reasoning'), 60)} | "
                f"new: {verdict.upper()} | {_one_line(reasoning, 80)}{depth_note}{flags}"
            )
            if apply:
                record_cost(user_id, usage)
                if not hold:
                    new_text = (
                        f"re-gated {today} under {PROMPT_NAME} -> {verdict.upper()} "
                        f"(was: {page.get('skip_reasoning') or ''}): {reasoning}"
                    )
                    write_regate(pid, new_text, depth if verdict == "include" else None,
                                 set_depth=verdict == "include")  # fmt: skip
                    if verdict == "include":
                        page_repo.restore_page(pid)
            tally[verdict] += 1
        except Exception as exc:  # noqa: BLE001 - one bad page must not abort the run
            tally["error"] += 1
            errors.append((pid, f"{type(exc).__name__}: {exc}"))
            print(f"  {pid} | ERROR {type(exc).__name__}: {exc}")

    print(
        f"[regate] done ({mode}): {tally['include']} include / {tally['skip']} skip / "
        f"{tally['error']} error / {tally['no_content']} no_content"
    )
    if needs_reprocess:
        print(f"[regate] needs reprocess: {needs_reprocess}")
    if title_only:
        print(f"[regate] title-only INCLUDE, not restored (use --allow-title-only): {title_only}")
    for pid, msg in errors:
        print(f"[regate] error page {pid}: {msg}")
    return {
        **tally,
        "needs_reprocess": needs_reprocess,
        "title_only": title_only,
        "errors": errors,
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--user-id", type=int, required=True)
    ap.add_argument("--apply", action="store_true", help="write changes (default: dry run)")
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--reason-pattern", default=DEFAULT_PATTERN)
    ap.add_argument(
        "--allow-title-only",
        action="store_true",
        help="also restore INCLUDE verdicts reached on an empty snippet",
    )
    args = ap.parse_args(argv)
    res = run(args.user_id, args.reason_pattern, args.apply, args.limit, args.allow_title_only)
    return 1 if res["error"] > 0 else 0


if __name__ == "__main__":
    sys.exit(main())
