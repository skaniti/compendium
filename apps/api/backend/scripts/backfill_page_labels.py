"""Backfill page labels for content rows that have none at the current labeller version.

Dry run by default: counts the unlabelled content rows, prints the cost
estimate and exits having made no API call. ``--apply`` labels them in
batches; it is resumable by construction (rows already labelled at the current
``labeller_version`` are never selected again), so an interrupted run is
continued by running it again.

Usage:
    python -m backend.scripts.backfill_page_labels                    # dry run
    python -m backend.scripts.backfill_page_labels --user-id 1 --limit 500
    python -m backend.scripts.backfill_page_labels --apply            # asks to confirm
    python -m backend.scripts.backfill_page_labels --apply --yes      # cron / no TTY

The command does not require ``LABEL_FIRST_ENABLED``: backfilling before the
flag is turned on is the intended rollout order, and nothing here runs unless
an operator invokes it.
"""

import argparse
import asyncio
import logging
import sys
from pathlib import Path

# repo root = two levels up (this file lives at backend/scripts/)
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.config.settings import settings
from backend.db import page_label_repo
from backend.db.connection import get_conn
from backend.services import page_labeller

log = logging.getLogger("backfill_page_labels")

REQUESTS_PER_CHUNK = 10
"""Requests per ``label_content_ids`` call (one cost event, one progress line)."""


def _user_ids_with_pages(only_active: bool) -> list[int]:
    where = "page_content_id IS NOT NULL AND user_id IS NOT NULL"
    if only_active:
        where += " AND COALESCE(human_status, status) = 'active'"
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(f"SELECT DISTINCT user_id FROM pages WHERE {where} ORDER BY user_id")
        return [r[0] for r in cur.fetchall()]


def format_estimate(est: dict, version: str) -> str:
    """The table printed before anything else happens."""
    per_page_list = est["usd_list"] / est["pages"] if est["pages"] else 0.0
    return "\n".join(
        [
            f"Labeller version : {version}",
            f"Pages to label   : {est['pages']}",
            f"Requests         : {est['requests']} (batch size {settings.label_batch_size})",
            f"Input tokens     : {est['input_tokens']:,}  (measured 6,114 per 8-page request)",
            f"Output tokens    : {est['output_tokens']:,}  (measured 1,005 per 8-page request)",
            f"Cost at list price        : ${est['usd_list']:.4f}  (${per_page_list:.5f}/page)",
            (
                f"Cost at measured effective: ${est['usd_measured']:.4f}  ($0.0001/page, "
                "prompt caching applied)"
            ),
        ]
    )


def _confirm(est: dict) -> bool:
    """TTY confirmation. Without a TTY the caller must pass ``--yes``."""
    if not sys.stdin.isatty():
        print("stdin is not a TTY: refusing to apply without --yes", file=sys.stderr)
        return False
    answer = input(f"Label {est['pages']} pages now? [y/N] ")
    return answer.strip().lower() in {"y", "yes"}


async def _apply(version: str, user_ids: list[int], limit: int | None, only_active: bool) -> dict:
    chunk_size = settings.label_batch_size * REQUESTS_PER_CHUNK
    total = {"labelled": 0, "requests": 0, "failed_requests": 0, "cost_usd": 0.0, "targets": 0}
    remaining = limit
    for uid in user_ids:
        if remaining is not None and remaining <= 0:
            break
        ids = page_label_repo.get_unlabelled_content_ids(
            version, user_id=uid, limit=remaining, only_active=only_active
        )
        total["targets"] += len(ids)
        if remaining is not None:
            remaining -= len(ids)
        for i in range(0, len(ids), chunk_size):
            chunk = ids[i : i + chunk_size]
            run = await page_labeller.label_content_ids(chunk, user_id=uid)
            total["labelled"] += len(run.labels)
            total["requests"] += run.requests
            total["failed_requests"] += run.failed_requests
            if run.error:
                total["errors"] = total.get("errors", 0) + 1
                print(f"user {uid}: chunk aborted: {run.error}", file=sys.stderr, flush=True)
            total["cost_usd"] += run.cost_usd
            print(
                f"user {uid}: {min(i + chunk_size, len(ids))}/{len(ids)} processed, "
                f"{total['labelled']} labelled so far, ${total['cost_usd']:.4f} spent",
                flush=True,
            )
    return total


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--user-id", type=int, default=None, help="only this user's pages")
    ap.add_argument("--limit", type=int, default=None, help="label at most this many pages")
    ap.add_argument(
        "--all-statuses",
        action="store_true",
        help="include archived/pending pages (default: active)",
    )
    ap.add_argument("--apply", action="store_true", help="call the model and write labels")
    ap.add_argument("--yes", action="store_true", help="skip the confirmation prompt")
    args = ap.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    only_active = not args.all_statuses
    try:
        version = page_labeller.labeller_version()
    except page_labeller.LabellerPromptError as exc:
        print(f"Cannot load the labelling prompt: {exc}", file=sys.stderr)
        return 2

    ids = page_label_repo.get_unlabelled_content_ids(
        version, user_id=args.user_id, limit=args.limit, only_active=only_active
    )
    est = page_labeller.estimate_cost(len(ids))
    print(format_estimate(est, version))

    if not args.apply:
        print("\nDry run: no API call made. Re-run with --apply to label these pages.")
        return 0
    if not ids:
        print("\nNothing to label.")
        return 0
    if not settings.has_anthropic:
        print("ANTHROPIC_API_KEY is not set; cannot apply.", file=sys.stderr)
        return 2
    if not args.yes and not _confirm(est):
        print("Aborted; nothing labelled.")
        return 1

    user_ids = [args.user_id] if args.user_id is not None else _user_ids_with_pages(only_active)
    total = asyncio.run(_apply(version, user_ids, args.limit, only_active))
    print(
        f"\nDone: {total['labelled']}/{total['targets']} labelled in {total['requests']} requests "
        f"({total['failed_requests']} failed). Actual spend: ${total['cost_usd']:.4f}. "
        "Re-run to retry anything unlabelled."
    )
    return 0 if total["failed_requests"] == 0 and not total.get("errors") else 3


if __name__ == "__main__":
    sys.exit(main())
