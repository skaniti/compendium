"""LangSmith integration safety helpers.

LangSmith's free tier caps monthly unique traces. Once that cap is hit,
the trace ingest endpoint returns 429s and the wrapped OpenAI/Anthropic
client paths can spam ``langsmith.client`` WARNINGs ("Failed to send
compressed multipart ingest") on every API call until the cap resets.
The actual LLM calls still succeed -- the trace-write happens on a
background flush, not in the API call's main path -- but the log noise
buries genuine signal.

Two helpers here:

- ``safe_wrap_openai`` / ``safe_wrap_anthropic`` -- defensive wrappers
  around ``langsmith.wrappers.wrap_*``. If wrap setup fails for any reason
  (cap-saturated client, package not installed, init crash), we log a
  one-time warning and return the unwrapped client so production LLM
  traffic isn't blocked.
- ``quiet_trace_ingest_warnings`` -- installs a logging filter on
  ``langsmith.client`` that drops the repeated trace-ingest 429 WARNINGs.
  The filter is keyed on a substring match so it only catches the known
  trace-flush error class; other LangSmith warnings still surface.

The cap is a billing concern, not a correctness one. These helpers let
the project run cleanly while the cap is over without anyone needing to
flip ``LANGCHAIN_TRACING_V2`` off (which would also disable tracing on
calls that *would* have fit under the cap).
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


_TRACE_INGEST_WARNING_NEEDLE = "Failed to send compressed multipart ingest"
"""Substring that uniquely identifies the trace-flush 429 warning. Stable
across recent langsmith versions; check before bumping the langsmith
dependency that the message text hasn't drifted."""


class _TraceIngestFilter(logging.Filter):
    """Drop the repetitive trace-ingest 429 WARNING from langsmith.client.

    Other ``langsmith.client`` log records pass through unchanged. Genuine
    LangSmith errors (auth, schema mismatches, etc.) still surface.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.getMessage()
        return _TRACE_INGEST_WARNING_NEEDLE not in msg


_filter_installed = False


def quiet_trace_ingest_warnings() -> None:
    """Install the trace-ingest WARNING filter on langsmith.client.

    Idempotent -- safe to call multiple times. After install, calls that
    fail to write traces (because the monthly cap is hit) no longer flood
    the log; the actual API call result is unchanged.
    """
    global _filter_installed
    if _filter_installed:
        return
    logging.getLogger("langsmith.client").addFilter(_TraceIngestFilter())
    _filter_installed = True


def safe_wrap_openai(client):
    """Wrap an OpenAI client with LangSmith tracing, falling back on failure.

    If ``langsmith.wrappers.wrap_openai`` raises during setup, we log once
    and return the unwrapped client. Tracing is disabled for the returned
    client; production API calls continue normally.
    """
    try:
        from langsmith.wrappers import wrap_openai

        return wrap_openai(client)
    except Exception as e:
        logger.warning(
            "LangSmith wrap_openai failed at setup (%s: %s); proceeding with "
            "unwrapped OpenAI client. Trace cap or transient init issue likely.",
            type(e).__name__,
            e,
        )
        return client


def safe_wrap_anthropic(client):
    """Wrap an Anthropic client with LangSmith tracing, falling back on failure.

    Mirrors ``safe_wrap_openai``.
    """
    try:
        from langsmith.wrappers import wrap_anthropic

        return wrap_anthropic(client)
    except Exception as e:
        logger.warning(
            "LangSmith wrap_anthropic failed at setup (%s: %s); proceeding with "
            "unwrapped Anthropic client.",
            type(e).__name__,
            e,
        )
        return client
