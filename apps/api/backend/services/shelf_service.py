"""Shelf canonicalisation: turn free-text page-label subtopics into stable shelves.

Why: the labeller emits a free-text ``subtopic`` per page ("storage bins",
"bin storage"...). Grouping directly on those strings would split one topic
into many and rename clusters every run. A *shelf* is the canonical, durable
topic: each new subtopic string is embedded and either attached to the nearest
shelf (cosine >= attach), put to a cheap yes/no model question (ask <= cosine
< attach), or becomes a new shelf. A shelf's ``stable_id`` is minted once and
is what the clusterer carries as the cluster's ``stable_id``.

The core (:class:`ShelfCanonicaliser`) needs no database and no network: the
embedder (``Callable[[list[str]], np.ndarray]``, L2-normalised rows), the
``ask`` callable and the :class:`ShelfStore` are all injected, so the offline
evaluation harness reuses it with :class:`MemoryShelfStore`. The DB-backed
entry points at the bottom are all gated by ``settings.label_first_enabled``.
"""

from __future__ import annotations

import logging
import re
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol

import numpy as np

from backend.config.settings import settings

logger = logging.getLogger(__name__)

_PUNCT_RE = re.compile(r"[^\w\s]", re.UNICODE)
_WS_RE = re.compile(r"\s+")
_ARTICLES = {"the", "a", "an"}
EXAMPLE_TITLES = 3

EmbedFn = Callable[[list[str]], np.ndarray]
AskFn = Callable[[str, dict], bool]


# ── config ───────────────────────────────────────────────────────────────


@dataclass
class ShelfConfig:
    attach: float = 0.80
    ask: float = 0.65
    merge_distance: float = 0.15
    soft_cap: int = 40
    min_cluster_size: int = 3

    @classmethod
    def from_settings(cls) -> ShelfConfig:
        """The single place settings are read (defaults keep this branch standalone)."""
        g = lambda name, default: getattr(settings, name, default)
        return cls(
            attach=float(g("shelf_attach_threshold", 0.80)),
            ask=float(g("shelf_ask_threshold", 0.65)),
            merge_distance=float(g("shelf_merge_distance", 0.15)),
            soft_cap=int(g("shelf_soft_cap", 40)),
            min_cluster_size=int(g("shelf_min_cluster_size", 3)),
        )


def _enabled() -> bool:
    return bool(getattr(settings, "label_first_enabled", False))


# ── text helpers ─────────────────────────────────────────────────────────


def normalize_subtopic(s: str) -> str:
    """Memo key: lowercase, punctuation stripped, whitespace collapsed, leading article dropped."""
    text = _WS_RE.sub(" ", _PUNCT_RE.sub(" ", (s or "").lower())).strip()
    words = text.split(" ") if text else []
    while len(words) > 1 and words[0] in _ARTICLES:
        words.pop(0)
    return " ".join(words)


def _shelf_name(subtopic: str) -> str:
    """Capitalise each word's first letter, leaving the rest alone ("iPhone" survives)."""
    words = _WS_RE.sub(" ", (subtopic or "").strip()).split(" ")
    return " ".join(w[:1].upper() + w[1:] for w in words if w)


def _unit(vec) -> np.ndarray:
    v = np.asarray(vec, dtype=np.float64)
    n = np.linalg.norm(v)
    return v / n if n > 0 else v


# ── index ────────────────────────────────────────────────────────────────


