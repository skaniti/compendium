"""HTTP tests for the Prompts dev-view routes (synthetic data; roles pinned)."""

import itertools
import json

import pytest
from fastapi.testclient import TestClient


def _pg_reachable() -> bool:
    try:
        from psycopg2 import connect

        from backend.config.settings import settings

        connect(settings.test_database_url).close()
        return True
    except Exception:  # noqa: BLE001
        return False


pytestmark = pytest.mark.skipif(not _pg_reachable(), reason="Test PostgreSQL not reachable")

from backend.config.settings import settings
from backend.db import auth_repo, user_repo
from backend.db.connection import get_conn
from backend.prompts import templates

NAME = "page_summary_v1"
REGISTRY = templates.PROMPTS[NAME]["template"]
_n = itertools.count()
ROLES = {
    "admin": ("admin", False),
    "acting": ("demo", True),
    "demo": ("demo", False),
    "user": ("user", False),
}


@pytest.fixture(autouse=True)
def _clean_tables():
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("TRUNCATE users CASCADE")
    yield


@pytest.fixture
def as_role():
    from backend.api.main import app, get_current_claims, verify_api_key

    def _set(key: str) -> TestClient:
        role, acting = ROLES[key]
        uid = user_repo.create_user(f"prompts-{key}-{next(_n)}@example.com", name="Prompts User")[
            "id"
        ]
        auth_repo.set_role(uid, role)
        app.dependency_overrides[verify_api_key] = lambda: uid
        if acting:
            app.dependency_overrides[get_current_claims] = lambda: {"acting_as_demo": True}
        else:
            app.dependency_overrides.pop(get_current_claims, None)
        return TestClient(app)

    yield _set
    app.dependency_overrides.pop(verify_api_key, None)
    app.dependency_overrides.pop(get_current_claims, None)


@pytest.fixture
def ofile(monkeypatch, tmp_path):
    f = tmp_path / "overrides.json"
    monkeypatch.setattr(settings, "prompt_overrides_path", str(f))
    return f


@pytest.fixture
def no_overrides(monkeypatch):
    monkeypatch.setattr(settings, "prompt_overrides_path", "")


def _write_run(root, run_id, version, sel, ts):
    d = root / run_id
    d.mkdir()
    (d / "run.json").write_text(
        json.dumps(
            {
                "timestamp": ts,
                "prompt_name": "alpha_gate",
                "prompt_version": version,
                "model": "model-x",
                "fixture_set_label": "set-a",
                "fixture_version": "fv1",
                "git_sha": "abc1234",
                "totals": {
                    "cost_usd": 0.01,
                    "wall_time_s": 3.0,
                    "llm_calls": 2,
                    "cache_hits": 0,
                    "cache_misses": 2,
                },
                "metrics": {"selection": {"accuracy": sel, "n_fixtures": 4}},
                "results": [
                    {
                        "fixture_id": "fx-001",
                        "actual_output": {"verdict": "a"},
                        "expected_output": {"verdict": "a"},
                    }
                ],
            }
        ),
        encoding="utf-8",
    )


@pytest.fixture
def runs(monkeypatch, tmp_path):
    root = tmp_path / "runs"
    root.mkdir()
    _write_run(root, "run-a", "v1.0", 0.5, "2026-01-01T00:00:00Z")
    _write_run(root, "run-b", "v1.1", 0.75, "2026-01-02T00:00:00Z")
    outside = tmp_path / "outside"
    outside.mkdir()
    _write_run(outside, "secret", "v9", 0.1, "2026-01-03T00:00:00Z")
    monkeypatch.setattr(settings, "eval_runs_dir", str(root))
    return root


def test_summary_shape(as_role, no_overrides):
    from backend.services.prompt_view import MODEL_IDS

    s = as_role("admin").get("/api/prompts/summary").json()
    assert tuple(m["id"] for m in s["models"]) == MODEL_IDS
    names = [p["name"] for t in s["tasks"] for p in t["prompts"]]
    assert sorted(names) == sorted(templates.PROMPTS)
    assert s["unused_models"][0]["source"] == "settings.default_summary_model"
    assert s["admin"]["overrides"] == {"configured": False, "readable": True, "count": 0}
    assert "://" not in json.dumps(s)


# An admin viewing as demo gets exactly what a plain demo gets (2026-10-04).
@pytest.mark.parametrize(
    "role, has_admin", [("admin", True), ("acting", False), ("demo", False), ("user", False)]
)
def test_summary_admin_block_per_role(as_role, no_overrides, monkeypatch, role, has_admin):
    monkeypatch.setattr(settings, "eval_runs_dir", "")
    s = as_role(role).get("/api/prompts/summary").json()
    if has_admin:
        assert s["admin"] == {
            "overrides": {"configured": False, "readable": True, "count": 0},
            "evals": {"configured": False},
        }
    else:
        assert s["admin"] is None


