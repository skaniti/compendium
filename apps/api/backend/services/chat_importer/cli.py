"""Chat-import CLI: parse -> extract -> verify -> ingest, dry-run by default.

Usage (from the repo root, inside the project venv):

    python -m backend.services.chat_importer ingest \
        --export-dir data/chat-imports/raw/2026-04-09-chatgpt-export
    python -m backend.services.chat_importer ingest --commit   # actually write

Follows the backfill_chunks convention: DRY-RUN unless --commit is passed.
``--wave`` is a provenance label recorded in chunk metadata (import_wave),
not a selection mechanism; use --max-conversations to bound a first pass.
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import sys
from pathlib import Path

from backend.services.chat_importer.db_lookup import PgURLLookup
from backend.services.chat_importer.extractor import extract_claims_from_conversation
from backend.services.chat_importer.ingester import ingest_verified_claims
from backend.services.chat_importer.parser import iter_export_shards, parse_export_shard
from backend.services.chat_importer.verifier import verify_claims

logger = logging.getLogger("chat_importer")

DEFAULT_EXPORT_DIR = Path("data/chat-imports/raw/2026-04-09-chatgpt-export")


def build_arg_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        prog="python -m backend.services.chat_importer",
        description="Import verified ChatGPT-export claims into the RAG corpus.",
    )
    sub = ap.add_subparsers(dest="command", required=True)

    ing = sub.add_parser("ingest", help="parse -> extract -> verify -> ingest")
    ing.add_argument(
        "--export-dir",
        type=Path,
        default=DEFAULT_EXPORT_DIR,
        help=f"unzipped export directory (default: {DEFAULT_EXPORT_DIR})",
    )
    ing.add_argument(
        "--commit",
        action="store_true",
        help="actually write chunks (default: dry-run, no DB writes)",
    )
    ing.add_argument(
        "--wave",
        type=int,
        default=1,
        help="import-wave label recorded in chunk metadata (default 1)",
    )
    ing.add_argument(
        "--max-conversations",
        type=int,
        default=0,
        help="cap conversations processed (0 = all)",
    )
    ing.add_argument(
        "--enable-l1",
        action="store_true",
        help="allow L1 (HEAD-request) verification fallback (default off)",
    )
    return ap


def run_ingest(args: argparse.Namespace) -> int:
    if not args.export_dir.is_dir():
        print(f"[chat-import] export dir not found: {args.export_dir}", file=sys.stderr)
        print(
            "[chat-import] unzip the ChatGPT export there first (see the "
            "ai-chat-history-migration plan, Phase 0).",
            file=sys.stderr,
        )
        return 2

    mode = "COMMIT (writing chunks)" if args.commit else "DRY-RUN (no writes)"
    print(f"[chat-import] mode={mode}  export={args.export_dir}  wave={args.wave}")

    # Parse + extract
    conversations = 0
    claims = []
    for shard in iter_export_shards(args.export_dir):
        for conv in parse_export_shard(shard):
            conversations += 1
            claims.extend(extract_claims_from_conversation(conv))
            if conversations % 100 == 0:
                print(f"  [parse] {conversations} conversations, {len(claims)} raw claims...")
            if args.max_conversations and conversations >= args.max_conversations:
                break
        if args.max_conversations and conversations >= args.max_conversations:
            break
    print(f"[chat-import] parsed {conversations} conversations -> {len(claims)} raw claims")

    if not claims:
        print("[chat-import] nothing to verify; done.")
        return 0

    # Verify (bulk SQL join; no LLM)
    verified = verify_claims(claims, PgURLLookup(), enable_l1=args.enable_l1)
    by_level: dict[str, int] = {}
    for c in verified:
        by_level[c.verification_level or "?"] = by_level.get(c.verification_level or "?", 0) + 1
    print(
        f"[chat-import] verified {len(verified)}/{len(claims)} claims "
        f"({', '.join(f'{k}={v}' for k, v in sorted(by_level.items())) or 'none'})"
    )

    # Ingest
    if args.commit:
        from backend.services.rag_pipeline import RAGPipeline

        pipeline = RAGPipeline()
    else:
        pipeline = None  # never touched in dry-run

    stats = asyncio.run(
        ingest_verified_claims(
            verified,
            pipeline,
            import_wave=args.wave,
            dry_run=not args.commit,
        )
    )

    print(
        f"[chat-import] {mode} complete: "
        f"claims={stats.claims_seen} ingested={stats.claims_ingested} "
        f"chunks={stats.chunks_written} refused={stats.refused_unverified} "
        f"zero-chunk={stats.zero_chunk_claims} errors={stats.errors}"
    )
    if not args.commit:
        print("[chat-import] re-run with --commit to write.")
    return 1 if stats.errors else 0


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    args = build_arg_parser().parse_args(argv)
    if args.command == "ingest":
        return run_ingest(args)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
