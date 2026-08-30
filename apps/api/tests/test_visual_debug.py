"""Smoke tests for scripts/dev/visual_debug.py. Covers the genuinely fragile
parts: image dimension cap, JSON schema completeness, folder structure
(Model B), auto-launch fall-through, and the Option-1.5 expected/actual/delta
round-trip."""

from __future__ import annotations

import json
import pathlib
from unittest.mock import patch

import pytest
from PIL import Image

from scripts.dev import visual_debug
from scripts.dev.visual_debug import (
    DEFAULT_THUMBNAIL_MAX,
    VisualDebugSession,
    _thumbnail_to_max,
)


@pytest.fixture
def tmp_base(tmp_path: pathlib.Path) -> pathlib.Path:
    return tmp_path / "vd"


def test_thumbnail_caps_oversized_image(tmp_path: pathlib.Path) -> None:
    """An oversized image must come out <= 1900px on the longest side."""
    big = Image.new("RGB", (3000, 200), (0, 0, 0))
    _thumbnail_to_max(big, max_size=DEFAULT_THUMBNAIL_MAX)
    assert max(big.size) <= DEFAULT_THUMBNAIL_MAX
    small = Image.new("RGB", (1000, 100), (0, 0, 0))
    _thumbnail_to_max(small, max_size=DEFAULT_THUMBNAIL_MAX)
    assert small.size == (1000, 100)


def test_session_creates_model_b_layout(tmp_base: pathlib.Path) -> None:
    """Init creates issue + iteration dirs; verify_postfix creates a NEW iteration dir."""
    s = VisualDebugSession("test issue", base_dir=tmp_base)
    assert s.issue_dir.parent == tmp_base
    assert s.issue_dir.name.endswith("-test-issue")
    assert s.iteration_dir.parent == s.issue_dir
    assert s.iteration_dir.exists()

    iters_before = sorted(p for p in s.issue_dir.iterdir() if p.is_dir())
    assert len(iters_before) == 1

    # Model B check: verify_postfix creates a NEW iteration folder
    s.add_point("p", screen=(50, 50), kind="reference")
    fake_raw = Image.new("RGB", (200, 200), (0, 0, 0))

    def fake_screenshot(ws_url: str, out_path: str) -> None:
        fake_raw.save(out_path)

    with patch.object(visual_debug, "_ensure_cdp_alive", lambda **kw: None), \
         patch.object(visual_debug.cdp_helper, "screenshot", side_effect=fake_screenshot):
        s.capture(ws_url="ws://fake")
        s.verify_postfix(ws_url="ws://fake")

    iters_after = sorted(p for p in s.issue_dir.iterdir() if p.is_dir())
    assert len(iters_after) == 2, f"Model B requires 2 iteration dirs, got {iters_after}"


def test_capture_writes_complete_json_schema(tmp_base: pathlib.Path) -> None:
    """annotation-info.json must contain all required keys per the spec."""
    s = VisualDebugSession("schema check", base_dir=tmp_base)
    s.add_point("ref", screen=(100, 100), kind="reference", world=(50.5, 50.5))
    s.add_line("expected", (100, 100), (200, 200), kind="expected")
    fake_raw = Image.new("RGB", (400, 400), (0, 0, 0))

    def fake_screenshot(ws_url: str, out_path: str) -> None:
        fake_raw.save(out_path)

    with patch.object(visual_debug, "_ensure_cdp_alive", lambda **kw: None), \
         patch.object(visual_debug.cdp_helper, "screenshot", side_effect=fake_screenshot):
        s.capture(
            ws_url="ws://fake",
            subject="ref pill",
            diagnosis="explicit cause",
            fix_location="src/foo.py:42",
        )

    info_path = s.iteration_dir / "annotation-info.json"
    assert info_path.exists()
    info = json.loads(info_path.read_text())
    required = {
        "issue", "issue_slug", "iteration", "subject", "reference_points",
        "lines", "diagnosis", "fix_location", "artifacts", "captured_at",
    }
    missing = required - info.keys()
    assert not missing, f"missing JSON keys: {missing}"
    assert info["fix_location"] == "src/foo.py:42"
    assert info["reference_points"][0]["world"] == [50.5, 50.5]
    # Option-1.5: when set_expected/set_actual were NOT called, those keys are absent
    assert "expected" not in info
    assert "actual" not in info
    assert "delta" not in info
    assert (s.iteration_dir / "annotated-full.png").exists()
    assert (s.iteration_dir / "annotated-cropped.png").exists()


