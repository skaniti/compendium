"""Shared synthetic-data helpers for the page-label tests (no real page data)."""

import json
from datetime import datetime, timezone

from backend.db import capture_repo, content_repo, page_repo, user_repo
from backend.db.connection import get_conn
from backend.services.llm_service import LLMProvider, LLMResponse

TRUNCATE_SQL = """
    TRUNCATE page_labels, cost_events, graph_cache, cluster_edges, page_clusters, clusters,
             recluster_runs, pages, page_content, captures, users CASCADE
"""


def truncate():
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(TRUNCATE_SQL)


def sql(query, params=()):
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(query, params)
        return cur.fetchall() if cur.description else None


def make_user(name="labeller"):
    return user_repo.create_user(f"{name}@example.test", name=name.title())


def make_page(user, cap, name, *, minute=0, text="body text", status="active", day=15):
    """Insert one page + content row; return (page_id, content_id)."""
    url = f"https://{name}.example.test/page"
    cid = content_repo.get_or_create_content(
        url, extracted_text=text, content_summary=f"summary of {name}"
    )["id"]
    pid = page_repo.insert_pages(
        cap["id"],
        [
            {
                "url": url,
                "title": f"Synthetic page {name}",
                "domain": f"{name}.example.test",
                "visited_at": datetime(2026, 3, day, 10, minute, tzinfo=timezone.utc),
                "dwell_time_seconds": 30,
                "extracted_text": text,
            }
        ],
    )[0]
    sql(
        "UPDATE pages SET page_content_id=%s, status=%s, content_summary=%s WHERE id=%s",
        (cid, status, f"summary of {name}", pid),
    )
    return pid, cid


def make_capture(user, capture_id="cap_lbl"):
    return capture_repo.save_capture(
        user_id=user["id"],
        capture_id=capture_id,
        source="desktop_active",
        started_at=datetime(2026, 3, 15, 10, 0, tzinfo=timezone.utc),
        ended_at=datetime(2026, 3, 15, 11, 0, tzinfo=timezone.utc),
    )


def item(page_id, **over):
    base = {
        "page_id": page_id,
        "category": "science_nature",
        "subtopic": "Synthetic shelf",
        "entity": None,
        "specificity": "narrow_topic",
        "content_kind": "article_reference",
        "knowledge_value": "keep",
        "evidence_level": "text",
        "language": "en",
        "flags": [],
        "private_sensitive": False,
        "confidence": 0.9,
    }
    base.update(over)
    return base


def llm_response(content, input_tokens=600, output_tokens=100, cost=0.0011):
    return LLMResponse(
        content=content if isinstance(content, str) else json.dumps(content),
        model="claude-haiku-5-5",
        provider=LLMProvider.ANTHROPIC,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        total_tokens=input_tokens + output_tokens,
        latency_ms=1.0,
        cost_usd=cost,
    )


class FakeLLM:
    """Stands in for LLMService: answers every request by labelling the page ids
    found in the user text; ``handler(call_index, prompt) -> str | Exception``
    overrides that."""

    def __init__(self, handler=None):
        self.calls: list[dict] = []
        self.handler = handler

    async def complete(self, prompt, **kwargs):
        self.calls.append({"prompt": prompt, **kwargs})
        if self.handler:
            out = self.handler(len(self.calls) - 1, prompt)
            if isinstance(out, Exception):
                raise out
            return llm_response(out)
        import re

        ids = [int(x) for x in re.findall(r"### page_id: (\d+)", prompt)]
        return llm_response({"items": [item(i, subtopic=f"Shelf {i}") for i in ids]})
