"""Build icon manifests from SVG files in the icons/svg/ directory.

Parses each .svg file, extracts path data and viewBox, then generates:
  - backend/data/icon_manifest.json        (label map for LLM icon selection)

This is the backend-only half of the original icon-build tool. The prior
Dash frontend output (icon_manifest.js / icon_data.json, an inline-SVG D3
render manifest) is not carried into apps/api -- apps/web has its own icon
mechanism (batch-01). If the web app ever needs SVG path data generated
from icons/svg/ the same way, that's a separate apps/web-side tool, not a
revival of this one's frontend output.

Old manifests are archived to .archive/icon-manifests/ with a date prefix.

Usage:
    python scripts/build_icon_manifests.py             # parse SVGs → generate manifests
    python scripts/build_icon_manifests.py --dry-run    # preview without writing
    python scripts/build_icon_manifests.py --no-archive # skip archiving old manifests
"""

from __future__ import annotations

import argparse
import json
import math
import re
import shutil
import sys
import xml.etree.ElementTree as ET
from datetime import date
from pathlib import Path

import yaml

# ── Paths ────────────────────────────────────────────────────────────────

PROJECT_ROOT = Path(__file__).resolve().parents[1]
ICONS_DIR = PROJECT_ROOT / "icons"
SVG_DIR = ICONS_DIR / "svg"
METADATA_PATH = ICONS_DIR / "icon_metadata.yaml"

BACKEND_MANIFEST = PROJECT_ROOT / "backend" / "data" / "icon_manifest.json"

ARCHIVE_DIR = PROJECT_ROOT / ".archive" / "icon-manifests"

SVG_NS = "http://www.w3.org/2000/svg"
NS_MAP = {"svg": SVG_NS}

# Tags that we can convert to <path> d-strings
SHAPE_CONVERTERS = {}  # populated by decorators below


# ── Shape-to-path converters ────────────────────────────────────────────


def _attr(elem: ET.Element, name: str, default: str = "0") -> float:
    """Read a numeric attribute, namespace-unaware."""
    return float(elem.get(name, default))


def circle_to_path(elem: ET.Element) -> str:
    cx, cy, r = _attr(elem, "cx"), _attr(elem, "cy"), _attr(elem, "r")
    # Two-arc circle
    return f"M{cx - r},{cy}" f"A{r},{r} 0 1,0 {cx + r},{cy}" f"A{r},{r} 0 1,0 {cx - r},{cy}Z"


def ellipse_to_path(elem: ET.Element) -> str:
    cx, cy = _attr(elem, "cx"), _attr(elem, "cy")
    rx, ry = _attr(elem, "rx"), _attr(elem, "ry")
    return f"M{cx - rx},{cy}" f"A{rx},{ry} 0 1,0 {cx + rx},{cy}" f"A{rx},{ry} 0 1,0 {cx - rx},{cy}Z"


def rect_to_path(elem: ET.Element) -> str:
    x, y = _attr(elem, "x"), _attr(elem, "y")
    w, h = _attr(elem, "width"), _attr(elem, "height")
    rx = _attr(elem, "rx", "0")
    ry = _attr(elem, "ry", str(rx))  # ry defaults to rx per SVG spec
    if rx == 0 and ry == 0:
        return f"M{x},{y}H{x + w}V{y + h}H{x}Z"
    # Rounded rect
    return (
        f"M{x + rx},{y}"
        f"H{x + w - rx}"
        f"A{rx},{ry} 0 0,1 {x + w},{y + ry}"
        f"V{y + h - ry}"
        f"A{rx},{ry} 0 0,1 {x + w - rx},{y + h}"
        f"H{x + rx}"
        f"A{rx},{ry} 0 0,1 {x},{y + h - ry}"
        f"V{y + ry}"
        f"A{rx},{ry} 0 0,1 {x + rx},{y}Z"
    )


def line_to_path(elem: ET.Element) -> str:
    x1, y1 = _attr(elem, "x1"), _attr(elem, "y1")
    x2, y2 = _attr(elem, "x2"), _attr(elem, "y2")
    return f"M{x1},{y1}L{x2},{y2}"


