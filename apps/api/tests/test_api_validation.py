"""Endpoint contract tests for the archive-validation pipeline."""

from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient


def _pg_reachable() -> bool:
    try:
        from backend.config.settings import settings
        from psycopg2 import connect

        conn = connect(settings.test_database_url)
        conn.close()
        return True
    except Exception:
        return False


pytestmark = pytest.mark.skipif(
    not _pg_reachable(),
    reason="Test PostgreSQL not reachable",
)


@pytest.fixture
def client_and_page():
    """Archive a single skip_gate page under the dev default user.

    `verify_api_key` bypasses auth in dev mode and returns `get_default_user_id()`.
    To keep the test user_id consistent between page creation and endpoint
    authorization, use the same dev user for both.
    """
    from backend.api.main import app, get_default_user_id
    from backend.db import capture_repo, page_repo
    from backend.db.connection import get_conn

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "TRUNCATE annotations, page_clusters, pages, captures, users CASCADE"
            )

    user_id = get_default_user_id()
    cap = capture_repo.save_capture(
        user_id=user_id,
        capture_id="cap_val",
        source="desktop_active",
        started_at=datetime(2026, 3, 15, 10, 0, tzinfo=timezone.utc),
        ended_at=datetime(2026, 3, 15, 11, 0, tzinfo=timezone.utc),
    )
    ids = page_repo.insert_pages(
        cap["id"],
        [
            {
                "url": "https://google.com/q",
                "title": "Q",
                "domain": "google.com",
                "visited_at": datetime(2026, 3, 15, 10, 0, tzinfo=timezone.utc),
            }
        ],
    )
    page_repo.archive_page(ids[0], "skip_gate")

    client = TestClient(app)
    return client, ids[0], user_id


class TestValidateArchiveEndpoint:
    def test_correct_label_records_annotation(self, client_and_page):
        client, page_id, _user_id = client_and_page
        r = client.post(
            f"/api/pages/{page_id}/validate-archive",
            json={"label": "correct", "note": "legit skip"},
        )
        assert r.status_code == 200
        body = r.json()
        assert body["page_id"] == page_id
        assert body["label"] == "correct"
        assert body["auto_flipped"] is False

        from backend.db import annotation_repo

        anns = annotation_repo.get_annotations_for_entity("page", page_id)
        val_anns = [a for a in anns if a["action"] == "validate_archive"]
        assert len(val_anns) == 1
        assert val_anns[0]["new_value"] == "correct"
        assert val_anns[0]["note"] == "legit skip"

    def test_incorrect_label_does_not_auto_flip(self, client_and_page):
        """Per execution-plan decision, labels stage without auto-flip."""
        client, page_id, user_id = client_and_page
        r = client.post(
            f"/api/pages/{page_id}/validate-archive",
            json={"label": "incorrect"},
        )
        assert r.status_code == 200
        assert r.json()["auto_flipped"] is False

        # Page should still be archived (no human_status override written yet).
        from backend.db import page_repo

        with_overrides = page_repo.get_pages_with_overrides(user_id)
        assert not any(p["id"] == page_id for p in with_overrides)

    def test_skip_label_records_skip(self, client_and_page):
        client, page_id, _user_id = client_and_page
        r = client.post(
            f"/api/pages/{page_id}/validate-archive",
            json={"label": "skip"},
        )
        assert r.status_code == 200

    def test_invalid_label_returns_422(self, client_and_page):
        client, page_id, _user_id = client_and_page
        r = client.post(
            f"/api/pages/{page_id}/validate-archive",
            json={"label": "maybe"},
        )
        assert r.status_code == 422
