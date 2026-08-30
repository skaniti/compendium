"""The recluster path enqueues a DQ run (best-effort) instead of dispatching."""

from unittest.mock import patch

from backend.services import clustering_service


def test_recluster_calls_enqueue_recluster_dq():
    """_maybe_enqueue_dq forwards to dq_scheduler.enqueue_recluster_dq(user_id)."""
    with patch("backend.services.dq_scheduler.enqueue_recluster_dq") as m:
        clustering_service._maybe_enqueue_dq(user_id=42)
    m.assert_called_once_with(42)


def test_recluster_enqueue_failure_is_swallowed():
    """A failure enqueuing DQ must never propagate back into the recluster."""
    with patch("backend.services.dq_scheduler.enqueue_recluster_dq",
               side_effect=RuntimeError("db down")):
        clustering_service._maybe_enqueue_dq(user_id=42)  # must not raise
