"""Ingest-time page labelling for label-first grouping.

One structured label (category, subtopic, content kind, knowledge value, ...)
per ``page_content`` row, produced by a pinned model with the registry prompt
``settings.label_prompt_key``. The request/response shape is the one the
analyst's calibration run used (8 pages per request, JSON object with an
``items`` array), so measured cost and quality carry over.

Everything here is fail-open: a failed request costs its pages a label, never
the capture or the other requests. Nothing is called unless a caller asks;
the ``label_first_enabled`` flag is checked by the callers (the ingest hook).
"""

import asyncio
import hashlib
import json
import logging
import math
import re
from dataclasses import dataclass, field

from backend.config.settings import settings

logger = logging.getLogger(__name__)

TAXONOMY = (
    "science_nature",
    "health_medicine_psychology",
    "technology_software_dev",
    "ai_llm_tools",
    "consumer_electronics_gadgets",
    "making_3d_printing",
    "crafts_hobbies",
    "games_gaming",
    "film_tv",
    "music_performers",
    "people_biography",
    "literature_books_comics",
    "history_politics_geography",
    "philosophy_humanities_arts",
    "food_cooking",
    "shopping_products",
    "finance_banking_admin",
    "education_coursework",
    "work_productivity_tools",
    "personal_apps_accounts",
    "search_navigation",
    "social_media_forums",
    "ai_chat_transcripts",
    "news_current_events",
    "travel_places_local",
    "other_unclear",
)
SPECIFICITIES = ("entity", "narrow_topic", "broad_field", "none")
CONTENT_KINDS = (
    "article_reference",
    "documentation_code",
    "product_listing",
    "forum_thread",
    "video_media",
    "search_results",
    "auth_login",
    "app_dashboard_ui",
    "email_message",
    "chat_transcript",
    "personal_document",
    "model_file_listing",
    "error_or_empty",
    "other",
)
KNOWLEDGE_VALUES = ("keep", "marginal", "exclude")
EVIDENCE_LEVELS = ("title_only", "snippet", "text")
FLAGS = (
    "title_text_mismatch",
    "boilerplate_text",
    "url_only_title",
    "non_english",
    "truncated_summary",
    "near_duplicate_hint",
    "pii_in_text",
)

MAX_SUBTOPIC_CHARS = 80

# Measured on claude-haiku-5-5 over 8-page requests (the calibration run).
MEASURED_BATCH_PAGES = 8
MEASURED_INPUT_TOKENS = 6114
MEASURED_OUTPUT_TOKENS = 1005
# Effective cost per page actually billed in that run (prompt caching applied).
MEASURED_USD_PER_PAGE = 0.0001

_MAX_PARALLEL_REQUESTS = 4
_WS = re.compile(r"\s+")
_STATUS_SUMMARY = re.compile(r"^(Domain skipped|URL pattern skipped|Page browsed outside|Skipped)")


def _item_schema() -> dict:
    return {
        "type": "object",
        "properties": {
            "page_id": {"type": "integer"},
            "category": {"type": "string", "enum": list(TAXONOMY)},
            "subtopic": {"type": "string"},
            "entity": {"type": ["string", "null"]},
            "specificity": {"type": "string", "enum": list(SPECIFICITIES)},
            "content_kind": {"type": "string", "enum": list(CONTENT_KINDS)},
            "knowledge_value": {"type": "string", "enum": list(KNOWLEDGE_VALUES)},
            "evidence_level": {"type": "string", "enum": list(EVIDENCE_LEVELS)},
            "language": {"type": "string"},
            "flags": {"type": "array", "items": {"type": "string", "enum": list(FLAGS)}},
            "private_sensitive": {"type": "boolean"},
            "confidence": {"type": "number"},
        },
        "required": [
            "page_id",
            "category",
            "subtopic",
            "entity",
            "specificity",
            "content_kind",
            "knowledge_value",
            "evidence_level",
            "language",
            "flags",
            "private_sensitive",
            "confidence",
        ],
        "additionalProperties": False,
    }