def _points_to_coords(points_str: str) -> list[tuple[float, float]]:
    """Parse SVG points attribute → list of (x, y) tuples."""
    nums = re.findall(r"[-+]?(?:\d+\.?\d*|\.\d+)", points_str)
    return [(float(nums[i]), float(nums[i + 1])) for i in range(0, len(nums) - 1, 2)]


def polygon_to_path(elem: ET.Element) -> str:
    pts = _points_to_coords(elem.get("points", ""))
    if not pts:
        return ""
    parts = [f"M{pts[0][0]},{pts[0][1]}"]
    parts.extend(f"L{x},{y}" for x, y in pts[1:])
    parts.append("Z")
    return "".join(parts)


def polyline_to_path(elem: ET.Element) -> str:
    pts = _points_to_coords(elem.get("points", ""))
    if not pts:
        return ""
    parts = [f"M{pts[0][0]},{pts[0][1]}"]
    parts.extend(f"L{x},{y}" for x, y in pts[1:])
    return "".join(parts)


SHAPE_CONVERTERS = {
    "circle": circle_to_path,
    "ellipse": ellipse_to_path,
    "rect": rect_to_path,
    "line": line_to_path,
    "polygon": polygon_to_path,
    "polyline": polyline_to_path,
}

# Tags to silently skip (decorative / unsupported)
SKIP_TAGS = {
    "defs",
    "style",
    "use",
    "clipPath",
    "mask",
    "image",
    "title",
    "desc",
    "metadata",
}


# ── Matrix math ─────────────────────────────────────────────────────────

# Matrices are stored as 6-tuples (a, b, c, d, e, f) representing the 3x3
# affine transform:
#
#     [ a c e ]
#     [ b d f ]
#     [ 0 0 1 ]
#
# Point transform:  new_x = a*x + c*y + e,  new_y = b*x + d*y + f
# Vector transform: new_dx = a*dx + c*dy,   new_dy = b*dx + d*dy  (no translation)

Matrix = tuple[float, float, float, float, float, float]
IDENTITY: Matrix = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)


def matrix_multiply(m1: Matrix, m2: Matrix) -> Matrix:
    """Return m1 @ m2 — composition where m2 is applied first, then m1."""
    a1, b1, c1, d1, e1, f1 = m1
    a2, b2, c2, d2, e2, f2 = m2
    return (
        a1 * a2 + c1 * b2,
        b1 * a2 + d1 * b2,
        a1 * c2 + c1 * d2,
        b1 * c2 + d1 * d2,
        a1 * e2 + c1 * f2 + e1,
        b1 * e2 + d1 * f2 + f1,
    )


def matrix_is_identity(m: Matrix, eps: float = 1e-9) -> bool:
    a, b, c, d, e, f = m
    return (
        abs(a - 1) < eps
        and abs(b) < eps
        and abs(c) < eps
        and abs(d - 1) < eps
        and abs(e) < eps
        and abs(f) < eps
    )


def matrix_is_diagonal(m: Matrix, eps: float = 1e-9) -> bool:
    """True if the linear part has no shear/rotation (b == c == 0)."""
    _, b, c, _, _, _ = m
    return abs(b) < eps and abs(c) < eps


def transform_point(m: Matrix, x: float, y: float) -> tuple[float, float]:
    a, b, c, d, e, f = m
    return (a * x + c * y + e, b * x + d * y + f)


def transform_vector(m: Matrix, dx: float, dy: float) -> tuple[float, float]:
    a, b, c, d, _, _ = m
    return (a * dx + c * dy, b * dx + d * dy)


# ── Transform attribute parsing ─────────────────────────────────────────

