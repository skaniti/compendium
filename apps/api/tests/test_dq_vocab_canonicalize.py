"""Integration tests for backend/scripts/_archive/dq_vocab_canonicalize.py.

SBERT is monkeypatched to a deterministic fake vector for every test except
the dry-run test, which asserts the real loader is never even imported.
"""

import json
import uuid

import pytest

from tests.test_repos import _pg_reachable

pytestmark = pytest.mark.skipif(not _pg_reachable(), reason="Test PostgreSQL not reachable")

from backend.db import dq_vocab_repo, user_repo
from backend.db.connection import get_conn
from backend.scripts._archive import dq_vocab_canonicalize

FAKE_EMBEDDING = [0.01] * 384


class _FakeVector:
    """Stands in for the numpy array SentenceTransformer.encode() returns."""

    def __init__(self, values):
        self._values = values

    def tolist(self):
        return list(self._values)


class _FakeSBert:
    def encode(self, text):
        return _FakeVector(FAKE_EMBEDDING)


@pytest.fixture(autouse=True)
def _patch_sbert(monkeypatch):
    """Deterministic fake encoder for every test in this file by default.

    Individual tests may re-patch (e.g. to a raising stub) to assert the
    real loader is never reached on the dry-run path.
    """
    monkeypatch.setattr("backend.services.sbert_loader.get_sbert_model", lambda: _FakeSBert())


def _fresh_user(label: str) -> int:
    email = f"{label}-{uuid.uuid4().hex[:8]}@test.local"
    return user_repo.create_user(email=email, name="vocab_canon_test")["id"]


def _fetch(uid, issue_type):
    return dq_vocab_repo.lookup(uid, issue_type)


def _write_manifest(tmp_path, canonicalize=None, create_and_canonicalize=None, alias=None, reject=None):
    manifest = {
        "canonicalize": canonicalize or [],
        "create_and_canonicalize": create_and_canonicalize or [],
        "alias": alias or [],
        "reject": reject or [],
    }
    p = tmp_path / "manifest.json"
    p.write_text(json.dumps(manifest))
    return p, manifest


# ── canonicalize ─────────────────────────────────────────────────────────


def test_canonicalize_writes_description_and_embedding():
    uid = _fresh_user("canon")
    dq_vocab_repo.insert_proposal(uid, "cluster_coherence_drift", "seed", None)

    entries = [{"issue_type": "cluster_coherence_drift", "description": "A cluster label mismatch description."}]
    results = dq_vocab_canonicalize._process_canonicalize(entries, apply=True, user_id=uid)

    assert results[0]["outcome"] == "applied"
    entry = _fetch(uid, "cluster_coherence_drift")
    assert entry.status == "canonical"
    assert entry.description == "A cluster label mismatch description."

    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT description_embedding IS NOT NULL FROM dq_vocab_issue_types "
            "WHERE user_id = %s AND issue_type = %s",
            (uid, "cluster_coherence_drift"),
        )
        assert cur.fetchone()[0] is True


def test_canonicalize_not_found_is_skipped_and_writes_nothing():
    uid = _fresh_user("canon_missing")
    entries = [{"issue_type": "never_proposed", "description": "Some description text here."}]

    results = dq_vocab_canonicalize._process_canonicalize(entries, apply=True, user_id=uid)

    assert results[0]["outcome"] == "not_found"
    assert _fetch(uid, "never_proposed") is None


def test_canonicalize_description_too_short_is_rejected_before_any_write():
    uid = _fresh_user("canon_short")
    dq_vocab_repo.insert_proposal(uid, "short_desc", "seed", None)
    entries = [{"issue_type": "short_desc", "description": "short"}]

    results = dq_vocab_canonicalize._process_canonicalize(entries, apply=True, user_id=uid)

    assert results[0]["outcome"] == "description_too_short"
    entry = _fetch(uid, "short_desc")
    assert entry.status == "proposed"  # untouched


# ── create_and_canonicalize ─────────────────────────────────────────────


def test_create_and_canonicalize_inserts_then_canonicalizes():
    uid = _fresh_user("create_canon")
    assert _fetch(uid, "detector_calibration") is None

    entries = [
        {
            "issue_type": "detector_calibration",
            "description": "Detector thresholds misfire at a measurable rate.",
            "proposal_rationale": "new canonical home for the sweep",
        }
    ]
    results = dq_vocab_canonicalize._process_create_and_canonicalize(entries, apply=True, user_id=uid)

    assert results[0]["outcome"] == "applied"
    entry = _fetch(uid, "detector_calibration")
    assert entry is not None
    assert entry.status == "canonical"
    assert entry.description == "Detector thresholds misfire at a measurable rate."
    assert entry.proposal_rationale == "new canonical home for the sweep"


