#!/usr/bin/env node
/**
 * Regenerate apps/extension/icons/comet-*.png from the comet-dark.svg /
 * comet-light.svg source artwork (560x532 viewBox; "dark" = white tail +
 * grey star for dark UIs, "light" = black tail + grey star for light UIs),
 * using `sharp` -- already a dependency in the repo root's node_modules.
 *
 * Run from the repo root:
 *   node apps/extension/icons/generate-comet.mjs
 *
 * Produces:
 *   comet-on-dark-{16,32,48,96,128}.png -- white-tail comet on a rounded
 *     dark box (#18191A fill, 22% corner radius, 1px #34363A border at a
 *     128px baseline). This is the "dark box behind the white icon"
 *     fallback mark that reads on any toolbar theme.
 *   comet-white-{16,32}.png -- white-tail comet on transparent
 *   comet-black-{16,32}.png -- black-tail comet on transparent
 * (Firefox's action.theme_icons picks between the white/black transparent
 * variants per-theme; Chrome uses comet-on-dark everywhere.)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Source artwork's native viewBox (both comet-dark.svg and comet-light.svg).
const SVG_VIEWBOX = { width: 560, height: 532 };

// How much of the box the artwork's viewBox fills, centred. The artwork
// already carries its own ~10% clear margin inside the 560x532 viewBox, so
// the transparent toolbar icons use the full box (that built-in margin is
// the only spacing, matching the browser's own toolbar icons); the boxed
// variant adds a slim margin so the tail stays clear of the rounded edge.
const FIT_TRANSPARENT = 1.0;
const FIT_BOXED = 0.9;

const DARK_BOX = {
  fill: '#18191A',
  border: '#34363A',
  cornerRadiusFrac: 0.22,
  // "1px border at 128" -- scaled proportionally for other sizes, same
  // baseline convention as the old generate.py, with a 1px floor so the
  // border stays visible (rather than rounding away) at small sizes.
  borderBaselineSize: 128,
};

const ON_DARK_SIZES = [16, 32, 48, 96, 128];
const TRANSPARENT_SIZES = [16, 32];

/** Rasterize the comet artwork to fit within `targetSize * fitFraction`,
 * preserving aspect ratio. Density is chosen so librsvg rasterizes directly
 * near the final pixel size instead of rendering at the SVG's native 560px
 * width and blurring on downscale. */
async function renderComet(svgFile, targetSize, fitFraction) {
  const svgPath = path.join(HERE, svgFile);
  const svg = readFileSync(svgPath);

  const innerSide = Math.round(targetSize * fitFraction);
  const scale = innerSide / SVG_VIEWBOX.width;
  const renderW = innerSide;
  const renderH = Math.max(1, Math.round(SVG_VIEWBOX.height * scale));
  const density = 72 * scale;

  const buffer = await sharp(svg, { density })
    .resize(renderW, renderH, { fit: 'fill', kernel: 'lanczos3' })
    .png()
    .toBuffer();

  return { buffer, width: renderW, height: renderH };
}

function roundedBoxSvg(size, radius, fill, borderColor, borderWidth) {
  const inset = borderWidth / 2;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <rect x="${inset}" y="${inset}" width="${size - borderWidth}" height="${size - borderWidth}"
          rx="${radius}" ry="${radius}"
          fill="${fill}" stroke="${borderColor}" stroke-width="${borderWidth}"/>
  </svg>`);
}

async function makeOnDark(size) {
  const cornerRadius = Math.round(size * DARK_BOX.cornerRadiusFrac);
  const borderW = Math.max(1, Math.round(size / DARK_BOX.borderBaselineSize));
  const boxSvg = roundedBoxSvg(size, cornerRadius, DARK_BOX.fill, DARK_BOX.border, borderW);
  const box = await sharp(boxSvg).png().toBuffer();

  const { buffer, width, height } = await renderComet('comet-dark.svg', size, FIT_BOXED); // white tail
  const left = Math.round((size - width) / 2);
  const top = Math.round((size - height) / 2);

  return sharp(box).composite([{ input: buffer, left, top }]).png().toBuffer();
}

async function makeTransparent(svgFile, size) {
  const { buffer, width, height } = await renderComet(svgFile, size, FIT_TRANSPARENT);
  const left = Math.round((size - width) / 2);
  const top = Math.round((size - height) / 2);

  return sharp({
    create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: buffer, left, top }])
    .png()
    .toBuffer();
}

async function main() {
  console.log(`Generating ${ON_DARK_SIZES.length} comet-on-dark icon(s) into ${HERE}`);
  for (const size of ON_DARK_SIZES) {
    const png = await makeOnDark(size);
    const out = path.join(HERE, `comet-on-dark-${size}.png`);
    writeFileSync(out, png);
    console.log(`  comet-on-dark-${size}.png -> ${size}x${size}px, ${png.length} bytes`);
  }

  console.log(`Generating ${TRANSPARENT_SIZES.length} comet-white icon(s) (white tail, transparent)`);
  for (const size of TRANSPARENT_SIZES) {
    const png = await makeTransparent('comet-dark.svg', size);
    const out = path.join(HERE, `comet-white-${size}.png`);
    writeFileSync(out, png);
    console.log(`  comet-white-${size}.png -> ${size}x${size}px, ${png.length} bytes`);
  }

  console.log(`Generating ${TRANSPARENT_SIZES.length} comet-black icon(s) (black tail, transparent)`);
  for (const size of TRANSPARENT_SIZES) {
    const png = await makeTransparent('comet-light.svg', size);
    const out = path.join(HERE, `comet-black-${size}.png`);
    writeFileSync(out, png);
    console.log(`  comet-black-${size}.png -> ${size}x${size}px, ${png.length} bytes`);
  }

  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
