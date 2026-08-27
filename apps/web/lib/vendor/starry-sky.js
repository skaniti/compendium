/* Vendored from compendium-explorer (private source repo):
 * frontend/dash/assets/starry-sky/starry-sky.js -- see compendium CLAUDE.md
 * for the port contract.
 *
 * Source-selection note (mig-01 task 8): task-8-brief.md names
 * `assets/starry_selector.js` as the file to vendor here, described as
 * "the <starry-sky> web-component definition." That file is actually
 * Dash-specific MOUNTING GLUE (polls for `window.StarrySky` +
 * `#starry-sky-mount`, reads the `active-starfield` localStorage key) -- it
 * has no rendering logic of its own and depends on this file already being
 * loaded as a prior <script> tag. THIS file (a sibling under
 * assets/starry-sky/) is the actual self-contained `<starry-sky>` custom
 * element implementation the brief's description matches, and it has
 * genuinely zero Dash coupling (confirmed by full read -- no Dash/React
 * references anywhere in it). starry_selector.js's mount-once /
 * variant-attribute-swap / hide-on-"none" behavior is reimplemented
 * natively in components/Starfield.tsx instead of vendored verbatim, since
 * React's useEffect lifecycle replaces its DOM-polling entirely and
 * StarfieldProvider's context replaces its localStorage read. See
 * .superpowers/sdd/task-8-report.md for the full rationale.
 *
 * One functional edit below this header: the trailing CommonJS-interop
 * line (`if (typeof module !== 'undefined' && module.exports) ...`) is
 * removed. It's dead code in this integration -- this file is only ever
 * loaded via a browser-side dynamic `import()` (components/Starfield.tsx),
 * never `require()`'d from Node -- and package.json's `"type": "module"`
 * makes Turbopack statically flag that CommonJS-shaped line as a
 * module-format mismatch ("Exports made by CommonJs syntax will lead to a
 * runtime error"), even though the `typeof module !== 'undefined'` guard
 * makes it unreachable in a browser. Removing it silences a real `npm run
 * build` warning without touching any code that runs in this app. Every
 * other line below is untouched.
 */
/*!
 * starry-sky.js — drop-in animated starry sky overlays (vanilla JS, no deps).
 *
 * Three variants, same contract:
 *   - transparent background
 *   - pointer-events: none (clicks pass through)
 *   - one positioned element, absolutely positioned to fill its parent
 *
 * USAGE — web component (recommended):
 *
 *   <script src="starry-sky.js"></script>
 *   <starry-sky variant="twinkle"></starry-sky>  <!-- or "pan" or "hyperspace" -->
 *
 *   Attributes (all optional):
 *     variant   "twinkle" | "pan" | "hyperspace"   default "twinkle"
 *     seed      number — deterministic star layout
 *     count     total stars in the base field
 *     duration  seconds per cycle (pan, hyperspace)
 *
 * USAGE — imperative:
 *
 *   StarrySky.mount(document.body, { variant: 'pan' });
 *
 * LAYERING: place above your page background, below your content.
 *   <starry-sky></starry-sky>
 *   <main style="position: relative; z-index: 1;">your content</main>
 *
 * The component itself defaults to position: fixed; inset: 0; z-index: 0.
 * Override with CSS on the <starry-sky> element if you need absolute
 * positioning inside a container.
 */
