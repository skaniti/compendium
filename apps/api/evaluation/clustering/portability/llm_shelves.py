"""Prototype: LLM grouping of label subtopics into shelves (no embedding thresholds).

Two variants share one state machine:

- ``fixed``: shelves live inside the fixed 26-key taxonomy. The first time a category is
  seen, one *group* call clusters its distinct subtopic strings into named shelves; after
  that, new strings are *placed* in chunks: each place call lists every existing shelf of
  the category and returns, per string, an existing shelf id or a new shelf name.
- ``induced``: one *induce* call over the user's first distinct strings proposes the
  user's own categories and their shelves; later place calls list every shelf of every
  induced category and return (shelf id) or (new shelf name + induced category id).

Calls are built as Message Batches lines and their results applied, so the same code runs
against the Batches API (offline evaluation) or a synchronous client. Distinct strings are
memoised by ``shelf_service.normalize_subtopic`` (same string -> same shelf, as the
canonicaliser does). A string the model leaves out stays unplaced and is retried in the next
wave; a string still unplaced after the last wave is noise.
"""

from __future__ import annotations

import json
import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field

from backend.services.label_first_clustering import CATEGORY_LABELS
from backend.services.shelf_service import normalize_subtopic

MODEL = "claude-haiku-5-5"
GROUP_MAX_STRINGS = 1500
"""Most distinct strings one group/induce call receives (larger first waves are placed)."""
PLACE_CHUNK = 150
"""New strings per place call."""

GROUP_SYSTEM = {
    "a": (
        "You organise one reader's saved web pages into topic shelves, like a careful librarian. "
        "Each page already has a short subtopic label. Group the labels you are given into shelves. "
        "A shelf is a topic a reader would browse as one unit and holds roughly 5-40 pages; "
        "labels that are different wordings of the same topic, or narrow cases of it, share a shelf. "
        "Do not make a shelf per label, and do not lump unrelated topics into one shelf. Every label "
        "goes to exactly one shelf. Shelf names: 2-5 words, general plural nouns, no articles."
    ),
    "b": (
        "You organise one reader's saved web pages into topic shelves, like a careful librarian. "
        "Each page already has a short subtopic label (with its page count). Group the labels into "
        "shelves. Aim for about one shelf per 15-25 pages in total: merge labels that a reader "
        "interested in the field would expect to find side by side, and keep apart labels that "
        "belong to clearly different fields. Every label goes to exactly one shelf. Shelf names: "
        "2-5 words, general plural nouns, no articles."
    ),
}

PLACE_SYSTEM = (
    "You maintain one reader's topic shelves of saved web pages, like a careful librarian. "
    "New pages arrive with short subtopic labels. For each new label, pick the existing shelf "
    "where the reader would expect to find it. Only if no existing shelf fits, give a new shelf "
    "name (2-5 words, general plural nouns, no articles); new labels in the same list that "
    "belong together must get the same new name. Prefer existing shelves; a shelf holds "
    "roughly 5-40 pages, so do not create a shelf for a mere rewording of an existing one."
)

INDUCE_SYSTEM = (
    "You organise one reader's saved web pages. Each page has a short subtopic label. From the "
    "labels you are given, propose this reader's own top-level categories (between 8 and 30, "
    "named for what this reader actually reads, each 1-4 words), and inside them topic shelves "
    "that each hold roughly 5-40 pages; labels that are different wordings of the same topic share "
    "a shelf. Every label goes to exactly one shelf and every shelf to exactly one category. "
    "Shelf names: 2-5 words, general plural nouns, no articles."
)

