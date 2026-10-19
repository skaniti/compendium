"""Label-first with embedding thresholds (the current design), driven offline.

Runs the production ``ShelfCanonicaliser`` (real ``ShelfIndex``, attach/ask/create logic)
over a user's labelled pages in arrival order. The "same shelf?" model call cannot be made
synchronously offline, so ``AskCache`` answers from a cache of earlier batch answers keyed
by the exact prompt; a prompt not in the cache is recorded as pending and answered "no"
(the production fail-open). Re-running after the pending prompts were answered converges
on what a live run would do; the residue of unanswered asks is reported.

Because the canonicaliser is sequential and sizes are nested, one pass over the largest
size yields the smaller sizes by snapshotting ``shelf_of`` after N pages.
"""

from __future__ import annotations

import hashlib
import json
from collections import defaultdict
from collections.abc import Callable

import numpy as np

from backend.prompts.templates import get_prompt_raw
from backend.services import shelf_service as ss


class TitleStore(ss.MemoryShelfStore):
    """Memory store with O(1) example titles (production reads page titles from the DB)."""

    def __init__(self, titles: dict[int, str]):
        super().__init__()
        self._titles = titles
        self._examples: dict[int, list[str]] = defaultdict(list)

    def upsert_shelf_page(self, shelf_id, page_content_id, subtopic, method, similarity) -> None:
        super().upsert_shelf_page(shelf_id, page_content_id, subtopic, method, similarity)
        ex = self._examples[shelf_id]
        if len(ex) < ss.EXAMPLE_TITLES:
            ex.append(self._titles.get(page_content_id) or subtopic)

    def get_example_titles(self, shelf_id, n=3) -> list[str]:
        return list(self._examples.get(shelf_id, []))[:n]


def ask_prompt(subtopic: str, shelf: dict) -> str:
    return get_prompt_raw(
        "shelf_same_v1",
        shelf_name=shelf["name"],
        category=shelf["category"],
        titles=ss._titles_block(shelf.get("example_titles", [])),
        subtopic=subtopic,
    )


def prompt_key(prompt: str) -> str:
    return hashlib.sha1(prompt.encode("utf-8")).hexdigest()[:20]


class AskCache:
    """``ask`` callable answering from cached batch answers; unknown prompts -> pending, no."""

    def __init__(self, answers: dict[str, bool] | None = None, mode: str = "cache"):
        self.answers = answers or {}
        self.mode = mode  # cache | never
        self.pending: dict[str, str] = {}
        self.asked = self.answered = self.defaulted = 0

    def __call__(self, subtopic: str, shelf: dict) -> bool:
        self.asked += 1
        if self.mode == "never":
            return False
        p = ask_prompt(subtopic, shelf)
        k = prompt_key(p)
        if k in self.answers:
            self.answered += 1
            return self.answers[k]
        self.pending[k] = p
        self.defaulted += 1
        return False


def ask_request(key: str, prompt: str) -> dict:
    """Batch line for one same-shelf prompt (production sends it as the user message)."""
    return {
        "custom_id": f"ask_{key}",
        "params": {
            "model": "claude-haiku-5-5",
            "max_tokens": 40,
            "messages": [{"role": "user", "content": prompt}],
            "thinking": {"type": "disabled"},
        },
    }


def run_canonicaliser(
    items: list[tuple[int, dict]],
    embed: Callable[[list[str]], np.ndarray],
    titles: dict[int, str],
    attach: float,
    ask: float,
    asker: AskCache,
    snapshots: tuple[int, ...],
    order_of: dict[int, int],
):
    """Assign ``items`` (page id, label) in order; return {size: (shelf_of, shelves, timing)} snapshots.

    ``order_of`` gives each page's arrival position; a snapshot at N holds the pages with
    position < N. Shelf categories are those of the creating label.
    """
    config = ss.ShelfConfig(attach=attach, ask=ask, merge_distance=0.15, soft_cap=10**9, min_cluster_size=1)
    store = TitleStore(titles)
    canon = ss.ShelfCanonicaliser(ss.ShelfIndex(), embed, asker, config, store)
    import resource
    import time

    out = {}
    t0 = time.perf_counter()
    c0 = time.process_time()

    def snap():
        return (
            dict(shelf_of),
            {s["id"]: {"name": s["name"], "category": s["category"]} for s in store.list_shelves()},
            {
                "wall_s": round(time.perf_counter() - t0, 2),
                "cpu_s": round(time.process_time() - c0, 2),
                "peak_rss_mb": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1),
                "asked": asker.asked,
                "shelves": len(store.shelves),
            },
        )

    snaps = sorted(snapshots)
    shelf_of: dict[int, int] = {}
    si = 0
    # assign in order, in blocks between snapshots (one embed call per block, as assign_many does)
    block: list[tuple[int, dict]] = []
    def flush():
        nonlocal block
        if block:
            res = canon.assign_many(block)
            shelf_of.update({cid: r.shelf_id for cid, r in res.items()})
            block = []
    for cid, label in items:
        while si < len(snaps) and order_of[cid] >= snaps[si]:
            flush()
            out[snaps[si]] = snap()
            si += 1
        block.append((cid, label))
    flush()
    while si < len(snaps):
        out[snaps[si]] = snap()
        si += 1
    return out


def partition(shelf_of: dict[int, int], shelves: dict[int, dict], labels: dict[int, dict], page_ids, min_size: int = 3):
    """Production ``build_partition`` semantics on ids: (assign, super)."""
    from backend.services.label_first_clustering import build_partition
    from backend.services.clustering_service import EXCLUDED_CONTENT_KINDS

    pages = [{"page_content_id": pid} for pid in page_ids]
    shelves_rows = {sid: {"name": s["name"], "stable_id": sid, "category": s["category"]} for sid, s in shelves.items()}
    part = build_partition(pages, labels, shelf_of, shelves_rows, min_size, excluded_kinds=EXCLUDED_CONTENT_KINDS)
    assign, sup = {}, {}
    for pid, c in zip(page_ids, part.labels):
        c = int(c)
        assign[pid] = c
        sup[pid] = part.cluster_category.get(c, -1) if c != -1 else -1
    return assign, sup, part.stats