class ShelfIndex:
    """In-memory shelf vocabulary with an O(#shelves) numpy nearest-neighbour."""

    def __init__(self, shelves: list[dict] | None = None):
        self._shelves: dict[int, dict] = {}
        self._rows: dict[int, int] = {}
        self._ids: list[int] = []
        self._mat: np.ndarray | None = None
        for s in shelves or []:
            self.add(s)

    def __len__(self) -> int:
        return len(self._ids)

    def get(self, shelf_id: int) -> dict | None:
        return self._shelves.get(shelf_id)

    def shelves(self) -> list[dict]:
        return [self._shelves[i] for i in self._ids]

    def add(self, shelf: dict) -> None:
        """Add (or replace) a shelf; ``centroid`` is coerced to a unit float64 array."""
        if shelf.get("centroid") is None:
            return
        vec = _unit(shelf["centroid"])
        shelf["centroid"] = vec
        shelf.setdefault("n_pages", 0)
        sid = shelf["id"]
        if sid in self._rows:
            self._shelves[sid] = shelf
            self._mat[self._rows[sid]] = vec
            return
        n = len(self._ids)
        if self._mat is None:
            self._mat = np.zeros((16, vec.shape[0]), dtype=np.float64)
        elif n >= self._mat.shape[0]:
            grown = np.zeros((self._mat.shape[0] * 2, self._mat.shape[1]), dtype=np.float64)
            grown[:n] = self._mat[:n]
            self._mat = grown
        self._mat[n] = vec
        self._rows[sid] = n
        self._ids.append(sid)
        self._shelves[sid] = shelf

    def remove(self, shelf_id: int) -> None:
        """Drop a shelf (merged away); rebuilds the matrix, which is rare."""
        if shelf_id not in self._rows:
            return
        keep = [self._shelves[i] for i in self._ids if i != shelf_id]
        self.__init__(keep)

    def nearest(self, vec) -> tuple[dict | None, float]:
        if not self._ids:
            return None, 0.0
        sims = self._mat[: len(self._ids)] @ _unit(vec)
        j = int(np.argmax(sims))
        return self._shelves[self._ids[j]], float(sims[j])

    def update_centroid(self, shelf_id: int, vec, n: int) -> None:
        """Running mean: ``centroid = (centroid*n + vec) / (n+1)``, renormalised; sets n_pages=n+1."""
        shelf = self._shelves[shelf_id]
        new = _unit(shelf["centroid"] * n + np.asarray(vec, dtype=np.float64) * 1.0)
        shelf["centroid"] = new
        shelf["n_pages"] = n + 1
        self._mat[self._rows[shelf_id]] = new

    def set_centroid(self, shelf_id: int, vec, n_pages: int) -> None:
        shelf = self._shelves[shelf_id]
        shelf["centroid"] = _unit(vec)
        shelf["n_pages"] = n_pages
        self._mat[self._rows[shelf_id]] = shelf["centroid"]


# ── stores ───────────────────────────────────────────────────────────────


class ShelfStore(Protocol):
    """Persistence for one user's shelves. Implementations are bound to a user."""

    def create_shelf(self, name: str, category: str, centroid, n_pages: int = 0) -> dict: ...
    def update_shelf(self, shelf_id: int, **fields) -> None: ...
    def list_shelves(self) -> list[dict]: ...
    def upsert_shelf_page(
        self, shelf_id: int, page_content_id: int, subtopic: str, method: str, similarity: float
    ) -> None: ...
    def get_shelf_string(self, subtopic_norm: str) -> int | None: ...
    def set_shelf_string(self, subtopic_norm: str, shelf_id: int) -> None: ...
    def get_example_titles(self, shelf_id: int, n: int = 3) -> list[str]: ...
    def pages_for_shelf(self, shelf_id: int) -> list[int]: ...
    def page_subtopics(self, shelf_id: int) -> dict[int, str]: ...
    def move_pages(
        self, from_id: int, to_id: int, method: str, content_ids: list[int] | None = None
    ) -> None: ...
    def repoint_strings(self, from_id: int, to_id: int) -> None: ...


class MemoryShelfStore:
    """Dict-backed store for tests and the offline harness (mints uuid4 stable ids)."""

    def __init__(self, user_id: int = 0):
        self.user_id = user_id
        self.shelves: dict[int, dict] = {}
        self.pages: dict[int, dict] = {}  # content_id -> {shelf_id, subtopic, method, similarity}
        self.strings: dict[str, int] = {}
        self._next = 1

    def create_shelf(self, name, category, centroid, n_pages=0) -> dict:
        shelf = {
            "id": self._next,
            "user_id": self.user_id,
            "stable_id": str(uuid.uuid4()),
            "name": name,
            "category": category,
            "centroid": None if centroid is None else np.array(centroid, dtype=np.float64),
            "n_pages": n_pages,
            "status": "active",
            "merged_into": None,
        }
        self._next += 1
        self.shelves[shelf["id"]] = shelf
        return dict(shelf)

    def update_shelf(self, shelf_id, **fields) -> None:
        if "centroid" in fields and fields["centroid"] is not None:
            fields["centroid"] = np.array(fields["centroid"], dtype=np.float64)
        self.shelves[shelf_id].update(fields)

    def list_shelves(self) -> list[dict]:
        return [dict(s) for s in self.shelves.values() if s["status"] == "active"]

    def upsert_shelf_page(self, shelf_id, page_content_id, subtopic, method, similarity) -> None:
        self.pages[page_content_id] = {
            "shelf_id": shelf_id,
            "subtopic": subtopic,
            "method": method,
            "similarity": similarity,
        }

    def get_shelf_string(self, subtopic_norm):
        return self.strings.get(subtopic_norm)

    def set_shelf_string(self, subtopic_norm, shelf_id) -> None:
        self.strings[subtopic_norm] = shelf_id

    def get_example_titles(self, shelf_id, n=3) -> list[str]:
        out: list[str] = []
        for p in self.pages.values():  # no titles in memory: distinct raw subtopics
            if p["shelf_id"] == shelf_id and p["subtopic"] not in out:
                out.append(p["subtopic"])
            if len(out) >= n:
                break
        return out

    def pages_for_shelf(self, shelf_id) -> list[int]:
        return sorted(c for c, p in self.pages.items() if p["shelf_id"] == shelf_id)

    def page_subtopics(self, shelf_id) -> dict[int, str]:
        return {c: p["subtopic"] for c, p in self.pages.items() if p["shelf_id"] == shelf_id}

    def move_pages(self, from_id, to_id, method, content_ids=None) -> None:
        for c, p in self.pages.items():
            if p["shelf_id"] == from_id and (content_ids is None or c in content_ids):
                p["shelf_id"] = to_id
                p["method"] = method

    def repoint_strings(self, from_id, to_id) -> None:
        for k, v in list(self.strings.items()):
            if v == from_id:
                self.strings[k] = to_id


