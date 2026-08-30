#!/usr/bin/env python3
"""Backfill trends tables from existing data.

Populates cost_events from:
  - pages.processing_metadata (skip gate costs per page)
  - recluster_runs.naming_cost (cluster naming costs)
and status_snapshots from historical page counts.

Idempotent — safe to run multiple times.
"""

import sys
from pathlib import Path

# Ensure project root is on sys.path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.db.connection import get_conn


def backfill_skip_gate_costs():
    """Create cost_events from pages.processing_metadata JSONB."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT COUNT(*) FROM cost_events "
                "WHERE event_type = 'skip_gate' AND metadata->>'backfilled' = 'true'"
            )
            existing = cur.fetchone()[0]
            if existing > 0:
                print(f"  cost_events already has {existing} backfilled skip_gate rows — skipping")
                return 0

            cur.execute("""
                INSERT INTO cost_events
                    (user_id, event_type, model, input_tokens, output_tokens,
                     cost_usd, latency_ms, metadata, created_at)
                SELECT
                    c.user_id,
                    'skip_gate',
                    'gpt-4o-mini',
                    COALESCE((p.processing_metadata->>'input_tokens')::int, 0),
                    COALESCE((p.processing_metadata->>'output_tokens')::int, 0),
                    COALESCE((p.processing_metadata->>'cost_usd')::real, 0),
                    (p.processing_metadata->>'latency_ms')::real,
                    jsonb_build_object(
                        'page_url', p.url,
                        'backfilled', true
                    ),
                    p.created_at
                FROM pages p
                JOIN captures c ON p.capture_id = c.id
                WHERE p.processing_metadata IS NOT NULL
                  AND p.processing_metadata->>'cost_usd' IS NOT NULL
                  AND (p.processing_metadata->>'cost_usd')::real > 0
            """)
            count = cur.rowcount
            print(f"  Inserted {count} skip_gate cost_events from pages.processing_metadata")
            return count


def backfill_naming_costs():
    """Create cost_events from recluster_runs naming costs."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT COUNT(*) FROM cost_events "
                "WHERE event_type = 'cluster_naming' AND metadata->>'backfilled' = 'true'"
            )
            existing = cur.fetchone()[0]
            if existing > 0:
                print(
                    f"  cost_events already has {existing} backfilled cluster_naming rows — skipping"
                )
                return 0

            cur.execute("""
                INSERT INTO cost_events
                    (user_id, event_type, model, cost_usd, metadata, created_at)
                SELECT
                    user_id,
                    'cluster_naming',
                    'gpt-4o-mini',
                    naming_cost,
                    jsonb_build_object(
                        'cluster_count', cluster_count,
                        'backfilled', true
                    ),
                    completed_at
                FROM recluster_runs
                WHERE status = 'completed'
                  AND naming_cost > 0
                  AND completed_at IS NOT NULL
            """)
            count = cur.rowcount
            print(f"  Inserted {count} cluster_naming cost_events from recluster_runs")
            return count


def backfill_status_snapshots():
    """Create daily status snapshots from page creation dates."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            # Check if already backfilled
            cur.execute("SELECT COUNT(*) FROM status_snapshots")
            existing = cur.fetchone()[0]
            if existing > 0:
                print(f"  status_snapshots already has {existing} rows — skipping")
                return 0

            # Build cumulative daily page counts
            cur.execute("""
                WITH daily AS (
                    SELECT
                        c.user_id,
                        DATE(p.created_at) AS day,
                        COUNT(*) FILTER (WHERE p.status = 'active') AS active,
                        COUNT(*) FILTER (WHERE p.status = 'pending') AS pending,
                        COUNT(*) FILTER (WHERE p.status IN ('skipped', 'archived')) AS archived
                    FROM pages p
                    JOIN captures c ON p.capture_id = c.id
                    WHERE p.created_at IS NOT NULL
                    GROUP BY c.user_id, DATE(p.created_at)
                )
                INSERT INTO status_snapshots
                    (user_id, active_count, pending_count, archived_count, snapshot_at)
                SELECT
                    user_id, active, pending, archived,
                    day + INTERVAL '23 hours 59 minutes'
                FROM daily
                ORDER BY day
            """)
            count = cur.rowcount
            print(f"  Inserted {count} status_snapshots from page history")
            return count


if __name__ == "__main__":
    print("Backfilling trends data...")
    print()
    print("[1/3] Skip gate costs from pages.processing_metadata:")
    backfill_skip_gate_costs()
    print()
    print("[2/3] Cluster naming costs from recluster_runs:")
    backfill_naming_costs()
    print()
    print("[3/3] Status snapshots from page history:")
    backfill_status_snapshots()
    print()
    print("Done.")
