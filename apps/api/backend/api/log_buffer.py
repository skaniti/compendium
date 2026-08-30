"""In-process ring buffer that captures structured log records for the
Dash Live Log Stream view.

Why this exists
---------------
Stdout JSON logs are great for log aggregators but hostile for human
scanning. Rather than ship a second formatter and try to keep them in
sync, we attach a buffer-backed `logging.Handler` alongside the JSON one
and serve those records through `/api/logs` to a Dash page that renders
them with color, capture grouping, and filters.

Design choices
--------------
- **Bounded deque**: O(1) append, O(1) drop-oldest. ``maxlen=2000`` is
  enough for a few minutes of busy capture processing without unbounded
  memory growth.
- **Monotonic cursor**: each record gets an integer id. The endpoint
  takes ``?since=<cursor>`` and returns everything strictly newer, so
  the client can poll without re-rendering history. The cursor is
  process-local — restarting resets it, which the frontend treats as
  "show everything."
- **Lock-protected writes only**: reads grab a snapshot under the lock
  and release it before serializing, so a slow JSON encode in the
  endpoint can't block log producers.
- **Captures component from logger name**: ``backend.services.foo`` →
  ``services.foo`` → ``foo`` fits the badge palette in the frontend
  without the producer having to opt in. Capture-id is opportunistically
  parsed from message text (looks for ``Capture <id>`` or
  ``capture=<id>``) so the frontend can group records visually.
"""

from __future__ import annotations

import logging
import queue
import re
import threading
import time
from collections import deque
from typing import Any

# Cap chosen to fit a few minutes of pipeline activity without bloating
# resident memory; ~2000 records is roughly 1-2 MB at typical message
# sizes. Drop-oldest is fine — the endpoint serves "since cursor" and
# clients re-sync when records are missing.
_MAX_RECORDS = 2000
# Write-through queue cap. If the DB writer falls behind (DB down,
# connection-pool stall), records past this cap drop silently — the
# ring buffer still has them for live tail. Choosing a number ~5x the
# expected per-capture burst is plenty of headroom.
_WRITE_QUEUE_MAX = 10_000
# Background writer drains at most this many records per flush, every
# _WRITE_FLUSH_INTERVAL seconds — whichever comes first.
_WRITE_BATCH_MAX = 200
_WRITE_FLUSH_INTERVAL = 2.0

_capture_id_re = re.compile(r"(?:Capture|capture[=_])\s*([a-z0-9_]{8,})", re.IGNORECASE)


