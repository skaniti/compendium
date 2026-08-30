"""Native agent trace recorder.

Captures per-chat ReAct loop execution detail (Tier 3 verbose) into the
``agent_traces`` + ``agent_trace_spans`` tables for autonomous diagnosis.

Coexists with existing infrastructure:
  - ``cost_events``: high-level cost/iteration summary (untouched by this
    recorder; written separately by ``_persist_agent_cost_event``).
  - LangSmith ``@traceable`` decorators: external trace UI (best-effort,
    capped on free tier; ``langsmith_safety.py`` handles the cap noise).
  - Per-iteration timing logs in ``agent.py``: stays as-is for log-tail
    debugging; this recorder is the structured/queryable counterpart.

Lifecycle:
  1. ``AgentTrace(user_id, query)`` created at the start of
     ``CompendiumAgent.query_stream``.
  2. ``trace.add_span(...)`` called at each LLM call, tool call, and
     retrieval inside the ReAct loop.
  3. ``trace.set_final_answer(...)`` accumulates streamed answer text.
  4. ``trace.set_status(...)`` records the loop exit path
     ('completed' | 'max_iter_exhausted' | 'error').
  5. ``await flush_trace_to_db(trace)`` is fired as a background task
     after the response stream closes -- chat UX never waits on the DB
     write. A failed write is logged and dropped; never raises.

Threading: each chat invocation creates its own ``AgentTrace`` and threads
it through ``AgentState.trace``. No shared mutable state across requests.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from backend.db.connection import get_conn

logger = logging.getLogger(__name__)

# Durable JSONL archive of every flushed trace, independent of the DB. The local
# dev database is a disposable replica that start_app.sh periodically drops and
# restores from the server mirror (wiping agent_traces + agent_trace_spans); this
# append-only file survives that, so trace history stays available for pattern
# analysis. Lives under data/*, which is gitignored.
_ARCHIVE_DIR = Path(__file__).resolve().parents[2] / "data" / "agent-traces"
_ARCHIVE_PATH = _ARCHIVE_DIR / "traces.jsonl"


@dataclass
class _Span:
    span_type: str
    span_name: str
    iteration: Optional[int]
    sequence_num: int
    inputs: Any = None
    outputs: Any = None
    latency_ms: Optional[float] = None
    metadata: dict = field(default_factory=dict)


@dataclass
class AgentTrace:
    """Per-chat trace. Append-only spans plus end-of-chat metadata."""

    user_id: int
    query: str
    spans: list[_Span] = field(default_factory=list)
    final_answer: Optional[str] = None
    total_cost_usd: float = 0.0
    iterations: int = 0
    status: str = "completed"
    error_message: Optional[str] = None
    sources_cited: list = field(default_factory=list)
    images_cited: list = field(default_factory=list)
    clusters_cited: list = field(default_factory=list)
    model: Optional[str] = None
    metadata: dict = field(default_factory=dict)
    _start_time: float = field(default_factory=time.perf_counter)

    def add_span(
        self,
        *,
        span_type: str,
        span_name: str,
        iteration: Optional[int] = None,
        inputs: Any = None,
        outputs: Any = None,
        latency_ms: Optional[float] = None,
        metadata: Optional[dict] = None,
    ) -> None:
        """Append one span to the trace. No DB write -- buffered until flush."""
        self.spans.append(
            _Span(
                span_type=span_type,
                span_name=span_name,
                iteration=iteration,
                sequence_num=len(self.spans),
                inputs=inputs,
                outputs=outputs,
                latency_ms=latency_ms,
                metadata=metadata or {},
            )
        )

    def append_answer_token(self, text: str) -> None:
        """Accumulate streamed answer tokens. Called from the chunk loop."""
        if self.final_answer is None:
            self.final_answer = text
        else:
            self.final_answer += text

    def set_status(self, status: str, error_message: Optional[str] = None) -> None:
        self.status = status
        if error_message is not None:
            self.error_message = error_message

    def total_latency_ms(self) -> float:
        return (time.perf_counter() - self._start_time) * 1000


def _to_jsonb(obj: Any) -> Optional[str]:
    """Coerce arbitrary Python values to a JSONB-compatible string.

    None passes through (NULL). Anything that round-trips json.dumps is
    used as-is. Anything else falls back to repr() so a non-serializable
    payload doesn't drop the whole trace write.
    """
    if obj is None:
        return None
    try:
        return json.dumps(obj, default=str, ensure_ascii=False)
    except Exception:
        try:
            return json.dumps({"__repr__": repr(obj)})
        except Exception:
            return json.dumps({"__repr__": "<unserializable>"})


def _write_trace_sync(trace: AgentTrace) -> int:
    """Insert the trace + all spans in a single transaction; return the new id.

    Sync psycopg2 path; called via run_in_executor from the async flush so
    the event loop isn't blocked.
    """
    total_latency = trace.total_latency_ms()

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO agent_traces (
                    user_id, query, final_answer, total_latency_ms,
                    total_cost_usd, iterations, status, error_message,
                    sources_cited, images_cited, clusters_cited, model, metadata
                )
                VALUES (
                    %s, %s, %s, %s,
                    %s, %s, %s, %s,
                    %s::jsonb, %s::jsonb, %s::jsonb, %s, %s::jsonb
                )
                RETURNING id
                """,
                (
                    trace.user_id,
                    trace.query,
                    trace.final_answer,
                    total_latency,
                    trace.total_cost_usd,
                    trace.iterations,
                    trace.status,
                    trace.error_message,
                    _to_jsonb(trace.sources_cited),
                    _to_jsonb(trace.images_cited),
                    _to_jsonb(trace.clusters_cited),
                    trace.model,
                    _to_jsonb(trace.metadata),
                ),
            )
            row = cur.fetchone()
            trace_id = row[0]

            # Bulk insert spans. For Tier 3 verbose with up to ~10 spans per
            # chat (5 LLM calls + 5 tool calls), executemany is fine; we don't
            # bother with COPY FROM.
            for span in trace.spans:
                cur.execute(
                    """
                    INSERT INTO agent_trace_spans (
                        trace_id, span_type, span_name, iteration,
                        sequence_num, inputs, outputs, latency_ms, metadata
                    )
                    VALUES (
                        %s, %s, %s, %s,
                        %s, %s::jsonb, %s::jsonb, %s, %s::jsonb
                    )
                    """,
                    (
                        trace_id,
                        span.span_type,
                        span.span_name,
                        span.iteration,
                        span.sequence_num,
                        _to_jsonb(span.inputs),
                        _to_jsonb(span.outputs),
                        span.latency_ms,
                        _to_jsonb(span.metadata),
                    ),
                )

    return trace_id