class DbShelfStore:
    """:mod:`backend.db.shelf_repo`-backed store bound to one user."""

    def __init__(self, user_id: int, embedder_key: str | None = None):
        self.user_id = user_id
        self.embedder_key = embedder_key

    def create_shelf(self, name, category, centroid, n_pages=0) -> dict:
        from backend.db import shelf_repo

        return shelf_repo.create_shelf(
            self.user_id, name, category, centroid, self.embedder_key, n_pages
        )

    def update_shelf(self, shelf_id, **fields) -> None:
        from backend.db import shelf_repo

        shelf_repo.update_shelf(shelf_id, **fields)

    def list_shelves(self) -> list[dict]:
        from backend.db import shelf_repo

        return shelf_repo.get_shelves(self.user_id)

    def upsert_shelf_page(self, shelf_id, page_content_id, subtopic, method, similarity) -> None:
        from backend.db import shelf_repo

        shelf_repo.upsert_shelf_page(
            shelf_id, page_content_id, self.user_id, subtopic, method, similarity
        )

    def get_shelf_string(self, subtopic_norm):
        from backend.db import shelf_repo

        return shelf_repo.get_shelf_string(self.user_id, subtopic_norm)

    def set_shelf_string(self, subtopic_norm, shelf_id) -> None:
        from backend.db import shelf_repo

        shelf_repo.set_shelf_string(self.user_id, subtopic_norm, shelf_id)

    def get_example_titles(self, shelf_id, n=3) -> list[str]:
        from backend.db import shelf_repo

        titles = shelf_repo.get_example_titles(shelf_id, n)
        if titles:
            return titles
        return list(dict.fromkeys(shelf_repo.get_page_subtopics(shelf_id).values()))[:n]

    def pages_for_shelf(self, shelf_id) -> list[int]:
        from backend.db import shelf_repo

        return shelf_repo.get_pages_for_shelf(shelf_id)

    def page_subtopics(self, shelf_id) -> dict[int, str]:
        from backend.db import shelf_repo

        return shelf_repo.get_page_subtopics(shelf_id)

    def move_pages(self, from_id, to_id, method, content_ids=None) -> None:
        from backend.db import shelf_repo

        shelf_repo.move_shelf_pages(from_id, to_id, method, content_ids)

    def repoint_strings(self, from_id, to_id) -> None:
        from backend.db import shelf_repo

        shelf_repo.repoint_shelf_strings(from_id, to_id)


# ── canonicaliser ────────────────────────────────────────────────────────


@dataclass
class AssignResult:
    shelf_id: int
    method: str  # attach | ask | create
    similarity: float
    created: bool = False
    stable_id: str | None = None