def test_ensure_cdp_alive_invokes_launcher_on_down(tmp_path: pathlib.Path) -> None:
    """If CDP is down, _ensure_cdp_alive must run the launcher subprocess and
    poll until alive. Mocked: subprocess.Popen is replaced; _cdp_is_alive
    returns False once then True forever."""
    calls = {"alive_n": 0, "popen_invoked": False}

    def fake_alive(base=visual_debug.cdp_helper.CDP_BASE, timeout=2.0) -> bool:
        calls["alive_n"] += 1
        return calls["alive_n"] > 1  # first call: down; subsequent: up

    class FakePopen:
        def __init__(self, *a, **kw):
            calls["popen_invoked"] = True

        def poll(self) -> int | None:
            # Pretend the launcher is still running -- exit-code path is
            # exercised separately in test_ensure_cdp_alive_surfaces_launcher_failure
            return None

    with patch.object(visual_debug, "_cdp_is_alive", side_effect=fake_alive), \
         patch.object(visual_debug.subprocess, "Popen", FakePopen):
        visual_debug._ensure_cdp_alive(timeout_s=5.0)

    assert calls["popen_invoked"], "launcher subprocess was not invoked"
    assert calls["alive_n"] >= 2, "polling loop did not run"


def test_ensure_cdp_alive_surfaces_launcher_failure(tmp_path: pathlib.Path) -> None:
    """If the launcher subprocess exits non-zero, _ensure_cdp_alive must
    raise immediately with the log tail in the message -- not wait out the
    full timeout."""
    # Pre-write a fake launcher log that the function's log_path open()
    # will overwrite, then the FakePopen will "write" by the test's pre-seed.
    # Simpler: let the function create the log file (empty), and assert
    # the exception fires fast.
    calls = {"poll_n": 0}

    class FakePopen:
        def __init__(self, *a, **kw):
            # Pretend to write something to the log fh that was passed
            kw["stdout"].write(b"FAKE LAUNCHER ERROR: sync gate failed\n")
            kw["stdout"].flush()

        def poll(self) -> int:
            calls["poll_n"] += 1
            return 2  # non-zero exit (matches launcher's sync-gate failure code)

    def always_down(base=visual_debug.cdp_helper.CDP_BASE, timeout=2.0) -> bool:
        return False

    with patch.object(visual_debug, "_cdp_is_alive", side_effect=always_down), \
         patch.object(visual_debug.subprocess, "Popen", FakePopen):
        with pytest.raises(RuntimeError, match=r"cdp_edge_launch\.sh failed \(exit 2\)"):
            visual_debug._ensure_cdp_alive(timeout_s=10.0)

    # Should have raised after the FIRST poll cycle, not after timeout
    assert calls["poll_n"] == 1, f"expected 1 poll before raise, got {calls['poll_n']}"


def test_close_cdp_when_already_down_returns_zero() -> None:
    """close_cdp must be idempotent: if CDP is not running, exit 0 cleanly
    without invoking taskkill."""
    taskkill_invoked = {"n": 0}

    def fake_run(*a, **kw):
        taskkill_invoked["n"] += 1
        raise AssertionError("taskkill must NOT be invoked when CDP is already down")

    with patch.object(visual_debug, "_cdp_is_alive", lambda **kw: False), \
         patch.object(visual_debug.subprocess, "run", side_effect=fake_run):
        rc = visual_debug.close_cdp()

    assert rc == 0, f"expected 0 (already-down), got {rc}"
    assert taskkill_invoked["n"] == 0


def test_close_cdp_refuses_unknown_owner_without_force() -> None:
    """If the port-9333 owner's commandline doesn't reference the scratch
    profile path, close_cdp must refuse to taskkill (could be main Edge or
    other tool) and return non-zero. Force=True bypasses the check."""
    taskkill_invoked = {"n": 0}

    def fake_owner_lookup() -> dict:
        # Return a mocked owner that does NOT match the scratch profile hint
        return {"pid": 99999, "cmdline": "/path/to/main/edge --some-flag"}

    def fake_run(*a, **kw):
        taskkill_invoked["n"] += 1
        from types import SimpleNamespace
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    with patch.object(visual_debug, "_find_cdp_owner", fake_owner_lookup), \
         patch.object(visual_debug.subprocess, "run", side_effect=fake_run):
        # Without force: refuse
        rc = visual_debug.close_cdp(force=False)

    assert rc == 2, f"expected 2 (refuse, no force), got {rc}"
    assert taskkill_invoked["n"] == 0, "taskkill must NOT be invoked when refusing"