def _archive_trace_sync(trace: AgentTrace, trace_id: Optional[int]) -> None:
    """Append the trace (row fields + spans) as one JSON line to the durable
    archive. Independent of the DB write so it survives disposable-DB wipes, and
    still records the trace even if the DB write failed (trace_id is None then)."""
    _ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
    record = {
        "trace_id": trace_id,
        "archived_at": datetime.now(timezone.utc).isoformat(),
        "user_id": trace.user_id,
        "query": trace.query,
        "final_answer": trace.final_answer,
        "total_latency_ms": trace.total_latency_ms(),
        "total_cost_usd": trace.total_cost_usd,
        "iterations": trace.iterations,
        "status": trace.status,
        "error_message": trace.error_message,
        "sources_cited": trace.sources_cited,
        "images_cited": trace.images_cited,
        "clusters_cited": trace.clusters_cited,
        "model": trace.model,
        "metadata": trace.metadata,
        "spans": [
            {
                "span_type": s.span_type,
                "span_name": s.span_name,
                "iteration": s.iteration,
                "sequence_num": s.sequence_num,
                "inputs": s.inputs,
                "outputs": s.outputs,
                "latency_ms": s.latency_ms,
                "metadata": s.metadata,
            }
            for s in trace.spans
        ],
    }
    line = json.dumps(record, default=str, ensure_ascii=False)
    with open(_ARCHIVE_PATH, "a", encoding="utf-8") as fh:
        fh.write(line + "\n")


async def flush_trace_to_db(trace: AgentTrace) -> None:
    """Async entry point: schedule the sync DB write on the thread pool.

    Failures are logged (with the trace's query as identifier) and dropped.
    Never raises -- a missed trace must not break the chat response that
    just succeeded.
    """
    loop = asyncio.get_running_loop()
    trace_id: Optional[int] = None
    try:
        trace_id = await loop.run_in_executor(None, _write_trace_sync, trace)
        logger.info(
            "agent_trace flushed: status=%s iterations=%d spans=%d query=%r",
            trace.status,
            trace.iterations,
            len(trace.spans),
            trace.query[:60],
        )
    except Exception:
        logger.exception(
            "agent_trace write failed; trace dropped (query=%r)",
            trace.query[:60],
        )
    # Durable archive -- independent of the DB so it survives disposable-DB wipes
    # (and captures the trace even if the DB write above failed).
    try:
        await loop.run_in_executor(None, _archive_trace_sync, trace, trace_id)
    except Exception:
        logger.exception(
            "agent_trace archive append failed (query=%r)",
            trace.query[:60],
        )
