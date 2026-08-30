-- 025_agent_traces.sql
-- Native agent trace tables for autonomous diagnosis of RAG chat behavior.
--
-- Two-table design (parent + spans) modelled after OpenTelemetry trace/span
-- semantics but specialized for the CompendiumAgent ReAct loop. Captured at
-- Tier 3 verbose: full LLM message contexts, full tool inputs/outputs,
-- complete retrieval candidate lists with scores. Storage budget at our
-- usage rate (<=50 chats/day) is ~5-15 MB/month before TTL pruning -- fine.
--
-- Coexists with existing cost_events (1 row per chat, cost focus) and
-- LangSmith @traceable decorators (when free-tier headroom available).
-- Powers the closed-loop diagnosis flow: Claude queries the trace tables
-- post-chat instead of asking the user for screenshots.
--
-- IF NOT EXISTS used throughout because the migration runner re-applies
-- this on every deploy (known bug with migrate.py).

CREATE TABLE IF NOT EXISTS agent_traces (
    id                  SERIAL PRIMARY KEY,
    user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    query               TEXT NOT NULL,
    final_answer        TEXT,
    total_latency_ms    REAL,
    total_cost_usd      REAL,
    iterations          INTEGER,
    -- 'completed' = normal break-on-no-tool-calls path
    -- 'max_iter_exhausted' = for-else fallback fired (added 2026-04-29)
    -- 'error' = exception during agent execution
    status              TEXT NOT NULL DEFAULT 'completed',
    error_message       TEXT,
    sources_cited       JSONB,        -- list of cited URLs
    images_cited        JSONB,        -- list of {thumb_url, source_url}
    clusters_cited      JSONB,        -- list of cluster slugs
    model               TEXT,         -- e.g. 'gpt-4o-mini'
    metadata            JSONB,        -- room for future fields w/o migration
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_traces_user
    ON agent_traces(user_id);
CREATE INDEX IF NOT EXISTS idx_agent_traces_created
    ON agent_traces(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_traces_status
    ON agent_traces(status) WHERE status <> 'completed';

CREATE TABLE IF NOT EXISTS agent_trace_spans (
    id                  SERIAL PRIMARY KEY,
    trace_id            INTEGER NOT NULL REFERENCES agent_traces(id) ON DELETE CASCADE,
    -- 'llm_call' = OpenAI chat.completions.create
    -- 'tool_call' = generic tool dispatch (search_compendium, get_page_detail, etc)
    -- 'retrieval' = sub-span of search_compendium with bi-encoder candidates + rerank scores
    span_type           TEXT NOT NULL,
    span_name           TEXT NOT NULL,    -- model name for llm_call, tool name for tool_call
    iteration           INTEGER,           -- ReAct loop iteration index (1-based); NULL if pre-loop
    sequence_num        INTEGER NOT NULL,  -- monotonic within a trace (preserves order)
    -- Tier 3 verbose: full inputs and outputs, not digests
    inputs              JSONB,
    outputs             JSONB,
    latency_ms          REAL,
    metadata            JSONB,             -- tokens, cost, error per-span
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_trace_spans_trace
    ON agent_trace_spans(trace_id, sequence_num);
CREATE INDEX IF NOT EXISTS idx_agent_trace_spans_type
    ON agent_trace_spans(span_type);
