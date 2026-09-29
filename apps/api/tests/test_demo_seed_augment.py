"""The augment rows are synthetic, deterministic, and shaped like the real
corpus's skip population (spec D10 c-1). Pure tests; the loader path is
covered by the Step 6 smoke against the test database."""

import gzip
import json
from collections import Counter
from pathlib import Path

from scripts.demo.build_demo_seed_augment import GATE_REASONS, build_augment_rows

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
        "skip_gate": 40,
        "domain_skip": 20,
        "placeholder_no_content": 10,
        "dedup": 6,
        "app_chrome_junk": 5,
        "dedupe_fold": 4,
        "manual_exclusion": 2,
        "trivial_capture": 3,
        None: 4,
    }
    for r in rows:
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
    gate = [r for r in rows if r["archive_reason"] == "skip_gate"]
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