def test_set_expected_set_actual_round_trip_and_delta(tmp_base: pathlib.Path) -> None:
    """Option-1.5: set_expected + set_actual must surface top-level
    expected/actual/delta in the JSON sidecar, with delta auto-computed
    as actual - expected (both screen and world if present)."""
    s = VisualDebugSession("delta-math", base_dir=tmp_base)
    s.set_expected("anchor", screen=(100, 200), world=(50.0, 80.0), formula="cluster + radial")
    s.set_actual("rendered", screen=(110, 250), world=(55.0, 100.0))

    fake_raw = Image.new("RGB", (400, 400), (0, 0, 0))

    def fake_screenshot(ws_url: str, out_path: str) -> None:
        fake_raw.save(out_path)

    with patch.object(visual_debug, "_ensure_cdp_alive", lambda **kw: None), \
         patch.object(visual_debug.cdp_helper, "screenshot", side_effect=fake_screenshot):
        info = s.capture(ws_url="ws://fake")

    # Round-trip
    assert info["expected"]["screen"] == [100, 200]
    assert info["expected"]["world"] == [50.0, 80.0]
    assert info["expected"]["formula"] == "cluster + radial"
    assert info["actual"]["screen"] == [110, 250]
    # Auto-computed delta: actual - expected
    assert info["delta"]["screen"] == [10, 50]  # [110-100, 250-200]
    assert info["delta"]["world"] == [5.0, 20.0]  # [55.0-50.0, 100.0-80.0]
    # Both screen and labels differ -> divergence_kind = "both"
    assert info["delta"]["divergence_kind"] == "both"

    # Verify the on-disk JSON matches (paranoia)
    info_disk = json.loads((s.iteration_dir / "annotation-info.json").read_text())
    assert info_disk["delta"]["screen"] == [10, 50]
    assert info_disk["delta"]["divergence_kind"] == "both"


def test_text_divergence_classified_when_screens_match(tmp_base: pathlib.Path) -> None:
    """When set_expected and set_actual share screen coords but have different
    labels (the breadcrumb-style text-divergence bug), delta.screen is [0,0]
    but divergence_kind must be 'text' to make the bug class explicit."""
    s = VisualDebugSession("text-bug", base_dir=tmp_base)
    s.set_expected("breadcrumb should read 'Whales'", screen=(200, 100))
    s.set_actual("breadcrumb actually reads 'BigCats > Whales'", screen=(200, 100))

    fake_raw = Image.new("RGB", (400, 200), (0, 0, 0))

    def fake_screenshot(ws_url: str, out_path: str) -> None:
        fake_raw.save(out_path)

    with patch.object(visual_debug, "_ensure_cdp_alive", lambda **kw: None), \
         patch.object(visual_debug.cdp_helper, "screenshot", side_effect=fake_screenshot):
        info = s.capture(ws_url="ws://fake")

    assert info["delta"]["screen"] == [0, 0]
    assert info["delta"]["divergence_kind"] == "text"


def test_capture_writes_vision_pass_template(tmp_base: pathlib.Path) -> None:
    """Every capture must write vision-pass.md into the iteration dir with
    the VISION_PASS_PENDING marker (the SessionStart hook keys off this)."""
    s = VisualDebugSession("vision-pass-template", base_dir=tmp_base)
    fake_raw = Image.new("RGB", (200, 200), (0, 0, 0))

    def fake_screenshot(ws_url: str, out_path: str) -> None:
        fake_raw.save(out_path)

    with patch.object(visual_debug, "_ensure_cdp_alive", lambda **kw: None), \
         patch.object(visual_debug.cdp_helper, "screenshot", side_effect=fake_screenshot):
        s.capture(ws_url="ws://fake")

    vp = s.iteration_dir / "vision-pass.md"
    assert vp.exists()
    content = vp.read_text()
    assert "VISION_PASS_PENDING" in content
    assert "## 1. Observations" in content
    assert "## 2. Caveats" in content
    assert "## 3. Bug status" in content


