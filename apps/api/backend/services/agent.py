"""Compendium search agent (ReAct).

Milestone 10 deliverable: CompendiumAgent — a ReAct (Reason + Act) agent
that answers natural language questions about the user's browsing compendium
using tool calling to search embeddings, inspect clusters, and read pages.
"""

import asyncio
import difflib
import json
import logging
import re
import time
from collections.abc import AsyncGenerator
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field

from backend.config.settings import settings
from backend.prompts.templates import PROMPTS, get_prompt
from backend.services.agent_trace_recorder import AgentTrace, flush_trace_to_db
from backend.services.graph_builder import _slugify

logger = logging.getLogger(__name__)

try:
    from langsmith import traceable as _traceable
except ImportError:

    def _traceable(*args, **kwargs):
        def _decorator(fn):
            return fn

        return _decorator if kwargs or not args else args[0]


def traceable(name: str):
    """Env-gated LangSmith tracing — no-op when tracing disabled."""
    if not (settings.langchain_tracing_v2 and settings.langchain_api_key):

        def _passthrough(fn):
            return fn

        return _passthrough
    return _traceable(name=name, run_type="chain")


AGENT_MODEL = "gpt-4o-mini"
MAX_ITERATIONS = 5
MAX_TOOL_RESULT_CHARS = 2000
# Chars of each tool result kept in the per-turn trace (tool_calls_made ->
# the chat's collapsible Trace block). Cut results end with an ellipsis so
# the UI can tell a truncated preview from a short result.
TOOL_RESULT_PREVIEW_CHARS = 600
AGENT_QUERY_EVENT_TYPE = "agent_query"

# P4 conversation-history caps (defense in depth). Applied in
# _prepare_history_messages rather than at the route layer so both
# /api/agent/query and .../query-stream get identical enforcement
# regardless of caller.
MAX_HISTORY_TURNS = 60
MAX_HISTORY_TURN_CHARS = 2000
MAX_HISTORY_TOTAL_CHARS = 8000


# Narrated-intent guard (Task 7d, 2026-09-26; narrowed in fix round 1): a
# chat pass on the demo corpus found the model writing "let me check that
# for you..." with NO tool call as its final turn -- since query()/
# query_stream() treat a no-tool-call assistant message as done, the hedge
# shipped as the answer. _narrates_intent() flags that shape of message so
# the ReAct loop (_react_loop for query(); the inline loop in
# query_stream()) can force one extra planning round instead of streaming
# the hedge. Phrases live in one tuple so tests can enumerate them; each is
# a literal (non-alternating) fragment so a test can embed it directly into
# a sentence. "i can only search" was deliberately dropped (fix round 1,
# review-7d.md Q5/controller ruling): it also matches the in-character
# out-of-scope reply v2/v3's own prompt recommends ("I can only search your
# compendium for that topic"), which would force a wasted planning call on
# an off-topic question -- the 2026-09-26 incident phrasing is still caught
# by "let me check" / "one moment" etc. Straight AND curly ("'"/"'") "I'll"
# apostrophes are both listed (fix round 1, review-7d.md Q4) since a model
# can emit either.
NARRATED_INTENT_PHRASES: tuple[str, ...] = (
    "let me search",
    "let me check",
    "let me look",
    "let me see",
    "one moment",
    "i'll search",
    "i’ll search",
    "i will search",
    "i'll check",
    "i’ll check",
    "i will check",
    "i'll look",
    "i’ll look",
    "i will look",
    "searching your compendium",
    "searching the compendium",
)
# Word-bounded (fix round 1, review-7d.md Q4) so a phrase must appear as
# whole words, not as a substring spanning unrelated words -- e.g. "one
# moment" must not match inside "someone momentous". `\b` wraps the WHOLE
# alternation (not each phrase individually -- `|` has lower precedence
# than a bare `\b`, so it must be inside one non-capturing group).
_NARRATED_INTENT_RE = re.compile(
    r"\b(?:" + "|".join(NARRATED_INTENT_PHRASES) + r")\b", re.IGNORECASE
)

# A markdown citation link ([Title](url)) -- a message that already carries
# one is a grounded answer, not a narrated hedge, even if it happens to
# contain a phrase like "I'll check" in passing.
_CITATION_MARKER_RE = re.compile(r"\[[^\]\n]+\]\([^)\s]+\)")

# Exact nudge text appended (system role, this turn only) when the guard
# fires -- kept as one module constant so query() and query_stream() can
# never drift to different wording for the same event.
NARRATED_INTENT_NUDGE = (
    "You described a search instead of performing one. Call "
    "search_compendium now with the user's question."
)


def _result_preview(result: str) -> str:
    """Trace preview of a tool result: the first TOOL_RESULT_PREVIEW_CHARS
    chars, plus an ellipsis when that cut anything."""
    if len(result) <= TOOL_RESULT_PREVIEW_CHARS:
        return result
    return result[:TOOL_RESULT_PREVIEW_CHARS] + "..."


def _narrates_intent(content: Optional[str]) -> bool:
    """True if `content` announces a search/check instead of performing
    one (see NARRATED_INTENT_PHRASES) -- UNLESS it already carries a
    markdown citation marker, in which case it's a grounded answer, not a
    hedge, regardless of incidental phrasing."""
    if not content:
        return False
    if _CITATION_MARKER_RE.search(content):
        return False
    return bool(_NARRATED_INTENT_RE.search(content))


# Ungrounded-answer guard: a first reply that is long, uncited prose with no
# tool call is a training-data answer to a corpus question. Same one-shot
# forced-search mechanism (and shared fired-flag) as the narrated-intent guard.
UNGROUNDED_ANSWER_MIN_CHARS = 400
UNGROUNDED_ANSWER_NUDGE = (
    "You answered without consulting the compendium. Every claim about the "
    "user's captured pages must come from a tool result: call "
    "search_compendium now with the user's question."
)


def _ungrounded_answer(content: Optional[str]) -> bool:
    """True if `content` has no citation marker and is at least
    UNGROUNDED_ANSWER_MIN_CHARS long (after strip). The v2/v3 prompts make
    greeting and out-of-scope replies one or two sentences, while a
    training-data answer to a corpus question is long prose; the length
    floor separates them without a second LLM call."""
    if not content:
        return False
    if _CITATION_MARKER_RE.search(content):
        return False
    return len(content.strip()) >= UNGROUNDED_ANSWER_MIN_CHARS


# Regex for the M8 multimodal image markers embedded in chunk text by
# fetch_wikipedia_content. Format: "[image: <thumb_url> | source: <full_url>]".
# Markers are stripped from chunk text before showing it to the LLM (so the
# model doesn't quote raw URLs in answers); URLs are surfaced separately on
# the SSE complete event so the frontend can render a thumbnail strip.
_IMAGE_MARKER_RE = re.compile(
    r"\[image:\s*(\S+?)\s*\|\s*source:\s*(\S+?)\s*\]",
    re.IGNORECASE,
)


def _extract_image_markers(text: str) -> tuple[str, list[dict]]:
    """Pull image markers out of chunk text.

    Returns ``(cleaned_text, list_of_image_dicts)``. Each dict has keys
    ``thumb_url`` and ``source_url`` -- the same pair that
    ``content_fetcher.fetch_wikipedia_content`` emits for each non-refusal
    image description.
    """
    if not text:
        return "", []
    images: list[dict] = []
    for match in _IMAGE_MARKER_RE.finditer(text):
        images.append(
            {"thumb_url": match.group(1), "source_url": match.group(2)}
        )
    cleaned = _IMAGE_MARKER_RE.sub("", text)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).strip()
    return cleaned, images


# Taxonomy-name fuzzy matching (search cascade stage 2 + get_cluster_info,
# both P1). Shared here so the two call sites rank candidate labels
# identically -- a query should never taxonomy-match in one tool and miss
# in the other because of a matching-rule drift between two copies.
_WORD_RE = re.compile(r"[a-z0-9]+")


def _tokenize(text: str) -> list[str]:
    """Lowercase word tokens for the taxonomy fuzzy-match helpers below."""
    return _WORD_RE.findall(text.lower())


def _label_match_tier(label: str, query_norm: str, query_tokens: list[str]) -> Optional[int]:
    """Best-match tier for a fuzzy taxonomy-label lookup.

    0 = exact match. 1 = prefix (one string starts with the other) or an
    exact single-token match. 2 = substring (either direction). 3 =
    typo-tolerant close match (``difflib``, cutoff 0.8, e.g. "astonomy" ->
    "astronomy"). ``None`` = no match at any tier. Lower is better; callers
    take the minimum tier across all candidate labels.

    Checked against both the full normalized query AND its individual word
    tokens (>=3 chars), so a multi-word query like "tell me about astronomy"
    still substring-matches a label "astronomy" even though the full query
    string isn't a substring of it.

    Prefix/substring/close-match tiers additionally require the label be
    >=3 chars (mirroring the token-length guard below), so a short label
    like "AI" can't substring-match into an unrelated query (e.g. "mail
    merge tutorials" via "ai" ⊂ "mail"). Exact matches are exempt --
    a query of "ai" must still match a label "AI".
    """
    if not label:
        return None
    label_norm = label.lower().strip()
    if not label_norm or not query_norm:
        return None
    if label_norm == query_norm:
        return 0
    label_long_enough = len(label_norm) >= 3
    if label_long_enough:
        if len(query_norm) >= 3:
            if label_norm.startswith(query_norm) or query_norm.startswith(label_norm):
                return 1
            if label_norm in query_norm or query_norm in label_norm:
                return 2
            if difflib.get_close_matches(query_norm, [label_norm], n=1, cutoff=0.8):
                return 3
        # Short (<3 char) queries get the same treatment as short labels:
        # bare containment is spurious ("ai" prefixes "air fryer recipes").
        # Only a word-boundary prefix counts ("ai" -> "ai tools").
        elif label_norm.startswith(query_norm) and not label_norm[len(query_norm)].isalnum():
            return 1
    for tok in query_tokens:
        if len(tok) < 3:
            continue
        if tok == label_norm:
            return 1
        if label_long_enough:
            if tok in label_norm or label_norm in tok:
                return 2
            if difflib.get_close_matches(tok, [label_norm], n=1, cutoff=0.8):
                return 3
    return None


