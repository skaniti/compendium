"""Pydantic schemas for ChatGPT export ingestion."""
from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

VerificationLevel = Literal["L3", "L2", "L1"]
TrustTier = Literal["high", "medium", "low"]
MessageRole = Literal["user", "assistant", "system", "tool", "unknown"]


class _Tolerant(BaseModel):
    """Base for raw export models; ignores unknown fields and validates leniently."""

    model_config = ConfigDict(extra="ignore")


class RawAuthor(_Tolerant):
    role: Optional[str] = None


class RawContent(_Tolerant):
    content_type: Optional[str] = None
    parts: list = Field(default_factory=list)


class RawMessageMetadata(_Tolerant):
    model_slug: Optional[str] = None


class RawMessage(_Tolerant):
    id: Optional[str] = None
    author: Optional[RawAuthor] = None
    content: Optional[RawContent] = None
    create_time: Optional[float] = None
    metadata: Optional[RawMessageMetadata] = None


class RawMappingNode(_Tolerant):
    id: Optional[str] = None
    message: Optional[RawMessage] = None
    parent: Optional[str] = None
    children: list[str] = Field(default_factory=list)


class RawConversation(_Tolerant):
    id: Optional[str] = None
    conversation_id: Optional[str] = None
    title: Optional[str] = None
    create_time: Optional[float] = None
    update_time: Optional[float] = None
    mapping: dict[str, RawMappingNode] = Field(default_factory=dict)
    current_node: Optional[str] = None


class NormalizedMessage(BaseModel):
    """One node on the active branch with text already extracted."""

    model_config = ConfigDict(frozen=True)

    message_id: str
    conversation_id: str
    role: MessageRole
    text: str
    model_slug: Optional[str] = None
    create_time: Optional[datetime] = None


class NormalizedConversation(BaseModel):
    """Linearized conversation: root-to-leaf via current_node."""

    model_config = ConfigDict(frozen=True)

    conversation_id: str
    title: str
    create_time: datetime
    messages: list[NormalizedMessage]


class ChatClaim(BaseModel):
    """One paragraph of message prose paired with one cited URL."""

    model_config = ConfigDict(frozen=True)

    conversation_id: str
    chat_title: str
    chat_create_time: datetime
    message_id: str
    message_role: MessageRole
    model_slug: Optional[str] = None

    paragraph_idx: int
    claim_text: str
    citation_url: str

    verification_level: Optional[VerificationLevel] = None
    trust_tier: Optional[TrustTier] = None
    normalized_citation_url: Optional[str] = None