def test_resume_session_derives_readable_issue_name(tmp_path: pathlib.Path) -> None:
    """_resume_session must derive a readable issue_name from the dir name
    (strip YYYY-MM-DD-HHMMSS- prefix, convert dashes to spaces) rather than
    using the raw slug+timestamp string. The README symptom inherits this."""
    issue_dir = tmp_path / "2026-05-02-124427-right-pane-stale-after-second-click"
    issue_dir.mkdir()
    s = visual_debug._resume_session(issue_dir)
    assert s.issue_name == "right pane stale after second click"
    assert s._readme_symptom == "right pane stale after second click"

    # Caller-supplied issue_name overrides the derivation
    s2 = visual_debug._resume_session(issue_dir, issue_name="My Bug")
    assert s2.issue_name == "My Bug"
    assert s2._readme_symptom == "My Bug"

    # Names without the timestamp prefix get dash-to-space only (no truncation)
    plain_dir = tmp_path / "no-timestamp-here"
    plain_dir.mkdir()
    s3 = visual_debug._resume_session(plain_dir)
    assert s3.issue_name == "no timestamp here"


def test_unknown_kind_raises(tmp_base: pathlib.Path) -> None:
    """Hard fail on unknown marker kind, with helpful error pointing at where to extend."""
    s = VisualDebugSession("unknown-kind", base_dir=tmp_base)
    import pytest
    with pytest.raises(ValueError, match=r"Unknown marker kind 'subject'"):
        s.add_point("foo", screen=(10, 10), kind="subject")  # type: ignore[arg-type]
    with pytest.raises(ValueError, match=r"To add a new kind, extend KIND_COLORS"):
        s.add_point("foo", screen=(10, 10), kind="warning")  # type: ignore[arg-type]


def test_kind_colors_are_hardcoded_per_convention(tmp_base: pathlib.Path) -> None:
    """add_point must derive color from kind via KIND_COLORS; caller can't override."""
    s = VisualDebugSession("kind-colors", base_dir=tmp_base)
    s.add_point("ref", screen=(10, 10), kind="reference")
    s.add_point("der", screen=(20, 20), kind="derived")
    assert s.points[0]["color"] == "#FFFFFF"
    assert s.points[0]["shape"] == "plus"
    assert s.points[1]["color"] == "#FFFFFF"
    assert s.points[1]["shape"] == "circle"


def test_bbox_api_canonicalizes(tmp_base: pathlib.Path) -> None:
    """Caller can pass bbox instead of screen; screen is derived as bbox center.
    And vice versa: passing screen derives an implicit bbox around the point."""
    s = VisualDebugSession("bbox-api", base_dir=tmp_base)
    s.add_point("rect-only", bbox=(100, 200, 300, 400), kind="reference")
    s.add_point("point-only", screen=(50, 60), kind="derived")
    assert s.points[0]["bbox"] == [100, 200, 300, 400]
    assert s.points[0]["screen"] == [200, 300]  # bbox center
    assert s.points[1]["screen"] == [50, 60]
    # Implicit bbox: screen +/- POINT_BBOX_HALF_PX
    h = visual_debug.POINT_BBOX_HALF_PX
    assert s.points[1]["bbox"] == [50 - h, 60 - h, 50 + h, 60 + h]


def test_capture_writes_unannotated_artifacts(tmp_base: pathlib.Path) -> None:
    """Capture must write BOTH unannotated and annotated, full and cropped (4 PNGs).
    JSON sidecar's artifacts dict references all four."""
    s = VisualDebugSession("unannot-artifacts", base_dir=tmp_base)
    s.add_point("ref", screen=(50, 50), kind="reference")
    fake_raw = Image.new("RGB", (200, 200), (32, 32, 32))

    def fake_screenshot(ws_url: str, out_path: str) -> None:
        fake_raw.save(out_path)

    with patch.object(visual_debug, "_ensure_cdp_alive", lambda **kw: None), \
         patch.object(visual_debug.cdp_helper, "screenshot", side_effect=fake_screenshot):
        info = s.capture(ws_url="ws://fake")

    for name in ("annotated-full.png", "annotated-cropped.png",
                 "unannotated-full.png", "unannotated-cropped.png"):
        assert (s.iteration_dir / name).exists(), f"missing {name}"
    assert "annotated_full" in info["artifacts"]
    assert "unannotated_full" in info["artifacts"]
    assert "unannotated_cropped" in info["artifacts"]
    # The unannotated full has the original 200x200 dims (no legend appended)
    from PIL import Image as PILImage
    with PILImage.open(s.iteration_dir / "unannotated-full.png") as un:
        assert un.size == (200, 200)
    # The annotated full has additional legend rows below
    with PILImage.open(s.iteration_dir / "annotated-full.png") as an:
        assert an.height > 200, "annotated-full should have legend rows below"


