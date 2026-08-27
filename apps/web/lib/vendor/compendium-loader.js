/* Vendored from compendium-explorer (private source repo):
 * frontend/dash/assets/_compendium_loader.js -- see compendium CLAUDE.md
 * for the port contract.
 *
 * ONE functional edit below (mig-01 task 9), everything else byte-for-byte
 * identical to the source: finishDismiss()'s first-run seen-flag
 * persistence swaps Dash's `window.dash_clientside.set_props(
 * 'compendium-loader-seen-store', {data: {ts: Date.now()}})` store write
 * (observed server-side by callbacks/compendium_loader_seen.py, which
 * persists `{compendium_loader_seen: true}` -- note: a BOOLEAN, not the
 * timestamp the store write's payload shape might suggest) for a plain
 * callback hook, `window.__compendiumLoaderOnSeen()`, that
 * components/CompendiumLoader.tsx registers before this module's
 * `initLoader()` can run. Keeps this file framework-agnostic (no ES import
 * of lib/preferences.ts) -- same "vendored files have no dependencies"
 * contract as lib/vendor/starry-sky.js. See that function below for the
 * exact diff; marked "EDIT (mig-01 task 9)".
 *
 * The `graph-version`-driven dismiss trigger is a SEPARATE Dash clientside
 * callback (frontend/dash/app.py, not part of this file) that flips
 * #compendium-loader's className to add .loader-dismiss once
 * refresh_graph_on_load's page-load graph fetch COMPLETES (graph-version
 * goes 0 -> >0, not merely "nodes exist" -- see that callback's own
 * comment for why the distinction matters). It is NOT ported here: this
 * migration slice has no graph load yet. See components/CompendiumLoader.tsx's
 * TODO(mig-03) for the stand-in trigger used in this batch ("shell mounted
 * + chat interactive").
 *
 * window.__compendiumLoader = {dismiss, replay, replayAsFirstRun, el} is
 * kept verbatim -- components/CompendiumLoader.tsx (dismiss trigger) and
 * components/Header.tsx (Settings -> Replay tutorial) both call into it,
 * same parity contract this file's own header comment (below) documents
 * for the Dash tour integration.
 */
/**
 * Compendium loader -- mode-aware lifecycle controller + HTML template.
 *
 * Ported from the bundle's inline <script> at
 * docs/project-plans/2026-05-11-004203-demo-loader-integration/bundle-source/project/Compendium Loader.html
 * with additions for three-mode dispatch (first-run / return / replay)
 * per spec.md.
 *
 * The Dash layout module renders #compendium-loader as a placeholder
 * div + a JSON `data-loader-config` attribute. Captions, icons, and
 * hint copy are owned by the Python module (so future personalization
 * stays a one-line swap). This file owns the HTML template structure
 * (everything that isn't user-swappable) and the lifecycle logic.
 *
 * Lookup `window.__compendiumLoader` for:
 *   - dismiss(): adds loader-dismiss class -> fade-out -> hide
 *   - replay():  re-shows loader in replay mode (DISMISS button visible,
 *                no brand row / first-run hint), restarts cycle. Used by
 *                Settings -> Replay tutorial.
 *   - replayAsFirstRun(): re-shows loader in FIRST-RUN visual chrome
 *                (brand row + hint, no DISMISS button), restarts cycle,
 *                suppresses the seen-flag persist. Used by the demo-role
 *                auto-replay so the demo user sees the same intro a
 *                brand-new user would see -- not the on-demand replay UI.
 *   - el:        the loader root element
 */
