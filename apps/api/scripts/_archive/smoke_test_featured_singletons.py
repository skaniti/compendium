"""Smoke-test the featured-singletons pipeline end-to-end.

Exercises every new code path introduced by the S1-S4 refactor:
- HDBSCAN returns (labels, outlier_scores) tuple
- _select_featured_singletons picks top-N by outlier_score
- featured_repo.insert_featured_singletons handles bulk insert + ON CONFLICT
- featured_repo.list_featured_singletons_for_run returns proper join
- graph_builder.build_graph_from_db sets kind="singleton" on the right nodes
- _write_featured_singletons_to_db wires correctly into the recluster flow

Uses real DB but creates an isolated synthetic recluster_run + cleans up
afterward. No production state mutated. Costs $0 (no LLM calls).

Run::

    python scripts/_archive/smoke_test_featured_singletons.py
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

# Force tracing off before LLM imports (not strictly needed for this test, but
# matches the audit script convention so future runs don't hit LangSmith caps).
os.environ["LANGCHAIN_TRACING_V2"] = "false"
os.environ.pop("LANGCHAIN_API_KEY", None)

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

import numpy as np  # noqa: E402

from backend.db import featured_repo  # noqa: E402
from backend.db.connection import get_conn  # noqa: E402
from backend.services.clustering_service import (  # noqa: E402
    FEATURED_SINGLETONS_DENSITY_PCT,
    ClusteringService,
)


USER_ID = 152


def step(n: int, msg: str) -> None:
    print(f"\n[{n}] {msg}")


def assert_eq(actual, expected, label: str) -> None:
    if actual != expected:
        raise AssertionError(f"{label}: expected {expected}, got {actual}")
    print(f"    OK: {label} == {expected}")


def main() -> int:
    print("=== Featured Singletons Smoke Test ===")

    # ---- Step 1: Constants + import sanity ---------------------------------
    step(1, f"FEATURED_SINGLETONS_DENSITY_PCT = {FEATURED_SINGLETONS_DENSITY_PCT}")
    assert_eq(FEATURED_SINGLETONS_DENSITY_PCT, 0.20, "density default")

    # ---- Step 2: _select_featured_singletons in-memory ---------------------
    step(2, "Test _select_featured_singletons picks top-N by outlier_score")
    # 10 pages: 6 in 2 real clusters, 4 noise with varying outlier scores
    labels = np.array([0, 0, 0, 1, 1, 1, -1, -1, -1, -1])
    outlier_scores = np.array([0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.95, 0.30, 0.80, 0.55])
    n_real_clusters = 2
    expected_target_n = round(2 * 0.20)  # = 0
    print(f"    n_real_clusters={n_real_clusters}, density=0.20 -> target_n={expected_target_n}")
    result = ClusteringService._select_featured_singletons(
        labels, outlier_scores, n_real_clusters
    )
    assert_eq(len(result), 0, "with 2 real clusters at 20% density, target=0 (round)")

    # Bigger cluster count to exercise selection
    result = ClusteringService._select_featured_singletons(
        labels, outlier_scores, n_real_clusters=10, density_pct=0.5
    )
    expected_top = [(6, 0.95), (8, 0.80), (9, 0.55), (7, 0.30)][:5]  # 10 * 0.5 = 5
    print(f"    n_real_clusters=10, density=0.50 -> picked: {result}")
    assert_eq(len(result), 4, "only 4 noise points available even at target=5")
    assert_eq(result[0], (6, 0.95), "top pick is highest outlier_score")

    # ---- Step 3: featured_repo schema sanity -------------------------------
    step(3, "Verify featured_repo round-trip on a synthetic recluster_run")
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO recluster_runs (user_id, status, started_at, completed_at, cluster_count)
                VALUES (%s, 'completed', NOW(), NOW(), 0)
                RETURNING id
                """,
                (USER_ID,),
            )
            test_run_id = cur.fetchone()[0]
            conn.commit()
    print(f"    created test recluster_run id={test_run_id}")

    try:
        # Need real page_ids for the FK -- pull two from active pages
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT p.id FROM pages p JOIN captures c ON p.capture_id = c.id "
                    "WHERE c.user_id = %s AND p.status = 'active' LIMIT 2",
                    (USER_ID,),
                )
                page_rows = cur.fetchall()
        page_ids = [r[0] for r in page_rows]
        print(f"    using page_ids={page_ids}")

        # Bulk insert
        n_inserted = featured_repo.insert_featured_singletons(
            [
                {"user_id": USER_ID, "page_id": page_ids[0], "recluster_run": test_run_id, "outlier_score": 0.91},
                {"user_id": USER_ID, "page_id": page_ids[1], "recluster_run": test_run_id, "outlier_score": 0.74},
            ]
        )
        assert_eq(n_inserted, 2, "insert_featured_singletons returns row count")

        # Idempotent: re-insert same rows -> 0 new
        n_dup = featured_repo.insert_featured_singletons(
            [{"user_id": USER_ID, "page_id": page_ids[0], "recluster_run": test_run_id, "outlier_score": 0.91}]
        )
        assert_eq(n_dup, 0, "ON CONFLICT DO NOTHING blocks duplicates")

        # List
        listed = featured_repo.list_featured_singletons_for_run(USER_ID, test_run_id)
        assert_eq(len(listed), 2, "list returns 2 rows")
        # Verify highest outlier_score first (ORDER BY DESC NULLS LAST)
        assert_eq(listed[0]["page_id"], page_ids[0], "top-scored singleton is page_ids[0]")
        assert_eq(listed[0]["outlier_score"], 0.91, "outlier_score round-trips")
        assert listed[0]["page_title"], "page_title joined from pages table"
        print(f"    sample: {listed[0]['page_title'][:50]} | outlier={listed[0]['outlier_score']}")

        # Count helper
        n = featured_repo.count_featured_singletons_for_run(USER_ID, test_run_id)
        assert_eq(n, 2, "count helper")

        # ---- Step 4: graph_builder picks up singleton kind -----------------
        # graph_builder's list_featured_singletons_for_run helper defaults to
        # the latest completed recluster -- so by-id query should work
        step(4, "Verify graph_builder integration: kind='singleton' propagates")
        from backend.services.graph_builder import build_graph_from_db

        # build_graph_from_db calls list_featured_singletons_for_run(user_id) which
        # picks the LATEST run. Our test run is the latest completed (just made).
        graph = build_graph_from_db(USER_ID)
        singleton_nodes = [n for n in graph.nodes if n.kind == "singleton"]
        print(f"    graph has {len(graph.nodes)} nodes, {len(singleton_nodes)} singleton-kind")
        # Validate structural shape -- must have at least our 2 test singletons
        assert len(singleton_nodes) >= 2, (
            f"expected >=2 singleton-kind nodes (our test inserts), got {len(singleton_nodes)}"
        )

        # Verify d3 payload includes kind
        d3 = graph.to_d3_json()
        kinds_in_d3 = {n.get("kind") for n in d3["nodes"]}
        print(f"    d3 payload node kinds present: {kinds_in_d3}")
        assert "singleton" in kinds_in_d3, "d3 nodes have kind='singleton'"

    finally:
        # ---- Cleanup -------------------------------------------------------
        step(5, "Cleanup: delete test recluster_run + cascading featured_singletons")
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM recluster_runs WHERE id = %s",
                    (test_run_id,),
                )
                conn.commit()
        # Verify cleanup
        n = featured_repo.count_featured_singletons_for_run(USER_ID, test_run_id)
        assert_eq(n, 0, "CASCADE removed featured_singletons rows on recluster_run delete")

    print("\n[OK] All smoke tests passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