def test_smart_truncate_preserves_combined_suffix() -> None:
    """Combined-marker label '<actual>  (expected: <expected>)' must keep
    the (expected:) suffix intact when the total exceeds max_chars; only
    the actual portion truncates. Regression test for the loader-bug capture
    where the suffix vanished from the legend."""
    sep = "  (expected: "
    long_actual = "a" * 250
    short_expected = "should be Whales"
    combined = f"{long_actual}{sep}{short_expected})"

    out = visual_debug._smart_truncate(combined, max_chars=200)
    # Suffix must be intact in the output
    assert sep.lstrip() in out, f"separator missing from truncated label: {out!r}"
    assert short_expected in out, f"expected portion missing: {out!r}"
    # Actual portion was truncated
    assert "a" * 250 not in out

    # Non-combined: simple character truncation
    plain = "x" * 300
    out_plain = visual_debug._smart_truncate(plain, max_chars=100)
    assert len(out_plain) == 100

    # Under-budget: no truncation, no ellipsis
    short = "tiny label"
    assert visual_debug._smart_truncate(short, max_chars=200) == short


def test_collapse_coincident_helper() -> None:
    """Pure-function test of the coincidence-collapse logic. Decoupled from
    rendering since label-wrap effects make image-dim comparison brittle."""
    expected = {"label": "should be Whales", "bbox": [50, 50, 100, 100],
                "screen": [75, 75], "kind": "expected", "color": "#93c47d", "shape": "rect"}
    actual_same = {"label": "actually Big Cats > Whales", "bbox": [50, 50, 100, 100],
                   "screen": [75, 75], "kind": "actual", "color": "#e06666", "shape": "rect"}
    actual_diff = {"label": "actually Big Cats", "bbox": [200, 200, 250, 250],
                   "screen": [225, 225], "kind": "actual", "color": "#e06666", "shape": "rect"}

    # Coincident bboxes -> 1 combined marker
    out_same = visual_debug._collapse_coincident(expected, actual_same)
    assert len(out_same) == 1
    assert out_same[0]["color"] == "#e06666"  # actual's color (red)
    assert "should be Whales" in out_same[0]["label"]
    assert "actually Big Cats > Whales" in out_same[0]["label"]
    assert out_same[0]["bbox"] == [50, 50, 100, 100]

    # Different bboxes -> 2 separate markers, both unchanged
    out_diff = visual_debug._collapse_coincident(expected, actual_diff)
    assert len(out_diff) == 2
    assert out_diff[0] is expected
    assert out_diff[1] is actual_diff

    # Only one set -> just that one
    assert visual_debug._collapse_coincident(expected, None) == [expected]
    assert visual_debug._collapse_coincident(None, actual_same) == [actual_same]
    # Neither set -> empty
    assert visual_debug._collapse_coincident(None, None) == []


def test_coincident_capture_writes_text_divergence_in_json(tmp_base: pathlib.Path) -> None:
    """End-to-end: when expected/actual coincide, the JSON sidecar still has
    both entries AND divergence_kind=='text'. The render-side collapse is
    tested separately by test_collapse_coincident_helper."""
    s = VisualDebugSession("coincidence-json", base_dir=tmp_base)
    s.set_expected("should be Whales", screen=(100, 100))
    s.set_actual("actually BigCats > Whales", screen=(100, 100))
    fake_raw = Image.new("RGB", (300, 300), (32, 32, 32))

    def fake_screenshot(ws_url: str, out_path: str) -> None:
        fake_raw.save(out_path)

    with patch.object(visual_debug, "_ensure_cdp_alive", lambda **kw: None), \
         patch.object(visual_debug.cdp_helper, "screenshot", side_effect=fake_screenshot):
        info = s.capture(ws_url="ws://fake")

    assert "expected" in info and "actual" in info
    assert info["delta"]["divergence_kind"] == "text"
    # Annotated image saved successfully
    assert (s.iteration_dir / "annotated-full.png").exists()
