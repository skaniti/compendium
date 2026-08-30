"""DB-backed URLLookup for the chat_importer verification cascade.

Read-only by construction: SELECT-only against `pages` (visit log).
Conforms to the URLLookup Protocol in verifier.py.

L3 queries `pages.normalized_url` rather than `page_content.normalized_url`
because the user's "browsing history" must include visits where skip_gate
chose not to store content (product pages, icon libraries -- exactly the
URLs the chat-import was motivated by). page_content is post-skip_gate
canonical content, a strict subset of pages.
"""
from __future__ import annotations

from backend.db.connection import get_conn


class PgURLLookup:
    """URLLookup backed by the user's compendium DB (`pages` table)."""

    def known_urls(self, normalized_urls: set[str]) -> set[str]:
        if not normalized_urls:
            return set()
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT DISTINCT normalized_url FROM pages "
                    "WHERE normalized_url = ANY(%s)",
                    (list(normalized_urls),),
                )
                return {row[0] for row in cur.fetchall()}

    def known_domains(self, domains: set[str]) -> set[str]:
        if not domains:
            return set()
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT DISTINCT domain FROM pages "
                    "WHERE domain = ANY(%s)",
                    (list(domains),),
                )
                return {row[0] for row in cur.fetchall()}
