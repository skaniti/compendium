# Almagest — a constellation typeface, size-graded

Three TrueType faces of one caps-only display family. Every glyph is an **asterism**:
stars at the vertices, straight sight-lines between them. The three faces are the same
skeleton at three optical sizes, built so an app can swap between them mid-zoom without
the text moving.

```
Almagest Display   >= 52px      stars dominate, sight-lines fully detached
Almagest Mid       22 - 51px    barely a step down from Display
Almagest Text      13 - 21px    almost starless; a monoline plotted skeleton
```

Open **`proof.html`** in a browser first. It `@font-face`-loads all three TTFs and
prints coverage plus a metric-freeze check. If it renders stars, the fonts are good.
Opened straight from disk, the `../../public/...` font URLs are blocked by Firefox's
`file://` origin rules (the sheet silently falls back to monospace) -- serve
`apps/web` over a local static server instead, e.g. `python3 -m http.server -d
apps/web 8080` then http://localhost:8080/fonts/almagest/proof.html.

---

## 1. What's in this folder

This folder (`apps/web/fonts/almagest/`) holds the source + compiler. The
compiled TTFs are tracked build output and live outside it, under
`apps/web/public/fonts/almagest/` (that's what the app and `proof.html`
actually load).

```
apps/web/fonts/almagest/
  tools/
    almagest-glyphs.cjs        THE SOURCE OF TRUTH — skeletons + tier params + geometry
    build-ttf.cjs               minimal TrueType writer (no dependencies)
    build.cjs                   node fonts/almagest/tools/build.cjs  -> regenerates everything below
  glyphs/                      GENERATED, gitignored -- design-time export, not shipped
    display/  mid/  text/
      U-0041.svg …              one SVG per glyph, per tier — the FINAL filled
                                outline (identical geometry to the TTF), y-up font
                                units flipped into SVG space, viewBox spans the
                                full advance width, baseline at y=0
      notdef.svg
      manifest.json             gid, char, unicode, advance, contour count, tier params
  proof.html                    specimen that loads the compiled TTFs from public/
  README.md
apps/web/public/fonts/almagest/
  Almagest-Display.ttf        76 KB   80 glyphs, 40 kern pairs   TRACKED build output
  Almagest-Mid.ttf            78 KB
  Almagest-Text.ttf           62 KB
```

Nothing in `public/fonts/almagest/` or `glyphs/` is hand-made. Both are
generated from `tools/almagest-glyphs.cjs`. **Edit skeletons there, never the
SVGs.**

```bash
npm run fonts:build                              # all three tiers (from apps/web)
node fonts/almagest/tools/build.cjs Display      # just one tier
```

No npm install. Node ≥ 14, standard library only.

The build's TTF timestamp is fixed (not `Date.now()`), so `npm run
fonts:build` is byte-identical run to run -- `almagest-build.test.ts`
(vitest) rebuilds into a temp dir and fails if the tracked TTFs under
`public/fonts/almagest/` have drifted from `tools/`.

---

## 2. How a glyph is built

### 2.1 The skeleton

Letters are polylines on a 5×7 lattice — `x` 0…4, `y` 0…6, where `y=0` is the baseline
and `y=6` the cap height. `A` is three points and a crossbar:

```js
A: { p: [[[0,0],[2,6],[4,0]], [[1,2],[3,2]]] }
```

One lattice step is `XU = 120` font units in x and `YU = 700/6` in y, on a 1000-unit em
with cap height 700. Optional `d:` entries are lone dots (period, colon). `w:` overrides
the advance width for narrow glyphs (`I`, `.`, quotes).

Curves are deliberately absent: everything is straight segments, because a constellation
is drawn with sight-lines. That also means the outlines convert to TrueType exactly —
every point is on-curve, no approximation between what you saw in the design doc and
what's in the font.

### 2.2 Star magnitude from the skeleton itself

Stars are not placed by hand. Each vertex is classified by **how many lines meet there**,
and that sets its size:

| lines meeting | class | diameter |
| --- | --- | --- |
| ≥ 3 (junction) | brightest | `star × contrast` |
| 2 (corner) | mid | `star` |
| 1 (terminal) | faint | `star ÷ contrast^0.7` |

This is why the letters stay legible as they shrink: the brightest stars land exactly on
the joints that define a letter's identity, so recognition survives long after the fine
lines fade.

### 2.3 Star shape

A 4-point polygon with a `pointiness` parameter that morphs it continuously:
`0` gives straight edges (a plain diamond), `1` collapses the edges into needles.
Inner radius is `R × cos(π/points) × (1 − pointiness × 0.74)`. All tiers use 4 points
rotated 20°, which keeps the points off-axis from the strokes they terminate.

### 2.4 Line trim — the twinkle

Each sight-line is pulled back from its stars by `trim × star radius`. At Display
(`trim 1.00`) the lines are fully detached and you read sky between line and star. If a
segment would be shorter than the two trims combined it is dropped entirely. Closing the
trim as the face gets smaller is what re-connects the letters.

### 2.5 Outline generation

Per glyph, per tier:

1. place the skeleton in font units (y-up, baseline 0)
2. classify vertices → star radii
3. trim each segment back from its stars
4. emit **one rectangle per segment** (offset by half the stroke), **one octagon at each
   segment end** (TrueType has no round caps — an octagon approximates one to within 2%),
   **one star polygon per starred vertex**, **one octagonal dot per plain dot**
5. force every contour clockwise (negative signed area) so non-zero winding fills

### 2.6 Symbols are starless

Punctuation, math, currency, arrows and all diacritics carry **no stars at any tier** —
stars made them read as debris rather than as marks. To replace the brightness the stars
were contributing, every starless contour is stroked **1.24×** heavier (`PLAIN_STROKE`).
Periods, colons and the dots of `!` `?` are round marks at `1.45 ×` that heavier stroke.
Figures and base letters keep their stars — an accented `É` has a fully starred `E` under
a plain acute.

---

## 3. The size grade

```
                star  contrast  trim  stroke  pointiness   star:stroke
