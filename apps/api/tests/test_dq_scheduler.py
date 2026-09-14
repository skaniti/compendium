# tests/test_dq_scheduler.py  (replace entire file)
"""dqBot scheduler now ENQUEUES rows for the worker instead of dispatching
investigations in-process. These are pure unit tests (no PG, no subprocess):
we mock user_repo + dq_runs_repo and assert the enqueue/gating behavior.

dqBot Tier 2 (the 2026-07-19 dqbot-tier2-role-split plan, private):
the recluster hook's enqueue call is gated by DQ_RUN_MODE (default "tier2"
enqueues a sensor pass; "legacy" enqueues a full run, matching pre-Tier-2
behavior) -- see test_recluster_enqueues_sensor_run_by_default_tier2 /
test_recluster_enqueues_full_run_under_legacy_mode."""

from __future__ import annotations

import os
from unittest.mock import MagicMock, patch

from backend.services import dq_scheduler


def _opted_in(uid):
    return {"id": uid, "email": f"{uid}@x.com", "name": str(uid),
            "preferences": {"enable_scheduled_runs": True}}


def test_weekly_enqueues_one_row_per_opted_in_user():
    enqueued = []
    with (
        patch.object(dq_scheduler.user_repo, "list_users_with_pref",
                     return_value=[_opted_in(1), _opted_in(2), _opted_in(3)]),
        patch.object(dq_scheduler.dq_runs_repo, "has_active_run_for_user", return_value=False),
        patch.object(dq_scheduler.dq_runs_repo, "enqueue",
                     side_effect=lambda user_id, trigger: enqueued.append((user_id, trigger))),
    ):
        dq_scheduler.enqueue_weekly_dq()
    assert enqueued == [(1, "schedule"), (2, "schedule"), (3, "schedule")]


def test_weekly_skips_user_with_active_run():
    enqueued = []
    with (
        patch.object(dq_scheduler.user_repo, "list_users_with_pref",
                     return_value=[_opted_in(1), _opted_in(2), _opted_in(3)]),
        patch.object(dq_scheduler.dq_runs_repo, "has_active_run_for_user",
                     side_effect=lambda uid: uid == 2),
        patch.object(dq_scheduler.dq_runs_repo, "enqueue",
                     side_effect=lambda user_id, trigger: enqueued.append((user_id, trigger))),
    ):
        dq_scheduler.enqueue_weekly_dq()
    assert enqueued == [(1, "schedule"), (3, "schedule")]


def test_recluster_enqueues_sensor_run_by_default_tier2(monkeypatch):
    """dqBot Tier 2 (the 2026-07-19 dqbot-tier2-role-split plan, private):
    with DQ_RUN_MODE unset (default "tier2"), the recluster hook enqueues a
    zero-LLM sensor pass, not a full run -- the sensor's own dq_gate decides
    whether a full run is warranted."""
    monkeypatch.delenv(dq_scheduler.DQ_RUN_MODE, raising=False)
    enqueued = []
    with (
        patch.dict(os.environ, {"DQ_SCHEDULER_DISABLED": "0"}, clear=False),
        patch.object(dq_scheduler.user_repo, "get_user_by_id", return_value=_opted_in(42)),
        patch.object(dq_scheduler.dq_runs_repo, "has_active_run_for_user", return_value=False),
        patch.object(dq_scheduler.dq_runs_repo, "enqueue",
                     side_effect=lambda user_id, trigger, run_kind="full":
                         enqueued.append((user_id, trigger, run_kind))),
    ):
        dq_scheduler.enqueue_recluster_dq(42)
    assert enqueued == [(42, "recluster_event", "sensor")]


def test_recluster_enqueues_full_run_under_legacy_mode():
    """DQ_RUN_MODE=legacy restores today's pre-Tier-2 behavior: the recluster
    hook enqueues a full run directly, with no run_kind override (defaults
    to 'full' at the repo layer)."""
    enqueued = []
    with (
        patch.dict(os.environ, {"DQ_SCHEDULER_DISABLED": "0", "DQ_RUN_MODE": "legacy"}, clear=False),
        patch.object(dq_scheduler.user_repo, "get_user_by_id", return_value=_opted_in(42)),
        patch.object(dq_scheduler.dq_runs_repo, "has_active_run_for_user", return_value=False),
        patch.object(dq_scheduler.dq_runs_repo, "enqueue",
                     side_effect=lambda user_id, trigger, run_kind="full":
                         enqueued.append((user_id, trigger, run_kind))),
    ):
        dq_scheduler.enqueue_recluster_dq(42)
    assert enqueued == [(42, "recluster_event", "full")]


def test_recluster_skips_when_pref_off():
    enqueue_mock = MagicMock()
    with (
        patch.dict(os.environ, {"DQ_SCHEDULER_DISABLED": "0"}, clear=False),
        patch.object(dq_scheduler.user_repo, "get_user_by_id",
                     return_value={"id": 42, "email": "u", "name": "u", "preferences": {}}),
        patch.object(dq_scheduler.dq_runs_repo, "has_active_run_for_user", return_value=False),
        patch.object(dq_scheduler.dq_runs_repo, "enqueue", side_effect=enqueue_mock),
    ):
        dq_scheduler.enqueue_recluster_dq(42)
    enqueue_mock.assert_not_called()


def test_recluster_skips_when_disabled_env():
    enqueue_mock = MagicMock()
    user_lookup = MagicMock()
    with (
        patch.dict(os.environ, {"DQ_SCHEDULER_DISABLED": "1"}, clear=False),
        patch.object(dq_scheduler.user_repo, "get_user_by_id", side_effect=user_lookup),
        patch.object(dq_scheduler.dq_runs_repo, "enqueue", side_effect=enqueue_mock),
    ):
        dq_scheduler.enqueue_recluster_dq(42)
    user_lookup.assert_not_called()
    enqueue_mock.assert_not_called()


def test_recluster_skips_when_active_run():
    enqueue_mock = MagicMock()
    with (
        patch.dict(os.environ, {"DQ_SCHEDULER_DISABLED": "0"}, clear=False),
        patch.object(dq_scheduler.user_repo, "get_user_by_id", return_value=_opted_in(42)),
        patch.object(dq_scheduler.dq_runs_repo, "has_active_run_for_user", return_value=True),
        patch.object(dq_scheduler.dq_runs_repo, "enqueue", side_effect=enqueue_mock),
    ):
        dq_scheduler.enqueue_recluster_dq(42)
    enqueue_mock.assert_not_called()