(function () {
  'use strict';

  // ─────────────────────────────────────────────────────────────
  // Deterministic PRNG (mulberry32) so stars render identically on reload.
  // ─────────────────────────────────────────────────────────────
  function mulberry32(seed) {
    return function () {
      let t = (seed += 0x6d2b79f5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const BASE_STYLES = `
    :host {
      position: fixed;
      inset: 0;
      z-index: 0;
      display: block;
      pointer-events: none;
      overflow: hidden;
      background: transparent;
    }
    .field, .layer { position: absolute; inset: 0; }
    .dust, .mid, .bright {
      position: absolute; inset: 0; border-radius: 50%;
    }
    .dust  { width: 1px;   height: 1px;   animation: ss-pulse 6s ease-in-out infinite; }
    .mid   { width: 1.3px; height: 1.3px; }
    .bright{ width: 1.9px; height: 1.9px; filter: drop-shadow(0 0 1.5px rgba(240,245,255,.8)); }
    .tw { position: absolute; border-radius: 50%; transform: translate(-50%,-50%); }
    .glint { position: absolute; overflow: visible; }
    .pan-layer {
      position: absolute; top: 0; left: 0;
      width: 200%; height: 150%;
      animation: ss-pan 90s linear infinite;
      will-change: transform;
    }
    .hs-star {
      position: absolute; left: 50%; top: 50%; border-radius: 50%;
    }
    @keyframes ss-pulse { 0%,100%{opacity:1} 50%{opacity:.55} }
    @keyframes ss-twinkle-big { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.15;transform:scale(.7)} }
    @keyframes ss-twinkle-soft { 0%,100%{opacity:1} 50%{opacity:.35} }
    @keyframes ss-pan { 0%{transform:translate3d(0,0,0)} 100%{transform:translate3d(-50%,-25%,0)} }
    @media (prefers-reduced-motion: reduce) {
      .dust, .mid, .bright, .tw, .glint g, .pan-layer, .hs-star { animation: none !important; }
    }
  `;

  // ─────────────────────────────────────────────────────────────
  // Helpers — shared by all variants
  // ─────────────────────────────────────────────────────────────
  function boxShadowField(rng, n, opMin, opMax, tileX = 100, tileY = 100, tiles = null) {
    const parts = [];
    for (let i = 0; i < n; i++) {
      const x = rng() * tileX;
      const y = rng() * tileY;
      const op = (opMin + rng() * (opMax - opMin)).toFixed(2);
      if (tiles) {
        tiles.forEach(([dx, dy]) => {
          parts.push(`${(x + dx).toFixed(2)}% ${(y + dy).toFixed(2)}% 0 rgba(240,245,255,${op})`);
        });
      } else {
        parts.push(`${x.toFixed(2)}% ${y.toFixed(2)}% 0 rgba(240,245,255,${op})`);
      }
    }
    return parts.join(',');
  }

  function buildGlintSvg(ns, g, idPrefix) {
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', 28);
    svg.setAttribute('height', 28);
    svg.setAttribute('viewBox', '-14 -14 28 28');
    svg.setAttribute('class', 'glint');
    svg.style.left = g.x + '%';
    svg.style.top = g.y + '%';
    svg.style.transform = `translate(-50%,-50%) scale(${g.scale})`;

    const defs = document.createElementNS(ns, 'defs');
    const coreId = `${idPrefix}-c-${g.i}`;
    const spId = `${idPrefix}-s-${g.i}`;
    defs.innerHTML =
      `<radialGradient id="${coreId}">
         <stop offset="0%" stop-color="${g.tint}${g.op})" />
         <stop offset="40%" stop-color="${g.tint}${g.op * 0.4})" />
         <stop offset="100%" stop-color="${g.tint}0)" />
       </radialGradient>
       <linearGradient id="${spId}" x1="0" y1="0.5" x2="1" y2="0.5">
         <stop offset="0%" stop-color="${g.tint}0)" />
         <stop offset="50%" stop-color="${g.tint}${g.op * 0.8})" />
         <stop offset="100%" stop-color="${g.tint}0)" />
       </linearGradient>`;
    svg.appendChild(defs);

    const group = document.createElementNS(ns, 'g');
    group.style.animation = `ss-twinkle-big ${g.dur}s ease-in-out ${g.delay}s infinite`;
    group.style.transformOrigin = 'center';
    group.innerHTML =
      `<rect x="-12" y="-0.25" width="24" height="0.5" fill="url(#${spId})" />
       <rect x="-0.25" y="-12" width="0.5" height="24" fill="url(#${spId})" />
       <circle cx="0" cy="0" r="5" fill="url(#${coreId})" />
       <circle cx="0" cy="0" r="0.9" fill="${g.tint}1)" />`;
    svg.appendChild(group);
    return svg;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';

  // ─────────────────────────────────────────────────────────────
  // Variant builders — each returns an element to append to shadow root
  // ─────────────────────────────────────────────────────────────
  function buildTwinkle(opts) {
    const { count = 380, twinkleCount = 60, glintCount = 4, seed = 211 } = opts;
    const rng = mulberry32(seed);
    const field = document.createElement('div');
    field.className = 'field';

    const dust = document.createElement('div');
    dust.className = 'dust';
    dust.style.boxShadow = boxShadowField(rng, Math.round(count * 0.85), 0.16, 0.4);
    field.appendChild(dust);

    const mid = document.createElement('div');
    mid.className = 'mid';
    mid.style.boxShadow = boxShadowField(rng, Math.round(count * 0.13), 0.3, 0.55);
    mid.style.animation = 'ss-twinkle-soft 4.5s ease-in-out -1.2s infinite';
    field.appendChild(mid);

    for (let i = 0; i < twinkleCount; i++) {
      const size = 1.2 + rng() * 1.4;
      const dur = 1.6 + rng() * 3.2;
      const delay = -rng() * 5;
      const op = 0.55 + rng() * 0.4;
      const tint = rng() < 0.15
        ? (rng() < 0.5 ? 'rgba(210,225,255,' : 'rgba(255,240,220,')
        : 'rgba(255,255,255,';
      const t = document.createElement('div');
      t.className = 'tw';
      t.style.left = (rng() * 100) + '%';
      t.style.top = (rng() * 100) + '%';
      t.style.width = size + 'px';
      t.style.height = size + 'px';
      t.style.background = `${tint}${op})`;
      t.style.boxShadow = `0 0 ${size * 1.5}px ${tint}${op * 0.4})`;
      t.style.animation = `ss-twinkle-big ${dur}s ease-in-out ${delay}s infinite`;
      field.appendChild(t);
    }

    for (let i = 0; i < glintCount; i++) {
      const g = {
        i, x: 10 + rng() * 80, y: 10 + rng() * 80,
        scale: 0.55 + rng() * 0.35,
        tint: rng() < 0.5 ? 'rgba(210,225,255,' : 'rgba(255,245,225,',
        op: 0.6 + rng() * 0.3, delay: -rng() * 8, dur: 3 + rng() * 2.5,
      };
      field.appendChild(buildGlintSvg(SVG_NS, g, 'ss-tw-' + seed));
    }
    return field;
  }

  function buildPan(opts) {
    const { count = 420, glintCount = 5, seed = 229, duration = 90 } = opts;
    const rng = mulberry32(seed);
    const layer = document.createElement('div');
    layer.className = 'pan-layer';
    layer.style.animationDuration = duration + 's';

    const tiles = [[0, 0], [50, 0], [0, 75], [50, 75]];

    const dust = document.createElement('div');
    dust.className = 'dust';
    dust.style.boxShadow = boxShadowField(rng, Math.round(count * 0.85 / 4), 0.16, 0.38, 50, 75, tiles);
    layer.appendChild(dust);

    const mid = document.createElement('div');
    mid.className = 'mid';
    mid.style.boxShadow = boxShadowField(rng, Math.round(count * 0.13 / 4), 0.38, 0.62, 50, 75, tiles);
    mid.style.animation = 'ss-twinkle-big 3.8s ease-in-out -1.5s infinite';
    layer.appendChild(mid);

    const bright = document.createElement('div');
    bright.className = 'bright';
    bright.style.boxShadow = boxShadowField(rng, Math.round(count * 0.02 / 4), 0.65, 0.88, 50, 75, tiles);
    bright.style.animation = 'ss-twinkle-big 3.2s ease-in-out -2.1s infinite';
    layer.appendChild(bright);

    const glintProto = Array.from({ length: glintCount }, (_, i) => ({
      i, x: rng() * 45, y: rng() * 70,
      scale: 0.5 + rng() * 0.3,
      tint: rng() < 0.5 ? 'rgba(210,225,255,' : 'rgba(255,245,225,',
      op: 0.6 + rng() * 0.3, delay: -rng() * 8,
      dur: 3 + (i % 3),
    }));

    tiles.forEach(([dx, dy], k) => {
      glintProto.forEach((gp) => {
        const g = { ...gp, i: `${k}-${gp.i}`, x: gp.x + dx, y: gp.y + dy };
        layer.appendChild(buildGlintSvg(SVG_NS, g, 'ss-pn-' + seed));
      });
    });
    return layer;
  }

  function buildHyperspace(opts, shadow) {
    const { count = 260, streamCount = 70, seed = 251, duration = 14 } = opts;
    const rng = mulberry32(seed);
    const field = document.createElement('div');
    field.className = 'field';

    const dust = document.createElement('div');
    dust.className = 'dust';
    dust.style.boxShadow = boxShadowField(rng, Math.round(count * 0.9), 0.14, 0.3);
    field.appendChild(dust);

    const mid = document.createElement('div');
    mid.className = 'mid';
    mid.style.boxShadow = boxShadowField(rng, Math.round(count * 0.1), 0.3, 0.5);
    mid.style.animation = 'ss-twinkle-soft 4s ease-in-out -1.2s infinite';
    field.appendChild(mid);

    let kfCss = '';
    for (let i = 0; i < streamCount; i++) {
      const ang = (i / streamCount) * Math.PI * 2 + rng() * 0.4;
      const dist = 70 + rng() * 20;
      const dx = Math.cos(ang) * dist;
      const dy = Math.sin(ang) * dist;
      const delay = -(rng() * duration);
      const size = 1 + rng() * 1.4;
      const op = 0.5 + rng() * 0.35;
      const tint = rng() < 0.12
        ? (rng() < 0.5 ? 'rgba(210,225,255,' : 'rgba(255,240,220,')
        : 'rgba(255,255,255,';
      const dur = duration * (0.75 + rng() * 0.5);
      const kfName = `ss-hs-${seed}-${i}`;

      const star = document.createElement('div');
      star.className = 'hs-star';
      star.style.width = size + 'px';
      star.style.height = size + 'px';
      star.style.background = `${tint}${op})`;
      star.style.boxShadow = `0 0 ${size * 2}px ${tint}${op * 0.5})`;
      star.style.animation = `${kfName} ${dur}s linear ${delay}s infinite`;
      field.appendChild(star);

      kfCss += `@keyframes ${kfName}{
        0%{transform:translate(-50%,-50%) translate(0,0) scale(.05);opacity:0}
        8%{opacity:${op}}
        88%{opacity:${op}}
        100%{transform:translate(-50%,-50%) translate(${dx.toFixed(2)}vmax,${dy.toFixed(2)}vmax) scale(3);opacity:0}
      }`;
    }
    const kfEl = document.createElement('style');
    kfEl.textContent = kfCss;
    shadow.appendChild(kfEl);
    return field;
  }

  // ─────────────────────────────────────────────────────────────
  // <starry-sky> web component
  // ─────────────────────────────────────────────────────────────
  class StarrySkyElement extends HTMLElement {
    static get observedAttributes() {
      return ['variant', 'seed', 'count', 'duration'];
    }
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
    }
    connectedCallback() { this._render(); }
    attributeChangedCallback() { if (this.isConnected) this._render(); }
    _render() {
      const shadow = this.shadowRoot;
      shadow.innerHTML = '';
      const style = document.createElement('style');
      style.textContent = BASE_STYLES;
      shadow.appendChild(style);

      const variant = (this.getAttribute('variant') || 'twinkle').toLowerCase();
      const opts = {};
      const seedAttr = this.getAttribute('seed');
      if (seedAttr != null) opts.seed = Number(seedAttr);
      const countAttr = this.getAttribute('count');
      if (countAttr != null) opts.count = Number(countAttr);
      const durAttr = this.getAttribute('duration');
      if (durAttr != null) opts.duration = Number(durAttr);

      let el;
      if (variant === 'pan') el = buildPan(opts);
      else if (variant === 'hyperspace') el = buildHyperspace(opts, shadow);
      else el = buildTwinkle(opts);
      shadow.appendChild(el);
    }
  }

  if (typeof customElements !== 'undefined' && !customElements.get('starry-sky')) {
    customElements.define('starry-sky', StarrySkyElement);
  }

  // Imperative API
  const StarrySky = {
    mount(parent, options = {}) {
      const el = document.createElement('starry-sky');
      if (options.variant) el.setAttribute('variant', options.variant);
      if (options.seed != null) el.setAttribute('seed', String(options.seed));
      if (options.count != null) el.setAttribute('count', String(options.count));
      if (options.duration != null) el.setAttribute('duration', String(options.duration));
      (parent || document.body).appendChild(el);
      return el;
    },
    Element: StarrySkyElement,
  };

  if (typeof window !== 'undefined') window.StarrySky = StarrySky;
})();