BATCH_SCHEMA = {
    "type": "object",
    "properties": {"items": {"type": "array", "items": _item_schema()}},
    "required": ["items"],
    "additionalProperties": False,
}


class LabelParseError(ValueError):
    """The response was not decodable JSON at all (e.g. truncated at max_tokens)."""


@dataclass
class LabelRun:
    """Outcome of a labelling call. ``labels`` is keyed by page_content_id."""

    labels: dict[int, dict] = field(default_factory=dict)
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float = 0.0
    requests: int = 0
    failed_requests: int = 0
    error: str | None = None
    """Set when the call aborted (prompt unloadable, database failure): callers surface it."""


PROMPT_FINGERPRINT_LEN = 8
REQUEST_TIMEOUT_S = 90.0
"""Seconds one labelling request may take; a timeout fails that request only."""


class LabellerPromptError(RuntimeError):
    """The labelling prompt cannot be loaded; labelling must not run on a guess."""


def labeller_prompt_text() -> str:
    """The system prompt as plain text: override file entry, else the registry template.

    Never passed through ``str.format``: it carries no placeholders, and a
    hand-edited override containing a single brace would make ``get_prompt_raw``
    raise on every request. A missing key or an override that is not a string
    raises :class:`LabellerPromptError` (logged) instead of labelling with
    something else.
    """
    from backend.prompts import templates

    key = settings.label_prompt_key
    entry = templates.PROMPTS.get(key)
    if entry is None:
        msg = f"labelling prompt {key!r} is not in the prompt registry"
        logger.error(msg)
        raise LabellerPromptError(msg)
    override = templates._load_overrides().get(key)
    if override is not None and not isinstance(override, str):
        msg = f"override for {key!r} is not a string; fix the PROMPT_OVERRIDES_PATH file"
        logger.error(msg)
        raise LabellerPromptError(msg)
    return override or entry["template"]


def prompt_fingerprint() -> str:
    """Short hash of the system prompt text that will actually run.

    Hashes the effective text: the registry template, or the override from
    ``PROMPT_OVERRIDES_PATH`` when one is set for ``label_prompt_key``. The
    generic registry prompt and a privately overridden one therefore stamp
    different versions, and so does any edit made in the Prompts dev view.
    """
    text = labeller_prompt_text()
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:PROMPT_FINGERPRINT_LEN]


def labeller_version() -> str:
    """``<model>@<prompt key>+<prompt hash>``: the version stamped on every label row."""
    return f"{settings.label_model}@{settings.label_prompt_key}+{prompt_fingerprint()}"


def run_coro_blocking(coro):
    """Run a coroutine to completion from sync code.

    Copied from ``clustering_service._run_coro_blocking`` (same reasoning; kept
    here so the labeller does not import the clustering module): the caller may
    be sync code running inside an event loop (``update_pages_from_response``
    is called from async code in ``backend/api/main.py``), where plain
    ``asyncio.run`` raises. With a loop running, hop to a fresh thread, which
    has none; otherwise run directly.
    """
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)

    import concurrent.futures

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(asyncio.run, coro).result()


# ---------------------------------------------------------------------------
# Request building
# ---------------------------------------------------------------------------


def build_page_input(page: dict) -> str:
    """The per-page block of the request (title, url, domain, visit, summary, text).

    Mirrors the analyst's ``build_batch.page_input``: whitespace-collapsed
    summary (<=300 chars) and text (<=700 chars), pipeline status strings are
    not summaries, and a summary that merely repeats the text's head is dropped.
    """
    summ = _WS.sub(" ", page.get("content_summary") or "").strip()
    text = _WS.sub(" ", page.get("extracted_text") or "").strip()
    if _STATUS_SUMMARY.match(summ):
        summ = ""
    visited = page.get("visited_at") or ""
    visited = visited.isoformat() if hasattr(visited, "isoformat") else str(visited)
    lines = [
        f"title: {page.get('title') or ''}",
        f"url: {(page.get('url') or '')[:300]}",
        f"domain: {page.get('domain') or ''}",
        f"visited: {visited[:10]}  dwell_seconds: {page.get('dwell_time_seconds')}",
    ]
    if text and summ and text[:120] == summ[:120]:
        summ = ""
    if summ:
        lines.append(f"summary: {summ[:300]}")
    if text:
        lines.append(f"text: {text[:700]}")
    return "\n".join(lines)