Display  >=52    190     1.70   1.00     27      0.61          12.0
Mid    22-51     170     1.60   0.80     31      0.58           8.8
Text     <=21     62     1.06   0.00     62      0.18           1.1
```

Two rules shaped these numbers:

**Nothing that moves a vertex is allowed to change.** Width (1.15), tracking (+180),
sidebearings (46), star rotation (20°), point count (4) and the lattice itself are frozen
across all three faces. Advance widths are therefore byte-identical — verified: every
glyph is the same integer advance in all three TTFs. A tier change can never reflow a
line, shift a letter, or re-break a paragraph. (Jitter — the surveyed irregularity
explored in early drafts — is 0 everywhere for the same reason: it would make a swap pop.)

**The grade accelerates.** Mid is barely a step off Display because the 52px crossover is
the visible one and stars still read fine at that size. Text absorbs the whole drop.
Star-to-stroke goes 12.0 → 8.8 → 1.1: nearly flat, then a cliff.

### LOD integration

```css
@font-face { font-family: "Almagest Display"; src: url(/fonts/almagest/Almagest-Display.ttf) format("truetype"); }
@font-face { font-family: "Almagest Mid";     src: url(/fonts/almagest/Almagest-Mid.ttf)     format("truetype"); }
@font-face { font-family: "Almagest Text";    src: url(/fonts/almagest/Almagest-Text.ttf)    format("truetype"); }
```

```js
const face = px => px >= 52 ? "Almagest Display" : px >= 22 ? "Almagest Mid" : "Almagest Text";

