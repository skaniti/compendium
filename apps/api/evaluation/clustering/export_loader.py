"""Read-only loader for a table export (``<table>.jsonl.gz``, one JSON object per row).

The export is a snapshot of the production tables the clustering pipeline reads
(``pages``, ``page_content``, ``captures``, the two embedding caches and the cluster
tables of past runs). :class:`ExportSnapshot` reproduces, in memory, exactly the rows
``page_repo.get_active_pages`` would return, so the harness can push them through the
unchanged ``ClusteringService`` conversion/filter/HDBSCAN code without a database.

Robustness: an export produced with credential redaction can hold a few truncated lines;
they are counted in :attr:`ExportSnapshot.skipped_lines` and skipped, never guessed at.
"""

from __future__ import annotations

import gzip
import json
import logging
from collections import Counter
from datetime import datetime
from functools import cache, lru_cache
from pathlib import Path

logger = logging.getLogger(__name__)

_DECODER = json.JSONDecoder(strict=False)


def _sort_instant(value) -> tuple:
    """Sort key for ISO timestamps (NULLs last), tolerant of unparseable strings."""
    if value is None:
        return (1, 0.0, "")
    try:
        return (0, datetime.fromisoformat(str(value)).timestamp(), "")
    except ValueError:
        return (0, float("inf"), str(value))


def _parse_vector(value) -> list[float]:
    """pgvector text (``"[0.1,0.2]"``) or an already-parsed list -> list of floats."""
    if isinstance(value, str):
        return [float(x) for x in value.strip("[]").split(",") if x]
    return [float(x) for x in value]


class ExportSnapshot:
    """Lazy, cached access to the tables of one export directory."""

    def __init__(self, export_dir: str | Path):
        self.export_dir = Path(export_dir)
        if not self.export_dir.is_dir():
            raise FileNotFoundError(f"export directory not found: {self.export_dir}")
        self.skipped_lines: Counter = Counter()

    # ── raw tables ───────────────────────────────────────────────────────

    def table_path(self, table: str) -> Path:
        return self.export_dir / f"{table}.jsonl.gz"

    @cache  # noqa: B019 -- one snapshot object per process
    def table(self, table: str) -> list[dict]:
        """All parseable rows of ``table`` (empty list when the file is absent)."""
        path = self.table_path(table)
        if not path.exists():
            logger.warning("export table missing: %s", path.name)
            return []
        rows: list[dict] = []
        with gzip.open(path, "rt", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rows.append(_DECODER.decode(line))
                except ValueError:
                    self.skipped_lines[table] += 1
        if self.skipped_lines[table]:
            logger.warning(
                "export table %s: skipped %d unparseable line(s)",
                table,
                self.skipped_lines[table],
            )
        return rows

    # ── derived views ────────────────────────────────────────────────────

    def user_ids(self) -> list[int]:
        """User ids present on captures, most pages first."""
        counts = Counter(c.get("user_id") for c in self.table("captures"))
        return [u for u, _ in counts.most_common() if u is not None]

    def active_page_rows(self, user_id: int, as_of: str | None = None) -> list[dict]:
        """Rows in the shape of ``page_repo.get_active_pages(user_id)``.

        Mirrors the SQL: pages JOIN captures (user scope) LEFT JOIN page_content,
        ``COALESCE(human_status, status) = 'active'``, ordered by ``visited_at``
        ascending with NULLs last. ``as_of`` (ISO timestamp) drops pages created after
        that instant, approximating the page set a stored run saw when the export is
        newer than the run (status changes since then cannot be undone).
        """
        captures = {c["id"]: c for c in self.table("captures") if c.get("user_id") == user_id}
        content = {c["id"]: c for c in self.table("page_content") if "id" in c}
        rows: list[dict] = []
        for p in self.table("pages"):
            cap = captures.get(p.get("capture_id"))
            if cap is None:
                continue
            if (p.get("human_status") or p.get("status")) != "active":
                continue
            if as_of is not None and (p.get("created_at") or "") > as_of:
                continue
            pc = content.get(p.get("page_content_id")) or {}
            rows.append(
                {
                    "id": p["id"],
                    "url": p.get("url"),
                    "title": p.get("title"),
                    "domain": p.get("domain"),
                    "dwell_time_seconds": p.get("dwell_time_seconds"),
                    "visited_at": p.get("visited_at"),
                    "status": p.get("status"),
                    "processing_depth": p.get("processing_depth"),
                    "content_summary": p.get("content_summary"),
                    "page_content_id": p.get("page_content_id"),
                    "capture_id": p.get("capture_id"),
                    "content_extracted_text": pc.get("extracted_text"),
                    "fetched_content": pc.get("fetched_content"),
                    "content_level_summary": pc.get("content_summary"),
                    "tool_selected": pc.get("tool_selected"),
                    "capture_text_id": cap.get("capture_id"),
                    "is_learning": pc.get("is_learning"),
                    # Columns added by later migrations; absent in older exports.
                    "normalized_url": p.get("normalized_url"),
                    "content_kind": pc.get("content_kind"),
                }
            )
        rows.sort(key=lambda r: _sort_instant(r["visited_at"]))
        return rows

    def embeddings(self, model_key: str) -> dict[int, list[float]]:
        """``{page_content_id: vector}`` from the cache table matching ``model_key``.

        ``model_key`` is ``"<model>@<contract>"`` for ``clustering_embeddings`` (the API
        embedding path) or a bare model name for the legacy ``page_embeddings`` table.
        """
        out: dict[int, list[float]] = {}
        if "@" in model_key:
            for r in self.table("clustering_embeddings"):
                if r.get("model_key") == model_key and r.get("embedding") is not None:
                    out[int(r["page_content_id"])] = _parse_vector(r["embedding"])
        else:
            for r in self.table("page_embeddings"):
                if r.get("model_name", model_key) == model_key and r.get("embedding") is not None:
                    out[int(r["page_content_id"])] = _parse_vector(r["embedding"])
        return out

    def run_assignments(self, run_id: int) -> dict[int, int]:
        """``{page_id: cluster_id}`` for the clusters of a stored recluster run.

        Pages of the run that only appear in ``featured_singletons`` map to -1. Pages
        that were filtered or left as unlisted noise are absent; callers add them with
        -1 over whatever page universe they compare on.
        """
        cluster_ids = {c["id"] for c in self.table("clusters") if c.get("recluster_run") == run_id}
        assign: dict[int, int] = {}
        for pc in self.table("page_clusters"):
            if pc.get("cluster_id") in cluster_ids:
                assign[int(pc["page_id"])] = int(pc["cluster_id"])
        for fs in self.table("featured_singletons"):
            if fs.get("recluster_run") == run_id:
                assign.setdefault(int(fs["page_id"]), -1)
        return assign

    def run_started_at(self, run_id: int) -> str | None:
        """``started_at`` of a stored recluster run (ISO string), or None."""
        for r in self.table("recluster_runs"):
            if r.get("id") == run_id:
                return r.get("started_at")
        return None

    def latest_completed_run(self, user_id: int | None = None) -> int | None:
        runs = [
            r
            for r in self.table("recluster_runs")
            if r.get("status") == "completed" and (user_id is None or r.get("user_id") == user_id)
        ]
        return max((int(r["id"]) for r in runs), default=None)
