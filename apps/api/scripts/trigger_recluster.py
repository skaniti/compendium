"""Trigger a recluster directly via the ClusteringService CLI path.

Avoids needing to restart the FastAPI backend just to inject the
``HDBSCAN_MIN_CLUSTER_SIZE`` env var. The settings module reads the env at
import time, so as long as we set the env var before importing
``ClusteringService``, the new threshold takes effect.

Usage::

    HDBSCAN_MIN_CLUSTER_SIZE=3 python scripts/trigger_recluster.py --user-id 152
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

# Force tracing off (LangSmith free-tier cap noise; same as the audit script).
os.environ["LANGCHAIN_TRACING_V2"] = "false"
os.environ.pop("LANGCHAIN_API_KEY", None)

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from backend.config.settings import settings  # noqa: E402
from backend.services.clustering_service import ClusteringService  # noqa: E402


async def run(user_id: int) -> int:
    print(f"Triggering recluster for user {user_id}")
    print(f"  HDBSCAN_MIN_CLUSTER_SIZE = {settings.hdbscan_min_cluster_size}")
    print(f"  (effective floor at this corpus = max(setting, n_pages // 150))")
    print()
    svc = ClusteringService(user_id=user_id)
    result = await svc.recluster_all(batch_mode=False)
    print()
    print(f"Recluster result: {result}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--user-id", type=int, default=152)
    args = parser.parse_args()
    return asyncio.run(run(args.user_id))


if __name__ == "__main__":
    raise SystemExit(main())
