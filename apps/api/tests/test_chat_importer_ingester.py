"""Ingester + CLI arg-surface tests for the chat importer (plan Phase 4)."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from pathlib import Path

from backend.services.chat_importer.cli import build_arg_parser, run_ingest
from backend.services.chat_importer.ingester import (
    claim_content_dict,
    claim_metadata,
    ingest_verified_claims,
    synthetic_chat_url,
)
from backend.services.chat_importer.schema import ChatClaim


def _claim(verified: bool = True, url: str = "https://example.com/doc") -> ChatClaim:
    base = dict(
        conversation_id="conv-1",
        chat_title="Icon library research",
        chat_create_time=datetime(2026, 4, 9, tzinfo=timezone.utc),
        message_id="msg-9",
        message_role="assistant",
        model_slug="gpt-4o",
        paragraph_idx=2,
        claim_text="Iconify aggregates 100+ icon sets under one API.",
        citation_url=url,
    )
    if verified:
        base.update(
            verification_level="L3",
            trust_tier="high",
            normalized_citation_url=url,
        )
    return ChatClaim(**base)


class FakePipeline:
    def __init__(self, chunk_ids=("c1",), raise_for=frozenset()):
        self.calls = []
        self.chunk_ids = list(chunk_ids)
        self.raise_for = raise_for

    async def add_document(self, url, content_dict, metadata=None):
        if url in self.raise_for:
            raise RuntimeError("boom")
        self.calls.append((url, content_dict, metadata))
        return self.chunk_ids


# ── metadata / URL shaping ───────────────────────────────────────────────


def test_synthetic_url_carries_full_provenance_path():
    assert synthetic_chat_url(_claim()) == "chatgpt://conversation/conv-1#msg=msg-9&para=2"


def test_metadata_matches_plan_provenance_table():
    md = claim_metadata(_claim(), import_wave=1)
    assert md["source_type"] == "chatgpt"
    assert md["trust_tier"] == "high"
    assert md["verification_level"] == "L3"
    assert md["citation_url"] == "https://example.com/doc"
    assert md["discovered_via"].startswith("chatgpt://conversation/")
    assert md["import_wave"] == 1


def test_content_dict_uses_full_text_key():
    cd = claim_content_dict(_claim())
    assert cd["full_text"].startswith("Iconify aggregates")
    assert cd["title"] == "Icon library research"


# ── ingest_verified_claims ───────────────────────────────────────────────


def test_commit_writes_via_citation_url():
    pipe = FakePipeline()
    stats = asyncio.run(ingest_verified_claims([_claim()], pipe, dry_run=False))
    assert stats.claims_ingested == 1
    assert stats.chunks_written == 1
    (url, content, metadata) = pipe.calls[0]
    assert url == "https://example.com/doc"  # option C: citation URL is source
    assert metadata["discovered_via"] == synthetic_chat_url(_claim())


def test_unverified_claims_are_refused_not_written():
    pipe = FakePipeline()
    stats = asyncio.run(
        ingest_verified_claims([_claim(verified=False)], pipe, dry_run=False)
    )
    assert stats.refused_unverified == 1
    assert stats.claims_ingested == 0
    assert pipe.calls == []


def test_dry_run_never_touches_pipeline():
    stats = asyncio.run(ingest_verified_claims([_claim()], None, dry_run=True))
    assert stats.claims_ingested == 1
    assert stats.chunks_written == 0


def test_one_failure_does_not_kill_the_wave():
    good = _claim()
    bad = _claim(url="https://example.com/bad")
    pipe = FakePipeline(raise_for=frozenset({"https://example.com/bad"}))
    stats = asyncio.run(ingest_verified_claims([bad, good], pipe, dry_run=False))
    assert stats.errors == 1
    assert stats.error_urls == ["https://example.com/bad"]
    assert stats.claims_ingested == 1  # the good one still landed


def test_zero_chunk_claims_are_counted():
    pipe = FakePipeline(chunk_ids=())
    stats = asyncio.run(ingest_verified_claims([_claim()], pipe, dry_run=False))
    assert stats.claims_ingested == 1
    assert stats.zero_chunk_claims == 1


# ── CLI surface ──────────────────────────────────────────────────────────


def test_cli_defaults_to_dry_run_wave_1():
    args = build_arg_parser().parse_args(["ingest"])
    assert args.commit is False
    assert args.wave == 1
    assert args.enable_l1 is False


def test_cli_missing_export_dir_exits_2(tmp_path: Path):
    args = build_arg_parser().parse_args(
        ["ingest", "--export-dir", str(tmp_path / "nope")]
    )
    assert run_ingest(args) == 2