@pytest.mark.parametrize(
    "role, sees_text", [("admin", True), ("acting", False), ("demo", False), ("user", False)]
)
def test_template_detail_redaction(as_role, ofile, role, sees_text):
    ofile.write_text(json.dumps({NAME: "LOCAL OVERRIDE {title}"}), encoding="utf-8")
    d = as_role(role).get(f"/api/prompts/templates/{NAME}").json()
    assert d["overridden"] is True and d["registry_template"] == REGISTRY
    if sees_text:
        assert d["override"] == "LOCAL OVERRIDE {title}"
    else:
        assert "override" not in d
        assert "LOCAL OVERRIDE" not in json.dumps(d)
    s = as_role(role).get("/api/prompts/summary").json()
    flags = {p["name"]: p["overridden"] for t in s["tasks"] for p in t["prompts"]}
    assert flags[NAME] is True
    assert "LOCAL OVERRIDE" not in json.dumps(s)


def test_template_unknown_and_bad_names(as_role, no_overrides):
    tc = as_role("demo")
    assert tc.get("/api/prompts/templates/nope_v1").status_code == 404
    assert tc.get("/api/prompts/templates/nope_v1").json() == {"detail": "prompt not found"}
    assert tc.get("/api/prompts/templates/Bad-Name").status_code == 422
    assert tc.get("/api/prompts/templates/" + "a" * 81).status_code == 422


ADMIN_REQUIRED = {"detail": "Admin context required"}
VIEWING_AS_DEMO = {"detail": "Disabled in demo view"}


@pytest.mark.parametrize(
    "role, denied",
    [
        ("admin", None),
        ("acting", VIEWING_AS_DEMO),
        ("demo", ADMIN_REQUIRED),
        ("user", ADMIN_REQUIRED),
    ],
)
def test_write_role_matrix(as_role, ofile, role, denied):
    # Every demo identity is refused, an admin viewing as demo included (2026-10-04).
    tc = as_role(role)
    r = tc.put(
        f"/api/prompts/templates/{NAME}/override", json={"template": "NEW {title} {content}"}
    )
    assert r.status_code == (403 if denied else 200)
    if denied:
        assert r.json() == denied
        assert not ofile.exists()
    r = tc.delete(f"/api/prompts/templates/{NAME}/override")
    assert r.status_code == (403 if denied else 200)
    if denied:
        assert r.json() == denied


def test_viewing_as_demo_cannot_reset_an_existing_override(as_role, ofile):
    as_role("admin").put(
        f"/api/prompts/templates/{NAME}/override", json={"template": "NEW {title} {content}"}
    )
    saved = ofile.read_text()
    tc = as_role("acting")
    r = tc.delete(f"/api/prompts/templates/{NAME}/override")
    assert (r.status_code, r.json()) == (403, VIEWING_AS_DEMO)
    assert ofile.read_text() == saved
    # Like a plain demo, it sees that the prompt is overridden, never the text.
    d = tc.get(f"/api/prompts/templates/{NAME}").json()
    assert d["overridden"] is True and "override" not in d


@pytest.mark.parametrize(
    "role, denied",
    [("demo", ADMIN_REQUIRED), ("user", ADMIN_REQUIRED), ("acting", VIEWING_AS_DEMO)],
)
def test_non_admin_403_precedes_validation(as_role, ofile, role, denied):
    tc = as_role(role)
    r = tc.put("/api/prompts/templates/nope_v1/override", json={})
    assert (r.status_code, r.json()) == (403, denied)
    r = tc.put("/api/prompts/templates/Bad-Name/override", json={"template": ""})
    assert (r.status_code, r.json()) == (403, denied)
    r = tc.delete("/api/prompts/templates/nope_v1/override")
    assert (r.status_code, r.json()) == (403, denied)
    r = tc.get("/api/prompts/evals/.hidden")
    assert (r.status_code, r.json()) == (403, denied)


def test_put_round_trip(as_role, ofile):
    tc = as_role("admin")
    r = tc.put(f"/api/prompts/templates/{NAME}/override", json={"template": "NEW {title}"})
    assert r.status_code == 200
    body = r.json()
    assert body["override"] == "NEW {title}" and body["overridden"] is True
    assert body["cleared"] is False and body["missing_placeholders"] == ["content"]
    assert json.loads(ofile.read_text(encoding="utf-8")) == {NAME: "NEW {title}"}
    assert templates.get_prompt_template(NAME) == "NEW {title}"
    r = tc.delete(f"/api/prompts/templates/{NAME}/override")
    assert r.status_code == 200 and r.json()["removed"] is True and r.json()["override"] is None
    assert tc.delete(f"/api/prompts/templates/{NAME}/override").json()["removed"] is False


def test_put_equal_to_registry_clears(as_role, ofile):
    tc = as_role("admin")
    tc.put(f"/api/prompts/templates/{NAME}/override", json={"template": "NEW {title}"})
    r = tc.put(f"/api/prompts/templates/{NAME}/override", json={"template": REGISTRY})
    assert r.json()["cleared"] is True and r.json()["overridden"] is False
    assert json.loads(ofile.read_text(encoding="utf-8")) == {}