// On a live zoom, switch on the RENDERED size, not the CSS size:
el.style.fontFamily = face(cssPx * currentScale);
```

An 80ms opacity crossfade on the swap hides the pop completely, but is optional — the
shapes are close enough at each crossover that a hard switch reads as focus pulling in.
Below 13px, keep Text and set `contrast` to 1.0: the stars disappear into the joins and
no fourth tier is needed.

## 3.1 In the app

The three faces are registered in `apps/web/app/styles/theme.css` as "Almagest
Display" / "Almagest Mid" / "Almagest Text" `@font-face` rules, sourced from
the compiled TTFs under `apps/web/public/fonts/almagest/`. Supercluster names
on the graph (`.supercluster-label`) get the tier chosen per zoom tick from
PAINTED pixel size by `almagestFace()` in
`apps/web/lib/graph/d3-graph-vendor.js` (Display ≥ 52px, Mid ≥ 22px, else
Text). The supercluster edge chip (`.sc-edge-chip`, fixed 14px) always uses
Text. Names render in caps by construction — there is no lowercase to fall
back to.

---

## 4. How this got here

Chronology, so the reasoning is inspectable rather than implied. The design
canvases referenced below (`*.dc.html`) are kept outside this repository.

1. **Four directions** (`Constellation Type — Directions.dc.html`). One shared skeleton,
   four treatments: uniform hairline stars; stars ranked by junction; crosshair markers
   with seeded lattice jitter ("sky chart"); condensed + heavy with diamond nodes. Each
   shown down a 44/22/13px ladder, because that ladder is where the idea lives or dies.
2. **Torn between the chart look and the condensed look**, so direction 2 kept the
   condensed proportions and replaced the diamond with a continuously morphable star
   polygon — `pointiness` — plus a live tuner
   (`Constellation Type — v2 Tunable.dc.html`, 10 parameters).
3. **Tuned by hand** to: pointiness 0.61, rotation 20°, contrast 1.70, trim 1.00,
   stroke 27, width 1.15, tracking 180, star 190. That tune is now Almagest Display,
   unchanged.
4. **Optical-size family** (`Almagest LOD.dc.html`) with the metric-freeze constraint and
   a scaling animation that shows the tier swaps against a control (the Display cut scaled
   the whole way down — it turns to grit).
5. **Symbol pass.** Stars removed from punctuation / math / currency / arrows /
   diacritics, `PLAIN_STROKE` added to compensate. `*` moved to superscript position with
   shorter rays; `$` bar broken into stubs above and below the S (the full bar merged into
   the S at heavy strokes); `%` rings enlarged; arrowheads widened; curly quotes corrected
   (a closing quote is a raised comma and must share its lean).
6. **Grade re-cut** so it accelerates: Mid pulled close to Display, Text taking the drop.
7. **Compiled** with the writer in `tools/`, and proved by loading the real files in
   `proof.html`.

### Naming

The obvious name, *Asterism*, is taken — it's a commercially sold script family from
Great Lakes Lettering (MyFonts / Fontspring), mainstream enough to avoid. **Almagest** is
Ptolemy's star catalogue; no notable typeface uses it. Unverified alternates if you want a
change: Uranometria, Declination, Sightline, Culmination, Hipparchus. Renaming is one
string in `tools/build.cjs` plus the filenames.

---

## 5. Character set

- `A–Z` — **lowercase codepoints map to the same caps glyphs**, so mixed-case input works
  and never renders a missing box
- `0–9`
- `. , : ; ! ? ' " ‘ ’ “ ” ( ) - – — /  &`
- `+ − = % $ € *`
- `→ ← ↑ ↓`
- `á ä å ç é è ê í ñ ó ö ü` and their capitals (24 codepoints, 12 glyphs)
- `space`, `.notdef` (a box — an unmapped character is visibly missing, never a silent `?`)

80 glyphs, 116 mapped codepoints per face.

---

## 6. Known limitations — read before shipping

1. **Contours overlap; they are not booleaned into a union.** Rectangles, caps and stars
   are stacked and filled with non-zero winding. Every rasteriser handles this correctly
   (verified in Chrome via `@font-face`), but a type designer opening the file in
   FontForge or Glyphs will see overlapping paths. If you need clean single outlines, run
   *Remove Overlap* in FontForge — or run the SVGs in `glyphs/` through a boolean union
   and re-import.
2. **Round caps are octagons.** TrueType has no line caps; an octagon is the
   approximation. Bump `disc()` to 12 sides in `almagest-glyphs.cjs` if you see faceting at
   poster sizes.
3. **Kerning is a legacy `kern` table (format 0), not GPOS.** 40 pairs, mostly diagonal
   caps (`AV`, `LT`, `T.`). Browsers and macOS honour it; some Windows apps only read
   GPOS. Tracking is +180 units, so the pairs are a refinement, not a necessity.
4. **No hinting.** Fine at 13px+ with modern greyscale antialiasing; expect mush in
   legacy black-and-white rasterisers.
5. **Vertical metrics are generous** (ascender 1080, descender −260 on a 1000 em) because
   Display-tier stars overshoot the cap height and accents sit above them. Default line
   height is ~1.34em; set your own `line-height` rather than relying on the font's.
6. **Caps only by design.** There is no lowercase and no small-cap alternate.
7. `.notdef` is the only glyph outside the character set above — anything unmapped shows
   a box.

## 7. If you need to change something

| Change | Where |
| --- | --- |
| A letter's shape | `G` in `tools/almagest-glyphs.cjs`, then `node fonts/almagest/tools/build.cjs` |
| Star look at one tier | `TIERS` in the same file |
| Add a glyph | add to `G`, add its char to `glyphOrder()` (and `PLAIN` if starless) |
| Kerning | `KERN` (values are lattice units, negative = tighter) |
| Family name | `names` in `tools/build.cjs` |
| A fourth tier | add to `TIERS` — never touch `FROZEN`, that's the metric contract |
