"""Tests for the capture export handoff — extension → sidecar/backend → DB/disk.

Covers the transitional space where data loss previously occurred:
the extension reports success but data never reaches persistence.

Passive captures land on disk via the sidecar with two-axis suffixes:
  _desktop_passive, _mobile_passive

Active captures persist to PostgreSQL via the backend API.
"""

import json
import uuid

import pytest
from fastapi.testclient import TestClient


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def sidecar_data_dir(tmp_path):
    """Patch the sidecar to write to a temp directory."""
    import scripts.passive_sidecar as sidecar

    original = sidecar.DATA_DIR
    original_index = sidecar.INDEX_PATH
    original_report = sidecar.REPORT_PATH

    sidecar.DATA_DIR = tmp_path
    sidecar.INDEX_PATH = tmp_path / "index.json"
    sidecar.REPORT_PATH = tmp_path / "report.md"

    yield tmp_path

    sidecar.DATA_DIR = original
    sidecar.INDEX_PATH = original_index
    sidecar.REPORT_PATH = original_report


@pytest.fixture()
def sidecar_client(sidecar_data_dir):
    from scripts.passive_sidecar import app

    with TestClient(app) as client:
        yield client


@pytest.fixture()
def active_data_dir(tmp_path):
    """Patch the active backend to write raw dumps to a temp directory."""
    import backend.api.main as main_mod

    original = main_mod.CAPTURES_DIR

    captures_dir = tmp_path / "captures"
    (captures_dir / "raw").mkdir(parents=True)
    main_mod.CAPTURES_DIR = captures_dir

    yield captures_dir

    main_mod.CAPTURES_DIR = original


@pytest.fixture()
def active_client(active_data_dir):  # noqa: ARG001 — fixture wires up patched CAPTURES_DIR
    from backend.api.main import app

    with TestClient(app) as client:
        yield client


def _make_passive_session(
    session_id="1709000000000_abc123def",
    started_at="2026-03-02T04:15:17.552Z",
    ended_at="2026-03-02T04:26:54.021Z",
    page_count=3,
):
    pages = [
        {
            "url": f"https://en.wikipedia.org/wiki/Page_{i}",
            "title": f"Page {i}",
            "timestamp": started_at,
            "dwellTimeSeconds": 30,
            "isTrackedDomain": True,
            "transitionType": "link",
            "transitionQualifiers": [],
        }
        for i in range(page_count)
    ]
    return {
        "captureId": session_id,
        "startedAt": started_at,
        "endedAt": ended_at,
        "pages": pages,
        "events": [],
        "trivial": page_count < 3,
    }


def _make_mobile_session(
    session_id="1709000000000_j8r1ohj22_mobile",
    started_at="2026-03-05T20:03:14.000Z",
    ended_at="2026-03-05T20:15:00.000Z",
    page_count=4,
):
    pages = [
        {
            "url": f"https://en.wikipedia.org/wiki/Mobile_Topic_{i}",
            "title": f"Mobile Topic {i}",
            "timestamp": started_at,
            "dwellTimeSeconds": 45,
            "isTrackedDomain": True,
            "transitionType": "link",
            "transitionQualifiers": [],
        }
        for i in range(page_count)
    ]
    return {
        "captureId": session_id,
        "startedAt": started_at,
        "endedAt": ended_at,
        "pages": pages,
        "events": [],
        "trivial": page_count < 3,
    }


def _make_active_session(
    session_id=None,
    started_at="2026-02-24T16:58:43.578Z",
    ended_at="2026-02-24T17:15:00.000Z",
    page_count=4,
):
    if session_id is None:
        session_id = f"test_active_{uuid.uuid4().hex[:12]}"
    pages = [
        {
            "url": f"https://en.wikipedia.org/wiki/Topic_{i}",
            "title": f"Topic {i}",
            "timestamp": started_at,
            "dwellTimeSeconds": 60,
            "isTrackedDomain": True,
        }
        for i in range(page_count)
    ]
    return {
        "captureId": session_id,
        "startedAt": started_at,
        "endedAt": ended_at,
        "pages": pages,
        "events": [],
    }


# ===========================================================================
# Desktop passive sidecar tests
# ===========================================================================