(function () {
    'use strict';

    // ====================================================================
    // SAFE DOM INJECTION
    // ====================================================================
    // Range.createContextualFragment parses the HTML string into a
    // DocumentFragment in the parent's namespace context. SVG markup gets
    // the SVG namespace automatically (vs document.createElement which
    // would create HTML-namespaced elements that the browser silently
    // refuses to render as SVG). Captions/hint text are escaped via
    // escapeHtml(); the rest of the template is hardcoded in this file.
    function injectFragment(parent, htmlString) {
        var range = document.createRange();
        range.selectNodeContents(parent);
        var fragment = range.createContextualFragment(htmlString);
        parent.appendChild(fragment);
    }

    function escapeHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // ====================================================================
    // HTML TEMPLATE BUILDERS
    // ====================================================================

    function panel3IconMarkup(icons) {
        return icons.map(function (icon) {
            var pathsMarkup = icon.paths.map(function (d) {
                // SVG path d-attr only accepts a constrained syntax (digits,
                // letters, signs, commas, spaces). Defensive escape against
                // a future config field passing a stray quote/angle bracket.
                return '<path d="' + escapeHtml(d) + '"/>';
            }).join('');
            return (
                '<g class="wm" transform="translate(' + icon.translate[0] + ','
                  + icon.translate[1] + ') scale(.55)" style="animation-delay:'
                  + escapeHtml(icon.animation_delay) + '">'
                  + '<g transform="translate(-36,-36)">' + pathsMarkup + '</g>'
                + '</g>'
            );
        }).join('');
    }

    function buildTemplate(cfg) {
        // Panel 1 -- Sources arrive. Brain at center, 5 source glyphs
        // (book, news, web, article, video) emerge along dotted rays and
        // settle at the rim with their labels. Ambient stragglers
        // sprinkle in the upper area for atmosphere.
        var panel1 = (
          '<section class="panel p1" data-panel="1" data-duration="3000">'
          + '<div class="art" aria-hidden="true">'
          + '<svg viewBox="-100 -100 200 200">'
          + '<defs>'
            // Soft-edged radial fill replaces filter:blur on the brain halo
            // -- cached once on first paint, no per-frame GPU re-blur cost.
            + '<radialGradient id="cl-p1-halo">'
              + '<stop offset="0%" stop-color="currentColor" stop-opacity="1"/>'
              + '<stop offset="100%" stop-color="currentColor" stop-opacity="0"/>'
            + '</radialGradient>'
          + '</defs>'
          + '<g transform="translate(0,40)">'
            + '<g class="strays">'
              + '<g class="petal-dot">'
                + '<circle cx="-92" cy="-92" r="1.0" style="--dx:25.13px;--dy:31.13px"/>'
                + '<circle cx="-70" cy="-130" r="0.52" style="--dx:16.73px;--dy:36.32px"/>'
                + '<circle cx="-50" cy="-118" r="0.4" style="--dx:13.45px;--dy:37.67px"/>'
                + '<circle cx="-30" cy="-110" r="1.0" style="--dx:8.88px;--dy:39.00px"/>'
                + '<circle cx="-12" cy="-128" r="0.52" style="--dx:3.20px;--dy:39.88px"/>'
                + '<circle cx="6" cy="-134" r="1.0" style="--dx:-1.52px;--dy:39.98px"/>'
                + '<circle cx="22" cy="-118" r="0.4" style="--dx:-6.20px;--dy:39.52px"/>'
                + '<circle cx="38" cy="-140" r="1.0" style="--dx:-9.13px;--dy:38.95px"/>'
                + '<circle cx="60" cy="-122" r="0.52" style="--dx:-15.38px;--dy:36.92px"/>'
                + '<circle cx="46" cy="-50" r="0.52" style="--dx:-21.52px;--dy:33.70px"/>'
                + '<circle cx="82" cy="-104" r="1.0" style="--dx:-21.83px;--dy:33.52px"/>'
                + '<circle cx="-46" cy="-50" r="0.4" style="--dx:21.52px;--dy:33.70px"/>'
                + '<circle cx="-20" cy="-66" r="0.4" style="--dx:8.88px;--dy:39.00px"/>'
                + '<circle cx="20" cy="-66" r="0.4" style="--dx:-8.88px;--dy:39.00px"/>'
                + '<circle cx="-72" cy="-28" r="0.52" style="--dx:32.85px;--dy:22.83px"/>'
                + '<circle cx="-62" cy="-50" r="0.76" style="--dx:26.10px;--dy:30.30px"/>'
                + '<circle cx="-48" cy="-68" r="0.4" style="--dx:18.82px;--dy:35.30px"/>'
                + '<circle cx="-32" cy="-82" r="0.64" style="--dx:11.78px;--dy:38.22px"/>'
                + '<circle cx="-22" cy="-55" r="0.4" style="--dx:11.00px;--dy:38.45px"/>'
                + '<circle cx="-10" cy="-72" r="0.76" style="--dx:4.22px;--dy:39.77px"/>'
                + '<circle cx="6" cy="-88" r="0.52" style="--dx:-2.17px;--dy:39.95px"/>'
                + '<circle cx="18" cy="-64" r="0.64" style="--dx:-8.20px;--dy:39.15px"/>'
                + '<circle cx="30" cy="-82" r="0.4" style="--dx:-11.07px;--dy:38.42px"/>'
                + '<circle cx="44" cy="-68" r="0.76" style="--dx:-17.57px;--dy:35.92px"/>'
                + '<circle cx="58" cy="-50" r="0.4" style="--dx:-25.10px;--dy:31.15px"/>'
                + '<circle cx="72" cy="-32" r="0.64" style="--dx:-32.00px;--dy:24.00px"/>'
                + '<circle cx="-36" cy="-38" r="0.4" style="--dx:20.58px;--dy:34.30px"/>'
                + '<circle cx="36" cy="-38" r="0.52" style="--dx:-20.58px;--dy:34.30px"/>'
              + '</g>'
            + '</g>'
            + '<g>'
              + '<line class="ray" x1="0" y1="22" x2="-77" y2="-10"/>'
              + '<line class="ray" x1="0" y1="22" x2="-55" y2="-90"/>'
              + '<line class="ray" x1="0" y1="22" x2="0"   y2="-122"/>'
              + '<line class="ray" x1="0" y1="22" x2="55"  y2="-90"/>'
              + '<line class="ray" x1="0" y1="22" x2="77"  y2="-10"/>'
            + '</g>'
            + '<g class="brain">'
              + '<circle class="brain-halo" fill="url(#cl-p1-halo)" cx="0" cy="22" r="30"/>'
              + '<circle class="brain-badge" cx="0" cy="22" r="22"/>'
              + '<g class="brain-icon" transform="translate(-16.2,5.8) scale(.45)">'
                + '<path d="M16.0,35.0L25.875,35.0"/>'
                + '<path d="M25.875,35c3.4167,0,4.75-2.9167,4.75-6.1667"/>'
                + '<path d="M16.0,45.5L19.75,45.5"/>'
                + '<path d="M35.2997,45.5L35.2997,39.4375"/>'
                + '<path d="M35.2997,39.4375c0-2.2455,1.2003-5.25,5.0756-5.25"/>'
                + '<path d="M58.4583,34.5417L49.875,34.5417"/>'
                + '<path d="M40.375,45.5c0,0,0.1642,10.5-7.9583,10.5H16c-7.2083,0-7.6667-10.5,0-10.5C8.7917,45.5,8.3333,35,16,35 c-8.1667-7.25,1.875-13.5625,6.5-8.6875c-4.799-6.625,5.375-10.3125,8.875-5C30.9627,16,36.2222,15.0417,41.1003,19.024 l-0.4336,0.351c2.375-2.375,10.1776-1.0833,10.1776,5.3141l-2.2192,1.6234c6.8646-6.8646,14.2083,4.1875,8.5,8.2292h1.3333 c4.75,0,5.2917,10.9583-1.3333,10.9583H29.2917"/>'
                + '<path d="M40.6667,19.375c-2.4167,2.4167-0.2822,3.1782-4.2707,7.1667"/>'
              + '</g>'
            + '</g>'
            + '<g class="src s1" style="--rx:-55px; --ry:-90px;">'
              + '<g class="glyph">'
                + '<rect x="-9" y="-7" width="18" height="14" rx="1.2"/>'
                + '<line x1="-6" y1="-3.5" x2="3" y2="-3.5"/>'
                + '<line x1="-6" y1="0"    x2="6" y2="0"/>'
                + '<line x1="-6" y1="3.5"  x2="6" y2="3.5"/>'
              + '</g>'
            + '</g>'
            + '<g class="src s2" style="--rx:-77px; --ry:-10px;">'
              + '<g class="glyph">'
                + '<path d="M-9,-7 Q0,-5 9,-7 L9,7 Q0,5 -9,7 Z"/>'
                + '<line x1="0" y1="-6" x2="0" y2="6"/>'
              + '</g>'
            + '</g>'
            + '<g class="src s3" style="--rx:0px; --ry:-122px;">'
              + '<g class="glyph">'
                + '<rect x="-9" y="-7" width="18" height="14" rx="1.4"/>'
                + '<line x1="-9" y1="-3.2" x2="9" y2="-3.2"/>'
                + '<circle cx="-6.4" cy="-5.2" r=".4"/>'
                + '<circle cx="-4.2" cy="-5.2" r=".4"/>'
                + '<circle cx="-2"   cy="-5.2" r=".4"/>'
              + '</g>'
            + '</g>'
            + '<g class="src s4" style="--rx:55px; --ry:-90px;">'
              + '<g class="glyph">'
                + '<path d="M-7,-9 L4,-9 L9,-4 L9,9 L-7,9 Z"/>'
                + '<path d="M4,-9 L4,-4 L9,-4"/>'
                + '<line x1="-4" y1="-1" x2="6" y2="-1"/>'
                + '<line x1="-4" y1="2"  x2="6" y2="2"/>'
                + '<line x1="-4" y1="5"  x2="3" y2="5"/>'
              + '</g>'
            + '</g>'
            + '<g class="src s5" style="--rx:77px; --ry:-10px;">'
              + '<g class="glyph">'
                + '<rect x="-10" y="-7" width="20" height="14" rx="2"/>'
                + '<path d="M-2,-3.4 L4.2,0 L-2,3.4 Z" fill="currentColor" stroke="none"/>'
              + '</g>'
            + '</g>'
            + '<text class="label l2" x="-77" y="4">BOOK</text>'
            + '<text class="label l1" x="-55" y="-76">NEWS</text>'
            + '<text class="label l3" x="0"   y="-108">WEB</text>'
            + '<text class="label l4" x="55"  y="-76">ARTICLE</text>'
            + '<text class="label l5" x="77"  y="4">VIDEO</text>'
          + '</g>'
          + '</svg>'
          + '</div>'
          + '<p class="caption"><span class="em">' + escapeHtml(cfg.panel_1_caption_em) + '</span> ' + escapeHtml(cfg.panel_1_caption_body) + '</p>'
          + '</section>'
        );

        var panel2 = (
          '<section class="panel p2" data-panel="2" data-duration="3100">'
          + '<div class="art" aria-hidden="true">'
          + '<svg viewBox="-100 -100 200 200">'
          + '<defs>'
            + '<radialGradient id="cl-p2-halo">'
              + '<stop offset="0%" stop-color="currentColor" stop-opacity="1"/>'
              + '<stop offset="100%" stop-color="currentColor" stop-opacity="0"/>'
            + '</radialGradient>'
          + '</defs>'
            + '<ellipse class="halo" fill="url(#cl-p2-halo)" cx="-52" cy="-30" rx="34" ry="22" style="animation-delay:.3s"/>'
            + '<ellipse class="halo" fill="url(#cl-p2-halo)" cx="38"  cy="-40" rx="30" ry="20" style="animation-delay:.5s"/>'
            + '<ellipse class="halo" fill="url(#cl-p2-halo)" cx="0"   cy="44"  rx="44" ry="26" style="animation-delay:.7s"/>'
            + '<g>'
              + '<circle class="stardrift" cx="-72" cy="20"  r=".8" style="--dx:18px;  --dy:-4px;  animation-delay:0s"/>'
              + '<circle class="stardrift" cx="68"  cy="34"  r=".8" style="--dx:-30px; --dy:-12px; animation-delay:.1s"/>'
              + '<circle class="stardrift" cx="-30" cy="64"  r=".8" style="--dx:14px;  --dy:-22px; animation-delay:.2s"/>'
              + '<circle class="stardrift" cx="22"  cy="-72" r=".8" style="--dx:-8px;  --dy:24px;  animation-delay:.3s"/>'
              + '<circle class="stardrift" cx="-78" cy="-58" r=".8" style="--dx:22px;  --dy:18px;  animation-delay:.05s"/>'
              + '<circle class="stardrift" cx="76"  cy="-12" r=".8" style="--dx:-26px; --dy:14px;  animation-delay:.25s"/>'
              + '<circle class="stardrift" cx="6"   cy="84"  r=".8" style="--dx:0px;   --dy:-30px; animation-delay:.15s"/>'
              + '<circle class="stardrift" cx="-58" cy="76"  r=".8" style="--dx:18px;  --dy:-32px; animation-delay:.35s"/>'
            + '</g>'
            + '<g>'
              + '<circle class="star" cx="-78" cy="-8"  r=".9" style="animation-delay:1.1s"/>'
              + '<circle class="star" cx="-30" cy="-58" r=".8" style="animation-delay:1.25s"/>'
              + '<circle class="star" cx="-72" cy="14"  r=".7" style="animation-delay:1.4s"/>'
              + '<circle class="star" cx="-32" cy="6"   r=".8" style="animation-delay:1.55s"/>'
              + '<circle class="star" cx="66"  cy="-58" r=".9" style="animation-delay:1.3s"/>'
              + '<circle class="star" cx="72"  cy="-12" r=".7" style="animation-delay:1.5s"/>'
              + '<circle class="star" cx="60"  cy="6"   r=".8" style="animation-delay:1.65s"/>'
              + '<circle class="star" cx="-46" cy="68"  r=".7" style="animation-delay:1.75s"/>'
              + '<circle class="star" cx="40"  cy="66"  r=".9" style="animation-delay:1.85s"/>'
              + '<circle class="star" cx="54"  cy="22"  r=".7" style="animation-delay:2.1s"/>'
              + '<circle class="star" cx="-66" cy="-66" r=".7" style="animation-delay:2.2s"/>'
            + '</g>'
            + '<g style="--cd:.85s">'
              + '<circle class="star" cx="-62" cy="-36" r="1.5" style="animation-delay:.85s"/>'
              + '<circle class="star" cx="-56" cy="-28" r="1.2" style="animation-delay:.95s"/>'
              + '<circle class="star" cx="-48" cy="-32" r="1.5" style="animation-delay:1.05s"/>'
              + '<circle class="star" cx="-44" cy="-24" r="1.2" style="animation-delay:1.15s"/>'
              + '<circle class="star" cx="-52" cy="-40" r="1"   style="animation-delay:1.25s"/>'
              + '<text class="label" x="-52" y="-58" style="animation-delay:1.6s">MARINE BIOLOGY</text>'
            + '</g>'
            + '<g>'
              + '<circle class="star" cx="26"  cy="-44" r="1.2" style="animation-delay:1.05s"/>'
              + '<circle class="star" cx="35"  cy="-48" r="1.5" style="animation-delay:1.15s"/>'
              + '<circle class="star" cx="43"  cy="-42" r="1.2" style="animation-delay:1.25s"/>'
              + '<circle class="star" cx="39"  cy="-33" r="1.5" style="animation-delay:1.35s"/>'
              + '<circle class="star" cx="31"  cy="-34" r="1"   style="animation-delay:1.45s"/>'
              + '<circle class="star" cx="47"  cy="-34" r="1"   style="animation-delay:1.55s"/>'
              + '<text class="label" x="38" y="-66" style="animation-delay:1.9s">MACHINE LEARNING</text>'
            + '</g>'
            + '<g>'
              + '<circle class="star" cx="-14" cy="38"  r="1.2" style="animation-delay:1.35s"/>'
              + '<circle class="star" cx="-4"  cy="34"  r="1.5" style="animation-delay:1.45s"/>'
              + '<circle class="star" cx="5"   cy="42"  r="1.2" style="animation-delay:1.55s"/>'
              + '<circle class="star" cx="16"  cy="38"  r="1.5" style="animation-delay:1.65s"/>'
              + '<circle class="star" cx="11"  cy="49"  r="1.2" style="animation-delay:1.75s"/>'
              + '<circle class="star" cx="-9"  cy="48"  r="1"   style="animation-delay:1.85s"/>'
              + '<circle class="star" cx="3"   cy="52"  r="1"   style="animation-delay:1.95s"/>'
              + '<circle class="star" cx="22"  cy="45"  r="1"   style="animation-delay:2.05s"/>'
              + '<text class="label" x="0" y="76" style="animation-delay:2.3s">CLASSIC LITERATURE</text>'
            + '</g>'
          + '</svg>'
          + '</div>'
          + '<p class="caption"><span class="em">' + escapeHtml(cfg.panel_2_caption_em) + '</span> ' + escapeHtml(cfg.panel_2_caption_body) + '</p>'
          + '</section>'
        );

        var panel3 = (
          '<section class="panel p3" data-panel="3" data-duration="3000">'
          + '<div class="art" aria-hidden="true">'
          + '<svg viewBox="-100 -100 200 200">'
            + panel3IconMarkup(cfg.panel_3_icons)
            + '<g style="--dx:14.00px;--dy:6.00px">'
              + '<circle class="star" cx="-82.8" cy="-52.2" r="1.00" style="animation-delay:0.20s"/>'
              + '<circle class="star" cx="-77.4" cy="-45" r="0.70"   style="animation-delay:0.26s"/>'
              + '<circle class="star" cx="-84.6" cy="-41.4" r="0.70"   style="animation-delay:0.33s"/>'
              + '<circle class="star" cx="-41.4" cy="-39.6" r="0.90" style="animation-delay:0.22s"/>'
              + '<circle class="star" cx="-36" cy="-34.2" r="0.70"   style="animation-delay:0.30s"/>'
              + '<circle class="star" cx="-45" cy="-30.6" r="0.70"   style="animation-delay:0.38s"/>'
              + '<circle class="star" cx="-84.6" cy="1.8"   r="0.90" style="animation-delay:0.26s"/>'
              + '<circle class="star" cx="-79.2" cy="7.2"   r="0.70"   style="animation-delay:0.33s"/>'
              + '<circle class="star" cx="-86.4" cy="10.8"  r="0.70"   style="animation-delay:0.42s"/>'
            + '</g>'
            + '<g style="--dx:-4.00px;--dy:14.00px">'
              + '<circle class="star" cx="55.8"  cy="-75.6" r="1.00" style="animation-delay:0.57s"/>'
              + '<circle class="star" cx="50.4"  cy="-70.2" r="0.70"   style="animation-delay:0.63s"/>'
              + '<circle class="star" cx="61.2"  cy="-70.2" r="0.70"   style="animation-delay:0.70s"/>'
              + '<circle class="star" cx="5.4"   cy="-77.4" r="0.90" style="animation-delay:0.60s"/>'
              + '<circle class="star" cx="0"   cy="-72" r="0.70"   style="animation-delay:0.68s"/>'
              + '<circle class="star" cx="10.8"  cy="-70.2" r="0.70"   style="animation-delay:0.75s"/>'
              + '<circle class="star" cx="61.2"  cy="-27" r="0.90" style="animation-delay:0.63s"/>'
              + '<circle class="star" cx="55.8"  cy="-21.6" r="0.70"   style="animation-delay:0.70s"/>'
              + '<circle class="star" cx="66.6"  cy="-19.8" r="0.70"   style="animation-delay:0.80s"/>'
            + '</g>'
            + '<g style="--dx:-14.00px;--dy:-4.00px">'
              + '<circle class="star" cx="82.8"  cy="-5.4"  r="1.00" style="animation-delay:0.95s"/>'
              + '<circle class="star" cx="75.6"  cy="-10.8" r="0.70"   style="animation-delay:1.01s"/>'
              + '<circle class="star" cx="77.4"  cy="-1.8"  r="0.70"   style="animation-delay:1.08s"/>'
              + '<circle class="star" cx="82.8"  cy="43.2"  r="0.90" style="animation-delay:0.98s"/>'
              + '<circle class="star" cx="75.6"  cy="37.8"  r="0.70"   style="animation-delay:1.05s"/>'
              + '<circle class="star" cx="86.4"  cy="37.8"  r="0.70"   style="animation-delay:1.13s"/>'
              + '<circle class="star" cx="37.8"  cy="55.8"  r="0.90" style="animation-delay:1.01s"/>'
              + '<circle class="star" cx="32.4"  cy="50.4"  r="0.70"   style="animation-delay:1.08s"/>'
              + '<circle class="star" cx="43.2"  cy="48.6"  r="0.70"   style="animation-delay:1.17s"/>'
            + '</g>'
            + '<g style="--dx:2.00px;--dy:-14.00px">'
              + '<circle class="star" cx="-41.4" cy="28.8"  r="1.00" style="animation-delay:1.32s"/>'
              + '<circle class="star" cx="-36" cy="23.4"  r="0.70"   style="animation-delay:1.38s"/>'
              + '<circle class="star" cx="-46.8" cy="23.4"  r="0.70"   style="animation-delay:1.46s"/>'
              + '<circle class="star" cx="-45" cy="75.6"  r="0.90" style="animation-delay:1.35s"/>'
              + '<circle class="star" cx="-39.6" cy="70.2"  r="0.70"   style="animation-delay:1.42s"/>'
              + '<circle class="star" cx="-50.4" cy="68.4"  r="0.70"   style="animation-delay:1.50s"/>'
              + '<circle class="star" cx="12.6"  cy="70.2"  r="0.90" style="animation-delay:1.38s"/>'
              + '<circle class="star" cx="7.2"   cy="75.6"  r="0.70"   style="animation-delay:1.46s"/>'
              + '<circle class="star" cx="18"  cy="75.6"  r="0.70"   style="animation-delay:1.53s"/>'
            + '</g>'
            + '<g style="--dx:-6.00px;--dy:4.00px">'
              + '<circle class="star" cx="-27" cy="-77.4" r="0.50" style="animation-delay:0.45s"/>'
              + '<circle class="star" cx="5.4"   cy="-19.8" r="0.50" style="animation-delay:0.68s"/>'
              + '<circle class="star" cx="-10.8" cy="-1.8"  r="0.40" style="animation-delay:0.90s"/>'
              + '<circle class="star" cx="18"  cy="12.6"  r="0.40" style="animation-delay:1.13s"/>'
              + '<circle class="star" cx="-64.8" cy="28.8"  r="0.50" style="animation-delay:1.35s"/>'
              + '<circle class="star" cx="-52.2" cy="-1.8"  r="0.40" style="animation-delay:1.58s"/>'
              + '<circle class="star" cx="41.4"  cy="-10.8" r="0.40" style="animation-delay:1.72s"/>'
              + '<circle class="star" cx="28.8"  cy="28.8"  r="0.40" style="animation-delay:1.88s"/>'
            + '</g>'
            + '<g>'
              + '<rect class="clbl" x="-86.58" y="-59.58" width="11" height="1.6" rx=".8" style="animation-delay:0.49s"/>'
              + '<rect class="clbl" x="-84.78" y="-57.24" width="7"  height="1.6" rx=".8" style="animation-delay:0.52s"/>'
              + '<rect class="clbl" x="-44.82" y="-44.64" width="9"  height="1.6" rx=".8" style="animation-delay:0.54s"/>'
              + '<rect class="clbl" x="-88.83" y="-3.24"  width="12" height="1.6" rx=".8" style="animation-delay:0.58s"/>'
              + '<rect class="clbl" x="-87.03" y="-0.9"  width="8"  height="1.6" rx=".8" style="animation-delay:0.61s"/>'
              + '<rect class="clbl" x="50.4"    y="-85.32" width="12" height="1.6" rx=".8" style="animation-delay:0.87s"/>'
              + '<rect class="clbl" x="51.3"    y="-82.98" width="10" height="1.6" rx=".8" style="animation-delay:0.90s"/>'
              + '<rect class="clbl" x="52.65"  y="-80.64" width="7"  height="1.6" rx=".8" style="animation-delay:0.95s"/>'
              + '<rect class="clbl" x="0.45"   y="-87.12" width="11" height="1.6" rx=".8" style="animation-delay:0.92s"/>'
              + '<rect class="clbl" x="1.8"     y="-84.78" width="8"  height="1.6" rx=".8" style="animation-delay:0.96s"/>'
              + '<rect class="clbl" x="56.7"    y="-32.04" width="10" height="1.6" rx=".8" style="animation-delay:0.98s"/>'
              + '<rect class="clbl" x="72"    y="-18.18" width="14" height="1.6" rx=".8" style="animation-delay:1.24s"/>'
              + '<rect class="clbl" x="74.25"  y="-15.84" width="9"  height="1.6" rx=".8" style="animation-delay:1.27s"/>'
              + '<rect class="clbl" x="76.5"    y="28.08"  width="12" height="1.6" rx=".8" style="animation-delay:1.29s"/>'
              + '<rect class="clbl" x="77.4"    y="30.42"  width="10" height="1.6" rx=".8" style="animation-delay:1.33s"/>'
              + '<rect class="clbl" x="79.2"    y="32.76"  width="6"  height="1.6" rx=".8" style="animation-delay:1.36s"/>'
              + '<rect class="clbl" x="33.3"    y="43.56"  width="10" height="1.6" rx=".8" style="animation-delay:1.35s"/>'
              + '<rect class="clbl" x="-46.35" y="16.02"  width="11" height="1.6" rx=".8" style="animation-delay:1.62s"/>'
              + '<rect class="clbl" x="-44.55" y="18.36"  width="7"  height="1.6" rx=".8" style="animation-delay:1.65s"/>'
              + '<rect class="clbl" x="-50.4"   y="61.02"  width="12" height="1.6" rx=".8" style="animation-delay:1.67s"/>'
              + '<rect class="clbl" x="-48.6"   y="63.36"  width="8"  height="1.6" rx=".8" style="animation-delay:1.71s"/>'
              + '<rect class="clbl" x="7.65"   y="60.48"  width="11" height="1.6" rx=".8" style="animation-delay:1.72s"/>'
              + '<rect class="clbl" x="9"    y="62.82"  width="8"  height="1.6" rx=".8" style="animation-delay:1.75s"/>'
              + '<rect class="clbl" x="10.35"  y="65.16"  width="5"  height="1.6" rx=".8" style="animation-delay:1.78s"/>'
            + '</g>'
          + '</svg>'
          + '</div>'
          + '<p class="caption"><span class="em">' + escapeHtml(cfg.panel_3_caption_em) + '</span> ' + escapeHtml(cfg.panel_3_caption_body) + '</p>'
          + '</section>'
        );

        return (
          '<div class="brand">'
            + '<span class="spinner" aria-hidden="true"></span>'
            + '<span>' + escapeHtml(cfg.brand_text) + '</span>'
          + '</div>'
          + '<div class="first-run-hint">' + escapeHtml(cfg.first_run_hint) + '</div>'
          + '<button type="button" class="replay-dismiss-btn" aria-label="Dismiss tutorial">'
            + '<span class="x-glyph" aria-hidden="true">' + String.fromCharCode(0x2715) + '</span>'
            + '<span>' + escapeHtml(cfg.replay_dismiss_label) + '</span>'
          + '</button>'
          + '<div class="stage">'
            + panel1 + panel2 + panel3
          + '</div>'
          + '<div class="progress" aria-hidden="true">'
            + '<span data-i="0"></span>'
            + '<span data-i="1"></span>'
            + '<span data-i="2"></span>'
          + '</div>'
        );
    }

    // ====================================================================
    // LIFECYCLE -- wait for placeholder, inject template, run cycle
    // ====================================================================
    var TRIES_MAX = 100;
    var POLL_MS = 100;
    var tries = 0;
    var waiter = setInterval(function () {
        var el = document.getElementById('compendium-loader');
        if (el) {
            clearInterval(waiter);
            initLoader(el);
        } else if (++tries > TRIES_MAX) {
            clearInterval(waiter);
        }
    }, POLL_MS);

    function initLoader(root) {
        // ---- Hydrate from Python-side config ----
        var configStr = root.getAttribute('data-loader-config') || '{}';
        var cfg;
        try {
            cfg = JSON.parse(configStr);
        } catch (e) {
            cfg = {};
        }
        cfg.brand_text           = cfg.brand_text           || 'Loading compendium';
        cfg.first_run_hint       = cfg.first_run_hint       || '';
        cfg.replay_dismiss_label = cfg.replay_dismiss_label || 'DISMISS TUTORIAL';
        cfg.panel_1_caption_em   = cfg.panel_1_caption_em   || '';
        cfg.panel_1_caption_body = cfg.panel_1_caption_body || '';
        cfg.panel_2_caption_em   = cfg.panel_2_caption_em   || '';
        cfg.panel_2_caption_body = cfg.panel_2_caption_body || '';
        cfg.panel_3_caption_em   = cfg.panel_3_caption_em   || '';
        cfg.panel_3_caption_body = cfg.panel_3_caption_body || '';
        cfg.panel_3_icons        = cfg.panel_3_icons        || [];

        injectFragment(root, buildTemplate(cfg));

        // ---- Identity ----
        // user_id is non-empty when an authenticated user is resolvable
        // server-side; we use it as a "should we persist the dismiss?"
        // gate. When empty (anonymous render paths), dismissal is
        // ephemeral and the tutorial replays on the next mount.
        var userId = root.getAttribute('data-user-id') || '';
        var canPersist = userId !== '';

        // ---- Mode is server-resolved ----
        // The Python layout module reads `compendium_loader_seen` from
        // user prefs and writes data-mode at layout build. JS only flips
        // to 'replay' via the public replay() API below.
        var mode = root.getAttribute('data-mode') || 'first-run';

        // ---- Sequence constants (from bundle) ----
        var INITIAL_OFFSET = 200;
        var TAIL_HOLD = 0;
        var FADE_MS = 420;

        var panels = root.querySelectorAll('.panel');
        var dots = root.querySelectorAll('.progress span');
        var panelDurations = Array.prototype.map.call(panels, function (p) {
            return parseInt(p.dataset.duration, 10) || 3000;
        });
        var entryDelays = [];
        panelDurations.forEach(function (_, i) {
            entryDelays.push(
                i === 0 ? INITIAL_OFFSET : entryDelays[i - 1] + panelDurations[i - 1]
            );
        });
        var CYCLE_MS = entryDelays[entryDelays.length - 1]
                     + panelDurations[panelDurations.length - 1]
                     + TAIL_HOLD;

        // ---- Mutable state (resettable for replay) ----
        var cycleComplete = false;
        var dismissRequested = false;
        var dismissed = false;
        var cycleTimers = [];
        // Set true by replayAsFirstRun() so the per-load demo replay
        // does NOT keep re-writing compendium_loader_seen on each cycle
        // (it's a visual re-play, not a true first run). resetState()
        // does not clear this -- it's set per-API-call from the public
        // method below.
        var suppressPersist = false;

        function clearTimers() {
            cycleTimers.forEach(function (t) { clearTimeout(t); });
            cycleTimers = [];
        }

        function resetState() {
            cycleComplete = false;
            dismissRequested = false;
            dismissed = false;
            clearTimers();
            root.classList.remove('loaded', 'loader-dismiss');
            root.querySelectorAll('.panel').forEach(function (p) {
                p.classList.remove('in');
            });
            root.querySelectorAll('.progress span').forEach(function (s) {
                s.classList.remove('on');
            });
            delete root.dataset.dismissPending;
        }

        function runCycle() {
            entryDelays.forEach(function (d, i) {
                cycleTimers.push(setTimeout(function () {
                    if (dismissed) return;
                    panels[i].classList.add('in');
                    dots.forEach(function (s, j) {
                        s.classList.toggle('on', j <= i);
                    });
                    root.dispatchEvent(new CustomEvent('compendium:loader:panel', {
                        detail: { index: i }
                    }));
                }, d));
            });

            cycleTimers.push(setTimeout(function () {
                cycleComplete = true;
                root.classList.add('loaded');
                root.dispatchEvent(new CustomEvent('compendium:loader:cycle-complete'));
                if (dismissRequested && !dismissed) finishDismiss();
            }, CYCLE_MS));
        }

        function finishDismiss() {
            if (dismissed) return;
            dismissed = true;
            // EDIT (mig-01 task 9): persist the seen-flag to user
            // preferences via a plain callback hook instead of Dash's
            // window.dash_clientside.set_props store write -- see this
            // file's header comment. components/CompendiumLoader.tsx
            // registers window.__compendiumLoaderOnSeen to call
            // patchPreferences({ compendium_loader_seen: true }). Replay
            // path still skips the call (replay is ephemeral).
            if (mode === 'first-run' && canPersist && !suppressPersist
                && typeof window.__compendiumLoaderOnSeen === 'function') {
                try {
                    window.__compendiumLoaderOnSeen();
                } catch (e) {
                    // Persistence failed -- next session will replay
                    // first-run, which is graceful degradation.
                }
            }
            setTimeout(function () {
                root.style.visibility = 'hidden';
                root.style.pointerEvents = 'none';
            }, FADE_MS + 40);
        }

        function show() {
            root.style.visibility = '';
            root.style.pointerEvents = '';
        }

        var mo = new MutationObserver(function () {
            if (!root.classList.contains('loader-dismiss')) return;
            if (dismissRequested) return;
            dismissRequested = true;
            watchdogDisarm();
            // 'return' mode has no animation to protect -> dismiss now.
            // 'first-run' AND 'replay' defer until their cycle finishes;
            // otherwise fast-arriving graph data (e.g. the populated
            // demo, ~158 pages) cuts the intro off mid-play. Replay is
            // an explicit "watch the tutorial" action (Settings replay,
            // or the demo-role auto-replay), so playing it through is
            // the correct behaviour, not a regression.
            if (cycleComplete || mode === 'return') {
                finishDismiss();
            } else {
                // first-run / replay, cycle not done -- defer the fade.
                root.classList.remove('loader-dismiss');
                root.dataset.dismissPending = '1';
            }
        });
        mo.observe(root, { attributes: true, attributeFilter: ['class'] });

        root.addEventListener('compendium:loader:cycle-complete', function () {
            if (root.dataset.dismissPending === '1' && !dismissed) {
                delete root.dataset.dismissPending;
                requestAnimationFrame(function () {
                    root.classList.add('loader-dismiss');
                });
            }
        });

        // ---- Stalled-load watchdog ----
        // graph-version never flipping (server error, dead backend, callback
        // exception) leaves the curtain up forever -- the documented
        // out-of-scope branch of the 56923ff dismiss fix (app.py "Note: if
        // refresh_graph_on_load *errors*"). Every historical loading hang
        // was some upstream failure funneling into exactly that branch, so
        // after WATCHDOG_MS without a dismissal request the loader stops
        // pretending and offers Reload / Continue. Armed once per page
        // mount; replay()/replayAsFirstRun() re-entries never re-arm (the
        // graph is already loaded by then). Tests/tuning override:
        // window.__compendiumLoaderWatchdogMs.
        var WATCHDOG_MS = window.__compendiumLoaderWatchdogMs || 60000;
        var watchdogTimer = null;

        function watchdogDisarm() {
            if (watchdogTimer) {
                clearTimeout(watchdogTimer);
                watchdogTimer = null;
            }
            var box = root.querySelector('.loader-watchdog');
            if (box) box.remove();
        }

        function watchdogFire() {
            watchdogTimer = null;
            if (dismissRequested || dismissed) return;
            if (root.querySelector('.loader-watchdog')) return;
            // Static markup; the only interpolation is a Number() coercion,
            // so nothing attacker-controlled can reach this innerHTML.
            var waitedSecs = Math.round(Number(WATCHDOG_MS) / 1000) || 0;
            var box = document.createElement('div');
            box.className = 'loader-watchdog';
            box.innerHTML =
                '<p class="loader-watchdog-msg">Still loading after ' +
                waitedSecs +
                's &mdash; the graph may have failed to load.</p>' +
                '<div class="loader-watchdog-actions">' +
                '<button type="button" class="loader-watchdog-btn loader-watchdog-reload">RELOAD</button>' +
                '<button type="button" class="loader-watchdog-btn loader-watchdog-continue">CONTINUE WITHOUT GRAPH</button>' +
                '</div>';
            box.querySelector('.loader-watchdog-reload').addEventListener('click', function () {
                window.location.reload();
            });
            box.querySelector('.loader-watchdog-continue').addEventListener('click', function () {
                box.remove();
                root.classList.add('loader-dismiss');
            });
            root.appendChild(box);
        }

        watchdogTimer = setTimeout(watchdogFire, WATCHDOG_MS);

        // ---- Replay X DISMISS button ----
        var dismissBtn = root.querySelector('.replay-dismiss-btn');
        if (dismissBtn) {
            dismissBtn.addEventListener('click', function () {
                root.classList.add('loader-dismiss');
            });
        }

        // ---- Mode-specific bootstrap ----
        if (mode === 'first-run') {
            runCycle();
        } else if (mode === 'replay') {
            runCycle();
        } else if (mode === 'return') {
            cycleComplete = true;
        }

        // ---- Public API ----
        window.__compendiumLoader = {
            el: root,
            dismiss: function () {
                root.classList.add('loader-dismiss');
            },
            replay: function () {
                show();
                mode = 'replay';
                root.setAttribute('data-mode', 'replay');
                suppressPersist = false;
                resetState();
                runCycle();
            },
            // Demo-role per-load entry point. Same animation as replay()
            // but renders in first-run visual chrome (brand row + hint,
            // no DISMISS button) so a demo viewer sees the same intro a
            // brand-new user would see. Suppresses the seen-flag persist
            // because this fires on every demo page load -- a true
            // first-run write would happen on every refresh otherwise.
            replayAsFirstRun: function () {
                show();
                mode = 'first-run';
                root.setAttribute('data-mode', 'first-run');
                suppressPersist = true;
                resetState();
                runCycle();
            }
        };
    }
})();
