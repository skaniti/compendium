"""Pydantic models for recategorization (human overrides) and tagging."""

from typing import Literal, Optional

from pydantic import BaseModel


# ── Override requests ───────────────────────────────────────────────────


class PageOverrideRequest(BaseModel):
    """Override the LLM's status and/or processing depth for a page."""

    human_status: Optional[Literal["active", "archived"]] = None
    human_processing_depth: Optional[Literal["processed", "skipped"]] = None
    note: Optional[str] = None


class PageFlagRequest(BaseModel):
    """Toggle the review queue flag on a page."""

    flagged: bool


class CaptureOverrideRequest(BaseModel):
    """Override the trivial flag on a capture."""

    human_is_trivial: Optional[bool] = None
    note: Optional[str] = None


class BatchOverrideRequest(BaseModel):
    """Override status for all pages matching a domain."""

    domain: str
    human_status: Literal["active", "archived"]
    note: Optional[str] = None


# ── Tag requests ────────────────────────────────────────────────────────


class TagCreateRequest(BaseModel):
    name: str
    color: str = "#808080"
    group_name: Optional[str] = None
    description: Optional[str] = None


class TagUpdateRequest(BaseModel):
    name: Optional[str] = None
    color: Optional[str] = None
    group_name: Optional[str] = None
    description: Optional[str] = None


class EntityTagRequest(BaseModel):
    entity_type: Literal["page", "capture"]
    entity_id: int