_TRANSFORM_FUNC_RE = re.compile(r"(\w+)\s*\(([^)]*)\)")
_NUM_RE = re.compile(r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?")


def _func_to_matrix(name: str, args: list[float]) -> Matrix | None:
    """Convert a single transform function to a matrix. Returns None for unknown."""
    if name == "matrix" and len(args) == 6:
        return (args[0], args[1], args[2], args[3], args[4], args[5])
    if name == "translate":
        tx = args[0] if args else 0.0
        ty = args[1] if len(args) > 1 else 0.0
        return (1.0, 0.0, 0.0, 1.0, tx, ty)
    if name == "scale":
        sx = args[0] if args else 1.0
        sy = args[1] if len(args) > 1 else sx
        return (sx, 0.0, 0.0, sy, 0.0, 0.0)
    if name == "rotate":
        if not args:
            return IDENTITY
        angle = math.radians(args[0])
        ca, sa = math.cos(angle), math.sin(angle)
        if len(args) >= 3:
            cx, cy = args[1], args[2]
            # translate(cx,cy) · rotate · translate(-cx,-cy)
            return (
                ca,
                sa,
                -sa,
                ca,
                cx - cx * ca + cy * sa,
                cy - cx * sa - cy * ca,
            )
        return (ca, sa, -sa, ca, 0.0, 0.0)
    if name == "skewX":
        t = math.tan(math.radians(args[0]))
        return (1.0, 0.0, t, 1.0, 0.0, 0.0)
    if name == "skewY":
        t = math.tan(math.radians(args[0]))
        return (1.0, t, 0.0, 1.0, 0.0, 0.0)
    return None


def parse_transform_attr(transform: str) -> Matrix:
    """Parse an SVG transform attribute into a single matrix. Unknown
    functions are silently skipped. Empty string returns identity."""
    if not transform:
        return IDENTITY
    result = IDENTITY
    for match in _TRANSFORM_FUNC_RE.finditer(transform):
        name = match.group(1)
        args = [float(n) for n in _NUM_RE.findall(match.group(2))]
        sub = _func_to_matrix(name, args)
        if sub is not None:
            result = matrix_multiply(result, sub)
    return result


# ── Path command tokenizer and parser ───────────────────────────────────

_PATH_TOKEN_RE = re.compile(
    r"([MmLlHhVvCcSsQqTtAaZz])|"  # commands
    r"([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)"  # numbers
)

_ARG_COUNTS = {
    "M": 2,
    "m": 2,
    "L": 2,
    "l": 2,
    "H": 1,
    "h": 1,
    "V": 1,
    "v": 1,
    "C": 6,
    "c": 6,
    "S": 4,
    "s": 4,
    "Q": 4,
    "q": 4,
    "T": 2,
    "t": 2,
    "A": 7,
    "a": 7,
    "Z": 0,
    "z": 0,
}


def _parse_path_commands(d: str) -> list[tuple[str, list[float]]]:
    """Parse a path d-string into [(cmd, args), ...] with implicit repetitions expanded."""
    # Tokenize
    tokens: list[tuple[str, float | str]] = []
    for m in _PATH_TOKEN_RE.finditer(d):
        if m.group(1):
            tokens.append(("cmd", m.group(1)))
        else:
            tokens.append(("num", float(m.group(2))))

    commands: list[tuple[str, list[float]]] = []
    i = 0
    n = len(tokens)
    while i < n:
        kind, value = tokens[i]
        if kind != "cmd":
            # Stray number before any command — skip
            i += 1
            continue
        cmd = str(value)
        i += 1
        argc = _ARG_COUNTS.get(cmd, 0)

        if argc == 0:
            commands.append((cmd, []))
            continue

        # Read first argument set
        first_set = True
        while i + argc <= n and all(tokens[i + k][0] == "num" for k in range(argc)):
            args = [float(tokens[i + k][1]) for k in range(argc)]  # type: ignore[arg-type]
            commands.append((cmd, args))
            i += argc
            if first_set:
                # Implicit repetition: after M/m becomes L/l
                if cmd == "M":
                    cmd = "L"
                elif cmd == "m":
                    cmd = "l"
                argc = _ARG_COUNTS[cmd]
                first_set = False

    return commands


# ── Path transformation ─────────────────────────────────────────────────


def _transform_arc(
    rx: float,
    ry: float,
    angle_deg: float,
    sweep: int,
    matrix: Matrix,
) -> tuple[float, float, float, int]:
    """Transform an elliptical arc's (rx, ry, rotation, sweep) under a matrix.

    Exact for any invertible matrix via SVD decomposition of the composed
    linear map. The endpoint (x, y) is transformed separately by the caller.
    """
    a, b, c, d, _, _ = matrix
    det = a * d - b * c
    # Ellipse parameterization: unit circle → ellipse via
    # E = rotate(angle) · scale(rx, ry)
    angle_rad = math.radians(angle_deg)
    ca, sa = math.cos(angle_rad), math.sin(angle_rad)
    # 2x2 ellipse matrix: rotate * diag(rx, ry)
    e11 = ca * rx
    e21 = sa * rx
    e12 = -sa * ry
    e22 = ca * ry
    # Compose with matrix's linear part: L · E
    m11 = a * e11 + c * e21
    m21 = b * e11 + d * e21
    m12 = a * e12 + c * e22
    m22 = b * e12 + d * e22

    # SVD of the composed 2x2 to recover (new_rx, new_ry, new_rotation)
    # Eigenvalues of M^T M give squared singular values
    ata_00 = m11 * m11 + m21 * m21
    ata_01 = m11 * m12 + m21 * m22
    ata_11 = m12 * m12 + m22 * m22
    trace = ata_00 + ata_11
    det_ata = ata_00 * ata_11 - ata_01 * ata_01
    disc = max(0.0, trace * trace / 4 - det_ata)
    sqrt_disc = math.sqrt(disc)
    l1 = trace / 2 + sqrt_disc  # larger eigenvalue
    l2 = max(0.0, trace / 2 - sqrt_disc)
    new_rx = math.sqrt(max(0.0, l1))
    new_ry = math.sqrt(max(0.0, l2))

    # Right singular vector for the larger eigenvalue
    if abs(ata_01) > 1e-12:
        v1x = l1 - ata_11
        v1y = ata_01
    elif ata_00 >= ata_11:
        v1x, v1y = 1.0, 0.0
    else:
        v1x, v1y = 0.0, 1.0
    norm = math.hypot(v1x, v1y)
    if norm > 0:
        v1x /= norm
        v1y /= norm
    # Rotation angle from the left singular vector (M @ v1)
    u1x = m11 * v1x + m12 * v1y
    u1y = m21 * v1x + m22 * v1y
    new_angle_deg = math.degrees(math.atan2(u1y, u1x))

    # Flip sweep direction if matrix reverses orientation
    new_sweep = sweep if det >= 0 else 1 - sweep
    return (new_rx, new_ry, new_angle_deg, new_sweep)


def _fmt(n: float) -> str:
    """Format a number compactly (6 significant digits, no trailing zeros)."""
    if n == 0 or n == -0:
        return "0"
    s = f"{n:.6g}"
    return s


def _serialize_path(commands: list[tuple[str, list[float]]]) -> str:
    """Emit a compact path d-string from (cmd, args) tuples."""
    parts: list[str] = []
    for cmd, args in commands:
        if not args:
            parts.append(cmd)
        else:
            parts.append(cmd + " " + " ".join(_fmt(a) for a in args))
    return " ".join(parts)


def transform_path_d(d: str, matrix: Matrix) -> str:
    """Apply an affine matrix to an SVG path d-string, preserving semantics.

    Handles all SVG path commands including relative forms, H/V shortcuts,
    and elliptical arcs. Returns the input unchanged if matrix is identity.
    """
    if matrix_is_identity(matrix):
        return d

    commands = _parse_path_commands(d)
    if not commands:
        return d

    out: list[tuple[str, list[float]]] = []
    # Track position in ORIGINAL coordinate space for H/V and Z handling
    cur_x, cur_y = 0.0, 0.0
    sub_x, sub_y = 0.0, 0.0  # subpath start
    is_first_cmd = True

    for cmd, args in commands:
        # SVG spec: if the first command is a relative moveto (m), its
        # coordinates are treated as absolute. Convert to M for clarity.
        if is_first_cmd and cmd == "m":
            cmd = "M"

        if cmd == "M":
            x, y = args
            nx, ny = transform_point(matrix, x, y)
            out.append(("M", [nx, ny]))
            cur_x, cur_y = x, y
            sub_x, sub_y = x, y
        elif cmd == "m":
            dx, dy = args
            ndx, ndy = transform_vector(matrix, dx, dy)
            out.append(("m", [ndx, ndy]))
            cur_x += dx
            cur_y += dy
            sub_x, sub_y = cur_x, cur_y
        elif cmd == "L":
            x, y = args
            nx, ny = transform_point(matrix, x, y)
            out.append(("L", [nx, ny]))
            cur_x, cur_y = x, y
        elif cmd == "l":
            dx, dy = args
            ndx, ndy = transform_vector(matrix, dx, dy)
            out.append(("l", [ndx, ndy]))
            cur_x += dx
            cur_y += dy
        elif cmd == "H":
            x = args[0]
            nx, ny = transform_point(matrix, x, cur_y)
            out.append(("L", [nx, ny]))
            cur_x = x
        elif cmd == "h":
            dx = args[0]
            ndx, ndy = transform_vector(matrix, dx, 0)
            out.append(("l", [ndx, ndy]))
            cur_x += dx
        elif cmd == "V":
            y = args[0]
            nx, ny = transform_point(matrix, cur_x, y)
            out.append(("L", [nx, ny]))
            cur_y = y
        elif cmd == "v":
            dy = args[0]
            ndx, ndy = transform_vector(matrix, 0, dy)
            out.append(("l", [ndx, ndy]))
            cur_y += dy
        elif cmd == "C":
            p1 = transform_point(matrix, args[0], args[1])
            p2 = transform_point(matrix, args[2], args[3])
            p3 = transform_point(matrix, args[4], args[5])
            out.append(("C", [*p1, *p2, *p3]))
            cur_x, cur_y = args[4], args[5]
        elif cmd == "c":
            v1 = transform_vector(matrix, args[0], args[1])
            v2 = transform_vector(matrix, args[2], args[3])
            v3 = transform_vector(matrix, args[4], args[5])
            out.append(("c", [*v1, *v2, *v3]))
            cur_x += args[4]
            cur_y += args[5]
        elif cmd == "S":
            p1 = transform_point(matrix, args[0], args[1])
            p2 = transform_point(matrix, args[2], args[3])
            out.append(("S", [*p1, *p2]))
            cur_x, cur_y = args[2], args[3]
        elif cmd == "s":
            v1 = transform_vector(matrix, args[0], args[1])
            v2 = transform_vector(matrix, args[2], args[3])
            out.append(("s", [*v1, *v2]))
            cur_x += args[2]
            cur_y += args[3]
        elif cmd == "Q":
            p1 = transform_point(matrix, args[0], args[1])
            p2 = transform_point(matrix, args[2], args[3])
            out.append(("Q", [*p1, *p2]))
            cur_x, cur_y = args[2], args[3]
        elif cmd == "q":
            v1 = transform_vector(matrix, args[0], args[1])
            v2 = transform_vector(matrix, args[2], args[3])
            out.append(("q", [*v1, *v2]))
            cur_x += args[2]
            cur_y += args[3]
        elif cmd == "T":
            nx, ny = transform_point(matrix, args[0], args[1])
            out.append(("T", [nx, ny]))
            cur_x, cur_y = args[0], args[1]
        elif cmd == "t":
            ndx, ndy = transform_vector(matrix, args[0], args[1])
            out.append(("t", [ndx, ndy]))
            cur_x += args[0]
            cur_y += args[1]
        elif cmd == "A":
            rx, ry, angle, laf, sf, x, y = args
            new_rx, new_ry, new_angle, new_sf = _transform_arc(rx, ry, angle, int(sf), matrix)
            nx, ny = transform_point(matrix, x, y)
            out.append(("A", [new_rx, new_ry, new_angle, laf, new_sf, nx, ny]))
            cur_x, cur_y = x, y
        elif cmd == "a":
            rx, ry, angle, laf, sf, dx, dy = args
            new_rx, new_ry, new_angle, new_sf = _transform_arc(rx, ry, angle, int(sf), matrix)
            ndx, ndy = transform_vector(matrix, dx, dy)
            out.append(("a", [new_rx, new_ry, new_angle, laf, new_sf, ndx, ndy]))
            cur_x += dx
            cur_y += dy
        elif cmd in ("Z", "z"):
            out.append((cmd, []))
            cur_x, cur_y = sub_x, sub_y

        is_first_cmd = False

    return _serialize_path(out)


# ── SVG parsing ─────────────────────────────────────────────────────────


def _local_tag(tag: str) -> str:
    """Strip namespace from tag: {http://www.w3.org/2000/svg}path → path."""
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def _collect_paths(
    elem: ET.Element,
    matrix: Matrix = IDENTITY,
    warnings: list[str] | None = None,
) -> list[str]:
    """Recursively collect path d-strings from an element tree, applying
    any composed <g> transforms along the way."""
    paths: list[str] = []
    if warnings is None:
        warnings = []

    for child in elem:
        tag = _local_tag(child.tag)

        if tag in SKIP_TAGS:
            if tag == "style":
                warnings.append("contains <style> element (stripped)")
            continue

        # Any element may carry its own transform attribute; compose with parent
        local = parse_transform_attr(child.get("transform", ""))
        effective = matrix if matrix_is_identity(local) else matrix_multiply(matrix, local)

        if tag == "g":
            paths.extend(_collect_paths(child, effective, warnings))
            continue

        if tag == "path":
            d = child.get("d", "").strip()
            if d:
                paths.append(transform_path_d(d, effective))
            continue

        if tag in SHAPE_CONVERTERS:
            converter = SHAPE_CONVERTERS[tag]
            d = converter(child)
            if d:
                paths.append(transform_path_d(d, effective))
            continue

        # Unknown tag — recurse in case it contains paths
        paths.extend(_collect_paths(child, effective, warnings))

    return paths


def parse_svg(svg_path: Path) -> dict | None:
    """Parse an SVG file → {viewBox, paths} or None on failure.

    Returns None and prints a warning if the SVG can't be parsed or has no paths.
    """
    try:
        tree = ET.parse(svg_path)
    except ET.ParseError as e:
        print(f"  WARNING: {svg_path.name} — XML parse error: {e}", file=sys.stderr)
        return None

    root = tree.getroot()
    root_tag = _local_tag(root.tag)
    if root_tag != "svg":
        print(
            f"  WARNING: {svg_path.name} — root element is <{root_tag}>, expected <svg>",
            file=sys.stderr,
        )
        return None

    # Extract viewBox
    view_box = root.get("viewBox")
    if not view_box:
        w = root.get("width", "24")
        h = root.get("height", "24")
        # Strip units (px, em, etc.)
        w = re.sub(r"[^\d.]", "", w) or "24"
        h = re.sub(r"[^\d.]", "", h) or "24"
        view_box = f"0 0 {w} {h}"

    # Collect paths
    warnings: list[str] = []
    paths = _collect_paths(root, warnings=warnings)

    for w in warnings:
        print(f"  WARNING: {svg_path.name} — {w}", file=sys.stderr)

    if not paths:
        print(f"  WARNING: {svg_path.name} — no renderable paths found", file=sys.stderr)
        return None

    return {"viewBox": view_box, "paths": paths}


# ── Metadata ─────────────────────────────────────────────────────────────


def load_metadata() -> tuple[dict[str, dict[str, str]], list[str]]:
    """Load icon_metadata.yaml (v2 schema).

    Returns ({icon_id: {"label": str, "category": str}}, category_order_list).

    Schema v2 requires both `_category_order` and `icons` top-level keys.
    Any other shape fails loudly — no silent fallback to the v1 flat schema.
    """
    if not METADATA_PATH.exists():
        sys.exit(f"ERROR: metadata file not found at {METADATA_PATH}")
    with METADATA_PATH.open(encoding="utf-8") as f:
        data = yaml.safe_load(f)
    if not isinstance(data, dict):
        sys.exit(f"ERROR: {METADATA_PATH} did not parse as a YAML mapping")
    if "_category_order" not in data or "icons" not in data:
        sys.exit(
            f"ERROR: {METADATA_PATH} is missing v2 schema keys "
            f"(expected `_category_order` and `icons`)"
        )
    category_order = list(data["_category_order"])
    icons = dict(data["icons"])
    return icons, category_order


def label_for(icon_id: str, metadata: dict[str, dict[str, str]]) -> str:
    """Get the label for an icon. Every icon must have a metadata entry."""
    entry = metadata.get(icon_id)
    if not entry:
        sys.exit(f"ERROR: icon {icon_id!r} has no metadata entry in {METADATA_PATH}")
    return entry["label"]


def category_for(icon_id: str, metadata: dict[str, dict[str, str]]) -> str:
    """Get the category for an icon."""
    entry = metadata.get(icon_id)
    if not entry:
        sys.exit(f"ERROR: icon {icon_id!r} has no metadata entry in {METADATA_PATH}")
    return entry["category"]


# ── Archive ──────────────────────────────────────────────────────────────


def archive_manifests() -> list[str]:
    """Move existing manifests to .archive/icon-manifests/ with date prefix.

    Returns list of archived file descriptions for logging.
    """
    ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
    today = date.today().strftime("%y-%m-%d")
    archived = []

    for src in (BACKEND_MANIFEST,):
        if not src.exists():
            continue

        dest_name = f"{today}_{src.name}"
        dest = ARCHIVE_DIR / dest_name

        # Handle duplicate same-day runs
        if dest.exists():
            seq = 2
            while True:
                stem = src.stem
                dest_name = f"{today}_{stem}_{seq}{src.suffix}"
                dest = ARCHIVE_DIR / dest_name
                if not dest.exists():
                    break
                seq += 1

        shutil.copy2(src, dest)
        archived.append(f"  {src.name} → .archive/icon-manifests/{dest.name}")

    return archived


# ── Generators ───────────────────────────────────────────────────────────


def generate_backend_json(
    icons: dict[str, dict],
    metadata: dict[str, dict[str, str]],
) -> str:
    """Generate backend icon_manifest.json — flat {icon_id: label} for LLM selection.

    Stays flat even though metadata now has category info, because the LLM
    prompt doesn't need category grouping (see super_cluster_service.py).
    """
    data = {icon_id: label_for(icon_id, metadata) for icon_id in sorted(icons.keys())}
    return json.dumps(data, indent=2, ensure_ascii=False) + "\n"


# ── Main ─────────────────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(
        description="Build icon manifests from SVG files in icons/svg/",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Preview what would be generated without writing files",
    )
    parser.add_argument(
        "--no-archive",
        action="store_true",
        help="Skip archiving old manifests before overwriting",
    )
    args = parser.parse_args()

    # Validate svg directory
    if not SVG_DIR.exists():
        print(f"ERROR: icons/svg/ directory not found at {SVG_DIR}", file=sys.stderr)
        print("Create it and add .svg files, then re-run.", file=sys.stderr)
        sys.exit(1)

    svg_files = sorted(SVG_DIR.glob("*.svg"))
    if not svg_files:
        print(f"ERROR: No .svg files found in {SVG_DIR}", file=sys.stderr)
        sys.exit(1)

    # Parse all SVGs
    print(f"Parsing {len(svg_files)} SVG files from icons/svg/...")
    icons: dict[str, dict] = {}
    for svg_path in svg_files:
        icon_id = svg_path.stem
        result = parse_svg(svg_path)
        if result:
            icons[icon_id] = result
            path_count = len(result["paths"])
            print(f"  {icon_id}: {path_count} path{'s' if path_count != 1 else ''}")

    if not icons:
        print("ERROR: No valid icons parsed.", file=sys.stderr)
        sys.exit(1)

    # Load metadata (v2 schema)
    metadata, category_order = load_metadata()

    # Drift check: every SVG must have a metadata entry and vice versa.
    svg_ids = set(icons.keys())
    meta_ids = set(metadata.keys())
    only_in_svg = svg_ids - meta_ids
    only_in_meta = meta_ids - svg_ids
    if only_in_svg or only_in_meta:
        print("\nERROR: drift between icons/svg/ and icon_metadata.yaml", file=sys.stderr)
        if only_in_svg:
            print(
                f"  SVGs without metadata entries: {sorted(only_in_svg)}",
                file=sys.stderr,
            )
        if only_in_meta:
            print(
                f"  Metadata entries without SVGs: {sorted(only_in_meta)}",
                file=sys.stderr,
            )
        sys.exit(1)
    print(f"\nMetadata OK: {len(metadata)} icons across {len(category_order)} categories")

    # Generate content
    backend_json = generate_backend_json(icons, metadata)

    if args.dry_run:
        print("\n── DRY RUN ─────────────────────────────────────")
        print(f"\nWould generate {len(icons)} icons in 1 file:")
        print(f"  {BACKEND_MANIFEST}")
        print("\nbackend icon_manifest.json:")
        print(f"  {backend_json.strip()}")
        return

    # Archive old manifest
    if not args.no_archive:
        archived = archive_manifests()
        if archived:
            print(f"\nArchived {len(archived)} old manifest(s):")
            for a in archived:
                print(a)

    # Write output
    BACKEND_MANIFEST.write_text(backend_json, encoding="utf-8")
    print(f"Wrote {BACKEND_MANIFEST}")

    print(f"\nDone — {len(icons)} icons built successfully.")


if __name__ == "__main__":
    main()