class TestDesktopPassiveSidecarExport:
    """POST to sidecar with desktop passive session → _desktop_passive suffix."""

    def test_file_lands_with_desktop_passive_suffix(self, sidecar_client, sidecar_data_dir):
        session = _make_passive_session()
        resp = sidecar_client.post("/api/passive-captures", json=session)

        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "saved"
        assert body["captureId"].endswith("_desktop_passive")

        files = list(sidecar_data_dir.glob("*_desktop_passive.json"))
        assert len(files) == 1

    def test_filename_uses_eastern_time(self, sidecar_client, sidecar_data_dir):
        # 2026-03-02T04:15:17Z UTC = 2026-03-01T23:15:17 ET (previous day!)
        session = _make_passive_session(started_at="2026-03-02T04:15:17.552Z")
        sidecar_client.post("/api/passive-captures", json=session)

        files = list(sidecar_data_dir.glob("*_desktop_passive.json"))
        assert len(files) == 1
        filename = files[0].name
        # Should show March 1st (ET), not March 2nd (UTC)
        assert filename.startswith("2026-03-01_231517")

    def test_session_id_rewritten_inside_file(self, sidecar_client, sidecar_data_dir):
        session = _make_passive_session(session_id="1709000000000_abc123def")
        sidecar_client.post("/api/passive-captures", json=session)

        files = list(sidecar_data_dir.glob("*_desktop_passive.json"))
        data = json.loads(files[0].read_text())

        assert not data["captureId"].startswith("1709")
        assert data["captureId"].endswith("_desktop_passive")
        # Random suffix preserved
        assert "abc123def" in data["captureId"]

    def test_index_json_gets_canonical_id(self, sidecar_client, sidecar_data_dir):
        session = _make_passive_session()
        sidecar_client.post("/api/passive-captures", json=session)

        index = json.loads((sidecar_data_dir / "index.json").read_text())
        assert len(index) == 1
        assert index[0]["captureId"].endswith("_desktop_passive")
        assert not index[0]["captureId"].startswith("1709")

    def test_duplicate_session_rejected(self, sidecar_client, sidecar_data_dir):
        session = _make_passive_session()
        resp1 = sidecar_client.post("/api/passive-captures", json=session)
        assert resp1.status_code == 200

        resp2 = sidecar_client.post("/api/passive-captures", json=session)
        assert resp2.status_code == 409

        files = list(sidecar_data_dir.glob("*_desktop_passive.json"))
        assert len(files) == 1

    def test_dst_boundary_conversion(self, sidecar_client, sidecar_data_dir):
        # March 8 2026 2:00 AM ET = DST spring forward
        # 2026-03-08T06:30:00Z = 2026-03-08T01:30:00 EST (before spring forward)
        session = _make_passive_session(
            session_id="1709900000000_dst11test",
            started_at="2026-03-08T06:30:00.000Z",
            ended_at="2026-03-08T07:00:00.000Z",
        )
        sidecar_client.post("/api/passive-captures", json=session)

        files = list(sidecar_data_dir.glob("*_desktop_passive.json"))
        assert len(files) == 1
        assert "2026-03-08_013000" in files[0].name

    def test_multiple_sessions_unique_files(self, sidecar_client, sidecar_data_dir):
        for i in range(3):
            session = _make_passive_session(
                session_id=f"170900000{i}000_rand{i:04d}xxx",
                started_at=f"2026-03-0{i+1}T12:00:00.000Z",
                ended_at=f"2026-03-0{i+1}T12:30:00.000Z",
            )
            resp = sidecar_client.post("/api/passive-captures", json=session)
            assert resp.status_code == 200

        files = list(sidecar_data_dir.glob("*_desktop_passive.json"))
        assert len(files) == 3

        index = json.loads((sidecar_data_dir / "index.json").read_text())
        assert len(index) == 3


# ===========================================================================
# Mobile passive session tests (suffix bug fix)
# ===========================================================================


