"""Capture input/output schemas."""

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator
from pydantic.alias_generators import to_camel


class PageVisit(BaseModel):
    """A single page visit in a browsing capture."""

    model_config = ConfigDict(populate_by_name=True, alias_generator=to_camel)

    url: str = Field(..., description="URL of the visited page")
    timestamp: datetime = Field(..., description="When the page was visited")
    dwell_time_seconds: Optional[int] = Field(None, description="Time spent on page in seconds")
    title: Optional[str] = Field(None, max_length=500, description="Page title")
    is_tracked_domain: bool = Field(
        True,
        description="Whether this is a tracked domain (Wikipedia, YouTube, Reddit)",
    )
    transition_type: Optional[str] = Field(
        None,
        description="How the user navigated here (from Chrome webNavigation API): "
        "typed, link, auto_bookmark, form_submit, reload, etc.",
    )
    transition_qualifiers: Optional[list[str]] = Field(
        None,
        description="Navigation qualifiers: client_redirect, server_redirect, forward_back",
    )
    extracted_text: Optional[str] = Field(
        None,
        max_length=100_000,
        description="Client-side extracted page text via Readability.js",
    )


class CaptureInput(BaseModel):
    """Input schema for a browsing capture from the extension."""

    model_config = ConfigDict(populate_by_name=True, alias_generator=to_camel, extra="ignore")

    capture_id: str = Field(..., max_length=100, description="Unique capture identifier")
    pages: list[PageVisit] = Field(..., description="List of visited pages")
    events: list[dict] = Field(
        default_factory=list,
        description="Non-navigation events (window focus, tab lifecycle, bookmarks)",
    )
    started_at: datetime = Field(..., description="Capture start time")
    ended_at: datetime = Field(..., description="Capture end time")
    device_label: Optional[str] = Field(
        None, max_length=100, description="User-set device label (provenance)"
    )
    client_meta: Optional[dict] = Field(
        None, description="Client-reported provenance (ua, app, ...)"
    )

    @field_validator("pages")
    @classmethod
    def cap_page_count(cls, v: list[PageVisit]) -> list[PageVisit]:
        if len(v) > 200:
            raise ValueError(f"Too many pages ({len(v)}); maximum is 200")
        return v

    @property
    def duration_minutes(self) -> float:
        """Calculate capture duration in minutes."""
        delta = self.ended_at - self.started_at
        return delta.total_seconds() / 60

    @property
    def tracked_pages(self) -> list[PageVisit]:
        """Get only pages from tracked domains."""
        return [p for p in self.pages if p.is_tracked_domain]


class PassiveCaptureInput(BaseModel):
    """Input from the passive extension / mobile app.

    Uses camelCase aliases to match the extension's JSON format directly.
    More permissive than CaptureInput — pages are raw dicts, timestamps are strings.

    Capture payload shape is a three-way twin: this model, the export payload
    built in apps/extension/modules/export.js, and SessionData in
    apps/android/app/src/main/java/dev/skaniti/compendium/model/SessionData.kt.
    """

    model_config = ConfigDict(populate_by_name=True, alias_generator=to_camel, extra="ignore")

    capture_id: str = Field(..., alias="captureId")
    started_at: str = Field(..., alias="startedAt")
    ended_at: str = Field(..., alias="endedAt")
    pages: list[dict] = Field(default_factory=list)
    events: list[dict] = Field(default_factory=list)
    trivial: bool = False
    device_label: Optional[str] = Field(None, alias="deviceLabel", max_length=100)
    client_meta: Optional[dict] = Field(None, alias="clientMeta")


class TopicCluster(BaseModel):
    """A group of related pages."""

    name: str = Field(..., description="Cluster name (2-4 words)")
    pages: list[str] = Field(..., description="Page URLs or titles in this cluster")
    theme: str = Field(..., description="Description of the common theme")


# =============================================================================
# Capture processing response models (Milestone 5 smoke test)
# =============================================================================


class PageProcessingResult(BaseModel):
    """Result of processing a single page through the tool-calling pipeline."""

    model_config = ConfigDict(populate_by_name=True, alias_generator=to_camel)

    url: str
    title: Optional[str] = None
    domain: Optional[str] = None
    tool_selected: Optional[str] = None
    tool_arguments: Optional[dict] = None
    status: Literal["success", "error", "catchall", "skipped"]
    content_summary: Optional[str] = None
    error_message: Optional[str] = None
    latency_ms: Optional[float] = None
    input_tokens: Optional[int] = None
    output_tokens: Optional[int] = None
    cost_usd: Optional[float] = None
    # Stage 1: Page processing depth (D+C tool call result)
    processing_depth: Optional[Literal["skipped", "surface", "full", "processed"]] = None
    processing_depth_reasoning: Optional[str] = None
    # Learning classification (Plan 07)
    is_learning: Optional[bool] = None
    # Stage 4: Content generation
    summary: Optional[str] = None
    images: Optional[list[dict]] = None
    # Filled in by _persist_single_page so downstream async steps
    # (asset archival) can find the row they just created.
    page_content_id: Optional[int] = None


class CaptureReceivedResponse(BaseModel):
    """Lightweight acknowledgment returned immediately after raw dump."""

    model_config = ConfigDict(populate_by_name=True, alias_generator=to_camel)

    status: str = "received"
    capture_id: str
    page_count: int
    raw_dump_path: Optional[str] = None
    journey_url: Optional[str] = None


class CaptureProcessingResponse(BaseModel):
    """Aggregate response after processing all pages in a capture."""

    model_config = ConfigDict(populate_by_name=True, alias_generator=to_camel)

    status: str = "processed"
    capture_id: str
    page_count: int
    pages_succeeded: int = 0
    pages_failed: int = 0
    pages_catchall: int = 0
    pages_skipped: int = 0
    results: list[PageProcessingResult] = []
    clusters: list[TopicCluster] = []
    capture_title: Optional[str] = None
    mini_summary: Optional[str] = None
    fetched_contents: dict[str, dict] = Field(
        default_factory=dict,
        description="Full fetched content keyed by URL, persisted for RAG/search",
    )
    raw_html_artifacts: dict[str, dict] = Field(
        default_factory=dict,
        description=(
            "Gzipped raw HTML keyed by URL. Each value has "
            "{'gzipped': bytes, 'content_type': str}. Persisted into "
            "page_content.raw_html for iframe preview archival."
        ),
    )
    schema_version: int = 4
    total_processing_time_ms: Optional[float] = None
    total_llm_cost_usd: Optional[float] = None
    model_used: Optional[str] = None
    journey_url: Optional[str] = None