def _request_key(page: dict) -> int:
    """The ``page_id`` shown to the model: the page row id, else the content id."""
    key = page.get("id")
    return int(key if key is not None else page["page_content_id"])


def build_request(pages: list[dict], system: str | None = None) -> tuple[str, str]:
    """``(system prompt, user text)`` for one request over ``pages``."""
    if system is None:
        system = labeller_prompt_text()
    body = "\n\n".join(f"### page_id: {_request_key(p)}\n{build_page_input(p)}" for p in pages)
    user = (
        f"Label each of the {len(pages)} pages below. Return items in the same order, "
        f"each with its page_id.\n\n{body}"
    )
    return system, user


# ---------------------------------------------------------------------------
# Response parsing
# ---------------------------------------------------------------------------

_FENCE = re.compile(r"^\s*```[a-zA-Z0-9_-]*\s*\n?(.*?)\n?\s*```\s*$", re.DOTALL)


def _opt_str(value) -> str | None:
    if value is None:
        return None
    value = str(value).strip()
    return value or None


def _validate_item(item: dict) -> dict:
    """Normalise one item or raise ValueError naming the problem."""
    category = item.get("category")
    if category not in TAXONOMY:
        raise ValueError(f"unknown category {category!r}")
    content_kind = item.get("content_kind")
    if content_kind not in CONTENT_KINDS:
        raise ValueError(f"unknown content_kind {content_kind!r}")
    knowledge_value = item.get("knowledge_value")
    if knowledge_value not in KNOWLEDGE_VALUES:
        raise ValueError(f"unknown knowledge_value {knowledge_value!r}")
    subtopic = item.get("subtopic")
    subtopic = subtopic.strip() if isinstance(subtopic, str) else ""
    if not subtopic or len(subtopic) > MAX_SUBTOPIC_CHARS:
        raise ValueError("subtopic empty or too long")
    flags = item.get("flags") or []
    if not isinstance(flags, list) or any(f not in FLAGS for f in flags):
        raise ValueError(f"bad flags {flags!r}")
    try:
        confidence = float(item.get("confidence"))
        confidence = None if math.isnan(confidence) else min(1.0, max(0.0, confidence))
    except (TypeError, ValueError):
        confidence = None
    specificity = item.get("specificity")
    evidence = item.get("evidence_level")
    private = item.get("private_sensitive")
    language = _opt_str(item.get("language"))
    return {
        "category": category,
        "subtopic": subtopic,
        "entity": _opt_str(item.get("entity")),
        "specificity": specificity if specificity in SPECIFICITIES else None,
        "content_kind": content_kind,
        "knowledge_value": knowledge_value,
        "evidence_level": evidence if evidence in EVIDENCE_LEVELS else None,
        "language": language[:16] if language else None,
        "flags": list(dict.fromkeys(flags)),
        "private_sensitive": private if isinstance(private, bool) else None,
        "confidence": confidence,
    }


