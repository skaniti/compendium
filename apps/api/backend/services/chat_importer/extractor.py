"""ChatGPT message prose -> per-paragraph ChatClaim list.

Heuristic v1: regex URL extraction inside non-fenced paragraphs only. Fenced
code blocks (```...```) are excluded. Inline-backticked URLs are kept (the
regex stops at backtick anyway). Only `assistant` and `user` messages are
considered: tool/system messages are deferred to a Phase 2.5 enhancement.
"""
from __future__ import annotations

import re
from datetime import datetime
from typing import Iterable

from backend.services.chat_importer.schema import (
    ChatClaim,
    NormalizedConversation,
    NormalizedMessage,
)

_URL_RE = re.compile(r'https?://[^\s<>"`)]+', re.IGNORECASE)
_TRAILING_PUNCT = ".,);:!?>\"'"
_FENCE = "```"
_PARA_SPLIT = re.compile(r"\n\s*\n")
_EXTRACT_ROLES: frozenset[str] = frozenset({"assistant", "user"})


def extract_claims_from_conversation(conv: NormalizedConversation) -> list[ChatClaim]:
    """Walk every message; per-message role filter drops system/tool internally."""
    claims: list[ChatClaim] = []
    for msg in conv.messages:
        claims.extend(extract_claims_from_message(msg, conv.title, conv.create_time))
    return claims


def extract_claims_from_message(
    msg: NormalizedMessage,
    chat_title: str,
    chat_create_time: datetime,
) -> list[ChatClaim]:
    """One claim per (non-code paragraph, deduped URL). Returns [] for non-extractable roles."""
    if msg.role not in _EXTRACT_ROLES:
        return []
    claims: list[ChatClaim] = []
    for para_idx, para in _iter_paragraphs(msg.text):
        for url in _find_urls(para):
            claims.append(
                ChatClaim(
                    conversation_id=msg.conversation_id,
                    chat_title=chat_title,
                    chat_create_time=chat_create_time,
                    message_id=msg.message_id,
                    message_role=msg.role,
                    model_slug=msg.model_slug,
                    paragraph_idx=para_idx,
                    claim_text=para,
                    citation_url=url,
                )
            )
    return claims


def _iter_paragraphs(text: str) -> Iterable[tuple[int, str]]:
    """Yield (idx, paragraph) for non-code paragraphs only.

    Splits on triple-backtick fences first; even-indexed segments are prose,
    odd are code. Within prose, split on blank lines.
    """
    segments = text.split(_FENCE)
    para_idx = 0
    for seg_i, seg in enumerate(segments):
        if seg_i % 2 == 1:
            continue
        for para in _PARA_SPLIT.split(seg):
            stripped = para.strip()
            if stripped:
                yield para_idx, stripped
                para_idx += 1


def _find_urls(text: str) -> list[str]:
    """Deduped URLs in text with trailing punctuation stripped."""
    found: list[str] = []
    seen: set[str] = set()
    for raw in _URL_RE.findall(text):
        url = _strip_trailing(raw)
        if url and url not in seen:
            seen.add(url)
            found.append(url)
    return found


def _strip_trailing(u: str) -> str:
    while u and u[-1] in _TRAILING_PUNCT:
        u = u[:-1]
    return u
