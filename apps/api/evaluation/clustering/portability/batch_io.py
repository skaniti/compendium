"""Message Batches I/O for the portability benchmark: label requests and result parsing.

The requests are exactly what ``backend.services.page_labeller.label_pages`` sends
(registry prompt as system, ``build_request`` user text, ``BATCH_SCHEMA`` structured
output, Haiku thinking disabled, ``220 * n + 400`` max tokens) except ``temperature``,
which the Batches endpoint rejects on the current models. Page data never enters the
repo: callers pass corpus paths and output paths.

Input page rows (JSONL or dicts): ``id`` (int, request key), ``title``, ``url``, ``text``
and optionally ``summary`` (defaults to the first 300 chars of ``text``, the capture-time
``content_summary`` recipe).
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Iterator
from pathlib import Path
from urllib.parse import urlparse

from backend.services import page_labeller as pl

SUMMARY_CHARS = 300
"""``content_summary`` is the first 300 characters of the primary text at capture."""


def page_dict(row: dict) -> dict:
    """A labeller page dict (the fields ``build_page_input`` reads) from a corpus row."""
    url = row.get("url") or ""
    text = row.get("text") or ""
    return {
        "id": int(row["id"]),
        "title": row.get("title") or "",
        "url": url,
        "domain": urlparse(url).netloc if url else "",
        "visited_at": row.get("visited_at") or "",
        "dwell_time_seconds": row.get("dwell_time_seconds"),
        "content_summary": row.get("summary") or text[:SUMMARY_CHARS],
        "extracted_text": text,
    }


def label_request(pages: list[dict], custom_id: str, model: str, system: str) -> dict:
    """One Message Batches line for ``pages`` (already in ``page_dict`` shape)."""
    _, user = pl.build_request(pages, system=system)
    extra = pl._extra_kwargs(model)
    return {
        "custom_id": custom_id,
        "params": {
            "model": model,
            "max_tokens": 220 * len(pages) + 400,
            "system": system,
            "messages": [{"role": "user", "content": user}],
            **extra,
        },
    }


def write_label_requests(
    rows: Iterable[dict],
    out_path: str | Path,
    prefix: str,
    batch_size: int = pl.MEASURED_BATCH_PAGES,
    model: str = "claude-haiku-5-5",
) -> dict:
    """Write label requests for ``rows`` (in order) to ``out_path``; returns counts."""
    system = pl.labeller_prompt_text()
    n_req = n_pages = 0
    chunk: list[dict] = []
    with open(out_path, "a", encoding="utf-8") as fh:

        def flush():
            nonlocal n_req, n_pages, chunk
            if chunk:
                cid = f"{prefix}_{n_req:06d}"
                fh.write(json.dumps(label_request(chunk, cid, model, system)) + "\n")
                n_req += 1
                n_pages += len(chunk)
                chunk = []

        for row in rows:
            chunk.append(page_dict(row))
            if len(chunk) >= batch_size:
                flush()
        flush()
    return {"requests": n_req, "pages": n_pages}


def iter_results(path: str | Path) -> Iterator[tuple[str, dict | None, dict]]:
    """Yield ``(custom_id, message or None, raw line)`` from a Batches results JSONL.

    Accepts the API's result shape (``{"custom_id", "result": {"type": "succeeded",
    "message": {...}}}``) and a flat ``{"custom_id", "message"}`` / ``{"custom_id",
    "response"}`` shape.
    """
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            raw = json.loads(line)
            cid = raw.get("custom_id")
            res = raw.get("result") or {}
            msg = None
            if isinstance(res, dict) and res.get("type") == "succeeded":
                msg = res.get("message")
            elif "message" in raw:
                msg = raw["message"]
            elif "response" in raw:
                msg = raw["response"]
            yield cid, msg, raw


def message_text(msg: dict | None) -> str:
    """Concatenated text blocks of a Messages API response."""
    if not msg:
        return ""
    return "".join(
        b.get("text", "") for b in msg.get("content") or [] if isinstance(b, dict) and b.get("type") == "text"
    )


def message_usage(msg: dict | None) -> tuple[int, int]:
    usage = (msg or {}).get("usage") or {}
    return int(usage.get("input_tokens") or 0), int(usage.get("output_tokens") or 0)


def parse_label_results(path: str | Path, expected: dict[str, list[int]]) -> dict:
    """Parse label results; ``expected`` maps custom_id -> page ids of that request.

    Returns ``{"labels": {page_id: label}, "input_tokens", "output_tokens",
    "failed_requests": [custom_id...], "missing_pages": n}`` using the production
    ``parse_labels`` (same per-item validation as ingest).
    """
    labels: dict[int, dict] = {}
    failed: list[str] = []
    tin = tout = 0
    seen: set[str] = set()
    for cid, msg, _raw in iter_results(path):
        if cid not in expected:
            continue
        seen.add(cid)
        i, o = message_usage(msg)
        tin += i
        tout += o
        if msg is None:
            failed.append(cid)
            continue
        try:
            parsed = pl.parse_labels(message_text(msg), expected[cid])
        except pl.LabelParseError:
            failed.append(cid)
            continue
        if not parsed:
            failed.append(cid)
        labels.update(parsed)
    failed.extend(sorted(set(expected) - seen))
    n_expected = sum(len(v) for v in expected.values())
    return {
        "labels": labels,
        "input_tokens": tin,
        "output_tokens": tout,
        "failed_requests": failed,
        "missing_pages": n_expected - len(labels),
    }
