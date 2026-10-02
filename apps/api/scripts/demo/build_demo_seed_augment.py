"""Generate demo_seed_augment.json: SYNTHETIC archived / skipped / pending
pages attached to the demo seed's existing captures, so the Pipeline dev
view (and the recorded demo-stub fixtures) have a skip/archive population
to show. Temporary: retired by the demo-seed-maturity re-export (D10 c-2).

Deterministic (no RNG, no clock): re-running against the same seed rewrites
an identical file. Rows carry no page_content / embeddings / clusters --
archived pages have none in the real corpus either -- and never appear in
the graph or diary (both count active pages only).

    cd apps/api && python scripts/demo/build_demo_seed_augment.py
"""

from __future__ import annotations

import gzip
import json
from itertools import cycle
from pathlib import Path

SEED_PATH = Path(__file__).resolve().parents[2] / "data" / "demo-seed" / "demo_seed.json.gz"
OUT_PATH = SEED_PATH.with_name("demo_seed_augment.json")

GATE_REASONS = (
    "login wall",
    "disambiguation page",
    "search results page",
    "content-free stub",
    "cookie consent redirect",
    "error page",
    "Marketplace / product / store listing",
    "User-specific page (profile, dashboard)",
)

# Category (backend.services.skip_categories ids) matching each gate reason.
GATE_CATEGORY = {
    "login wall": "login_wall",
    "disambiguation page": "disambiguation",
    "search results page": "search_results",
    "content-free stub": "content_free_stub",
    "cookie consent redirect": "error_page",
    "error page": "error_page",
    "Marketplace / product / store listing": "store_listing",
    "User-specific page (profile, dashboard)": "user_specific",
}

# (archive_reason, count, processing_depth, status) -- mirrors the real
# corpus's shape (2026-08-25 capture): gate + domain skips carry depth
# 'skipped'; the placeholder/dedup/chrome family has NULL depth ("Other").
PLAN = (
    ("skip_gate", 40, "skipped", "archived"),
    ("domain_skip", 20, "skipped", "archived"),
    ("placeholder_no_content", 10, None, "archived"),
    ("dedup", 6, None, "archived"),
    ("app_chrome_junk", 5, None, "archived"),
    ("dedupe_fold", 4, None, "archived"),
    ("manual_exclusion", 2, None, "archived"),
    ("trivial_capture", 3, None, "archived"),
    (None, 4, None, "pending"),
)

# Flow-path rows (pipeline flow redesign): (kind, archive_reason, count, depth, human_status).
# kind "url_pattern" rows are rule-filter skips recognised by content_summary;
# the rest exercise before-gate manual archives and processed-then-archived pages.
FLOW_PLAN = (
    ("url_pattern", "skip_gate", 8, "skipped", None),
    ("manual_early", None, 6, None, "archived"),
    ("processed_manual", None, 3, "processed", "archived"),
    ("processed_duplicate", "dedupe_fold", 2, "processed", None),
)

# Plausible public junk on the seed's own domains: (domain, url template, title template).
JUNK = (
    (
        "en.wikipedia.org",
        "https://en.wikipedia.org/w/index.php?search={q}&title=Special:Search",
        'Search results for "{q}" - Wikipedia',
    ),
    (
        "en.wikipedia.org",
        "https://en.wikipedia.org/wiki/{Q}_(disambiguation)",
        "{Q} (disambiguation) - Wikipedia",
    ),
    (
        "en.wikipedia.org",
        "https://en.wikipedia.org/w/index.php?title=Special:UserLogin&returnto={Q}",
        "Log in - Wikipedia",
    ),
    (
        "arxiv.org",
        "https://arxiv.org/search/?query={q}&searchtype=all",
        "Search | arXiv e-print repository",
    ),
    ("arxiv.org", "https://arxiv.org/login?next={q}", "Login | arXiv"),
    ("github.com", "https://github.com/login?return_to={q}", "Sign in to GitHub"),
    ("github.com", "https://github.com/search?q={q}", "Search: {q}"),
    (
        "www.gutenberg.org",
        "https://www.gutenberg.org/ebooks/search/?query={q}",
        "Search results for {q} | Project Gutenberg",
    ),
)
QUERIES = (
    "diffusion",
    "mercury",
    "entropy",
    "graph",
    "lattice",
    "orbit",
    "cipher",
    "prism",
    "quasar",
    "tensor",
    "isotope",
    "comet",
)


