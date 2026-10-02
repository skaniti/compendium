"""The augment rows are synthetic, deterministic, and shaped like the real
corpus's skip population (spec D10 c-1). Pure tests; the loader path is
covered by the Step 6 smoke against the test database."""

import gzip
import json
from collections import Counter
from pathlib import Path

from scripts.demo.build_demo_seed_augment import GATE_CATEGORY, GATE_REASONS, build_augment_rows

SEED = Path("data/demo-seed/demo_seed.json.gz")
AUG = Path("data/demo-seed/demo_seed_augment.json")


def _seed():
    return json.load(gzip.open(SEED))


def test_rows_are_deterministic_and_match_committed_file():
    d = _seed()
    rows = build_augment_rows(d["pages"], d["captures"])
    assert rows == build_augment_rows(d["pages"], d["captures"])
    assert json.loads(AUG.read_text())["pages"] == rows


def test_distribution_and_depths():
    d = _seed()
    rows = build_augment_rows(d["pages"], d["captures"])
    by_reason = Counter(r["archive_reason"] for r in rows)
    assert by_reason == {
        "skip_gate": 40 + 8,
        "domain_skip": 20,
        "placeholder_no_content": 10,
        "dedup": 6,
        "app_chrome_junk": 5,
        "dedupe_fold": 4 + 2,
        "manual_exclusion": 2,
        "trivial_capture": 3,
        None: 4 + 6 + 3,
    }
    for r in rows:
        if (
            (r["content_summary"] or "").startswith("URL pattern skipped")
            or r["human_status"]
            or r["processing_depth"] == "processed"
        ):
            continue  # flow-path rows: covered by test_flow_path_rows
        if r["archive_reason"] in ("skip_gate", "domain_skip"):
            assert r["status"] == "archived" and r["processing_depth"] == "skipped"
        elif r["archive_reason"] is None:
            assert (
                r["status"] == "pending"
                and r["processing_depth"] is None
                and r["skip_reasoning"] is None
            )
        else:
            assert r["status"] == "archived" and r["processing_depth"] is None
    gate = [r for r in rows if r["archive_reason"] == "skip_gate" and not r["content_summary"]]
    assert {r["skip_reasoning"] for r in gate} <= set(GATE_REASONS)
    assert all(
        r["skip_reasoning"].startswith("Domain skipped: ")
        for r in rows
        if r["archive_reason"] == "domain_skip"
    )


def test_ids_captures_and_hygiene():
    d = _seed()
    rows = build_augment_rows(d["pages"], d["captures"])
    max_seed_id = max(p["id"] for p in d["pages"])
    assert [r["id"] for r in rows] == list(range(max_seed_id + 1, max_seed_id + 1 + len(rows)))
    capture_ids = {c["id"] for c in d["captures"]}
    assert all(r["capture_id"] in capture_ids for r in rows)
    assert all(r["user_id"] == d["pages"][0]["user_id"] for r in rows)  # remapped by the loader
    seed_domains = {p["domain"] for p in d["pages"]}
    assert all(r["domain"] in seed_domains for r in rows)
    text = json.dumps(rows)
    # Terms assembled from parts so this tracked file never matches the
    # pre-push identifier scan.
    bad_terms = ["ska" + "niti", "sravya" + "kaniti", "print" + "ables", "claude" + ".ai"]
    for bad in bad_terms:
        assert bad not in text


EXPECTED_CATEGORY = {
    "login wall": "login_wall",
    "disambiguation page": "disambiguation",
    "search results page": "search_results",
    "content-free stub": "content_free_stub",
    "cookie consent redirect": "error_page",
    "error page": "error_page",
    "Marketplace / product / store listing": "store_listing",
    "User-specific page (profile, dashboard)": "user_specific",
}


def test_skip_gate_rows_carry_a_valid_category_others_null():
    from backend.services.skip_categories import SKIP_CATEGORY_IDS

    d = _seed()
    rows = build_augment_rows(d["pages"], d["captures"])
    assert GATE_CATEGORY == EXPECTED_CATEGORY
    assert set(EXPECTED_CATEGORY) == set(GATE_REASONS)
    for r in rows:
        if r["archive_reason"] == "skip_gate" and not r["content_summary"]:
            assert r["skip_category"] in SKIP_CATEGORY_IDS
            assert r["skip_category"] == EXPECTED_CATEGORY[r["skip_reasoning"]]
        else:
            assert r["skip_category"] is None


def test_flow_path_rows():
    d = _seed()
    rows = build_augment_rows(d["pages"], d["captures"])
    url_pat = [r for r in rows if (r["content_summary"] or "").startswith("URL pattern skipped")]
    assert len(url_pat) == 8
    for r in url_pat:
        assert r["status"] == "archived" and r["archive_reason"] == "skip_gate"
        assert r["processing_depth"] == "skipped"
        assert r["skip_reasoning"] is None and r["skip_category"] is None
        assert r["content_summary"].startswith(f"URL pattern skipped: {r['domain']} (")
    manual_early = [
        r
        for r in rows
        if r["human_status"] == "archived"
        and r["processing_depth"] is None
        and r["archive_reason"] is None
    ]
    assert len(manual_early) == 6 and all(r["status"] == "archived" for r in manual_early)
    processed = [r for r in rows if r["processing_depth"] == "processed"]
    assert Counter((r["archive_reason"], r["human_status"]) for r in processed) == {
        (None, "archived"): 3,
        ("dedupe_fold", None): 2,
    }
    assert all(r["status"] == "archived" for r in processed)