GROUP_SCHEMA = {
    "type": "object",
    "properties": {
        "shelves": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "members": {"type": "array", "items": {"type": "integer"}},
                },
                "required": ["name", "members"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["shelves"],
    "additionalProperties": False,
}

INDUCE_SCHEMA = {
    "type": "object",
    "properties": {
        "categories": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "shelves": GROUP_SCHEMA["properties"]["shelves"],
                },
                "required": ["name", "shelves"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["categories"],
    "additionalProperties": False,
}

PLACE_SCHEMA = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "i": {"type": "integer"},
                    "shelf_id": {"type": ["integer", "null"]},
                    "new_shelf": {"type": ["string", "null"]},
                    "category_id": {"type": ["integer", "null"]},
                },
                "required": ["i", "shelf_id", "new_shelf", "category_id"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["items"],
    "additionalProperties": False,
}

_WS = re.compile(r"\s+")


def _clean_name(name: str) -> str:
    return _WS.sub(" ", (name or "").strip().strip("\"'.")).strip()[:80]


def _request(custom_id: str, system: str, user: str, schema: dict, max_tokens: int) -> dict:
    return {
        "custom_id": custom_id,
        "params": {
            "model": MODEL,
            "max_tokens": int(max_tokens),
            "system": system,
            "messages": [{"role": "user", "content": user}],
            "output_config": {"format": {"type": "json_schema", "schema": schema}},
            "thinking": {"type": "disabled"},
        },
    }


@dataclass
class ShelfState:
    """All shelves of one user under one variant; JSON-serialisable."""

    variant: str  # "fixed" | "induced"
    prompt: str = "a"
    shelves: dict[int, dict] = field(default_factory=dict)  # id -> {name, category}
    string_shelf: dict[str, int] = field(default_factory=dict)  # memo key -> shelf id
    categories: list[str] = field(default_factory=list)  # induced category names
    stats: Counter = field(default_factory=Counter)

    # ── persistence ──
    def to_json(self) -> dict:
        return {
            "variant": self.variant,
            "prompt": self.prompt,
            "shelves": {str(k): v for k, v in self.shelves.items()},
            "string_shelf": self.string_shelf,
            "categories": self.categories,
            "stats": dict(self.stats),
        }

    @classmethod
    def from_json(cls, d: dict) -> ShelfState:
        s = cls(d["variant"], d.get("prompt", "a"))
        s.shelves = {int(k): v for k, v in d["shelves"].items()}
        s.string_shelf = dict(d["string_shelf"])
        s.categories = list(d.get("categories") or [])
        s.stats = Counter(d.get("stats") or {})
        return s

    # ── helpers ──
    def key(self, category: str, subtopic: str) -> str:
        norm = normalize_subtopic(subtopic)
        return f"{category}||{norm}" if self.variant == "fixed" else norm

    def _new_shelf(self, name: str, category: str) -> int:
        sid = max(self.shelves, default=0) + 1
        self.shelves[sid] = {"name": _clean_name(name) or "Unnamed", "category": category}
        return sid

    def _shelf_by_name(self, category: str) -> dict[str, int]:
        return {
            normalize_subtopic(s["name"]): sid
            for sid, s in self.shelves.items()
            if s["category"] == category
        }

    def category_shelves(self, category: str) -> list[int]:
        return [sid for sid, s in self.shelves.items() if s["category"] == category]

    def assign(self, items: list[tuple[int, str, str]]) -> dict[int, int]:
        """page id -> shelf id (``-1`` when the page's string was never placed)."""
        out = {}
        for pid, cat, sub in items:
            out[pid] = self.string_shelf.get(self.key(cat, sub), -1)
        return out


def new_strings(state: ShelfState, items: list[tuple[int, str, str]]) -> dict[str, list]:
    """Group the not-yet-memoised strings of ``items`` (page order) by scope.

    Returns scope -> list of [key, display string, page count] in first-seen order;
    the scope is the category (fixed) or ``"*"`` (induced).
    """
    seen: dict[str, list] = {}
    order: dict[str, list[str]] = defaultdict(list)
    for _pid, cat, sub in items:
        if not (sub or "").strip():
            continue
        k = state.key(cat, sub)
        if k in state.string_shelf:
            continue
        if k not in seen:
            scope = cat if state.variant == "fixed" else "*"
            seen[k] = [k, normalize_subtopic(sub), 0, scope]
            order[scope].append(k)
        seen[k][2] += 1
    return {scope: [seen[k][:3] for k in keys] for scope, keys in order.items()}


def _lines(strings: list[list], with_counts: bool = True) -> str:
    return "\n".join(
        f"{i}. {s[1]}" + (f" ({s[2]} pages)" if with_counts else "")
        for i, s in enumerate(strings, 1)
    )


def build_requests(state: ShelfState, items, prefix: str) -> tuple[list[dict], dict]:
    """Requests for one wave: group/induce calls for unseen scopes, place calls otherwise.

    Returns (request lines, pending) where pending maps custom_id -> what to apply.
    """
    reqs: list[dict] = []
    pending: dict[str, dict] = {}
    todo = new_strings(state, items)
    n = 0
    for scope, strings in todo.items():
        has_shelves = (
            bool(state.category_shelves(scope)) if state.variant == "fixed" else bool(state.shelves)
        )
        if not has_shelves:
            head, rest = strings[:GROUP_MAX_STRINGS], strings[GROUP_MAX_STRINGS:]
            cid = f"{prefix}_g{n:05d}"
            n += 1
            if state.variant == "fixed":
                label = CATEGORY_LABELS.get(scope, scope)
                user = (
                    f"Category: {label}\n{len(head)} subtopic labels, with the number of pages "
                    f"carrying each:\n{_lines(head)}\n\nReturn the shelves; members are label numbers."
                )
                reqs.append(
                    _request(cid, GROUP_SYSTEM[state.prompt], user, GROUP_SCHEMA, 14 * len(head) + 1500)
                )
                pending[cid] = {"op": "group", "scope": scope, "strings": head}
            else:
                user = (
                    f"{len(head)} subtopic labels, with the number of pages carrying each:\n"
                    f"{_lines(head)}\n\nReturn the categories with their shelves; members are label numbers."
                )
                reqs.append(_request(cid, INDUCE_SYSTEM, user, INDUCE_SCHEMA, 14 * len(head) + 3000))
                pending[cid] = {"op": "induce", "scope": scope, "strings": head}
            if rest:  # cannot be placed until the group call returns: next wave
                state.stats["deferred_strings"] += len(rest)
            continue
        for start in range(0, len(strings), PLACE_CHUNK):
            chunk = strings[start : start + PLACE_CHUNK]
            cid = f"{prefix}_p{n:05d}"
            n += 1
            if state.variant == "fixed":
                sids = state.category_shelves(scope)
                shelf_lines = "\n".join(f"[{sid}] {state.shelves[sid]['name']}" for sid in sids)
                label = CATEGORY_LABELS.get(scope, scope)
                user = (
                    f"Category: {label}\nExisting shelves:\n{shelf_lines}\n\nNew labels:\n"
                    f"{_lines(chunk)}\n\nFor every new label return i, shelf_id (an existing id) "
                    f"or new_shelf (a new name); category_id is always null."
                )
            else:
                cats = "\n".join(f"<{j}> {c}" for j, c in enumerate(state.categories))
                by_cat = defaultdict(list)
                for sid, s in state.shelves.items():
                    by_cat[s["category"]].append(sid)
                blocks = []
                for j, c in enumerate(state.categories):
                    blocks.append(
                        f"<{j}> {c}:\n" + "\n".join(f"  [{sid}] {state.shelves[sid]['name']}" for sid in by_cat[c])
                    )
                user = (
                    f"Categories:\n{cats}\n\nExisting shelves by category:\n" + "\n".join(blocks)
                    + f"\n\nNew labels:\n{_lines(chunk)}\n\nFor every new label return i, shelf_id "
                    f"(an existing id) or new_shelf (a new name) with category_id (the <number> "
                    f"of its category); shelf_id null when new_shelf is given."
                )
            reqs.append(_request(cid, PLACE_SYSTEM, user, PLACE_SCHEMA, 40 * len(chunk) + 500))
            pending[cid] = {"op": "place", "scope": scope, "strings": chunk}
    return reqs, pending


def _members(entries, n: int) -> list[tuple[str, list[int]]]:
    out = []
    for e in entries or []:
        if not isinstance(e, dict):
            continue
        idx = [int(m) for m in e.get("members") or [] if isinstance(m, int) and 1 <= m <= n]
        out.append((_clean_name(e.get("name") or ""), idx))
    return out


def apply_result(state: ShelfState, job: dict, text: str | None) -> None:
    """Apply one call's output (``None`` = failed call) to ``state``; fail-open per string."""
    strings = job["strings"]
    try:
        data = json.loads(text) if text else None
    except (json.JSONDecodeError, TypeError):
        data = None
    if data is None:
        state.stats[f"{job['op']}_failed_calls"] += 1
    placed: set[int] = set()
    scope = job["scope"]
    if job["op"] == "group" and data:
        names = state._shelf_by_name(scope)
        for name, idx in _members(data.get("shelves"), len(strings)):
            idx = [i for i in idx if i not in placed]
            if not idx:
                continue
            key = normalize_subtopic(name)
            sid = names.get(key) or state._new_shelf(name, scope)
            names[key] = sid
            for i in idx:
                state.string_shelf[strings[i - 1][0]] = sid
                placed.add(i)
    elif job["op"] == "induce" and data:
        for cat in data.get("categories") or []:
            cname = _clean_name((cat or {}).get("name") or "")
            if not cname:
                continue
            if cname not in state.categories:
                state.categories.append(cname)
            names = state._shelf_by_name(cname)
            for name, idx in _members(cat.get("shelves"), len(strings)):
                idx = [i for i in idx if i not in placed]
                if not idx:
                    continue
                key = normalize_subtopic(name)
                sid = names.get(key) or state._new_shelf(name, cname)
                names[key] = sid
                for i in idx:
                    state.string_shelf[strings[i - 1][0]] = sid
                    placed.add(i)
    elif job["op"] == "place" and data:
        valid = (
            set(state.category_shelves(scope)) if state.variant == "fixed" else set(state.shelves)
        )
        name_cache: dict[tuple[str, str], int] = {}
        for it in data.get("items") or []:
            if not isinstance(it, dict):
                continue
            i = it.get("i")
            if not isinstance(i, int) or not 1 <= i <= len(strings) or i in placed:
                continue
            sid = it.get("shelf_id")
            if isinstance(sid, int) and sid in valid:
                state.string_shelf[strings[i - 1][0]] = sid
                state.stats["placed_existing"] += 1
                placed.add(i)
                continue
            name = _clean_name(it.get("new_shelf") or "")
            if not name:
                continue
            if state.variant == "fixed":
                cat = scope
            else:
                cj = it.get("category_id")
                cat = (
                    state.categories[cj]
                    if isinstance(cj, int) and 0 <= cj < len(state.categories)
                    else (state.categories[0] if state.categories else "Other")
                )
            key = (cat, normalize_subtopic(name))
            if key not in name_cache:
                name_cache[key] = state._shelf_by_name(cat).get(key[1]) or state._new_shelf(name, cat)
                state.stats["placed_new_shelf"] += 1
            state.string_shelf[strings[i - 1][0]] = name_cache[key]
            placed.add(i)
    # strings the model left out stay unmemoised: the next wave places them (a string never
    # placed by the final wave is noise, like an unshelved page in production)
    state.stats[f"{job['op']}_omitted_strings"] += sum(
        1 for s in strings if s[0] not in state.string_shelf
    )


def cluster_assignment(state: ShelfState, items, min_cluster_size: int = 3):
    """(page -> cluster or -1, page -> supercluster or -1) with the production size band."""
    shelf_of = state.assign(items)
    sizes = Counter(s for s in shelf_of.values() if s != -1)
    assign, sup = {}, {}
    for pid, sid in shelf_of.items():
        if sid == -1 or sizes[sid] < min_cluster_size:
            assign[pid], sup[pid] = -1, -1
        else:
            assign[pid] = sid
            sup[pid] = state.shelves[sid]["category"]
    return assign, sup