# ── alias ────────────────────────────────────────────────────────────────


def test_alias_target_not_canonical_errors_cleanly_without_write():
    uid = _fresh_user("alias_bad_target")
    dq_vocab_repo.insert_proposal(uid, "alias_source", "seed", None)
    dq_vocab_repo.insert_proposal(uid, "not_yet_canonical", "seed", None)  # still 'proposed'

    entries = [{"issue_type": "alias_source", "target": "not_yet_canonical"}]
    results = dq_vocab_canonicalize._process_alias(entries, apply=True, user_id=uid)

    assert results[0]["outcome"] == "target_not_canonical"
    source = _fetch(uid, "alias_source")
    assert source.status == "proposed"  # untouched -- no write happened
    assert source.aliased_to is None


def test_alias_target_missing_entirely_errors_cleanly():
    uid = _fresh_user("alias_missing_target")
    dq_vocab_repo.insert_proposal(uid, "alias_source", "seed", None)
    entries = [{"issue_type": "alias_source", "target": "does_not_exist"}]

    results = dq_vocab_canonicalize._process_alias(entries, apply=True, user_id=uid)

    assert results[0]["outcome"] == "target_not_canonical"
    assert _fetch(uid, "alias_source").status == "proposed"


def test_alias_not_found_is_skipped():
    uid = _fresh_user("alias_missing_source")
    dq_vocab_repo.insert_proposal(uid, "target_label", "seed", None)
    dq_vocab_repo.canonicalize(uid, "target_label", "Target description for lookup test.", FAKE_EMBEDDING, uid)

    entries = [{"issue_type": "never_proposed", "target": "target_label"}]
    results = dq_vocab_canonicalize._process_alias(entries, apply=True, user_id=uid)

    assert results[0]["outcome"] == "not_found"


# ── reject ───────────────────────────────────────────────────────────────


def test_reject_leaves_aliased_to_null():
    uid = _fresh_user("reject")
    dq_vocab_repo.insert_proposal(uid, "reject_me", "seed", None)

    results = dq_vocab_canonicalize._process_reject(["reject_me"], apply=True, user_id=uid)

    assert results[0]["outcome"] == "applied"
    entry = _fetch(uid, "reject_me")
    assert entry.status == "rejected"
    assert entry.aliased_to is None


def test_reject_not_found_is_skipped():
    uid = _fresh_user("reject_missing")
    results = dq_vocab_canonicalize._process_reject(["never_existed"], apply=True, user_id=uid)
    assert results[0]["outcome"] == "not_found"


# ── ordering: alias succeeds because canonicalize ran first ───────────────


def test_alias_succeeds_because_canonicalize_ran_first_in_main(tmp_path, monkeypatch):
    uid = _fresh_user("ordering")
    dq_vocab_repo.insert_proposal(uid, "target_label", "seed", None)
    dq_vocab_repo.insert_proposal(uid, "alias_source", "seed", None)

    manifest_path, _ = _write_manifest(
        tmp_path,
        canonicalize=[{"issue_type": "target_label", "description": "Target label description text."}],
        alias=[{"issue_type": "alias_source", "target": "target_label"}],
    )
    monkeypatch.setattr(dq_vocab_canonicalize, "MANIFEST_PATH", manifest_path)

    dq_vocab_canonicalize.main(apply=True, user_id=uid)

    target = _fetch(uid, "target_label")
    assert target.status == "canonical"
    source = _fetch(uid, "alias_source")
    assert source.status == "rejected"
    assert source.aliased_to == "target_label"


# ── idempotent second run ──────────────────────────────────────────────


