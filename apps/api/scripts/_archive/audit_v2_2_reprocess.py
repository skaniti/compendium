"""Audit run: skip_gate v2.2 against current active compendium pages.

Read-only. Pulls all active pages for the user, renders the skip_gate v2.2
prompt against each, and records the verdict. Pages where v2.2 returns
"skip" are written to a diff list for human review (these are candidates
for status='inactive' once approved).

Output: scripts/audit_output/v2_2_audit_<timestamp>.json with
  {
    "audit_at": ...,
    "user_id": ...,
    "n_active_pages": ...,
    "n_v22_says_skip": ...,
    "n_v22_says_process": ...,
    "n_errored": ...,
    "estimated_cost_usd": ...,
    "candidates_to_drop": [
      {"page_id": ..., "url": ..., "title": ..., "domain": ...,
       "v22_verdict": "skip", "v22_reasoning": "..."},
      ...
    ]
  }

Usage::

    python scripts/_archive/audit_v2_2_reprocess.py --user-id 152 [--limit N]

The diff list is for review only -- this script does NOT modify the DB.
Apply approved drops via a separate step (e.g., a one-shot UPDATE).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

import os  # noqa: E402

# Force-disable LangSmith tracing BEFORE importing anything that might wrap
# OpenAI -- prior runs hit LangSmith's monthly trace cap and the resulting
# 429s broke 73% of calls. The audit doesn't need tracing.
os.environ["LANGCHAIN_TRACING_V2"] = "false"
os.environ.pop("LANGCHAIN_API_KEY", None)

from backend.config.settings import settings  # noqa: E402
from backend.db import page_repo  # noqa: E402
from backend.prompts.templates import get_prompt  # noqa: E402
from backend.services.llm_service import PAGE_PROCESSING_TOOLS  # noqa: E402


SKIP_GATE_TEMPLATE = "skip_gate_v2_2"
MODEL = "gpt-4o-mini"
SNIPPET_MAX_LEN = 2000

OUT_DIR = REPO_ROOT / "scripts" / "audit_output"

# Progress log lives on Linux-native storage (~/.cache) rather than the
# /mnt/c WSL→Windows mount. The audit's append cadence (~3-5 file
# open/write/close per sec sustained for ~10+ minutes) can hang the 9P
# client on the mount, leaving the file inaccessible until the WSL VM
# restarts. ext4 has no such failure mode at this load. The final summary
# JSON still writes to OUT_DIR (one-shot, fine for 9P).
PROGRESS_DIR = Path.home() / ".cache" / "td-audit"
PROGRESS_PATH = PROGRESS_DIR / "v2_2_audit_progress.jsonl"
"""Append-only per-page result log. Writes one JSON object per line as each
LLM call completes; on resume, lines whose page_id is already present are
skipped. Pass ``--fresh`` to clear and restart from scratch. The OpenAI 200K
TPM cap + 1734-page audit means a single run can take 10-12 minutes; failures
or interruptions during that window would otherwise lose all progress."""


def _load_progress() -> dict[int, dict]:
    """Load existing per-page results from PROGRESS_PATH; empty dict if absent.

    Lines that fail to parse (e.g. partial write at SIGKILL) are skipped --
    we keep what we can. Resumes are page_id-keyed so a duplicate write of
    the same page is harmless.
    """
    progress: dict[int, dict] = {}
    if not PROGRESS_PATH.exists():
        return progress
    with PROGRESS_PATH.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
                progress[int(r["page_id"])] = r
            except (json.JSONDecodeError, KeyError, ValueError):
                continue
    return progress


def _append_progress(record: dict) -> None:
    """Atomically append one result line to the progress log + flush."""
    with PROGRESS_PATH.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")
        f.flush()


def _build_snippet(page: dict) -> str:
    """Best-effort snippet for the page, mirroring what production gives skip_gate."""
    for key in ("content_summary", "content_level_summary", "content_extracted_text"):
        v = page.get(key)
        if v:
            return str(v)[:SNIPPET_MAX_LEN]
    return ""


async def _audit_one(
    page: dict,
    *,
    client,
    semaphore: asyncio.Semaphore,
) -> dict:
    """Bypass LLMService and call the bare OpenAI client to avoid any
    LangSmith wrapping issues. Tools schema and prompt template still come
    from production code so the verdict is faithful to skip_gate v2.2.

    Retries with exponential backoff on RateLimitError (OpenAI's 200K TPM
    cap fires when audit + production traffic overlap; backoff gives the
    bucket time to refill rather than hard-failing the page's verdict).
    """
    snippet = _build_snippet(page)
    prompt = get_prompt(
        SKIP_GATE_TEMPLATE,
        title=page.get("title") or "(no title)",
        url=page.get("url") or "",
        domain=page.get("domain") or "unknown",
        snippet_len=str(len(snippet)),
        snippet=snippet,
    )
    messages = [{"role": "user", "content": prompt}]
    max_attempts = 5
    response = None
    last_err = None
    for attempt in range(max_attempts):
        async with semaphore:
            try:
                response = await client.chat.completions.create(
                    model=MODEL,
                    messages=messages,
                    tools=PAGE_PROCESSING_TOOLS,
                    temperature=0.0,
                )
                break
            except Exception as e:
                last_err = e
                # RateLimitError -> back off and retry; other errors -> immediate fail.
                if "RateLimit" in type(e).__name__ and attempt < max_attempts - 1:
                    # Capped exponential backoff: 1, 2, 4, 8 seconds (max). Matches
                    # OpenAI TPM bucket refill (~3333 tok/sec = ~3 req/sec at 1.1K
                    # tokens/req); deeper backoff just over-corrects.
                    delay = min(8, 2 ** attempt)
                    await asyncio.sleep(delay)
                    continue
                response = None
                break

    if response is None:
        return {
            "page_id": page["id"],
            "url": page.get("url"),
            "title": page.get("title"),
            "domain": page.get("domain"),
            "v22_verdict": "<error>",
            "v22_reasoning": f"{type(last_err).__name__ if last_err else 'Unknown'}: {last_err}",
            "cost_usd": 0.0,
        }

    msg = response.choices[0].message
    tool_calls = msg.tool_calls or []
    if not tool_calls:
        verdict = "<no-tool-call>"
        reasoning = msg.content or ""
    else:
        tc = tool_calls[0]
        name = tc.function.name
        try:
            args = json.loads(tc.function.arguments) if tc.function.arguments else {}
        except (json.JSONDecodeError, ValueError):
            args = {}
        verdict = "skip" if name == "skip_page" else "process"
        reasoning = args.get("reasoning") or args.get("reason", "")

    # Cost: gpt-4o-mini at $0.00015/1K input + $0.0006/1K output (Apr 2026 prices).
    in_tok = response.usage.prompt_tokens if response.usage else 0
    out_tok = response.usage.completion_tokens if response.usage else 0
    cost = (in_tok / 1000) * 0.00015 + (out_tok / 1000) * 0.0006

    return {
        "page_id": page["id"],
        "url": page.get("url"),
        "title": page.get("title"),
        "domain": page.get("domain"),
        "v22_verdict": verdict,
        "v22_reasoning": str(reasoning)[:500],
        "cost_usd": float(cost),
    }


async def run_audit(
    user_id: int, limit: int | None, concurrency: int, fresh: bool
) -> int:
    pages = page_repo.get_active_pages(user_id)
    if limit:
        pages = pages[:limit]
    n_total = len(pages)
    if n_total == 0:
        print(f"No active pages for user {user_id}", file=sys.stderr)
        return 2

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    PROGRESS_DIR.mkdir(parents=True, exist_ok=True)

    # Resume: load any prior progress and skip those page_ids.
    if fresh and PROGRESS_PATH.exists():
        PROGRESS_PATH.unlink()
        print(f"--fresh: cleared {PROGRESS_PATH.name}")

    progress = _load_progress()
    pages_remaining = [p for p in pages if int(p["id"]) not in progress]
    n_remaining = len(pages_remaining)
    n_resumed = n_total - n_remaining

    print(
        f"Auditing {n_total} active pages with {SKIP_GATE_TEMPLATE} "
        f"(concurrency={concurrency}, resumed={n_resumed}, todo={n_remaining})"
    )
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_path = OUT_DIR / f"v2_2_audit_{ts}.json"

    from openai import AsyncOpenAI

    client = AsyncOpenAI(api_key=settings.openai_api_key)
    semaphore = asyncio.Semaphore(concurrency)
    t_start = time.perf_counter()

    async def _audit_and_persist(p: dict) -> dict:
        r = await _audit_one(p, client=client, semaphore=semaphore)
        _append_progress(r)
        return r

    tasks = [_audit_and_persist(p) for p in pages_remaining]
    new_results: list[dict] = []
    completed = 0
    for coro in asyncio.as_completed(tasks):
        r = await coro
        new_results.append(r)
        completed += 1
        if completed % 25 == 0 or completed == n_remaining:
            elapsed = time.perf_counter() - t_start
            rate = completed / elapsed if elapsed > 0 else 0.0
            print(
                f"  {completed}/{n_remaining} ({rate:.1f}/s, {elapsed:.0f}s elapsed) "
                f"-- progress flushed to {PROGRESS_PATH.name}"
            )

    results = list(progress.values()) + new_results
    n = len(results)

    n_skip = sum(1 for r in results if r["v22_verdict"] == "skip")
    n_process = sum(1 for r in results if r["v22_verdict"] == "process")
    n_error = sum(1 for r in results if r["v22_verdict"] == "<error>")
    n_other = n - n_skip - n_process - n_error
    total_cost = sum(r["cost_usd"] for r in results)

    candidates_to_drop = sorted(
        (r for r in results if r["v22_verdict"] == "skip"),
        key=lambda r: (r.get("domain") or "", r.get("url") or ""),
    )
    errors = [r for r in results if r["v22_verdict"] == "<error>"]

    out_path.write_text(
        json.dumps(
            {
                "audit_at": datetime.now(timezone.utc).isoformat(),
                "user_id": user_id,
                "skip_gate_template": SKIP_GATE_TEMPLATE,
                "model": MODEL,
                "n_active_pages": n,
                "n_v22_says_skip": n_skip,
                "n_v22_says_process": n_process,
                "n_errored": n_error,
                "n_other": n_other,
                "estimated_cost_usd": round(total_cost, 4),
                "elapsed_seconds": round(time.perf_counter() - t_start, 1),
                "candidates_to_drop": candidates_to_drop,
                "errors": errors,
            },
            indent=2,
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    print()
    print(f"Audit complete in {time.perf_counter() - t_start:.0f}s, ${total_cost:.4f}")
    print(f"  v2.2 says skip:    {n_skip:>4} ({100*n_skip/n:.1f}%)")
    print(f"  v2.2 says process: {n_process:>4} ({100*n_process/n:.1f}%)")
    if n_error:
        print(f"  errors:            {n_error:>4}")
    if n_other:
        print(f"  other:             {n_other:>4}")
    print(f"  -> {out_path}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--user-id", type=int, default=152)
    parser.add_argument("--limit", type=int, default=None, help="Limit pages audited (for testing)")
    parser.add_argument("--concurrency", type=int, default=2)
    parser.add_argument(
        "--fresh",
        action="store_true",
        help="Discard existing progress log and restart from page 0",
    )
    args = parser.parse_args(argv)
    return asyncio.run(
        run_audit(args.user_id, args.limit, args.concurrency, args.fresh)
    )


if __name__ == "__main__":
    raise SystemExit(main())