@pytest.mark.parametrize(
    "text, start",
    [
        ("", "The template is empty."),
        ("{title} {", "The template has unbalanced braces ("),
        ("{nope}", "Unknown placeholder {nope}."),
        ("x" * 32_001, "The template is longer than 32,000 characters."),
    ],
)
def test_put_validation(as_role, ofile, text, start):
    r = as_role("admin").put(f"/api/prompts/templates/{NAME}/override", json={"template": text})
    assert r.status_code == 422 and r.json()["detail"].startswith(start)
    assert not ofile.exists()


def test_put_unknown_name_is_404_for_admin(as_role, ofile):
    r = as_role("admin").put("/api/prompts/templates/nope_v1/override", json={"template": "x"})
    assert r.status_code == 404


def test_put_not_configured_409_and_tracked_untouched(as_role, no_overrides):
    before = templates._OVERRIDES_PATH.read_bytes()
    tc = as_role("admin")
    r = tc.put(f"/api/prompts/templates/{NAME}/override", json={"template": "NEW {title}"})
    assert r.status_code == 409
    assert r.json() == {"detail": "Prompt overrides are not configured on this deployment."}
    assert tc.delete(f"/api/prompts/templates/{NAME}/override").status_code == 409
    assert templates._OVERRIDES_PATH.read_bytes() == before


def test_put_unreadable_file_409_and_untouched(as_role, ofile):
    ofile.write_text("{broken", encoding="utf-8")
    tc = as_role("admin")
    r = tc.put(f"/api/prompts/templates/{NAME}/override", json={"template": "NEW {title}"})
    assert r.status_code == 409
    assert r.json() == {
        "detail": "The override file can't be read; fix or remove it on the server."
    }
    assert ofile.read_text(encoding="utf-8") == "{broken"
    s = tc.get("/api/prompts/summary").json()
    assert s["admin"]["overrides"] == {"configured": True, "readable": False, "count": 0}


def test_put_unwritable_directory_500(as_role, monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "prompt_overrides_path", str(tmp_path / "missing-dir" / "o.json"))
    r = as_role("admin").put(
        f"/api/prompts/templates/{NAME}/override", json={"template": "NEW {title}"}
    )
    assert r.status_code == 500 and r.json() == {"detail": "The override file couldn't be written."}


@pytest.mark.parametrize(
    "role, status", [("admin", 200), ("acting", 403), ("demo", 403), ("user", 403)]
)
def test_evals_role_matrix(as_role, runs, role, status):
    tc = as_role(role)
    assert tc.get("/api/prompts/evals").status_code == status
    assert tc.get("/api/prompts/evals/run-a").status_code == status
    if role == "acting":
        assert tc.get("/api/prompts/evals").json() == VIEWING_AS_DEMO
        assert tc.get("/api/prompts/evals/run-a").json() == VIEWING_AS_DEMO


def test_evals_not_configured(as_role, monkeypatch):
    monkeypatch.setattr(settings, "eval_runs_dir", "")
    assert as_role("admin").get("/api/prompts/evals").json() == {
        "configured": False,
        "readable": False,
        "runs": [],
        "skipped": 0,
    }
    monkeypatch.setattr(settings, "eval_runs_dir", "/nonexistent-prompts-runs")
    assert as_role("admin").get("/api/prompts/evals").json() == {
        "configured": True,
        "readable": False,
        "runs": [],
        "skipped": 0,
    }
    assert as_role("admin").get("/api/prompts/evals/run-a").status_code == 404


def test_evals_configured(as_role, runs):
    tc = as_role("admin")
    body = tc.get("/api/prompts/evals").json()
    assert body["configured"] and body["readable"] and body["skipped"] == 0
    assert [r["run_id"] for r in body["runs"]] == ["run-b", "run-a"]
    assert body["runs"][0]["delta"] == {
        "vs_version": "v1.0",
        "vs_run_id": "run-a",
        "selection": 0.25,
        "stress": None,
    }
    d = tc.get("/api/prompts/evals/run-b").json()
    assert d["run_id"] == "run-b" and d["fixtures"][0]["status"] == "correct"
    assert tc.get("/api/prompts/evals/run-zzz").json() == {"detail": "run not found"}


def test_eval_detail_traversal(as_role, runs):
    tc = as_role("admin")
    for path in (
        "/api/prompts/evals/..%2Foutside%2Fsecret",
        "/api/prompts/evals/%2E%2E",
        "/api/prompts/evals/.hidden",
        "/api/prompts/evals/..",
        "/api/prompts/evals/run-a%2F..%2F..%2Foutside",
    ):
        r = tc.get(path)
        assert r.status_code in (404, 422), path
        assert "secret" not in r.text


def test_unauthenticated_in_prod_mode_is_401(monkeypatch):
    from backend.api.main import app

    monkeypatch.setattr(settings, "environment", "production")
    tc = TestClient(app)
    for path in (
        "/api/prompts/summary",
        f"/api/prompts/templates/{NAME}",
        "/api/prompts/evals",
        "/api/prompts/evals/run-a",
    ):
        assert tc.get(path).status_code == 401, path
    assert (
        tc.put(f"/api/prompts/templates/{NAME}/override", json={"template": "x"}).status_code == 401
    )
    assert tc.delete(f"/api/prompts/templates/{NAME}/override").status_code == 401