def test_second_apply_run_is_idempotent(tmp_path, monkeypatch):
    uid = _fresh_user("idempotent")
    dq_vocab_repo.insert_proposal(uid, "canon_a", "seed", None)
    dq_vocab_repo.insert_proposal(uid, "alias_a", "seed", None)
    dq_vocab_repo.insert_proposal(uid, "reject_a", "seed", None)

    manifest_path, manifest = _write_manifest(
        tmp_path,
        canonicalize=[{"issue_type": "canon_a", "description": "Canon A description text here."}],
        create_and_canonicalize=[
            {
                "issue_type": "canon_b_new",
                "description": "Brand new canonical description text.",
                "proposal_rationale": "r",
            }
        ],
        alias=[{"issue_type": "alias_a", "target": "canon_a"}],
        reject=["reject_a"],
    )
    monkeypatch.setattr(dq_vocab_canonicalize, "MANIFEST_PATH", manifest_path)

    dq_vocab_canonicalize.main(apply=True, user_id=uid)
    dq_vocab_canonicalize.main(apply=True, user_id=uid)  # second run

    canon_results = dq_vocab_canonicalize._process_canonicalize(
        manifest["canonicalize"], apply=False, user_id=uid
    )
    create_results = dq_vocab_canonicalize._process_create_and_canonicalize(
        manifest["create_and_canonicalize"], apply=False, user_id=uid
    )
    alias_results = dq_vocab_canonicalize._process_alias(manifest["alias"], apply=False, user_id=uid)
    reject_results = dq_vocab_canonicalize._process_reject(manifest["reject"], apply=False, user_id=uid)

    all_results = canon_results + create_results + alias_results + reject_results
    assert all(r["outcome"] == "already_done" for r in all_results)

    # No orphaned 'proposed' rows left behind by the two runs.
    assert dq_vocab_canonicalize._safety_check(uid, manifest, apply=True) == []


# ── dry run: no writes, SBERT never touched ────────────────────────────


def test_dry_run_writes_nothing_and_never_loads_sbert(tmp_path, monkeypatch):
    uid = _fresh_user("dry_run")
    dq_vocab_repo.insert_proposal(uid, "canon_c", "seed", None)
    dq_vocab_repo.insert_proposal(uid, "alias_c", "seed", None)
    dq_vocab_repo.insert_proposal(uid, "reject_c", "seed", None)

    def _boom():
        raise AssertionError("SBERT must not load during a dry run")

    monkeypatch.setattr("backend.services.sbert_loader.get_sbert_model", _boom)

    manifest_path, _ = _write_manifest(
        tmp_path,
        canonicalize=[{"issue_type": "canon_c", "description": "Canon C description text here."}],
        create_and_canonicalize=[
            {
                "issue_type": "canon_d_new",
                "description": "Another brand new canonical description.",
                "proposal_rationale": "r",
            }
        ],
        alias=[{"issue_type": "alias_c", "target": "canon_c"}],
        reject=["reject_c"],
    )
    monkeypatch.setattr(dq_vocab_canonicalize, "MANIFEST_PATH", manifest_path)

    dq_vocab_canonicalize.main(apply=False, user_id=uid)  # must not raise

    assert _fetch(uid, "canon_c").status == "proposed"
    assert _fetch(uid, "alias_c").status == "proposed"
    assert _fetch(uid, "reject_c").status == "proposed"
    assert _fetch(uid, "canon_d_new") is None


# ── safety check ─────────────────────────────────────────────────────────


def test_safety_check_flags_uncovered_proposed_rows_in_dry_run(tmp_path, monkeypatch):
    uid = _fresh_user("safety")
    dq_vocab_repo.insert_proposal(uid, "covered_by_canonicalize", "seed", None)
    dq_vocab_repo.insert_proposal(uid, "not_covered_at_all", "seed", None)

    manifest_path, manifest = _write_manifest(
        tmp_path,
        canonicalize=[
            {"issue_type": "covered_by_canonicalize", "description": "Covered description text here."}
        ],
    )
    monkeypatch.setattr(dq_vocab_canonicalize, "MANIFEST_PATH", manifest_path)

    remaining = dq_vocab_canonicalize._safety_check(uid, manifest, apply=False)
    assert remaining == ["not_covered_at_all"]


def test_safety_check_empty_after_full_apply(tmp_path, monkeypatch):
    uid = _fresh_user("safety_clean")
    dq_vocab_repo.insert_proposal(uid, "canon_e", "seed", None)

    manifest_path, manifest = _write_manifest(
        tmp_path,
        canonicalize=[{"issue_type": "canon_e", "description": "Canon E description text here."}],
    )
    monkeypatch.setattr(dq_vocab_canonicalize, "MANIFEST_PATH", manifest_path)

    dq_vocab_canonicalize.main(apply=True, user_id=uid)

    assert dq_vocab_canonicalize._safety_check(uid, manifest, apply=True) == []


# ── real frozen manifest sanity check ──────────────────────────────────


def test_manifest_absent_fails_loudly_from_default_path():
    """No manifest ships (they are per-deployment operational data); the
    loader must fail LOUDLY with FileNotFoundError, never silently no-op."""
    with pytest.raises(FileNotFoundError):
        dq_vocab_canonicalize._load_manifest()