def _persist_agent_cost_event(
    user_id: int,
    state: "AgentState",
    query_preview: str,
    total_latency_ms: float,
) -> None:
    """Record one summary cost_events row per agent query.

    Powers the Evidence L5 (tool-mix) and L9 (iteration-histogram) viz by
    emitting `event_type='agent_query'` with metadata carrying `iterations`
    and `tools_used`. Errors are swallowed with a warning so a DB write
    failure never breaks an in-flight agent response to the user.
    """
    try:
        from backend.db.trends_repo import insert_cost_event

        tools_used = [log.get("tool", "") for log in state.tool_calls_log if log.get("tool")]
        insert_cost_event(
            user_id=user_id,
            event_type=AGENT_QUERY_EVENT_TYPE,
            model=AGENT_MODEL,
            input_tokens=state.total_input_tokens,
            output_tokens=state.total_output_tokens,
            cost_usd=state.total_cost_usd,
            latency_ms=total_latency_ms,
            metadata={
                "source": "agent",
                "iterations": state.iterations,
                "tools_used": tools_used,
                "query_preview": query_preview[:120],
            },
        )
    except Exception as e:
        logger.warning("Failed to persist agent cost_event: %s", e)


_MD_LINK_URL_RE = re.compile(
    r"\[[^\]]*\]\(\s*<?(https?://(?:[^\s()<>]|\([^\s()<>]*\))+)>?[^)]*\)"
)
_BARE_URL_RE = re.compile(r"https?://(?:[^\s<>()\[\]\"'*]|\([^\s()]*\))+")


def _urls_in_text(text: str) -> list[str]:
    """URLs in ``text`` (markdown links and bare), first-appearance order, deduped."""
    found: list[tuple[int, str]] = []
    for m in _MD_LINK_URL_RE.finditer(text):
        found.append((m.start(1), m.group(1)))
    for m in _BARE_URL_RE.finditer(text):
        found.append((m.start(), m.group(0).rstrip(".,;:!?*_")))
    found.sort(key=lambda t: t[0])
    out: list[str] = []
    for _, u in found:
        if u not in out:
            out.append(u)
    return out


def _sources_for_answer(state: "AgentState", answer_text: str | None) -> list[str]:
    """Sources to report for a finished answer, in a stable order.

    The URLs the answer text cites (markdown link or bare URL, first-appearance
    order, deduped) that a tool actually retrieved. If the answer cites none of
    them, fall back to every retrieved URL in tool order (deduped).
    """
    retrieved: list[str] = []
    for u in state.sources_cited:
        if u not in retrieved:
            retrieved.append(u)
    cited = [u for u in _urls_in_text(answer_text or "") if u in retrieved]
    return cited or retrieved


def _build_sources_detail(state: "AgentState", urls: list[str] | None = None) -> list[dict]:
    """De-duped, first-seen-order {"url", "page_id", "node_id"} list from
    AgentState (or, when ``urls`` is given, exactly those URLs in that order).

    Shared by AgentResponse (non-streaming) and the SSE complete event
    (streaming) so both surfaces expose the same page_id/node_id-carrying
    source shape (P9-backend; node_id added by the P7 locate-glyph fix --
    see CompendiumAgent._cite_source).
    """
    seen: list[str] = []
    for u in state.sources_cited if urls is None else urls:
        if u not in seen:
            seen.append(u)
    return [
        {
            "url": u,
            "page_id": state.source_page_ids.get(u),
            "node_id": state.source_node_ids.get(u),
        }
        for u in seen
    ]


# =============================================================================
# Agent models
# =============================================================================


class HistoryTurn(BaseModel):
    """One prior turn of a multi-turn chat (P4), threaded into the ReAct
    loop's message list ahead of the current query so follow-ups like
    "tell me more about that" resolve against what was already discussed.

    Role is constrained to user/assistant (no system/tool turns from
    caller-supplied history) -- an invalid role fails FastAPI body
    validation (422) before agent logic ever sees it. Caps (turn count,
    per-turn length, total length) and injection sanitization are applied
    server-side in ``_prepare_history_messages``, not here -- this model
    is just the wire contract.
    """

    role: Literal["user", "assistant"]
    content: str = Field(min_length=1)


class AgentMessage(BaseModel):
    """A single message in the agent conversation."""

    role: Literal["system", "user", "assistant", "tool"]
    content: Optional[str] = None
    tool_call_id: Optional[str] = None
    tool_calls: Optional[list[dict]] = None


class AgentState(BaseModel):
    """State maintained across the ReAct loop."""

    messages: list[AgentMessage] = []
    tool_calls_log: list[dict] = []
    sources_cited: list[str] = []
    clusters_cited: list[str] = []
    # url -> page_id for every entry in sources_cited that a tool could
    # resolve to a concrete page row (P9-backend: lets the complete-event
    # sources payload carry page_id per source for a future jump-to-node
    # UI, without changing the existing `sources` list-of-URLs shape that
    # frontend/dash/assets/search_stream.js already renders as link pills).
    # Populated via CompendiumAgent._cite_source, the single choke point
    # every tool implementation citation goes through.
    source_page_ids: dict[str, int] = {}
    # url -> graph node id for every entry in sources_cited whose citing
    # tool had a page TITLE to slugify (P7 locate-glyph fix). node_id
    # reproduces graph_builder._slugify(title) -- the exact function
    # build_graph_from_db uses to derive GraphNode.id -- so the frontend
    # can join sources_detail against window.__d3GetClusterPages() output
    # (graph node ids are slugified page titles, NOT numeric page_ids).
    # Populated via the same CompendiumAgent._cite_source choke point as
    # source_page_ids; absent url -> no title was available, node_id
    # renders null (frontend degrades to a disabled locate glyph).
    source_node_ids: dict[str, str] = {}
    # Image markers parsed out of retrieved chunks via the M8 multimodal
    # augment. Each dict: {"thumb_url", "source_url"}. Surfaced to the
    # frontend on the SSE complete event so the chat strip can render
    # thumbnails alongside the answer.
    images_cited: list[dict] = []
    total_cost_usd: float = 0.0
    # Token accumulators across the ReAct loop; persisted on query completion
    # so the Evidence L5/L9 mix-bars can read distribution signals from cost_events.
    total_input_tokens: int = 0
    total_output_tokens: int = 0
    iterations: int = 0
    max_iterations: int = MAX_ITERATIONS
    # Per-chat trace recorder (see backend/services/agent_trace_recorder.py).
    # Threaded through state so _execute_tool / _tool_search_compendium can
    # add spans without parameter-list churn. Optional so non-streaming /
    # legacy paths work unmodified.
    trace: Any = None


class AgentResponse(BaseModel):
    """Final response returned to the caller."""

    answer: str
    sources: list[str]
    # Additive, non-breaking companion to `sources`: {"url", "page_id",
    # "node_id"} per source. page_id null when a tool couldn't resolve
    # one; node_id null when the citing tool had no page title to slugify.
    # `sources` itself stays a flat URL list -- frontend/dash/assets/
    # search_stream.js renders it directly as link pills. P9-backend:
    # page_id is substrate for a future jump-to-node graph UI; node_id
    # (P7 fix) is what the existing locate-glyph feature actually joins
    # against, since graph node ids are slugified page titles, not
    # page_ids -- see CompendiumAgent._cite_source.
    sources_detail: list[dict] = []
    # M8 multimodal images parsed from retrieved chunks (Wikipedia
    # vision-augment markers). Each dict: {"thumb_url", "source_url"}.
    # Empty when no image-augmented chunks were retrieved.
    images: list[dict] = []
    tool_calls_made: list[dict]
    total_cost_usd: float
    iterations: int
    model: str


# =============================================================================
# Tool definitions (OpenAI function-calling schema)
# =============================================================================

AGENT_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "search_compendium",
            "description": (
                "Search the knowledge compendium by semantic similarity. "
                "Returns the most relevant pages matching the query. On a miss, "
                "internally falls back through a taxonomy-name match, a "
                "low-confidence candidate list, and (if include_archived was "
                "false) a widened archive-inclusive retry before reporting a "
                "diagnosed absence -- see the result markers documented in the "
                "system prompt."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Natural language search query",
                    },
                    "top_k": {
                        "type": "integer",
                        "description": "Number of results to return (default 5)",
                        "default": 5,
                    },
                    "include_archived": {
                        "type": "boolean",
                        "description": (
                            "Also search archived/excluded pages (business "
                            "lookups, navigation/search pages, deduped or "
                            "manually-removed pages) that are omitted by "
                            "default. Results from archived pages are marked "
                            "[archived]. Default false."
                        ),
                        "default": False,
                    },
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_cluster_info",
            "description": (
                "Get information about a specific topic cluster "
                "including its name and member pages."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "cluster_name": {
                        "type": "string",
                        "description": "Name or slug of the cluster to look up",
                    },
                },
                "required": ["cluster_name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_page_detail",
            "description": (
                "Get full details about a specific page including its "
                "content summary, URL, and metadata."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "page_id": {
                        "type": "integer",
                        "description": "Database ID of the page",
                    },
                },
                "required": ["page_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_clusters",
            "description": (
                "List all topic clusters in the compendium with their " "names and page counts."
            ),
            "parameters": {
                "type": "object",
                "properties": {},
            },
        },
    },
]