def parse_labels(text: str, expected_ids: list[int]) -> dict[int, dict]:
    """Parse a response into ``{page_id: label}`` for the ids in ``expected_ids``.

    Tolerates a markdown code fence, a bare list, and a single item instead of
    the ``{"items": [...]}`` wrapper. Fail-open per item: an invalid item
    (unknown category/kind/value, bad flags, bad subtopic), one with an
    unexpected or missing ``page_id`` (a missing id is attributed to the
    only expected id when the request had exactly one page), or a repeat of an
    id is dropped with a warning and the rest kept. Raises ``LabelParseError``
    when the text is not decodable JSON (a truncated response): the caller
    treats the whole request as failed.
    """
    raw = text or ""
    m = _FENCE.match(raw)
    if m:
        raw = m.group(1)
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, TypeError) as e:
        raise LabelParseError(f"undecodable label response: {e}") from e

    if isinstance(data, dict) and isinstance(data.get("items"), list):
        items = data["items"]
    elif isinstance(data, dict):
        items = [data]
    elif isinstance(data, list):
        items = data
    else:
        raise LabelParseError("label response is neither an object nor a list")

    expected = set(expected_ids)
    out: dict[int, dict] = {}
    for item in items:
        if not isinstance(item, dict):
            logger.warning("label item is not an object; dropped")
            continue
        pid = item.get("page_id")
        if pid is None and len(expected_ids) == 1:
            pid = expected_ids[0]
        try:
            pid = int(pid)
        except (TypeError, ValueError):
            logger.warning("label item without a usable page_id; dropped")
            continue
        if pid not in expected:
            logger.warning("label item for unexpected page_id %s; dropped", pid)
            continue
        if pid in out:
            logger.warning("duplicate label item for page_id %s; first kept", pid)
            continue
        try:
            out[pid] = _validate_item(item)
        except ValueError as e:
            logger.warning("label item for page_id %s dropped: %s", pid, e)
    return out


# ---------------------------------------------------------------------------
# Labelling
# ---------------------------------------------------------------------------


def _extra_kwargs(model: str) -> dict:
    """Anthropic request extras: JSON-schema output; Haiku must not think.

    Haiku otherwise spends ~1.7k unasked thinking tokens and hits max_tokens;
    Sonnet rejects ``disabled`` and takes ``between_tools`` (analyst's note).
    """
    thinking = {"type": "disabled"} if "haiku" in model else {"type": "between_tools"}
    return {
        "output_config": {"format": {"type": "json_schema", "schema": BATCH_SCHEMA}},
        "thinking": thinking,
    }


async def label_pages(pages: list[dict], *, user_id: int, llm=None) -> LabelRun:
    """Label ``pages`` in requests of ``settings.label_batch_size``.

    Pages are deduplicated by ``page_content_id`` (one label per content row;
    pages without one are keyed by their own id) before chunking. A page dict
    needs ``id`` (the request key) and the fields ``build_page_input`` reads.
    A failing request is logged and counted in ``failed_requests``; the others
    proceed. ``user_id`` is accepted for the caller's bookkeeping (cost
    attribution happens in ``label_content_ids``).
    """
    run = LabelRun()
    seen: set[int] = set()
    unique: list[dict] = []
    for p in pages:
        ckey = p.get("page_content_id")
        ckey = int(ckey if ckey is not None else p["id"])
        if ckey in seen:
            continue
        seen.add(ckey)
        unique.append(p)
    if not unique:
        return run

    if llm is None:
        from backend.services.llm_service import LLMService

        llm = LLMService()

    system_prompt = labeller_prompt_text()  # fails loudly before any request is made
    size = max(1, int(settings.label_batch_size))
    chunks = [unique[i : i + size] for i in range(0, len(unique), size)]
    model = settings.label_model
    sem = asyncio.Semaphore(_MAX_PARALLEL_REQUESTS)

    async def one(chunk: list[dict]):
        keys = [_request_key(p) for p in chunk]
        _, user = build_request(chunk, system=system_prompt)
        async with sem:
            resp = await asyncio.wait_for(
                llm.complete(
                    user,
                    model=model,
                    system_prompt=system_prompt,
                    temperature=0,
                    max_tokens=220 * len(chunk) + 400,
                    extra_kwargs=_extra_kwargs(model),
                ),
                timeout=REQUEST_TIMEOUT_S,
            )
        return resp, parse_labels(resp.content, keys)

    results = await asyncio.gather(*(one(c) for c in chunks), return_exceptions=True)
    for chunk, res in zip(chunks, results):
        run.requests += 1
        if isinstance(res, BaseException):
            if isinstance(res, (KeyboardInterrupt, SystemExit)):
                raise res
            run.failed_requests += 1
            logger.error("label request for %d pages failed: %r", len(chunk), res)
            continue
        resp, parsed = res
        run.input_tokens += resp.input_tokens
        run.output_tokens += resp.output_tokens
        run.cost_usd += resp.cost_usd
        if not parsed:
            run.failed_requests += 1
            logger.error("label request for %d pages yielded no valid labels", len(chunk))
        for p in chunk:
            label = parsed.get(_request_key(p))
            if label is not None:
                ckey = p.get("page_content_id")
                run.labels[int(ckey if ckey is not None else p["id"])] = label
    return run