class RingBufferHandler(logging.Handler):
    """Thread-safe bounded buffer of recent log records, keyed by monotonic id.

    Optionally write-through to Postgres via a background daemon thread
    (see ``start_db_writer``). The thread is opt-in so unit tests and
    one-shot scripts that import this module don't accidentally start a
    long-running worker.
    """

    def __init__(self, maxlen: int = _MAX_RECORDS) -> None:
        super().__init__()
        self._buf: deque[dict[str, Any]] = deque(maxlen=maxlen)
        self._lock = threading.Lock()
        self._next_id = 1

        # Write-through plumbing. ``_write_queue`` is created here but
        # the worker thread is only started when ``start_db_writer()`` is
        # called explicitly — usually from the FastAPI lifespan handler.
        self._write_queue: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=_WRITE_QUEUE_MAX)
        self._writer_thread: threading.Thread | None = None
        self._writer_stop = threading.Event()
        self._dropped_writes = 0

    def emit(self, record: logging.LogRecord) -> None:
        try:
            payload = self._record_to_dict(record)
        except Exception:
            self.handleError(record)
            return
        with self._lock:
            payload["id"] = self._next_id
            self._next_id += 1
            self._buf.append(payload)
        # Best-effort enqueue for the DB writer. Drop on overflow rather
        # than block a logging call — losing a few DEBUG records to a
        # stalled DB is far less bad than stalling the request that
        # produced them.
        try:
            self._write_queue.put_nowait(payload)
        except queue.Full:
            self._dropped_writes += 1

    def snapshot(self, since: int = 0, limit: int = 500) -> list[dict[str, Any]]:
        """Return up to ``limit`` records with id > ``since``, oldest first."""
        with self._lock:
            recent = list(self._buf)
        if since:
            recent = [r for r in recent if r["id"] > since]
        if len(recent) > limit:
            recent = recent[-limit:]
        return recent

    def latest_id(self) -> int:
        with self._lock:
            return self._next_id - 1

    def clear(self) -> None:
        with self._lock:
            self._buf.clear()

    # ----- DB write-through ------------------------------------------------

    def start_db_writer(self) -> None:
        """Spawn the background daemon thread that persists records to Postgres.

        Idempotent — calling it twice does nothing. If the DB write fails
        repeatedly, records keep flowing through the ring buffer (live
        tail unaffected) and we retry on the next flush.
        """
        if self._writer_thread is not None and self._writer_thread.is_alive():
            return
        self._writer_stop.clear()
        t = threading.Thread(
            target=self._writer_loop,
            name="log-buffer-writer",
            daemon=True,
        )
        t.start()
        self._writer_thread = t

    def stop_db_writer(self, timeout: float = 5.0) -> None:
        """Signal the writer thread to drain and exit. Used in lifespan shutdown."""
        self._writer_stop.set()
        if self._writer_thread is not None:
            self._writer_thread.join(timeout=timeout)
            self._writer_thread = None

    def dropped_writes(self) -> int:
        """Return the count of records dropped due to queue overflow."""
        return self._dropped_writes

    def _writer_loop(self) -> None:
        """Pull records off the queue, batch them, write to log_repo."""
        # Lazy import: keeps the buffer importable without a configured
        # DB (unit tests, scripts that just want an in-memory log tail).
        from backend.db import log_repo

        last_flush = time.monotonic()
        pending: list[dict[str, Any]] = []
        own_logger = logging.getLogger(__name__)

        while not self._writer_stop.is_set():
            timeout = max(0.1, _WRITE_FLUSH_INTERVAL - (time.monotonic() - last_flush))
            try:
                rec = self._write_queue.get(timeout=timeout)
                pending.append(rec)
            except queue.Empty:
                pass

            should_flush = pending and (
                len(pending) >= _WRITE_BATCH_MAX
                or (time.monotonic() - last_flush) >= _WRITE_FLUSH_INTERVAL
            )
            if not should_flush:
                continue

            try:
                log_repo.insert_batch(pending)
            except Exception as e:
                # Don't recurse: the failure is itself a log event the
                # buffer will capture, but we suppress emitting *into*
                # the persistence layer to avoid a feedback loop.
                own_logger.warning(
                    "log persistence flush failed (%d records): %s", len(pending), e
                )
            pending.clear()
            last_flush = time.monotonic()

        # Drain whatever's left on shutdown
        while True:
            try:
                pending.append(self._write_queue.get_nowait())
            except queue.Empty:
                break
        if pending:
            try:
                from backend.db import log_repo as _final_log_repo

                _final_log_repo.insert_batch(pending)
            except Exception:
                pass  # shutting down — best-effort only

    @staticmethod
    def _record_to_dict(record: logging.LogRecord) -> dict[str, Any]:
        message = record.getMessage()
        component = _component_from_logger(record.name)
        capture_id = _extract_capture_id(message)
        payload: dict[str, Any] = {
            "ts": record.created,  # epoch seconds, float
            "level": record.levelname,
            "logger": record.name,
            "component": component,
            "message": message,
            "capture_id": capture_id,
        }
        if record.exc_info:
            payload["exc_text"] = logging.Formatter().formatException(record.exc_info)
        # Surface any structured extras (slowapi/observability middleware adds these)
        for key in ("request_id", "method", "path", "status_code", "duration_ms"):
            if key in record.__dict__:
                payload[key] = record.__dict__[key]
        return payload


def _component_from_logger(name: str) -> str:
    """Map ``backend.services.clustering_service`` → ``cluster`` style tag."""
    short = name.split(".")[-1] if "." in name else name
    # Friendlier aliases for the UI badges
    aliases = {
        "main": "api",
        "raw_html_archiver": "archive",
        "clustering_service": "cluster",
        "super_cluster_service": "cluster",
        "graph_builder": "graph",
        "graph_service": "graph",
        "rag_pipeline": "rag",
        "vector_store": "rag",
        "content_repo": "db",
        "page_repo": "db",
        "capture_repo": "db",
        "connection": "db",
        "content_extractor": "extract",
        "content_fetcher": "extract",
        "sbert_loader": "sbert",
        "agent": "agent",
    }
    return aliases.get(short, short)


def _extract_capture_id(message: str) -> str | None:
    match = _capture_id_re.search(message)
    if not match:
        return None
    candidate = match.group(1)
    # Common false positives: skip numeric-only snippets or timestamps
    if candidate.isdigit() and len(candidate) < 10:
        return None
    return candidate


# Module-level singleton — installed by main.py on startup
_buffer: RingBufferHandler | None = None


def get_buffer() -> RingBufferHandler:
    """Return the process-wide buffer, instantiating on first call."""
    global _buffer
    if _buffer is None:
        _buffer = RingBufferHandler()
    return _buffer