# Resolved from the versioned prompt registry (backend/prompts/templates.py,
# name "agent_system_{version}") rather than hardcoded here, so the Models
# dev view can hot-reload it via overrides.json without a restart. The
# version comes from settings (env var AGENT_SYSTEM_PROMPT_VERSION), which
# is the no-deploy rollback path from the self-aware v2 framing back to v1.
# This module-level binding exists for backwards-compat importers
# (frontend/dash/layouts/graph_canvas.py's agent-internals debug panel;
# tests) that expect `from backend.services.agent import SYSTEM_PROMPT` to
# work -- it reflects the value at process start. The live ReAct loop
# (query / query_stream) re-resolves via _system_prompt_name() +
# get_prompt() on every call instead of reading this constant, so
# overrides.json edits take effect on the NEXT query without a restart,
# matching every other registry-backed prompt's hot-reload behavior.
def _system_prompt_name() -> str:
    """Registry key for the agent system prompt, per settings.

    Falls back to the shipped default version if the configured one is not
    a registered template -- a typo'd env var must degrade to a working
    agent, not a KeyError on every query.
    """
    name = f"agent_system_{settings.agent_system_prompt_version}"
    if name not in PROMPTS:
        logger.warning(
            "Unknown agent_system_prompt_version %r; falling back to v2",
            settings.agent_system_prompt_version,
        )
        return "agent_system_v2"
    return name


try:
    SYSTEM_PROMPT = get_prompt(_system_prompt_name())
except Exception:
    # A bad overrides.json entry (e.g. a stray literal { or }) must not
    # crash app boot -- graph_canvas.py imports this module at Dash startup.
    SYSTEM_PROMPT = PROMPTS[_system_prompt_name()]["template"]


def _prepare_history_messages(history: Optional[list[HistoryTurn]]) -> list["AgentMessage"]:
    """P4: cap + sanitize prior chat turns into ReAct-loop messages.

    Defense in depth against an unbounded or hostile history payload
    (last MAX_HISTORY_TURNS turns -- a safety net; the per-turn and total
    char caps below are the real limit -- each truncated to MAX_HISTORY_TURN_CHARS,
    then oldest-first dropped while total content chars still exceed
    MAX_HISTORY_TOTAL_CHARS). Order is preserved throughout -- turns are
    only ever capped/truncated/dropped, never reordered -- so the caller
    gets [oldest kept turn, ..., newest kept turn] ready to splice between
    the system message and the current query.

    User-role turns are additionally run through sanitize_agent_query; a
    turn that trips the injection guard is dropped, not raised -- an
    earlier turn tripping a pattern must never fail an otherwise-legitimate
    follow-up query (only the CURRENT query keeps raise-on-injection
    behavior, in CompendiumAgent.query / query_stream). Assistant-role
    turns are cap-only: they're model-generated, not user input.
    """
    if not history:
        return []

    from backend.utils.sanitize import PromptInjectionError, sanitize_agent_query

    turns: list[tuple[str, str]] = []
    for turn in history[-MAX_HISTORY_TURNS:]:
        content = turn.content[:MAX_HISTORY_TURN_CHARS]
        if turn.role == "user":
            try:
                content = sanitize_agent_query(content, max_length=MAX_HISTORY_TURN_CHARS)
            except PromptInjectionError:
                logger.info("Dropping history turn: matched injection pattern")
                continue
            if not content:
                # All-control-char / all-whitespace turn after sanitization
                # -- an empty user message adds no follow-up context.
                continue
        turns.append((turn.role, content))

    total_chars = sum(len(c) for _, c in turns)
    while turns and total_chars > MAX_HISTORY_TOTAL_CHARS:
        _, dropped_content = turns.pop(0)
        total_chars -= len(dropped_content)

    return [AgentMessage(role=role, content=content) for role, content in turns]


# =============================================================================
# CompendiumAgent (ReAct search agent)
# =============================================================================