async def label_content_ids(content_ids: list[int], *, user_id: int) -> LabelRun:
    """Label content rows, store the labels, and record one cost event.

    Rows already labelled at the current ``labeller_version`` are skipped (a
    re-visited URL is not paid for twice). Loads one representative page per
    content row, labels them, upserts ``page_labels``, writes
    ``page_content.content_kind`` from each label (rows without a label keep
    their value), and inserts ONE ``page_labelling`` cost event for the call.
    Fail-open: any exception is logged and the run so far is returned.
    """
    run = LabelRun()
    try:
        from backend.db import content_repo, page_label_repo, trends_repo

        version = labeller_version()
        ids = list(dict.fromkeys(content_ids))
        done = page_label_repo.get_labels(ids, version)
        todo = [c for c in ids if c not in done]
        if not todo:
            return run
        pages = page_label_repo.get_label_inputs(todo, user_id=user_id)
        run = await label_pages(pages, user_id=user_id)

        rows = [
            {**label, "page_content_id": cid, "user_id": user_id, "labeller_version": version}
            for cid, label in run.labels.items()
        ]
        page_label_repo.upsert_labels(rows)
        for cid, label in run.labels.items():
            content_repo.update_content(cid, content_kind=label.get("content_kind"))

        if run.requests:
            try:
                trends_repo.insert_cost_event(
                    user_id=user_id,
                    event_type="page_labelling",
                    model=settings.label_model,
                    input_tokens=run.input_tokens,
                    output_tokens=run.output_tokens,
                    cost_usd=run.cost_usd,
                    metadata={
                        "pages": len(pages),
                        "requests": run.requests,
                        "labeller_version": version,
                    },
                )
            except Exception:
                logger.exception("page_labelling cost event failed")
    except Exception as exc:
        logger.exception("label_content_ids failed for %d content rows", len(content_ids))
        run.error = f"{type(exc).__name__}: {exc}"[:300]
    return run


def estimate_cost(n_pages: int, batch_size: int | None = None) -> dict:
    """Projected cost of labelling ``n_pages`` pages. No API call.

    Tokens scale the measured 6,114 in / 1,005 out per 8-page request by page
    count; ``usd_list`` prices them at the model's list price;
    ``usd_measured`` is the effective $0.0001/page the calibration run billed
    (prompt caching applied).
    """
    from backend.services.llm_service import MODEL_PRICING

    batch = max(1, int(batch_size or settings.label_batch_size))
    n = max(0, int(n_pages))
    scale = n / MEASURED_BATCH_PAGES
    tin = round(MEASURED_INPUT_TOKENS * scale)
    tout = round(MEASURED_OUTPUT_TOKENS * scale)
    price = MODEL_PRICING.get(settings.label_model, {"input": 0.0, "output": 0.0})
    return {
        "pages": n,
        "requests": math.ceil(n / batch),
        "input_tokens": tin,
        "output_tokens": tout,
        "usd_list": (tin * price["input"] + tout * price["output"]) / 1000,
        "usd_measured": n * MEASURED_USD_PER_PAGE,
    }
