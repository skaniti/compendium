"""ChatGPT export parser: shards -> NormalizedConversation iterator."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator, Optional

from backend.services.chat_importer.schema import (
    MessageRole,
    NormalizedConversation,
    NormalizedMessage,
    RawConversation,
    RawMessage,
)

_VALID_ROLES: tuple[str, ...] = ("user", "assistant", "system", "tool")


def iter_export_shards(export_dir: Path) -> Iterator[Path]:
    """Sorted conversations-NNN.json shards in the export dir."""
    yield from sorted(export_dir.glob("conversations-*.json"))


def parse_export_shard(shard_path: Path) -> Iterator[NormalizedConversation]:
    """One JSON shard -> stream of NormalizedConversation. Skips invalid entries."""
    with shard_path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    for raw in data:
        try:
            conv = RawConversation.model_validate(raw)
        except Exception:
            continue
        normalized = linearize_conversation(conv)
        if normalized is not None:
            yield normalized


def linearize_conversation(raw: RawConversation) -> Optional[NormalizedConversation]:
    """Walk current_node -> parent path; return None if conversation is unusable."""
    conversation_id = raw.conversation_id or raw.id
    if not conversation_id or not raw.current_node or not raw.create_time:
        return None

    raw_messages = _walk_active_branch(raw)
    messages: list[NormalizedMessage] = []
    for raw_msg in raw_messages:
        normalized = _normalize_message(raw_msg, conversation_id)
        if normalized is not None:
            messages.append(normalized)
    if not messages:
        return None

    return NormalizedConversation(
        conversation_id=conversation_id,
        title=(raw.title or "(untitled)").strip()[:500],
        create_time=datetime.fromtimestamp(raw.create_time, tz=timezone.utc),
        messages=messages,
    )


def _walk_active_branch(raw: RawConversation) -> list[RawMessage]:
    """current_node walked back to root via parent pointers; siblings ignored."""
    current = raw.current_node
    seen: set[str] = set()
    path: list[RawMessage] = []
    while current and current in raw.mapping and current not in seen:
        seen.add(current)
        node = raw.mapping[current]
        if node.message and node.message.content:
            path.append(node.message)
        current = node.parent
    return list(reversed(path))


def _normalize_message(raw: RawMessage, conversation_id: str) -> Optional[NormalizedMessage]:
    """Concatenate string parts; drop the message if no text remains."""
    if not raw.id or not raw.content:
        return None

    text = "\n".join(p for p in raw.content.parts if isinstance(p, str)).strip()
    if not text:
        return None

    role: MessageRole
    raw_role = raw.author.role if raw.author and raw.author.role else None
    role = raw_role if raw_role in _VALID_ROLES else "unknown"  # type: ignore[assignment]

    create_time = (
        datetime.fromtimestamp(raw.create_time, tz=timezone.utc)
        if raw.create_time else None
    )

    return NormalizedMessage(
        message_id=raw.id,
        conversation_id=conversation_id,
        role=role,
        text=text,
        model_slug=raw.metadata.model_slug if raw.metadata else None,
        create_time=create_time,
    )
