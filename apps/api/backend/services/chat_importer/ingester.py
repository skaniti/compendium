"""Verified chat claims -> RAG chunks via the existing RAGPipeline.

Implements the plan's Option C (hybrid) URL scheme: each chunk's source URL is
the *citation URL* (the primary source the claim corroborates), so chat prose
reinforces the cited page in retrieval; the synthetic chat URL rides in
metadata as ``discovered_via`` for provenance/audit.

DB writes happen HERE and nowhere earlier in the import pipeline (plan Phase 4
gate); unverified claims are refused outright as defense against a caller
skipping the verification cascade.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field

from backend.services.chat_importer.schema import ChatClaim

logger = logging.getLogger(__name__)

SOURCE_TYPE = "chatgpt"


@dataclass
class IngestStats:
    """Outcome counters for one ingest pass."""

    claims_seen: int = 0
    claims_ingested: int = 0
    chunks_written: int = 0
    refused_unverified: int = 0
    zero_chunk_claims: int = 0
    errors: int = 0
    error_urls: list[str] = field(default_factory=list)


def synthetic_chat_url(claim: ChatClaim) -> str:
    """Provenance URL for a chat-derived claim (never used as source_url)."""
    return (
        f"chatgpt://conversation/{claim.conversation_id}"
        f"#msg={claim.message_id}&para={claim.paragraph_idx}"
    )


def claim_metadata(claim: ChatClaim, *, import_wave: int) -> dict:
    """Chunk metadata JSONB for a verified claim (plan's provenance table)."""
    return {
        "source_type": SOURCE_TYPE,
        "chat_id": claim.conversation_id,
        "chat_title": claim.chat_title,
        "chat_create_time": claim.chat_create_time.isoformat(),
        "message_id": claim.message_id,
        "message_role": claim.message_role,
        "model_slug": claim.model_slug,
        "citation_url": claim.citation_url,
        "verification_level": claim.verification_level,
        "trust_tier": claim.trust_tier,
        "paragraph_idx": claim.paragraph_idx,
        "discovered_via": synthetic_chat_url(claim),
        "import_wave": import_wave,
    }


def claim_content_dict(claim: ChatClaim) -> dict:
    """Shape the claim as a fetcher-style content dict for the chunkers.

    ``full_text`` is first in the generic chunkers' key chain, so a paragraph
    claim typically produces exactly one chunk.
    """
    return {
        "title": claim.chat_title,
        "full_text": claim.claim_text,
    }


async def ingest_verified_claims(
    claims: list[ChatClaim],
    rag_pipeline,
    *,
    import_wave: int = 1,
    dry_run: bool = True,
) -> IngestStats:
    """Write verified claims into the pgvector corpus. Dry-run by default.

    Each claim becomes ``rag_pipeline.add_document(citation_url, content,
    metadata)``. Failures are per-claim (one bad claim cannot kill the wave);
    refusals (missing verification_level/trust_tier) are counted, never
    silently dropped.
    """
    stats = IngestStats()
    for claim in claims:
        stats.claims_seen += 1

        if claim.verification_level is None or claim.trust_tier is None:
            stats.refused_unverified += 1
            logger.warning(
                "refusing unverified claim (conv=%s msg=%s) -- run verify_claims first",
                claim.conversation_id,
                claim.message_id,
            )
            continue

        if dry_run:
            stats.claims_ingested += 1
            continue

        try:
            chunk_ids = await rag_pipeline.add_document(
                claim.citation_url,
                claim_content_dict(claim),
                metadata=claim_metadata(claim, import_wave=import_wave),
            )
        except Exception:
            stats.errors += 1
            stats.error_urls.append(claim.citation_url)
            logger.exception(
                "ingest failed for claim (conv=%s url=%s)",
                claim.conversation_id,
                claim.citation_url,
            )
            continue

        stats.claims_ingested += 1
        if chunk_ids:
            stats.chunks_written += len(chunk_ids)
        else:
            stats.zero_chunk_claims += 1

    return stats