class ShelfCanonicaliser:
    """Assign page labels to shelves. No DB, no network: everything is injected."""

    def __init__(
        self,
        index: ShelfIndex,
        embed: EmbedFn,
        ask: AskFn | None,
        config: ShelfConfig,
        store: ShelfStore,
    ):
        self.index = index
        self.embed = embed
        self.ask = ask
        self.config = config
        self.store = store
        self.asked = 0
        self._vecs: dict[str, np.ndarray] = {}  # normalised string -> vector (this instance)

    def assign(self, page_content_id: int, label: dict) -> AssignResult:
        return self.assign_many([(page_content_id, label)])[page_content_id]

    def assign_many(self, items: list[tuple[int, dict]]) -> dict[int, AssignResult]:
        """Embed every not-yet-memoised string in ONE call, then assign in order.

        Sequential processing means a shelf created for one string is visible
        to the next, so near-duplicates in the same batch collapse.
        """
        out: dict[int, AssignResult] = {}
        if not items:
            return out
        todo: list[str] = []
        seen: set[str] = set()
        for _, label in items:
            norm = normalize_subtopic(label["subtopic"])
            if norm in seen or norm in self._vecs:
                continue
            seen.add(norm)
            if self._memo_shelf(norm) is None:
                todo.append(norm)
        if todo:
            mat = np.asarray(self.embed(todo), dtype=np.float64)
            for norm, row in zip(todo, mat):
                self._vecs[norm] = _unit(row)
        for cid, label in items:
            out[cid] = self._assign_one(cid, label)
        return out

    def _memo_shelf(self, norm: str) -> dict | None:
        sid = self.store.get_shelf_string(norm)
        return self.index.get(sid) if sid is not None else None

    def _assign_one(self, cid: int, label: dict) -> AssignResult:
        subtopic = label["subtopic"]
        norm = normalize_subtopic(subtopic)
        vec = self._vecs.get(norm)
        shelf = self._memo_shelf(norm)
        if shelf is not None:
            method, sim, created = "attach", 1.0, False
        else:
            if vec is None:  # memo pointed at a shelf no longer active; re-embed
                vec = _unit(self.embed([norm])[0])
                self._vecs[norm] = vec
            shelf, sim = self.index.nearest(vec)
            created = False
            if shelf is not None and sim >= self.config.attach:
                method = "attach"
            elif shelf is not None and sim >= self.config.ask and self._ask(subtopic, shelf):
                method = "ask"
            else:
                method = "create"
        if method == "create":
            made = self.store.create_shelf(
                _shelf_name(subtopic), label.get("category") or "other", vec, 1
            )
            made["centroid"] = vec.copy()
            made["n_pages"] = 1
            self.index.add(made)
            shelf, sim, created = made, 1.0, True
        elif vec is not None:
            self.index.update_centroid(shelf["id"], vec, shelf["n_pages"])
            self.store.update_shelf(
                shelf["id"], centroid=shelf["centroid"], n_pages=shelf["n_pages"]
            )
        else:  # defensive: no vector, count only
            shelf["n_pages"] += 1
            self.store.update_shelf(shelf["id"], n_pages=shelf["n_pages"])
        self.store.set_shelf_string(norm, shelf["id"])
        self.store.upsert_shelf_page(shelf["id"], cid, subtopic, method, sim)
        return AssignResult(shelf["id"], method, sim, created, shelf.get("stable_id"))

    def _ask(self, subtopic: str, shelf: dict) -> bool:
        if self.ask is None:
            return False
        view = {
            "name": shelf["name"],
            "category": shelf["category"],
            "example_titles": self.store.get_example_titles(shelf["id"], EXAMPLE_TITLES),
        }
        self.asked += 1
        try:
            return bool(self.ask(subtopic, view))
        except Exception:
            logger.warning("shelf ask failed; creating a new shelf", exc_info=True)
            return False


# ── LLM callables (fail-open) ────────────────────────────────────────────


def _complete_blocking(prompt: str) -> tuple[str, float]:
    """One short model call from sync code; returns (text, cost_usd)."""
    from backend.services.clustering_service import _run_coro_blocking
    from backend.services.llm_service import LLMService

    model = getattr(settings, "label_model", "claude-haiku-5-5")
    resp = _run_coro_blocking(
        LLMService().complete(prompt, model=model, temperature=0, max_tokens=40)
    )
    return (resp.content or "").strip(), float(getattr(resp, "cost_usd", 0.0) or 0.0)


def _titles_block(titles: list[str]) -> str:
    return "\n".join(f"- {t}" for t in titles) or "- (none)"


class _Asker:
    """Base for LLM callables: accumulates ``cost_usd``; any error is swallowed."""

    def __init__(self):
        self.cost_usd = 0.0

    def _call(self, prompt: str) -> str | None:
        try:
            text, cost = _complete_blocking(prompt)
            self.cost_usd += cost
            return text
        except Exception:
            logger.warning("shelf LLM call failed (fail-open)", exc_info=True)
            return None


def _is_yes(text: str | None) -> bool:
    return bool(text) and text.strip().lower().startswith("yes")


class SameShelfAsker(_Asker):
    """``ask`` callable: is this subtopic the same topic as the shelf?"""

    def __call__(self, subtopic: str, shelf: dict) -> bool:
        from backend.prompts.templates import get_prompt_raw

        prompt = get_prompt_raw(
            "shelf_same_v1",
            shelf_name=shelf["name"],
            category=shelf["category"],
            titles=_titles_block(shelf.get("example_titles", [])),
            subtopic=subtopic,
        )
        return _is_yes(self._call(prompt))