class TestMobilePassiveSidecarExport:
    """POST to sidecar with mobile session → _mobile_passive suffix, random ID preserved."""

    def test_mobile_gets_mobile_passive_suffix(self, sidecar_client, sidecar_data_dir):
        session = _make_mobile_session()
        resp = sidecar_client.post("/api/passive-captures", json=session)

        assert resp.status_code == 200
        body = resp.json()
        assert body["captureId"].endswith("_mobile_passive")

        files = list(sidecar_data_dir.glob("*_mobile_passive.json"))
        assert len(files) == 1

    def test_mobile_preserves_random_id(self, sidecar_client, sidecar_data_dir):
        """The 9-char random ID from the mobile app must appear in the filename."""
        session = _make_mobile_session(session_id="1709000000000_j8r1ohj22_mobile")
        sidecar_client.post("/api/passive-captures", json=session)

        files = list(sidecar_data_dir.glob("*_mobile_passive.json"))
        assert len(files) == 1
        assert "j8r1ohj22" in files[0].name

    def test_mobile_session_id_rewritten(self, sidecar_client, sidecar_data_dir):
        session = _make_mobile_session(session_id="1709000000000_xk9m2pq7r_mobile")
        sidecar_client.post("/api/passive-captures", json=session)

        files = list(sidecar_data_dir.glob("*_mobile_passive.json"))
        data = json.loads(files[0].read_text())

        assert data["captureId"].endswith("_mobile_passive")
        assert "xk9m2pq7r" in data["captureId"]
        assert not data["captureId"].startswith("1709")

    def test_mobile_index_entry(self, sidecar_client, sidecar_data_dir):
        session = _make_mobile_session()
        sidecar_client.post("/api/passive-captures", json=session)

        index = json.loads((sidecar_data_dir / "index.json").read_text())
        assert len(index) == 1
        assert index[0]["captureId"].endswith("_mobile_passive")

    def test_mixed_sources_in_same_directory(self, sidecar_client, sidecar_data_dir):
        """Desktop passive and mobile passive sessions coexist."""
        passive = _make_passive_session(
            session_id="1709000000000_aaa111bbb",
            started_at="2026-03-01T18:00:00.000Z",
            ended_at="2026-03-01T18:30:00.000Z",
        )
        mobile = _make_mobile_session(
            session_id="1709000000000_ccc222ddd_mobile",
            started_at="2026-03-02T18:00:00.000Z",
            ended_at="2026-03-02T18:30:00.000Z",
        )

        sidecar_client.post("/api/passive-captures", json=passive)
        sidecar_client.post("/api/passive-captures", json=mobile)

        desktop_files = list(sidecar_data_dir.glob("*_desktop_passive.json"))
        mobile_files = list(sidecar_data_dir.glob("*_mobile_passive.json"))
        assert len(desktop_files) == 1
        assert len(mobile_files) == 1

        index = json.loads((sidecar_data_dir / "index.json").read_text())
        assert len(index) == 2


# ===========================================================================
# Desktop active backend tests
# ===========================================================================


class TestDesktopActiveBackendExport:
    """POST to active backend → capture persists to PostgreSQL."""

    def test_capture_persists_to_db(self, active_client, active_data_dir):
        session = _make_active_session()
        resp = active_client.post("/api/captures", json=session)

        assert resp.status_code == 200
        body = resp.json()
        assert body["captureId"] == session["captureId"]
        assert body["pageCount"] == len(session["pages"])

    def test_session_data_preserved(self, active_client, active_data_dir):
        session = _make_active_session(page_count=5)
        resp = active_client.post("/api/captures", json=session)

        assert resp.status_code == 200
        body = resp.json()
        assert body["pageCount"] == 5

        # Verify the capture exists in the DB
        from backend.db import capture_repo

        cap = capture_repo.get_capture(session["captureId"])
        assert cap is not None
        assert cap["source"] == "desktop_active"


# ===========================================================================
# Cross-system sorting test
# ===========================================================================


class TestChronologicalSorting:
    """Files from all sources sort chronologically when mixed."""

    def test_filenames_sort_chronologically(self, sidecar_client, sidecar_data_dir):
        # Create desktop_passive on Mar 1, mobile_passive on Mar 2, desktop_passive on Mar 3
        passive_1 = _make_passive_session(
            session_id="170900000_1000_aaa111aaa",
            started_at="2026-03-01T18:00:00.000Z",
            ended_at="2026-03-01T18:30:00.000Z",
        )
        mobile = _make_mobile_session(
            session_id="170900000_2000_bbb222bbb_mobile",
            started_at="2026-03-02T18:00:00.000Z",
            ended_at="2026-03-02T18:30:00.000Z",
        )
        passive_3 = _make_passive_session(
            session_id="170900000_3000_ccc333ccc",
            started_at="2026-03-03T18:00:00.000Z",
            ended_at="2026-03-03T18:30:00.000Z",
        )

        sidecar_client.post("/api/passive-captures", json=passive_1)
        sidecar_client.post("/api/passive-captures", json=mobile)
        sidecar_client.post("/api/passive-captures", json=passive_3)

        all_files = sorted(f for f in sidecar_data_dir.glob("*.json") if f.name != "index.json")
        names = [f.name for f in all_files]

        assert len(names) == 3
        assert "2026-03-01" in names[0]
        assert "2026-03-02" in names[1]
        assert "2026-03-03" in names[2]
