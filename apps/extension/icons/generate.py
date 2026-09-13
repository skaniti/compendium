#!/usr/bin/env python3
"""
Regenerate apps/extension/icons/icon-*.png in the Compendium Grey palette.

Mark: a rounded dark square, a flat "C" ring open on the right, and a filled
accent dot plugging the opening.

Each size is drawn independently at a 1024px master canvas -- with stroke/
border/dot proportions computed from the TARGET size first, then scaled up to
1024 -- and LANCZOS-downsampled back down to that target. Drawing per-target
(rather than downsampling one shared 1024 master to every size) is what lets
the 16px icon get a boosted relative stroke width instead of a proportion
that would round away to nothing.

Usage: python3 apps/extension/icons/generate.py
"""

import os

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))

# Compendium Grey palette (matches --c-bg / --c-border / --c-text / --c-accent
# in popup.css and cache.css).
BG_FILL = (0x18, 0x19, 0x1A, 255)
BG_BORDER = (0x34, 0x36, 0x3A, 255)
RING_COLOR = (0xD7, 0xD8, 0xDA, 255)
DOT_COLOR = (0x6E, 0x85, 0xA9, 255)

MASTER = 1024
SIZES = [128, 96, 48, 32, 16]

SQUARE_MARGIN_FRAC = 0.04   # margin from canvas edge to the square backdrop
CORNER_RADIUS_FRAC = 0.22   # of target size
BORDER_BASELINE_SIZE = 128  # "1px-equivalent border ... at 128"
RING_DIAMETER_FRAC = 0.58   # of target size
RING_STROKE_FRAC = 0.15     # of target size
RING_STROKE_MIN_PX = 3      # minimum stroke width, binds at the 16px target
DOT_DIAMETER_FRAC = 0.18    # of target size
RING_START_DEG = 40         # opening is the short arc through 0 deg (east)
RING_END_DEG = 320


def render_icon(target):
    """Render one icon at `target` px, via a 1024px master canvas."""
    scale = MASTER / target

    img = Image.new('RGBA', (MASTER, MASTER), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # ── Background: rounded dark square with a hairline border ──────────
    margin = SQUARE_MARGIN_FRAC * target * scale
    corner_radius = round(CORNER_RADIUS_FRAC * target * scale)
    border_w = max(1, round((target / BORDER_BASELINE_SIZE) * scale))
    sq_box = [margin, margin, MASTER - margin, MASTER - margin]
    draw.rounded_rectangle(
        sq_box, radius=corner_radius,
        fill=BG_FILL, outline=BG_BORDER, width=border_w,
    )

    # ── "C" ring: flat stroke, open on the right ─────────────────────────
    cx = cy = MASTER / 2
    ring_r = (RING_DIAMETER_FRAC * target * scale) / 2
    stroke_at_target = max(RING_STROKE_MIN_PX, round(RING_STROKE_FRAC * target))
    stroke = max(1, round(stroke_at_target * scale))
    ring_box = [cx - ring_r, cy - ring_r, cx + ring_r, cy + ring_r]
    draw.arc(ring_box, start=RING_START_DEG, end=RING_END_DEG,
             fill=RING_COLOR, width=stroke)

    # ── Accent dot, centred in the ring's opening (due east / angle 0) ───
    dot_r = max(1, round(DOT_DIAMETER_FRAC * target * scale)) / 2
    dot_cx, dot_cy = cx + ring_r, cy
    draw.ellipse(
        [dot_cx - dot_r, dot_cy - dot_r, dot_cx + dot_r, dot_cy + dot_r],
        fill=DOT_COLOR,
    )

    return img.resize((target, target), Image.LANCZOS)


def main():
    print(f"Generating {len(SIZES)} icon(s) into {HERE} (master {MASTER}px)")
    for size in SIZES:
        icon = render_icon(size)
        path = os.path.join(HERE, f'icon-{size}.png')
        icon.save(path, 'PNG')
        print(f"  icon-{size}.png -> {size}x{size}px, {os.path.getsize(path)} bytes")
    print("Done.")


if __name__ == '__main__':
    main()