def build_augment_rows(seed_pages: list[dict], seed_captures: list[dict]) -> list[dict]:
    next_id = max(p["id"] for p in seed_pages) + 1
    user_id = seed_pages[0]["user_id"]
    captures = sorted(seed_captures, key=lambda c: c["id"])
    cap_cycle = cycle(captures)
    junk_cycle = cycle(JUNK)
    q_cycle = cycle(QUERIES)
    gate_cycle = cycle(GATE_REASONS)
    rows: list[dict] = []
    for reason, count, depth, status in PLAN:
        for _ in range(count):
            cap = next(cap_cycle)
            domain, url_t, title_t = next(junk_cycle)
            q = next(q_cycle)
            url = url_t.format(q=q, Q=q.capitalize())
            category = None
            if reason == "skip_gate":
                reasoning = next(gate_cycle)
                category = GATE_CATEGORY[reasoning]
            elif reason == "domain_skip":
                reasoning = f"Domain skipped: {domain}"
            else:
                reasoning = None
            rows.append(
                {
                    "id": next_id,
                    "url": url,
                    "title": title_t.format(q=q, Q=q.capitalize()),
                    "domain": domain,
                    "status": status,
                    "user_id": user_id,
                    "capture_id": cap["id"],
                    "created_at": cap["started_at"],
                    "visited_at": cap["started_at"],
                    "human_status": None,
                    "archive_reason": reason,
                    "extracted_text": None,
                    "normalized_url": url,
                    "skip_reasoning": reasoning,
                    "skip_category": category,
                    "content_summary": "Domain skipped" if reason == "domain_skip" else None,
                    "page_content_id": None,
                    "transition_type": "link",
                    "processing_depth": depth,
                    "is_tracked_domain": True,
                    "dwell_time_seconds": 3,
                    "flagged_for_review": False,
                    "processing_metadata": None,
                    "transition_qualifiers": None,
                    "human_processing_depth": None,
                }
            )
            next_id += 1
    rows.extend(_flow_rows(next_id, user_id, captures, cap_cycle, junk_cycle, q_cycle))
    return rows


def _flow_rows(next_id, user_id, captures, cap_cycle, junk_cycle, q_cycle) -> list[dict]:
    rows: list[dict] = []
    for kind, reason, count, depth, human_status in FLOW_PLAN:
        for i in range(count):
            cap = next(cap_cycle)
            domain, url_t, title_t = next(junk_cycle)
            q = next(q_cycle)
            url = url_t.format(q=q, Q=q.capitalize())
            url_pattern = kind == "url_pattern"
            rows.append(
                {
                    "id": next_id,
                    "url": url,
                    "title": title_t.format(q=q, Q=q.capitalize()),
                    "domain": domain,
                    "status": "archived",
                    "user_id": user_id,
                    "capture_id": cap["id"],
                    "created_at": cap["started_at"],
                    "visited_at": cap["started_at"],
                    "human_status": human_status,
                    "archive_reason": reason,
                    "extracted_text": None,
                    "normalized_url": url,
                    "skip_reasoning": None,
                    "skip_category": None,
                    "content_summary": (
                        f"URL pattern skipped: {domain} ({3 + i}s)" if url_pattern else None
                    ),
                    "page_content_id": None,
                    "transition_type": "link",
                    "processing_depth": depth,
                    "is_tracked_domain": True,
                    "dwell_time_seconds": 3,
                    "flagged_for_review": False,
                    "processing_metadata": None,
                    "transition_qualifiers": None,
                    "human_processing_depth": None,
                }
            )
            next_id += 1
    return rows


def main() -> None:
    with gzip.open(SEED_PATH, "rt", encoding="utf-8") as f:
        seed = json.load(f)
    rows = build_augment_rows(seed["pages"], seed["captures"])
    out = {
        "manifest": {
            "generated_by": "scripts/demo/build_demo_seed_augment.py",
            "source_seed_export_date": seed["manifest"]["export_date"],
            "row_counts": {"pages": len(rows)},
            "synthetic": True,
        },
        "pages": rows,
    }
    OUT_PATH.write_text(json.dumps(out, indent=1) + "\n")
    print(f"wrote {OUT_PATH} ({len(rows)} pages)")


if __name__ == "__main__":
    main()