def ask_same_shelf(subtopic: str, shelf: dict) -> bool:
    """Default ``ask``: yes/no on ``settings.label_model``; fail-open → False (create)."""
    return SameShelfAsker()(subtopic, shelf)


class MergeAsker(_Asker):
    """``ask_merge`` callable: should shelf A and B be merged?"""

    def __call__(self, a: dict, b: dict) -> bool:
        from backend.prompts.templates import get_prompt_raw

        prompt = get_prompt_raw(
            "shelf_merge_v1",
            name_a=a["name"],
            category_a=a["category"],
            titles_a=_titles_block(a.get("example_titles", [])),
            name_b=b["name"],
            category_b=b["category"],
            titles_b=_titles_block(b.get("example_titles", [])),
        )
        return _is_yes(self._call(prompt))


class SplitNamer(_Asker):
    """``ask_split_name`` callable: name for the smaller half of a split, or None."""

    def __call__(self, shelf: dict, subtopics: list[str]) -> str | None:
        from backend.prompts.templates import get_prompt_raw

        prompt = get_prompt_raw(
            "shelf_split_name_v1",
            shelf_name=shelf["name"],
            category=shelf["category"],
            subtopics=_titles_block(subtopics),
        )
        text = self._call(prompt)
        name = _WS_RE.sub(" ", (text or "").splitlines()[0]).strip(" \"'.") if text else ""
        return name[:80] or None


# ── DB-backed entry points ───────────────────────────────────────────────


def _excluded(label: dict) -> bool:
    from backend.services.clustering_service import EXCLUDED_CONTENT_KINDS

    return label.get("knowledge_value") == "exclude" or (
        label.get("content_kind") in EXCLUDED_CONTENT_KINDS
    )


def _get_labels(content_ids: list[int]) -> dict[int, dict]:
    try:
        from backend.db import page_label_repo
    except ImportError:
        logger.info("page_label_repo not available; nothing to shelve")
        return {}
    return page_label_repo.get_labels(content_ids)


def _build_canonicaliser(user_id: int) -> ShelfCanonicaliser:
    from functools import partial

    from backend.services import text_embedder

    store = DbShelfStore(user_id, embedder_key=text_embedder.embedder_key())
    index = ShelfIndex(store.list_shelves())
    return ShelfCanonicaliser(
        index,
        partial(text_embedder.embed_texts, user_id=user_id),
        SameShelfAsker(),
        ShelfConfig.from_settings(),
        store,
    )


def assign_new_labels(user_id: int, content_ids: list[int]) -> dict[int, AssignResult]:
    """Shelve the labelled, non-excluded, not-yet-shelved content ids. ``{}`` when flag off."""
    if not _enabled() or not content_ids:
        return {}
    from backend.db import shelf_repo

    labels = _get_labels(list(content_ids))
    shelved = shelf_repo.get_shelf_pages(user_id)
    items = [
        (cid, lab)
        for cid, lab in sorted(labels.items())
        if cid not in shelved and not _excluded(lab) and (lab.get("subtopic") or "").strip()
    ]
    if not items:
        return {}
    return _build_canonicaliser(user_id).assign_many(items)


def assign_all_unshelved(user_id: int) -> dict:
    """Catch-up: shelve every labelled, non-excluded content id of the user with no shelf row.

    Returns ``{"assigned": n, "created": n, "asked": n}`` (``{}`` when flag off).
    """
    if not _enabled():
        return {}
    from backend.db import shelf_repo
    from backend.db.connection import get_conn

    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
                SELECT DISTINCT p.page_content_id FROM pages p
                 WHERE p.user_id = %s AND p.status = 'active' AND p.page_content_id IS NOT NULL
                """,
            (user_id,),
        )
        ids = [r[0] for r in cur.fetchall()]
    shelved = shelf_repo.get_shelf_pages(user_id)
    ids = [i for i in ids if i not in shelved]
    labels = _get_labels(ids)
    items = [
        (cid, lab)
        for cid, lab in sorted(labels.items())
        if not _excluded(lab) and (lab.get("subtopic") or "").strip()
    ]
    if not items:
        return {"assigned": 0, "created": 0, "asked": 0}
    canon = _build_canonicaliser(user_id)
    res = canon.assign_many(items)
    return {
        "assigned": len(res),
        "created": sum(1 for r in res.values() if r.created),
        "asked": canon.asked,
    }