class CompendiumAgent:
    """ReAct agent for querying the browsing compendium.

    Implements the Reason-Act-Observe loop:
    1. LLM receives query + tool definitions
    2. LLM either returns a final answer or calls a tool
    3. Tool result is appended to conversation history
    4. Loop until final answer or max iterations
    """

    def __init__(self, user_id: int):
        self.user_id = user_id
        self._openai_client = None
        self._encoder = None

        # Per-query DB caches. Agent instances are short-lived (one per
        # user query), so per-instance caching is effectively per-query
        # caching. Avoids re-fetching the same active_pages / clusters
        # on every tool call within a single ReAct loop -- a multi-tool
        # query previously paid these scans 2-3x.
        self._clusters_cache: list[dict] | None = None
        self._pages_cache: list[dict] | None = None

        # Lazy-init OpenAI client
        if settings.has_openai:
            from openai import AsyncOpenAI

            from backend.services.langsmith_safety import (
                quiet_trace_ingest_warnings,
                safe_wrap_openai,
            )

            quiet_trace_ingest_warnings()
            client = AsyncOpenAI(api_key=self._resolve_openai_key())
            if settings.langchain_tracing_v2 and settings.langchain_api_key:
                client = safe_wrap_openai(client)
            self._openai_client = client

    def _resolve_openai_key(self) -> str:
        """Pick the OpenAI key for this user: demo sessions get their own.

        Agent chat is the only LLM path a demo session can still reach --
        ingest, recluster and dqBot are all role-gated -- and it is
        deliberately left open because it is the demo's headline feature.
        Its slowapi limits key on source IP, so they bound one visitor
        rather than aggregate spend. Billing the demo to a separate key
        lets a provider-side budget cap bound the PUBLIC credential without
        capping the owner's own usage on the same deployment.

        Falls back to the shared key when openai_api_key_demo is unset, so
        an unconfigured deployment behaves exactly as before.

        Role is read from the DB rather than trusted from a token. An
        admin viewing-as-demo also lands on the demo key: that session is
        demo-shaped, and attributing its spend to the demo budget is the
        conservative side to err on.
        """
        if not settings.openai_api_key_demo:
            return settings.openai_api_key

        try:
            from backend.db import auth_repo

            if auth_repo.get_role(self.user_id) == "demo":
                return settings.openai_api_key_demo
        except Exception:
            # Never let a role lookup failure break chat -- fall through to
            # the shared key, which is the pre-existing behaviour.
            logger.warning(
                "agent: role lookup failed for user %s; using shared OpenAI key",
                self.user_id,
            )

        return settings.openai_api_key

    def _get_encoder(self):
        """Lazy-load the SBERT model (shared singleton across services)."""
        if self._encoder is None:
            from backend.services.sbert_loader import get_sbert_model

            self._encoder = get_sbert_model()
        return self._encoder

    def _get_pages_cached(self) -> list[dict]:
        """Lazy + memoized fetch of this user's active pages."""
        if self._pages_cache is None:
            from backend.db import page_repo

            self._pages_cache = page_repo.get_active_pages(self.user_id)
        return self._pages_cache

    def _get_clusters_cached(self) -> list[dict]:
        """Lazy + memoized fetch of this user's clusters."""
        if self._clusters_cache is None:
            from backend.db import cluster_repo

            self._clusters_cache = cluster_repo.get_clusters_for_user(self.user_id)
        return self._clusters_cache

    def _is_admin(self) -> bool:
        """P5 (optional): role check backing the streaming complete event's
        cost/tool-call redaction. Fails closed (non-admin) on a lookup
        error -- a DB hiccup here must never turn into "leak internals by
        default", and must never turn an otherwise-successful response
        into a failure either, so this never raises."""
        try:
            from backend.db import auth_repo

            return auth_repo.get_role(self.user_id) == "admin"
        except Exception:
            logger.debug(
                "CompendiumAgent._is_admin: role lookup failed; defaulting to non-admin",
                exc_info=True,
            )
            return False

    def _redact_complete_event(self, event: dict) -> dict:
        """P5 (optional): strip cost/tool-call internals from a streaming
        `complete` event for non-admin callers, in place, returning it.

        Single choke point so every `complete` event query_stream yields --
        the main ReAct-loop event AND the no-API-key / empty-compendium
        early-return events -- honors the same redaction contract. Before
        this helper existed, the two early-return paths skipped
        `_is_admin()` entirely and always emitted total_cost_usd/
        tool_calls_made (harmless zero/empty values there, but an
        inconsistent wire contract across the three complete-event sites).
        """
        if not self._is_admin():
            event.pop("total_cost_usd", None)
            event.pop("tool_calls_made", None)
        return event

    @traceable(name="CompendiumAgent.query")
    async def query(
        self, user_query: str, history: list[HistoryTurn] | None = None
    ) -> AgentResponse:
        """Main entry point: answer a natural language question.

        ``history`` (P4): prior chat turns for follow-up context, spliced
        between the system message and the current query. Capped/sanitized
        by ``_prepare_history_messages``. Injection on the CURRENT query
        still raises PromptInjectionError (unchanged) -- only history-turn
        injection is silently dropped.
        """
        if not self._openai_client:
            return AgentResponse(
                answer="OpenAI API key not configured. Cannot run agent.",
                sources=[],
                tool_calls_made=[],
                total_cost_usd=0.0,
                iterations=0,
                model=AGENT_MODEL,
            )

        # Pre-flight: check if compendium has any data. Populates the
        # per-query pages cache so subsequent tool calls reuse the result.
        pages = self._get_pages_cached()
        if not pages:
            return AgentResponse(
                answer=(
                    "Your compendium is empty — no pages have been captured yet. "
                    "Browse some pages and process them through the pipeline first."
                ),
                sources=[],
                tool_calls_made=[],
                total_cost_usd=0.0,
                iterations=0,
                model=AGENT_MODEL,
            )

        # Sanitize user query (length limit + control char stripping)
        from backend.utils.sanitize import sanitize_agent_query

        user_query = sanitize_agent_query(user_query)

        # Build initial state: system prompt, then capped/sanitized prior
        # turns (P4), then the current query.
        state = AgentState(
            messages=[
                AgentMessage(role="system", content=get_prompt(_system_prompt_name())),
                *_prepare_history_messages(history),
                AgentMessage(role="user", content=user_query),
            ],
        )

        # Run ReAct loop
        query_start = time.perf_counter()
        state = await self._react_loop(state)
        total_latency_ms = (time.perf_counter() - query_start) * 1000

        # Persist summary cost_event (enables L5 + L9 analytics viz)
        _persist_agent_cost_event(self.user_id, state, user_query, total_latency_ms)

        # Extract final answer (last assistant message without tool calls)
        answer = ""
        for msg in reversed(state.messages):
            if msg.role == "assistant" and msg.content and not msg.tool_calls:
                answer = msg.content
                break

        if not answer:
            answer = "I wasn't able to find a clear answer. Try rephrasing your question."

        answer_sources = _sources_for_answer(state, answer)
        return AgentResponse(
            answer=answer,
            sources=answer_sources,
            sources_detail=_build_sources_detail(state, answer_sources),
            images=state.images_cited,
            tool_calls_made=state.tool_calls_log,
            total_cost_usd=state.total_cost_usd,
            iterations=state.iterations,
            model=AGENT_MODEL,
        )

    async def query_stream(
        self, user_query: str, history: list[HistoryTurn] | None = None
    ) -> AsyncGenerator[dict[str, Any], None]:
        """Stream the agent response as a series of events.

        Yields dicts with a ``type`` key:
        - ``{"type": "status", "text": "..."}`` — progress during tool iterations
        - ``{"type": "token", "text": "..."}``  — streamed answer tokens
        - ``{"type": "complete", ...}``          — final metadata (sources, trace, cost)
        - ``{"type": "error", "error_class": "rejected"|"internal", "message": "..."}``
          — the loop failed after this generator started running (P5).
          "rejected" = the current query tripped the injection guard
          (message is the guard's own explanation, safe to show verbatim).
          "internal" = any other exception (OpenAI failure, malformed
          tool-call JSON, etc.) -- message is a generic sentence plus the
          exception's CLASS NAME only, never ``str(e)`` or a traceback,
          since this reaches the browser. Always the last event; the
          generator returns cleanly afterward instead of propagating, so
          StreamingResponse's body-send doesn't just die mid-stream with
          no payload (the failure mode this replaces -- see main.py's
          agent_query_stream for why the old outer try/except never
          caught anything here: this method's body only starts executing
          once StreamingResponse begins iterating it, which is AFTER the
          route handler already returned 200 + SSE headers).

        ``history`` (P4): prior chat turns for follow-up context, same
        cap/sanitize contract as ``query()``.
        """
        if not self._openai_client:
            yield {"type": "token", "text": "OpenAI API key not configured."}
            yield self._redact_complete_event(
                {
                    "type": "complete",
                    "sources": [],
                    "tool_calls_made": [],
                    "total_cost_usd": 0,
                    "iterations": 0,
                    "model": AGENT_MODEL,
                }
            )
            return

        pages = self._get_pages_cached()
        if not pages:
            yield {
                "type": "token",
                "text": "Your compendium is empty — no pages captured yet.",
            }
            yield self._redact_complete_event(
                {
                    "type": "complete",
                    "sources": [],
                    "tool_calls_made": [],
                    "total_cost_usd": 0,
                    "iterations": 0,
                    "model": AGENT_MODEL,
                }
            )
            return

        from backend.utils.sanitize import PromptInjectionError, sanitize_agent_query

        # Trace created before sanitization (holding the raw query) so a
        # rejected query is still flushed for audit/debugging; overwritten
        # with the sanitized value below once that succeeds.
        trace = AgentTrace(user_id=self.user_id, query=user_query)
        trace.model = AGENT_MODEL

        try:
            user_query = sanitize_agent_query(user_query)
            trace.query = user_query

            state = AgentState(
                messages=[
                    AgentMessage(role="system", content=get_prompt(_system_prompt_name())),
                    *_prepare_history_messages(history),
                    AgentMessage(role="user", content=user_query),
                ],
            )

            # Native trace recorder (Tier 3 verbose). Threaded through state
            # so _execute_tool / _tool_search_compendium can record
            # sub-spans without parameter-list churn. Coexists with
            # cost_events (cost focus) and LangSmith @traceable (external
            # UI when free-tier headroom). See
            # backend/services/agent_trace_recorder.py.
            state.trace = trace

            # ReAct loop with streaming on the final answer
            query_start = time.perf_counter()
            grounding_guard_fired = False
            for i in range(state.max_iterations):
                state.iterations = i + 1
                messages = self._build_openai_messages(state)
                start = time.perf_counter()

                # Non-streaming call to check for tool calls
                response = await self._openai_client.chat.completions.create(
                    model=AGENT_MODEL,
                    messages=messages,
                    tools=AGENT_TOOLS,
                    temperature=0.0,
                    max_tokens=1000,
                )
                latency_ms = (time.perf_counter() - start) * 1000
                logger.info(
                    "agent iter %d: gpt-4o-mini non-streaming call took %.0fms",
                    i + 1,
                    latency_ms,
                )
                msg = response.choices[0].message
                usage = response.usage

                if usage:
                    from backend.services.llm_service import MODEL_PRICING

                    pricing = MODEL_PRICING.get(AGENT_MODEL, {})
                    cost = (
                        usage.prompt_tokens * pricing.get("input", 0)
                        + usage.completion_tokens * pricing.get("output", 0)
                    ) / 1000
                    state.total_cost_usd += cost
                    state.total_input_tokens += usage.prompt_tokens
                    state.total_output_tokens += usage.completion_tokens

                # Trace: record the planning LLM call. Inputs = full message
                # context as sent to OpenAI; outputs = the assistant message
                # content + any requested tool calls.
                trace.add_span(
                    span_type="llm_call",
                    span_name=AGENT_MODEL,
                    iteration=i + 1,
                    inputs={"messages": messages, "tools_available": [t["function"]["name"] for t in AGENT_TOOLS]},
                    outputs={
                        "content": msg.content,
                        "tool_calls": [
                            {"name": tc.function.name, "arguments": tc.function.arguments}
                            for tc in (msg.tool_calls or [])
                        ],
                    },
                    latency_ms=latency_ms,
                    metadata={
                        "phase": "plan",
                        "prompt_tokens": getattr(usage, "prompt_tokens", None) if usage else None,
                        "completion_tokens": getattr(usage, "completion_tokens", None) if usage else None,
                    },
                )

                if not msg.tool_calls:
                    # Narrated-intent hedge or long uncited answer with no tool used yet this turn:
                    # nudge once and force one more planning round instead
                    # of streaming the hedge as the final answer.
                    if (
                        not grounding_guard_fired
                        and not state.tool_calls_log
                        and (
                            _narrates_intent(msg.content)
                            or _ungrounded_answer(msg.content)
                        )
                    ):
                        grounding_guard_fired = True
                        _narrated = _narrates_intent(msg.content)
                        state.messages.append(
                            AgentMessage(
                                role="system",
                                content=(
                                    NARRATED_INTENT_NUDGE
                                    if _narrated
                                    else UNGROUNDED_ANSWER_NUDGE
                                ),
                            )
                        )
                        trace.add_span(
                            span_type="llm_call",
                            span_name=AGENT_MODEL,
                            iteration=i + 1,
                            inputs={"messages": messages},
                            outputs={"content": msg.content},
                            latency_ms=latency_ms,
                            metadata={
                                "phase": (
                                    "narrated_intent_guard"
                                    if _narrated
                                    else "ungrounded_answer_guard"
                                )
                            },
                        )
                        logger.info(
                            "agent iter %d: %s guard fired -- "
                            "forcing another planning call",
                            i + 1,
                            "narrated-intent" if _narrated else "ungrounded-answer",
                        )
                        continue

                    # Final answer — re-request with streaming
                    _stream_start = time.perf_counter()
                    _stream_text_buf: list[str] = []
                    answer_stream = await self._openai_client.chat.completions.create(
                        model=AGENT_MODEL,
                        messages=messages,
                        temperature=0.0,
                        max_tokens=1000,
                        stream=True,
                    )
                    async for chunk in answer_stream:
                        delta = chunk.choices[0].delta
                        if delta.content:
                            _stream_text_buf.append(delta.content)
                            trace.append_answer_token(delta.content)
                            yield {"type": "token", "text": delta.content}
                    trace.add_span(
                        span_type="llm_call",
                        span_name=AGENT_MODEL,
                        iteration=i + 1,
                        inputs={"messages": messages},
                        outputs={"content": "".join(_stream_text_buf)},
                        latency_ms=(time.perf_counter() - _stream_start) * 1000,
                        metadata={"phase": "answer_stream"},
                    )
                    break

                # Tool calls — execute and yield status
                tool_call_dicts = [
                    {
                        "id": tc.id,
                        "name": tc.function.name,
                        "arguments": json.loads(tc.function.arguments),
                    }
                    for tc in msg.tool_calls
                ]
                state.messages.append(
                    AgentMessage(role="assistant", content=msg.content, tool_calls=tool_call_dicts)
                )

                for tc in tool_call_dicts:
                    yield {"type": "status", "text": f"Using {tc['name']}..."}
                    _tool_start = time.perf_counter()
                    result = await self._execute_tool(tc["name"], tc["arguments"], state)
                    _tool_latency_ms = (time.perf_counter() - _tool_start) * 1000
                    state.messages.append(
                        AgentMessage(role="tool", content=result, tool_call_id=tc["id"])
                    )
                    state.tool_calls_log.append(
                        {
                            "iteration": i + 1,
                            "tool": tc["name"],
                            "arguments": tc["arguments"],
                            "result_preview": _result_preview(result),
                        }
                    )
                    # Trace: full tool call (Tier 3 = full result, not preview).
                    # Note: _tool_search_compendium adds an additional
                    # 'retrieval' sub-span with the bi-encoder candidates +
                    # rerank scores; this span is the outer dispatch wrapper.
                    trace.add_span(
                        span_type="tool_call",
                        span_name=tc["name"],
                        iteration=i + 1,
                        inputs={"arguments": tc["arguments"]},
                        outputs={"result": result},
                        latency_ms=_tool_latency_ms,
                        metadata={"tool_call_id": tc["id"]},
                    )
            else:
                # Loop exhausted without `break`: the agent ran all
                # max_iterations rounds of tool calls without ever producing
                # a no-tool-call response (the path that streams the answer
                # and breaks). Without this fallback the streaming generator
                # yields zero "type=token" events and the chat UI renders an
                # empty answer body even though `sources` is populated --
                # bug observed 2026-04-29 ("who's <a biography subject>" →
                # 5 iter, 5 tools, no answer text). Force one final summary call so
                # the user gets a synthesis of what was gathered.
                logger.warning(
                    "Agent hit max_iterations=%d without final answer; forcing summary",
                    state.max_iterations,
                )
                trace.set_status("max_iter_exhausted")
                final_messages = self._build_openai_messages(state)
                final_messages.append(
                    {
                        "role": "system",
                        "content": (
                            "You have reached the maximum number of tool iterations."
                            " Synthesize a final answer based on the tool results above."
                            " Do not call any more tools."
                        ),
                    }
                )
                _fallback_start = time.perf_counter()
                _fallback_text_buf: list[str] = []
                answer_stream = await self._openai_client.chat.completions.create(
                    model=AGENT_MODEL,
                    messages=final_messages,
                    temperature=0.0,
                    max_tokens=1000,
                    stream=True,
                )
                async for chunk in answer_stream:
                    delta = chunk.choices[0].delta
                    if delta.content:
                        _fallback_text_buf.append(delta.content)
                        trace.append_answer_token(delta.content)
                        yield {"type": "token", "text": delta.content}
                trace.add_span(
                    span_type="llm_call",
                    span_name=AGENT_MODEL,
                    iteration=state.max_iterations,
                    inputs={"messages": final_messages},
                    outputs={"content": "".join(_fallback_text_buf)},
                    latency_ms=(time.perf_counter() - _fallback_start) * 1000,
                    metadata={"phase": "max_iter_fallback_summary"},
                )

            total_latency_ms = (time.perf_counter() - query_start) * 1000
            _persist_agent_cost_event(self.user_id, state, user_query, total_latency_ms)

            # Populate trace summary fields and schedule background flush.
            # Fire-and-forget: chat UX never waits on the DB write. Failure
            # is logged inside flush_trace_to_db; never bubbles to the caller.
            trace.iterations = state.iterations
            trace.total_cost_usd = state.total_cost_usd
            answer_sources = _sources_for_answer(state, trace.final_answer)
            trace.sources_cited = list(answer_sources)
            trace.images_cited = state.images_cited
            trace.clusters_cited = list(set(state.clusters_cited))

            complete_event = {
                "type": "complete",
                "sources": answer_sources,
                "sources_detail": _build_sources_detail(state, answer_sources),
                "cluster_ids": list(set(state.clusters_cited)),
                "images": state.images_cited,
                "tool_calls_made": state.tool_calls_log,
                "total_cost_usd": state.total_cost_usd,
                "iterations": state.iterations,
                "model": AGENT_MODEL,
            }
            # P5 (optional): strip cost/tool-call internals for non-admin
            # users via the shared _redact_complete_event helper (also used
            # by the no-API-key / empty-compendium early returns above),
            # mirroring the frontend's admin-gated trace panel. The trace
            # row written below keeps the full data either way -- this only
            # trims what goes out over the wire.
            yield self._redact_complete_event(complete_event)
            asyncio.create_task(flush_trace_to_db(trace))
        except PromptInjectionError as e:
            trace.set_status("error", error_message=f"rejected (injection guard): {e}")
            asyncio.create_task(flush_trace_to_db(trace))
            yield {"type": "error", "error_class": "rejected", "message": str(e)}
            return
        except Exception as e:
            logger.exception(
                "agent query_stream failed mid-loop (query=%r)", user_query[:80]
            )
            trace.set_status("error", error_message=f"{type(e).__name__}: {e}")
            asyncio.create_task(flush_trace_to_db(trace))
            yield {
                "type": "error",
                "error_class": "internal",
                "message": (
                    f"An internal error occurred while answering your query "
                    f"({type(e).__name__})."
                ),
            }
            return

    @traceable(name="CompendiumAgent._react_loop")
    async def _react_loop(self, state: AgentState) -> AgentState:
        """Iterate: call LLM → execute tools → repeat until done."""
        grounding_guard_fired = False
        for i in range(state.max_iterations):
            state.iterations = i + 1

            # Build messages for OpenAI
            messages = self._build_openai_messages(state)

            # Call LLM
            start = time.perf_counter()
            response = await self._openai_client.chat.completions.create(
                model=AGENT_MODEL,
                messages=messages,
                tools=AGENT_TOOLS,
                temperature=0.0,
                max_tokens=1000,
            )
            latency_ms = (time.perf_counter() - start) * 1000

            msg = response.choices[0].message
            usage = response.usage

            # Track cost + tokens
            if usage:
                from backend.services.llm_service import MODEL_PRICING

                pricing = MODEL_PRICING.get(AGENT_MODEL, {})
                cost = (
                    usage.prompt_tokens * pricing.get("input", 0)
                    + usage.completion_tokens * pricing.get("output", 0)
                ) / 1000
                state.total_cost_usd += cost
                state.total_input_tokens += usage.prompt_tokens
                state.total_output_tokens += usage.completion_tokens

            # No tool calls → final answer, UNLESS this is a narrated-intent
            # hedge with no tool used yet this turn -- then nudge once and
            # force one more planning round instead of shipping the hedge.
            if not msg.tool_calls:
                if (
                    not grounding_guard_fired
                    and not state.tool_calls_log
                    and (
                        _narrates_intent(msg.content)
                        or _ungrounded_answer(msg.content)
                    )
                ):
                    grounding_guard_fired = True
                    _narrated = _narrates_intent(msg.content)
                    state.messages.append(
                        AgentMessage(
                            role="system",
                            content=(
                                NARRATED_INTENT_NUDGE
                                if _narrated
                                else UNGROUNDED_ANSWER_NUDGE
                            ),
                        )
                    )
                    logger.info(
                        f"Agent iteration {i+1}: "
                        f"{'narrated-intent' if _narrated else 'ungrounded-answer'} guard fired "
                        f"({latency_ms:.0f}ms) -- forcing another planning call"
                    )
                    continue

                state.messages.append(AgentMessage(role="assistant", content=msg.content or ""))
                logger.info(
                    f"Agent iteration {i+1}: final answer "
                    f"({latency_ms:.0f}ms, ${state.total_cost_usd:.4f})"
                )
                break

            # Has tool calls → execute each and append results
            tool_call_dicts = [
                {
                    "id": tc.id,
                    "name": tc.function.name,
                    "arguments": json.loads(tc.function.arguments),
                }
                for tc in msg.tool_calls
            ]
            state.messages.append(
                AgentMessage(
                    role="assistant",
                    content=msg.content,
                    tool_calls=tool_call_dicts,
                )
            )

            for tc in tool_call_dicts:
                result = await self._execute_tool(tc["name"], tc["arguments"], state)
                state.messages.append(
                    AgentMessage(
                        role="tool",
                        content=result,
                        tool_call_id=tc["id"],
                    )
                )
                state.tool_calls_log.append(
                    {
                        "iteration": i + 1,
                        "tool": tc["name"],
                        "arguments": tc["arguments"],
                        "result_preview": _result_preview(result),
                    }
                )
                logger.info(
                    f"Agent iteration {i+1}: called {tc['name']}"
                    f"({json.dumps(tc['arguments'])}) → {len(result)} chars"
                )

        return state

    def _build_openai_messages(self, state: AgentState) -> list[dict]:
        """Convert AgentState messages to OpenAI API format."""
        messages = []
        for msg in state.messages:
            if msg.role == "system":
                messages.append({"role": "system", "content": msg.content})
            elif msg.role == "user":
                messages.append({"role": "user", "content": msg.content})
            elif msg.role == "assistant":
                entry = {"role": "assistant"}
                if msg.content:
                    entry["content"] = msg.content
                if msg.tool_calls:
                    entry["tool_calls"] = [
                        {
                            "id": tc["id"],
                            "type": "function",
                            "function": {
                                "name": tc["name"],
                                "arguments": json.dumps(tc["arguments"]),
                            },
                        }
                        for tc in msg.tool_calls
                    ]
                messages.append(entry)
            elif msg.role == "tool":
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": msg.tool_call_id,
                        "content": msg.content or "",
                    }
                )
        return messages

    @traceable(name="CompendiumAgent._execute_tool")
    async def _execute_tool(self, name: str, args: dict, state: AgentState) -> str:
        """Dispatch a tool call to the appropriate handler."""
        try:
            if name == "search_compendium":
                return self._tool_search_compendium(
                    args["query"],
                    args.get("top_k", 5),
                    state,
                    include_archived=args.get("include_archived", False),
                )
            elif name == "get_cluster_info":
                return self._tool_get_cluster_info(args["cluster_name"], state)
            elif name == "get_page_detail":
                return self._tool_get_page_detail(args["page_id"], state)
            elif name == "list_clusters":
                return self._tool_list_clusters()
            else:
                return f"Unknown tool: {name}"
        except Exception as e:
            logger.error(f"Tool {name} failed: {e}")
            return f"Error executing {name}: {e}"

    # -- Tool implementations --------------------------------------------------

    def _archived_page_content_ids(self, page_content_ids: list) -> set[int]:
        """Of the given page_content ids, those backing NO active page for this user.

        Used by the archive-inclusive scope (include_archived=True / the
        cascade's auto-widen stage) to label results sourced from
        archived/excluded pages so answers can flag non-curated content.
        """
        ids = [pcid for pcid in page_content_ids if pcid]
        if not ids:
            return set()
        from backend.db.connection import get_conn

        with get_conn() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT pc.id FROM page_content pc WHERE pc.id = ANY(%s) "
                "AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.page_content_id = pc.id "
                "AND p.user_id = %s AND COALESCE(p.human_status, p.status) = 'active')",
                (ids, self.user_id),
            )
            return {row[0] for row in cur.fetchall()}

    def _page_ids_for_content_ids(self, page_content_ids: list) -> dict[int, int]:
        """Map page_content_id -> a representative page.id for this user, ANY status.

        The active-pages cache (``_get_pages_cached``) only covers active
        pages, so it can't annotate archive-scoped search results with
        ``[id=<page_id>]``. Used by ``_format_search_results`` for those
        results and by ``_get_page_any_status`` so ids surfaced that way
        actually resolve in get_page_detail.
        """
        ids = [pcid for pcid in page_content_ids if pcid]
        if not ids:
            return {}
        from backend.db.connection import get_conn

        with get_conn() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT DISTINCT ON (p.page_content_id) p.page_content_id, p.id "
                "FROM pages p WHERE p.page_content_id = ANY(%s) AND p.user_id = %s "
                "ORDER BY p.page_content_id, p.id",
                (ids, self.user_id),
            )
            return {row[0]: row[1] for row in cur.fetchall()}

    def _get_page_any_status(self, page_id: int) -> dict | None:
        """Direct any-status lookup for one page id, scoped to this user.

        Only reached when get_page_detail misses the active-pages cache --
        the search cascade's auto-widen / include_archived path can cite
        pages outside that cache (P9-backend: "[id=]" ids must actually
        resolve regardless of which cascade stage produced them).
        """
        from backend.db.connection import get_conn

        with get_conn() as conn, conn.cursor() as cur:
            cur.execute(
                """
                SELECT p.id, p.url, p.title, p.domain, p.dwell_time_seconds,
                       p.content_summary, pc.extracted_text, pc.content_summary
                FROM pages p
                LEFT JOIN page_content pc ON p.page_content_id = pc.id
                WHERE p.id = %s AND p.user_id = %s
                """,
                (page_id, self.user_id),
            )
            row = cur.fetchone()
        if not row:
            return None
        return {
            "id": row[0],
            "url": row[1],
            "title": row[2],
            "domain": row[3],
            "dwell_time_seconds": row[4],
            "content_summary": row[5],
            "content_extracted_text": row[6],
            "content_level_summary": row[7],
        }

    @staticmethod
    def _cite_source(
        state: AgentState | None,
        url: str | None,
        page_id: int | None,
        title: str | None = None,
    ) -> None:
        """Record a citation, its page id, and its graph node id when known
        (P9-backend page_id; P7 locate-glyph fix node_id).

        Single choke point every tool implementation's citation goes
        through, so ``source_page_ids``/``source_node_ids`` (the url ->
        page_id / url -> node_id maps behind the complete-event
        ``sources_detail`` payload) stay consistent regardless of which
        tool -- or which cascade stage within search_compendium --
        produced the citation.

        ``title``, when given, is slugified with graph_builder's own
        ``_slugify`` -- the same function ``build_graph_from_db`` uses to
        derive ``GraphNode.id`` from a page's title -- so the resulting
        node_id is an EXACT reproduction of the graph's node id, not an
        approximation. Note graph_builder does not disambiguate slug
        collisions: two active pages sharing a title collapse into ONE
        graph node (see ``build_graph_from_db``'s ``if leaf_id in nodes``
        merge branch), so there is no suffix scheme to reproduce here.
        When title is falsy (unresolvable, or the page itself had no
        title -- graph_builder skips titleless pages entirely, so they
        have no node either), node_id is left unset and
        ``_build_sources_detail`` reports it as null; the frontend
        degrades that to a disabled locate glyph, same as an unknown
        page_id today.
        """
        if not state or not url:
            return
        state.sources_cited.append(url)
        if page_id is not None:
            state.source_page_ids[url] = page_id
        if title:
            state.source_node_ids[url] = _slugify(title)

    def _collect_member_pages(
        self, members: list[dict], cap: int, state: AgentState | None = None
    ) -> tuple[list[str], int]:
        """Render up to `cap` page-listing lines across the given clusters.

        Returns (lines, total_page_count). Citation bookkeeping runs over
        ALL member pages regardless of the display cap -- matches
        get_cluster_info's pre-existing precedent, where sources_cited /
        clusters_cited drive graph highlighting for the whole matched
        topic, not just the preview lines shown to the LLM.
        """
        pages = self._get_pages_cached()
        page_map = {p["id"]: p for p in pages}
        lines: list[str] = []
        total = 0
        for c in members:
            for pid in c.get("page_ids", []):
                p = page_map.get(pid)
                if not p:
                    continue
                total += 1
                if len(lines) < cap:
                    title = p.get("title") or p.get("url", "Unknown")
                    lines.append(f"  - [id={pid}] {title} ({p.get('url', '')})")
                self._cite_source(state, p.get("url"), pid, p.get("title"))
        return lines, total

    def _format_supercluster_lookup(
        self, label: str, clusters: list[dict], state: AgentState | None
    ) -> str:
        """get_cluster_info's rendering for a supercluster-level match."""
        members = [c for c in clusters if c.get("super_cluster") == label]
        if state:
            for c in members:
                state.clusters_cited.append(c["cluster_slug"])
        page_lines, total = self._collect_member_pages(members, cap=10, state=state)
        member_names = ", ".join(c["cluster_name"] for c in members)
        return (
            f"Supercluster: {label}\n"
            f"Member clusters ({len(members)}): {member_names}\n"
            f"Pages ({total} total, showing up to 10):\n" + "\n".join(page_lines)
        )[:MAX_TOOL_RESULT_CHARS]

    def _match_taxonomy(self, query: str, state: AgentState | None) -> str | None:
        """Search cascade stage 2: does the query NAME a cluster/supercluster
        the user already has? In-memory against the cached clusters list --
        no embedding call. Catches hypernym/topic-label queries (e.g.
        "astronomy") that the cross-encoder reranker under-scores because no
        single page TITLE contains the word, even when bi-encoder recall on
        the topic is healthy (2026-07-16 astronomy-miss audit: best rerank
        0.070, cosine sims 0.45-0.51). Superclusters are checked first
        (coarser, more likely what a bare topic-label query means); leaf
        clusters only if no supercluster matches.
        """
        clusters = self._get_clusters_cached()
        if not clusters:
            return None

        query_norm = query.lower().strip()
        if not query_norm:
            return None
        query_tokens = _tokenize(query_norm)

        supercluster_tiers: dict[str, int] = {}
        for c in clusters:
            sc = c.get("super_cluster")
            if not sc:
                continue
            tier = _label_match_tier(sc, query_norm, query_tokens)
            if tier is not None:
                supercluster_tiers[sc] = min(tier, supercluster_tiers.get(sc, 99))

        if supercluster_tiers:
            best_label = min(supercluster_tiers, key=supercluster_tiers.get)
            members = [c for c in clusters if c.get("super_cluster") == best_label]
            if state:
                for c in members:
                    state.clusters_cited.append(c["cluster_slug"])
            page_lines, total = self._collect_member_pages(members, cap=10, state=state)
            member_names = ", ".join(c["cluster_name"] for c in members)
            return (
                f"Taxonomy match: your compendium has a supercluster named "
                f"'{best_label}' (matched by topic name, not content "
                f"relevance -- treat this as a structural fact about the "
                f"user's compendium, not a ranked search result).\n"
                f"Member clusters ({len(members)}): {member_names}\n"
                f"Pages ({total} total, showing up to 10):\n" + "\n".join(page_lines)
            )[:MAX_TOOL_RESULT_CHARS]

        query_slug = re.sub(r"[\s-]+", "_", query_norm)
        best_tier: int | None = None
        best_cluster: dict | None = None
        for c in clusters:
            name_tier = _label_match_tier(c["cluster_name"], query_norm, query_tokens)
            slug_tier = _label_match_tier(c["cluster_slug"], query_slug, query_tokens)
            tier = min((t for t in (name_tier, slug_tier) if t is not None), default=None)
            if tier is not None and (best_tier is None or tier < best_tier):
                best_tier, best_cluster = tier, c

        if best_cluster is None:
            return None

        if state:
            state.clusters_cited.append(best_cluster["cluster_slug"])
        page_lines, total = self._collect_member_pages([best_cluster], cap=10, state=state)
        return (
            f"Taxonomy match: your compendium has a cluster named "
            f"'{best_cluster['cluster_name']}' (matched by topic name, not "
            f"content relevance -- treat this as a structural fact about "
            f"the user's compendium, not a ranked search result).\n"
            f"Pages ({total} total, showing up to 10):\n" + "\n".join(page_lines)
        )[:MAX_TOOL_RESULT_CHARS]

    def _format_search_results(
        self,
        results: list[dict],
        candidates: list[dict],
        state: AgentState | None,
        active_only: bool,
        low_confidence: bool = False,
    ) -> str:
        """Render reranked chunks into the LLM-facing result text, and (when
        `state` is provided) update the citation/highlighting bookkeeping
        that both AgentResponse and the SSE complete event read from.

        Shared by the cascade's confirmed-match happy path (stage 1) and
        its low-confidence fallback (stage 3, `low_confidence=True`). The
        two stages intentionally diverge on citation: stage 1 populates
        sources_cited / clusters_cited normally, but stage 3 leaves both
        untouched -- unconfirmed candidates must not render as source pills
        or trigger graph highlighting. The `[id=<page_id>]` tag stays in the
        LLM-facing text either way; get_page_detail's own citation path
        handles attribution if the model drills into a low-confidence hit.
        """
        pages = self._get_pages_cached()
        pcid_to_page_id: dict[int, int] = {
            p["page_content_id"]: p["id"] for p in pages if p.get("page_content_id")
        }
        # page_id -> title, for the P7 locate-glyph node_id (see
        # CompendiumAgent._cite_source). Cheap: same `pages` list already
        # fetched above, just a second dict comprehension over it.
        pid_to_title: dict[int, str] = {p["id"]: p.get("title") for p in pages}

        url_to_cluster: dict[str, str] = {}
        if state:
            clusters = self._get_clusters_cached()
            pid_to_url = {p["id"]: p.get("url", "") for p in pages}
            for c in clusters:
                for pid in c.get("page_ids", []):
                    u = pid_to_url.get(pid, "")
                    if u:
                        url_to_cluster[u] = c["cluster_slug"]

        # Archive-scoped results (include_archived=True / cascade auto-widen)
        # may reference page_content not covered by the active-pages cache
        # above; resolve those ids with one extra targeted query instead of
        # caching every status for every query (the common active-only path
        # pays nothing extra).
        archived_pcids: set[int] = set()
        if not active_only:
            archived_pcids = self._archived_page_content_ids(
                [r.get("page_content_id") for r in results]
            )
            missing = [
                r.get("page_content_id")
                for r in results
                if r.get("page_content_id") not in pcid_to_page_id
            ]
            if missing:
                pcid_to_page_id.update(self._page_ids_for_content_ids(missing))

        lines = []
        seen_urls: set[str] = set()
        seen_image_urls: set[str] = (
            {img["source_url"] for img in state.images_cited} if state else set()
        )
        # Presentation-level dedup for duplicate chunk rows in the corpus
        # (a data artifact -- see repro 2026-07-17, "space telescopes"/user
        # 152: two identical SERENDIP chunks rendered as separate lines
        # with identical rerank scores). `results` is already score-sorted
        # descending, so the first occurrence of a (url, normalized chunk
        # text) pair carries the higher-or-equal rerank score; later
        # occurrences are skipped rather than rendered again. Retrieval and
        # rerank are untouched -- this only trims the already-sliced
        # `results` list, so it may render fewer than top_k lines when
        # duplicates are present, which is honest given the underlying data.
        seen_render_keys: set[tuple[str, str]] = set()
        for r in results:
            url = r.get("url", "unknown")
            # M8: extract image markers from the FULL chunk_text (not the
            # 300-char content_summary, which can truncate past the marker).
            # The cleaned text -- markers stripped -- is what the LLM sees,
            # so it never quotes raw URLs in answers.
            full_text = r.get("chunk_text") or r.get("content_summary") or ""
            render_key = (url, " ".join(full_text.split()))
            if render_key in seen_render_keys:
                continue
            seen_render_keys.add(render_key)
            _full_clean, full_images = _extract_image_markers(full_text)
            summary_clean, _ = _extract_image_markers(
                (r.get("content_summary") or "")[:300]
            )
            if state and full_images:
                for img in full_images:
                    src = img.get("source_url", "")
                    if src and src not in seen_image_urls:
                        state.images_cited.append(img)
                        seen_image_urls.add(src)
            # Prefer the cross-encoder rerank score (joint relevance) over
            # the bi-encoder cosine similarity (topical proximity) when
            # both are present. The reranker is the better signal.
            score = r.get("rerank_score", r.get("similarity", 0))
            pid = pcid_to_page_id.get(r.get("page_content_id"))
            id_tag = f" [id={pid}]" if pid is not None else ""
            tags = ""
            if r.get("page_content_id") in archived_pcids:
                tags += " [archived]"
            if low_confidence:
                tags += " [low-confidence]"
            lines.append(f"- [{url}]{id_tag} (relevance: {score:.3f}){tags}\n  {summary_clean}")
            if url != "unknown" and url not in seen_urls:
                # Dedup citations: a page with multiple matching chunks
                # should appear as a single cited source, not N times.
                seen_urls.add(url)
                # Low-confidence hits are candidates, not confirmed answers --
                # citing them would render source pills / graph highlighting
                # even when the answer says nothing was found. The [id=N] tag
                # stays in the LLM-facing text; get_page_detail's own citation
                # path handles attribution if the model drills in.
                if not low_confidence:
                    self._cite_source(
                        state, url, pid, pid_to_title.get(pid) if pid is not None else None
                    )
                    cslug = url_to_cluster.get(url)
                    if state and cslug:
                        state.clusters_cited.append(cslug)

        # Page-scoped image harvest. The image-descriptions chunk for a
        # backfilled page often gets out-competed in cross-encoder rerank
        # by direct-answer chunks (e.g., "who is X" surfaces bio sections
        # over the visual description chunk). Result: cited pages display
        # without their image strip even though the markers exist in
        # other chunks of the same page.
        #
        # Fix: after building seen_urls from rerank top-K, walk the
        # bi-encoder candidate list (top-25) and harvest image markers
        # from any chunk whose URL is already cited. This means: if a
        # page is cited as a source, its images surface -- regardless of
        # whether the specific image-descriptions chunk made it past the
        # reranker. Pages NOT in seen_urls (low-relevance) don't have
        # their images surfaced, so we don't pollute the strip with
        # unrelated thumbnails.
        #
        # Verified 2026-04-29 via trace 9 (a biography-subject "who dat"
        # query): rerank top-5 was all bio chunks (Early life, Personal life,
        # Education, Other work, Television work) -- zero markers
        # surfaced. Bi-encoder top-25 includes the image-descriptions
        # chunk at rank #5. Without this harvest, the strip stayed empty
        # for biographical queries against backfilled pages.
        if state:
            for cand in candidates:
                cand_url = cand.get("url", "")
                if not cand_url or cand_url not in seen_urls:
                    continue
                cand_text = cand.get("chunk_text") or ""
                _, cand_images = _extract_image_markers(cand_text)
                for img in cand_images:
                    src = img.get("source_url", "")
                    if src and src not in seen_image_urls:
                        state.images_cited.append(img)
                        seen_image_urls.add(src)

        preamble = (
            "[low-confidence results: these pages are semantically related "
            "to the query but did not clear the relevance threshold -- "
            "treat them as candidates, not confirmed answers]\n"
            if low_confidence
            else ""
        )
        return (preamble + "\n".join(lines))[:MAX_TOOL_RESULT_CHARS]

    def _low_confidence_result(
        self,
        candidates: list[dict],
        ranked: list[dict],
        state: AgentState | None,
        active_only: bool,
    ) -> str | None:
        """Search cascade stage 3: surface the top 3 candidates, marked
        [low-confidence], when bi-encoder recall found something plausible
        but no chunk cleared the rerank threshold and no taxonomy match
        fired. Gated on the BEST bi-encoder similarity (not rerank score)
        because the reranker rewards lexical/title overlap and under-scores
        hypernym queries even when topical recall is healthy. Returns None
        (fall through to the next cascade stage) when the floor isn't met.
        """
        if not candidates:
            return None
        best_sim = max(c.get("similarity", 0.0) for c in candidates)
        if best_sim < settings.agent_low_confidence_sim_floor:
            return None
        top3 = ranked[:3]
        if not top3:
            return None
        return self._format_search_results(
            top3, candidates, state, active_only=active_only, low_confidence=True
        )

    def _structured_absence(
        self,
        candidates: list[dict],
        ranked: list[dict],
        archived_included: bool,
    ) -> str:
        """Search cascade stage 5 (last resort): a diagnosed absence instead
        of a bare "no matches" the model has no way to reason about -- real
        candidate count and scores so it can judge whether a rephrase is
        worth trying rather than guessing.
        """
        n = len(candidates)
        best_rerank = ranked[0].get("rerank_score", 0.0) if ranked else 0.0
        best_sim = max((c.get("similarity", 0.0) for c in candidates), default=0.0)
        scope = "active and archived" if archived_included else "active compendium"
        return (
            f"No relevant matches: {n} candidates evaluated, best rerank "
            f"score {best_rerank:.3f}, best similarity {best_sim:.2f} -- "
            f"this topic appears absent from the compendium ({scope})."
        )

    def _tool_search_compendium(
        self,
        query: str,
        top_k: int = 5,
        state: AgentState | None = None,
        include_archived: bool = False,
    ) -> str:
        """Two-stage retrieval plus a 5-stage fallback cascade for misses.

        Stage A (bi-encoder recall): SBERT embed query, pgvector cosine
        top-25 (unioned with an archive-inclusive pass when the effective
        scope is archive-inclusive -- see the nested `_retrieve`). Stage B
        (cross-encoder rerank): joint (query, chunk) relevance score,
        sigmoid-mapped to [0,1]. Results at/above
        settings.agent_relevance_threshold are the confirmed-match happy
        path (stage 1, unchanged from before this cascade existed).

        Below threshold, in order, stopping at the first stage that
        produces output (2026-07-16 astronomy-miss fix; see
        docs/llm/llm-stack.md "Agent / retrieval" for the rationale and the
        empirical scores that motivated each stage):
          2. Taxonomy match (`_match_taxonomy`): does the query NAME a
             cluster/supercluster the user already has? In-memory, no
             embedding call -- catches hypernym/topic-label queries (e.g.
             "astronomy") the cross-encoder under-scores because no page
             TITLE contains the word, even though bi-encoder recall on the
             topic is healthy.
          3. Low-confidence fallback (`_low_confidence_result`): best
             bi-encoder similarity clears
             settings.agent_low_confidence_sim_floor -> surface the top 3
             candidates marked [low-confidence] instead of silence.
          4. Auto-widen: if the caller didn't already ask for
             include_archived, retry once with the archive-inclusive union
             (what the old dedicated full_search tool did) and re-run
             stages 1-3 against it.
          5. Structured absence (`_structured_absence`): a diagnosed
             "nothing here" with the actual candidate count and best
             scores.

        Candidate count was 50 historically; reduced to 25 on 2026-04-29
        after cross-encoder rerank on CPU was identified as a meaningful
        latency contributor. With ivfflat.probes=20 (set in
        find_similar_chunks), the bi-encoder candidate quality is high
        enough that 25 is sufficient.
        """
        from backend.db import embedding_repo
        from backend.services.reranker import rerank

        threshold = settings.agent_relevance_threshold
        encoder = self._get_encoder()
        query_vec = encoder.encode(query).tolist()

        def _retrieve(active_only: bool) -> tuple[list[dict], list[dict], dict]:
            """One bi-encoder recall + cross-encoder rerank pass.

            Reranks the FULL candidate pool (not just top_k) so later
            cascade stages (low-confidence top-3, structured-absence
            diagnostics) can read scores beyond whatever top_k the LLM
            requested, without a second rerank pass.
            """
            _t0 = time.perf_counter()
            cands = embedding_repo.find_similar_chunks(
                query_vec, top_k=25, user_id=self.user_id, active_only=active_only
            )
            if not active_only:
                # Union the active candidates with the archive-inclusive
                # ones. The recall pool is a fixed 25, so without this an
                # archived near-neighbor can crowd a relevant *active*
                # chunk out of the pool and the widened search would
                # return LESS than the default. The union guarantees it's
                # a superset of the active scope. (Moved here from the old
                # dedicated full_search tool.)
                seen_ids = {c["page_chunk_id"] for c in cands}
                for c in embedding_repo.find_similar_chunks(
                    query_vec, top_k=25, user_id=self.user_id, active_only=True
                ):
                    if c["page_chunk_id"] not in seen_ids:
                        cands.append(c)
                        seen_ids.add(c["page_chunk_id"])
            _t1 = time.perf_counter()
            ranked_all = rerank(query, cands, top_k=len(cands)) if cands else []
            _t2 = time.perf_counter()
            timings = {"pgvector_ms": (_t1 - _t0) * 1000, "rerank_ms": (_t2 - _t1) * 1000}
            logger.info(
                "search_compendium retrieval pass (active_only=%s): "
                "pgvector=%.0fms rerank=%.0fms (%d candidates -> %d reranked)",
                active_only,
                timings["pgvector_ms"],
                timings["rerank_ms"],
                len(cands),
                len(ranked_all),
            )
            return cands, ranked_all, timings

        def _trace(candidates, ranked_all, results, timings, phase: str) -> None:
            # Trace: retrieval sub-span, one per retrieval pass (primary and,
            # if the cascade reaches it, auto-widen). Captures the full
            # candidate list (with bi-encoder distances), the reranked pool,
            # and the post-threshold filtered subset so post-hoc queries can
            # answer "why did the agent surface these chunks?" without
            # re-running the model. Tier 3 verbose: chunk_text included.
            if state is None or getattr(state, "trace", None) is None:
                return

            reranked_stored = ranked_all[:top_k]

            def _chunk_summary(c: dict, include_rerank: bool) -> dict:
                summary = {
                    "page_chunk_id": c.get("page_chunk_id"),
                    "url": c.get("url"),
                    "domain": c.get("domain"),
                    "section_title": c.get("section_title"),
                    "page_content_id": c.get("page_content_id"),
                    "distance": c.get("distance"),
                    "similarity": c.get("similarity"),
                    "chunk_text": c.get("chunk_text"),
                }
                if include_rerank and "rerank_score" in c:
                    summary["rerank_score"] = c.get("rerank_score")
                return summary

            state.trace.add_span(
                span_type="retrieval",
                span_name="search_compendium",
                iteration=state.iterations or None,
                inputs={
                    "query": query,
                    "top_k_requested": top_k,
                    "bi_encoder_top_k": 25,
                    "phase": phase,
                },
                outputs={
                    "candidates": [_chunk_summary(c, include_rerank=False) for c in candidates],
                    "reranked": [_chunk_summary(c, include_rerank=True) for c in reranked_stored],
                    "results": [_chunk_summary(c, include_rerank=True) for c in results],
                },
                latency_ms=timings["pgvector_ms"] + timings["rerank_ms"],
                metadata={
                    "phase": phase,
                    "pgvector_ms": timings["pgvector_ms"],
                    "rerank_ms": timings["rerank_ms"],
                    "candidates_returned": len(candidates),
                    "reranked_returned": len(reranked_stored),
                    "rerank_pool_size": len(ranked_all),
                    "results_returned_after_threshold": len(results),
                    "relevance_threshold": threshold,
                },
            )

        # -- Stage A/B + Stage 1 (confirmed-match happy path) ---------------
        active_only = not include_archived
        candidates, ranked_all, timings = _retrieve(active_only)
        results = [r for r in ranked_all[:top_k] if r.get("rerank_score", 0.0) >= threshold]
        _trace(
            candidates,
            ranked_all,
            results,
            timings,
            phase="primary_include_archived" if include_archived else "primary",
        )

        if results:
            return self._format_search_results(results, candidates, state, active_only=active_only)

        # -- Stage 2: taxonomy match -----------------------------------------
        taxonomy = self._match_taxonomy(query, state)
        if taxonomy:
            return taxonomy

        # -- Stage 3: low-confidence fallback --------------------------------
        low_conf = self._low_confidence_result(candidates, ranked_all, state, active_only=active_only)
        if low_conf:
            return low_conf

        # -- Stage 4: auto-widen (only if not already archive-inclusive) ----
        if not include_archived:
            candidates2, ranked_all2, timings2 = _retrieve(active_only=False)
            results2 = [r for r in ranked_all2[:top_k] if r.get("rerank_score", 0.0) >= threshold]
            _trace(candidates2, ranked_all2, results2, timings2, phase="auto_widen")

            if results2:
                return self._format_search_results(results2, candidates2, state, active_only=False)

            low_conf2 = self._low_confidence_result(candidates2, ranked_all2, state, active_only=False)
            if low_conf2:
                return low_conf2

            # -- Stage 5: structured absence (widened diagnostics) ----------
            return self._structured_absence(candidates2, ranked_all2, archived_included=True)

        # -- Stage 5: structured absence (already archive-inclusive) -------
        return self._structured_absence(candidates, ranked_all, archived_included=include_archived)

    def _tool_get_cluster_info(self, cluster_name: str, state: AgentState | None = None) -> str:
        """Look up a cluster or supercluster by name/slug (fuzzy,
        typo-tolerant) and return its pages.

        Ranks every candidate label by match quality (exact > prefix >
        substring > close-match typo, via `_label_match_tier`) instead of
        the first substring hit in cluster order, and checks supercluster
        labels alongside leaf cluster names/slugs (P1: taxonomy visible
        from this tool too, not just the search cascade's taxonomy stage).
        """
        clusters = self._get_clusters_cached()
        if not clusters:
            return "No clusters found. The compendium may not have been clustered yet."

        query_norm = cluster_name.lower().strip()
        query_slug = re.sub(r"[\s-]+", "_", query_norm)
        query_tokens = _tokenize(query_norm)

        best_tier: int | None = None
        best_cluster: dict | None = None
        supercluster_tiers: dict[str, int] = {}
        for c in clusters:
            name_tier = _label_match_tier(c["cluster_name"], query_norm, query_tokens)
            slug_tier = _label_match_tier(c["cluster_slug"], query_slug, query_tokens)
            tier = min((t for t in (name_tier, slug_tier) if t is not None), default=None)
            if tier is not None and (best_tier is None or tier < best_tier):
                best_tier, best_cluster = tier, c

            sc = c.get("super_cluster")
            if sc:
                sc_tier = _label_match_tier(sc, query_norm, query_tokens)
                if sc_tier is not None:
                    supercluster_tiers[sc] = min(sc_tier, supercluster_tiers.get(sc, 99))

        best_supercluster = (
            min(supercluster_tiers, key=supercluster_tiers.get) if supercluster_tiers else None
        )

        # A supercluster match only wins over a leaf-cluster match when it's
        # a STRICTLY better tier -- ties prefer the more specific leaf hit
        # (so a cluster literally named "astronomy" isn't swallowed by an
        # "astronomy" supercluster label that matches at the same tier).
        if best_supercluster is not None and (
            best_tier is None or supercluster_tiers[best_supercluster] < best_tier
        ):
            return self._format_supercluster_lookup(best_supercluster, clusters, state)

        if best_cluster is None:
            available = ", ".join(c["cluster_name"] for c in clusters)
            return f"Cluster '{cluster_name}' not found. Available: {available}"

        match = best_cluster
        if state:
            state.clusters_cited.append(match["cluster_slug"])

        # Get page titles for the cluster's pages (cached across the query)
        all_pages = self._get_pages_cached()
        page_map = {p["id"]: p for p in all_pages}

        page_lines = []
        for pid in match.get("page_ids", []):
            p = page_map.get(pid)
            if p:
                title = p.get("title") or p.get("url", "Unknown")
                page_lines.append(f"  - [id={pid}] {title} ({p.get('url', '')})")
                self._cite_source(state, p.get("url"), pid, p.get("title"))

        return (
            f"Cluster: {match['cluster_name']} (slug: {match['cluster_slug']})\n"
            f"Pages ({len(match.get('page_ids', []))}):\n" + "\n".join(page_lines[:20])
        )[:MAX_TOOL_RESULT_CHARS]

    def _tool_get_page_detail(self, page_id: int, state: AgentState | None = None) -> str:
        """Get detailed info about a specific page, by id.

        Checks the active-pages cache first (the common case); falls back
        to an any-status DB lookup (`_get_page_any_status`) so ids surfaced
        from archived / [low-confidence] search results (P9-backend:
        search result lines now carry [id=<page_id>]) also resolve, not
        just ids for pages in the curated active compendium.
        """
        pages = self._get_pages_cached()
        page = next((p for p in pages if p["id"] == page_id), None)

        if not page:
            page = self._get_page_any_status(page_id)

        if not page:
            return f"Page with id={page_id} not found."

        url = page.get("url", "")
        self._cite_source(state, url, page_id, page.get("title"))

        summary = (
            page.get("content_summary")
            or page.get("content_level_summary")
            or page.get("content_extracted_text", "")[:500]
            or "No content available"
        )

        return (
            f"Title: {page.get('title', 'Unknown')}\n"
            f"URL: {url}\n"
            f"Domain: {page.get('domain', '')}\n"
            f"Dwell time: {page.get('dwell_time_seconds', 0)}s\n"
            f"Content: {summary}"
        )[:MAX_TOOL_RESULT_CHARS]

    def _tool_list_clusters(self) -> str:
        """List all clusters with page counts, grouped by supercluster (P1:
        taxonomy visible in the overview tool, not just leaf cluster names).
        Clusters with no supercluster assignment fall under "(ungrouped)".
        """
        clusters = self._get_clusters_cached()
        if not clusters:
            return "No clusters found. Run the clustering pipeline first."

        groups: dict[str, list[dict]] = {}
        for c in clusters:
            label = c.get("super_cluster") or "(ungrouped)"
            groups.setdefault(label, []).append(c)

        # Named superclusters first (alphabetical), "(ungrouped)" last.
        named = sorted(k for k in groups if k != "(ungrouped)")
        ordered_labels = named + (["(ungrouped)"] if "(ungrouped)" in groups else [])

        lines = []
        for label in ordered_labels:
            lines.append(f"{label}:")
            for c in groups[label]:
                page_count = len(c.get("page_ids", []))
                lines.append(f"  - {c['cluster_name']} ({page_count} pages)")

        return f"Found {len(clusters)} topic clusters:\n" + "\n".join(lines)
