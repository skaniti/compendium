"use client";

import { useEffect } from "react";
import { patchPreferences } from "@/lib/preferences";

// Ports layouts/compendium_loader.py's render_compendium_loader(): the
// Python module renders ONLY this outer placeholder div (mode + config
// baked in server-side) and lets the asset JS inject the full template
// client-side. This component mirrors that split -- the outer shell here,
// everything else injected by lib/vendor/compendium-loader.js once it
// finds #compendium-loader in the DOM.
//
// window.__compendiumLoader / window.__compendiumLoaderOnSeen types live
// in lib/vendor/vendor.d.ts (shared with components/Header.tsx, which
// calls .replay() from Settings -> Replay tutorial).

// ---------------------------------------------------------------------
// Swappable config -- verbatim port of compendium_loader.py's
// _PANEL_3_ICONS / _PANEL_*_CAPTION_* / _BRAND_ROW_TEXT / _FIRST_RUN_HINT /
// _REPLAY_DISMISS_LABEL constants + _build_config(). Kept here (not in the
// vendor JS) for the same reason the Python module keeps them separate
// from the asset JS: personalization only ever needs to edit this file.
// ---------------------------------------------------------------------
interface Panel3Icon {
  name: string;
  translate: [number, number];
  animation_delay: string;
  paths: string[];
}

const PANEL_3_ICONS: Panel3Icon[] = [
  {
    name: "octopus",
    translate: [-64.8, -23.4],
    animation_delay: "0.00s",
    paths: [
      "M60,30c2-6-3-6-3-6c-7,1-2,7-2,7s6,11-4.5833,10.6142C39.8333,41.2284,43,31,43,31c6.0698-5.0974,4-11,4-11 c-3-10-11-9-11-9s-8-1-11,8c0,0-3,9,4,12c0,0,4,11-8,11c0,0-10,0-4-13c0,0,2-7-4-5c0,0-3,1-2,6",
      "M33,33c0,0,4,11-7,14c0,0-7-1-7,5s4,6,6,5s3-4,3-4",
      "M38.7091,33c0,0-4,11,7,14c0,0,7-1,7,5s-4,6-6,5s-3-4-3-4",
      "M19.1157,45c0,0-2,1-4-1s-4-1-4-1s-4,1-1,5c0,0,1,2,4,1",
      "M54,45c0,0,2,1,4-1s4-1,4-1s4,1,1,5c0,0-1,2-4,1",
    ],
  },
  {
    name: "brain",
    translate: [30.6, -52.2],
    animation_delay: "0.38s",
    paths: [
      "M16.0,35.0L25.875,35.0",
      "M25.875,35c3.4167,0,4.75-2.9167,4.75-6.1667",
      "M16.0,45.5L19.75,45.5",
      "M35.2997,45.5L35.2997,39.4375",
      "M35.2997,39.4375c0-2.2455,1.2003-5.25,5.0756-5.25",
      "M58.4583,34.5417L49.875,34.5417",
      "M40.375,45.5c0,0,0.1642,10.5-7.9583,10.5H16c-7.2083,0-7.6667-10.5,0-10.5C8.7917,45.5,8.3333,35,16,35 c-8.1667-7.25,1.875-13.5625,6.5-8.6875c-4.799-6.625,5.375-10.3125,8.875-5C30.9627,16,36.2222,15.0417,41.1003,19.024 l-0.4336,0.351c2.375-2.375,10.1776-1.0833,10.1776,5.3141l-2.2192,1.6234c6.8646-6.8646,14.2083,4.1875,8.5,8.2292h1.3333 c4.75,0,5.2917,10.9583-1.3333,10.9583H29.2917",
      "M40.6667,19.375c-2.4167,2.4167-0.2822,3.1782-4.2707,7.1667",
    ],
  },
  {
    name: "raspberry-pi",
    translate: [57.6, 19.8],
    animation_delay: "0.75s",
    paths: [
      "M55.7803,11.2616C51.51,31.1894,38.4049,24.395,36.6244,20.8907C34.844,17.3864,36.5642,3.4328,55.7803,11.2616z",
      "M45.5723,15.2944c-3.1311,1.2014-7.1389,3.1342-8.9149,5.6542",
      "M16.344,11.2616c4.2703,19.9278,17.3754,13.1334,19.1558,9.6291C37.2803,17.3864,35.5602,3.4328,16.344,11.2616z",
      "M26.5521,15.2944c3.1311,1.2014,7.1389,3.1342,8.9149,5.6542",
      "M19.9502,25.5384c0,0-2.5794,1.5485-3.1555,4.0953s0.0005,5.3368,0.0005,5.3368s-4.0466,1.6684-4.0466,6.9178 s3.4132,6.7328,3.4132,6.7328s0.0403,6.1949,3.859,9.5361c3.8187,3.3412,7.8262,3.3565,7.8262,3.3565s2.0841,4.4087,8.2153,4.4087 s8.2153-4.4087,8.2153-4.4087s4.1496-0.606,7.8262-3.3565c3.6766-2.7504,3.5755-9.5361,3.5755-9.5361s3.6966-1.4834,3.6966-6.7328 s-4.0466-6.9178-4.0466-6.9178s0.5766-2.7901,0.0005-5.3368s-3.1555-4.0953-3.1555-4.0953",
      "M42.243,29.4751c0,0-2.6163,2.7671-5.8436,2.7671",
      "M30.3319,29.4751c0,0,2.6163,2.7671,5.8436,2.7671",
      "M50.0623,39.5238c0,2.8921-2.4819,5.2365-5.5436,5.2365",
      "M38.7628,39.5238c0,2.8921,2.4819,5.2365,5.5436,5.2365",
      "M33.8827,39.5238c0,2.8921-2.4819,5.2365-5.5436,5.2365",
      "M22.5831,39.5238c0,2.8921,2.4819,5.2365,5.5436,5.2365",
      "M41.9049,53.8616c-1.0434,1.389-3.1599,2.3393-5.6011,2.3393",
      "M30.3414,53.6923c0.9945,1.4804,3.1823,2.5085,5.7214,2.5085",
      "M30.2894,54.05c0,1.2407-0.7684,2.3588-1.9976,3.1439",
      "M41.9647,54.05c0,1.3528,0.9134,2.5597,2.3417,3.3483",
      "M23.4111,42.6717c0,2.3661-1.6613,4.3657-3.9422,5.0147",
      "M25.0119,29.4392c0,3.0961-2.4819,5.6059-5.5436,5.6059",
      "M46.3732,29.4392c0,3.0961,2.4819,5.6059,5.5436,5.6059",
      "M49.2512,42.6717c0,2.26,1.5157,4.1856,3.6392,4.9194",
    ],
  },
  {
    name: "trident",
    translate: [-19.8, 50.4],
    animation_delay: "1.13s",
    paths: [
      "M40.1565,67.0054v-8.4719c1.6181,0.9361,3.4967,1.4719,5.5005,1.4719c4.7844,0,9.1921-2.0095,10.4955-6.9403 c0.3112-1.1773,0.3498-2.4102,0.2359-3.6226l-0.1761-0.7819c-1.3037-5.7893-1.8268-11.7271-1.5553-17.6552l0,0h3l-4.5032-7.8401 l-4.4968,7.8401h3l-0.4802,9.1245l-0.2672,5.0769c-0.0725,1.3768-0.4085,2.7268-0.9899,3.9769l0,0 c-1.7015,3.6581-6.9018,3.6598-8.6056,0.0028l0,0c-0.5842-1.2539-0.942-2.6014-1.0569-3.9799l-1.6001-19.201l-0.0332-0.3403h3 L37.127,17.825l-4.5032,7.8401h3l0.0005,0.1968l-1.6001,19.201c-0.1149,1.3786-0.4727,2.726-1.0569,3.9799l0,0 c-1.7038,3.657-6.9042,3.6553-8.6056-0.0028l0,0c-0.5814-1.2501-0.9175-2.6001-0.99-3.9769l-0.2672-5.0769l-0.4802-9.1245h3 l-4.4968-7.8401l-4.5032,7.8401h3l0,0c0.2715,5.9281-0.2516,11.8659-1.5553,17.6552l-0.1761,0.7819 c-0.1139,1.2124-0.0753,2.4453,0.2359,3.6226c1.3034,4.9308,5.7111,6.9403,10.4955,6.9403c2.0038,0,3.8824-0.5358,5.5005-1.4719 l0.0116,8.5736",
    ],
  },
];

const BRAND_ROW_TEXT = "Loading compendium";
const FIRST_RUN_HINT = "(You can replay this tutorial anytime from Settings → Replay Tutorial)";
const REPLAY_DISMISS_LABEL = "DISMISS TUTORIAL";

const PANEL_1_CAPTION_EM = "Capture as you learn.";
const PANEL_1_CAPTION_BODY =
  "Articles, books, papers, videos — every source drifts into your compendium.";
const PANEL_2_CAPTION_EM = "Patterns emerge.";
const PANEL_2_CAPTION_BODY = "Clusters surface in what you read — query them, and the picture sharpens.";
const PANEL_3_CAPTION_EM = "Curiosity shapes it.";
const PANEL_3_CAPTION_BODY =
  "Pin the topics that matter — they become featured constellations in your sky.";

const LOADER_CONFIG = {
  brand_text: BRAND_ROW_TEXT,
  first_run_hint: FIRST_RUN_HINT,
  replay_dismiss_label: REPLAY_DISMISS_LABEL,
  panel_1_caption_em: PANEL_1_CAPTION_EM,
  panel_1_caption_body: PANEL_1_CAPTION_BODY,
  panel_2_caption_em: PANEL_2_CAPTION_EM,
  panel_2_caption_body: PANEL_2_CAPTION_BODY,
  panel_3_caption_em: PANEL_3_CAPTION_EM,
  panel_3_caption_body: PANEL_3_CAPTION_BODY,
  panel_3_icons: PANEL_3_ICONS,
};
const LOADER_CONFIG_JSON = JSON.stringify(LOADER_CONFIG);

export interface CompendiumLoaderProps {
  // Server-resolved `compendium_loader_seen` preference (AppShell reads it
  // the same way it seeds panel widths / starfield -- before first paint,
  // so there's no first-run/return flash). false/omitted -> first-run,
  // matching compendium_loader.py's `"return" if has_seen else "first-run"`.
  initialHasSeen?: boolean;
  // Whether a real authenticated user is resolvable server-side -- gates
  // the vendor module's first-run seen-flag persist, mirroring Python's
  // `user_id is not None` -> non-empty data-user-id -> canPersist check.
  // Defaults true so a bare <CompendiumLoader /> (tests, ad-hoc use) is
  // fully exercisable without also wiring auth; AppShell always passes
  // this explicitly from getInitialCompendiumLoaderSeen().
  canPersist?: boolean;
}

export default function CompendiumLoader({
  initialHasSeen = false,
  canPersist = true,
}: CompendiumLoaderProps) {
  const mode = initialHasSeen ? "return" : "first-run";

  useEffect(() => {
    // Bridge for lib/vendor/compendium-loader.js's finishDismiss() (see
    // that file's header comment on this edit): the Dash original writes
    // a `compendium-loader-seen-store` value that a server callback
    // observes and persists as {compendium_loader_seen: true} (a BOOLEAN
    // -- corrected fact #1, not the store write's `{ts: Date.now()}}`
    // payload shape). Registered before the dynamic import below so it's
    // always in place before the vendor module's initLoader() can run.
    // Re-registered on every mount (unlike the guarded block below) --
    // the cleanup at the bottom of this effect deletes it on every
    // unmount, so a later remount needs it put back or finishDismiss()'s
    // `typeof window.__compendiumLoaderOnSeen === 'function'` check would
    // silently stop persisting the seen-flag after any unmount/remount.
    window.__compendiumLoaderOnSeen = () => {
      void patchPreferences({ compendium_loader_seen: true });
    };

    // Explicit idempotence latch (mig-02 carryover -- previously an
    // unstated side effect of lib/vendor/compendium-loader.js's dynamic
    // import() being ESM-cached, documented only in this test file's own
    // comment, not in source). LOAD-BEARING CONSTRAINT: the vendor
    // module's top-level IIFE initializes ONCE per module load -- it polls
    // for #compendium-loader, binds window.__compendiumLoader to THAT
    // node, and never re-arms. Even though the IIFE itself only ever runs
    // once (ESM caching), without this guard a SECOND mount's .then()
    // callback below (this file's own tryDismiss trigger, not the vendor
    // file's) would still re-run and call window.__compendiumLoader.dismiss()
    // -- harmless today (nothing remounts yet; batch 02 keeps nav
    // state-only), but wrong the moment a remount can target a genuinely
    // fresh #compendium-loader node (client-side route navigation): that
    // node's overlay would never initialize, and dismiss() would keep
    // toggling classes on the OLD, now-detached node, leaving the new
    // node's pointer-events-active full-screen curtain stuck up forever
    // with no working dismiss path. This guard makes the "don't re-run
    // vendor init" latch explicit and skips the whole flow on a remount;
    // it does NOT yet solve remounting itself -- a real vendor `reinit(el)`
    // hook that re-binds to the fresh node is still required before this
    // guard's skip becomes correct instead of merely inert. That hook must
    // land before any client-side navigation is introduced into this app.
    // (window-scoped, not a module-level variable -- see vendor.d.ts's own
    // comment on this flag for why.)
    //
    // IMPORTANT: this only latches PERMANENTLY once this run's bootstrap
    // flow actually reaches a terminal state (see `completed` below) --
    // Next's App Router defaults reactStrictMode to true, and this repo's
    // next.config.ts never overrides it, so every dev mount runs
    // effect -> cleanup -> effect synchronously before the dynamic
    // import's microtask chain gets a turn. Without the rollback in the
    // cleanup below, the FIRST (discarded) run would set this flag and
    // then immediately be cancelled before its tryDismiss ever ran; the
    // SECOND (real, persisted) run would see the flag already set, skip
    // starting its own flow entirely, and the curtain would never
    // dismiss -- in every dev session, not just a hypothetical future
    // remount.
    if (window.__compendiumLoaderVendorInitStarted) {
      return () => {
        delete window.__compendiumLoaderOnSeen;
      };
    }
    window.__compendiumLoaderVendorInitStarted = true;

    let cancelled = false;
    // True once THIS run's bootstrap flow has reached a terminal state --
    // either tryDismiss found window.__compendiumLoader and called
    // dismiss(), or it gave up after MAX_TRIES. Lets the cleanup below
    // tell "this mount's flow genuinely finished (or is still legitimately
    // live)" apart from "this mount was torn down before its flow got
    // anywhere" -- see the latch comment above for why that distinction is
    // load-bearing under StrictMode's synchronous double-invoke.
    let completed = false;
    // Bare setTimeout/clearTimeout (not window.*), matching
    // ThemeProvider.tsx's debounceRef pattern -- ReturnType<typeof
    // window.setTimeout> resolves to the DOM lib's `number`, but this
    // program also has Node's ambient ReturnType<typeof setTimeout> in
    // scope for the bare global, so mixing `window.setTimeout` calls with
    // a `ReturnType<typeof window.setTimeout>`-typed variable trips a
    // number-vs-Timeout mismatch during `next build`'s type check.
    let pollId: ReturnType<typeof setTimeout> | undefined;

    void import("@/lib/vendor/compendium-loader.js").then(() => {
      if (cancelled) return;
      // Task A1-4 (batch 03 graph canvas port): real dismiss trigger,
      // replacing the mig-03 stand-in below it used to be ("the vendor
      // module finished initializing", i.e. calling dismiss() as soon as
      // window.__compendiumLoader appeared, before there was any graph to
      // wait on). Dash's own signal is a SEPARATE clientside callback
      // (app.py) that flips #compendium-loader's className to add
      // .loader-dismiss once refresh_graph_on_load's page-load graph fetch
      // COMPLETES (graph-version goes 0 -> >0 -- deliberately not "nodes
      // exist", see that callback's comment for why the distinction
      // matters for an empty-but-loaded compendium). This port's analogue:
      // window.__compendiumGraphRendered, set `true` by
      // components/GraphCanvas.tsx from vendor.render()'s `onFirstPaint`
      // callback -- the first Web Worker `tick` message's positions
      // painted (Task group W, W3 step; before that task, render() was
      // itself synchronous and this fired right after it returned --
      // see that component's own comment; lib/vendor/vendor.d.ts
      // documents the flag itself). tryDismiss below now polls BOTH
      // window.__compendiumLoader
      // (vendor ready) AND this flag (graph painted) before calling
      // dismiss() -- order-independent (whichever condition becomes true
      // last is what this poll is waiting on; a flag already true when
      // this poll starts is picked up on the very next tick, same as
      // window.__compendiumLoader already was before this change).
      //
      // Re-init constraint preserved: this only changes WHEN the existing
      // dismiss() call fires, not whether/how the loader itself
      // (re)initializes -- window.__compendiumLoader is still the SAME
      // node the vendor's own poll binds ONCE (the constraint
      // window.__compendiumLoaderVendorInitStarted's own comment
      // documents above); no new mount/remount path is introduced here.
      //
      // Calling dismiss() is still safe for every mode regardless of
      // timing: the vendor module's own MutationObserver defers first-run/
      // replay finalization until their animation cycle completes
      // regardless of when dismiss() is called (see
      // lib/vendor/compendium-loader.js's mode-aware dismiss-defer logic)
      // -- only 'return' mode (no animation to protect) finalizes
      // immediately.
      //
      let tries = 0;
      // ~10s at 50ms, matching the vendor module's own poll ceiling. Now
      // also the give-up ceiling for "graph never painted" (e.g. a
      // zero-node compendium, where GraphCanvas never calls the vendor's
      // render() at all and this flag never arrives) -- see
      // task-A1-4-report.md for why that case is knowingly left to this
      // same fallback rather than special-cased in this slice.
      const MAX_TRIES = 200;
      const tryDismiss = () => {
        if (cancelled) return;
        if (window.__compendiumLoader && window.__compendiumGraphRendered) {
          window.__compendiumLoader.dismiss();
          completed = true;
          return;
        }
        if (++tries > MAX_TRIES) {
          // give up silently -- terminal state either way, the latch stays
          // permanent rather than retrying on a future remount. See the
          // MAX_TRIES comment above for the (now more reachable) case this
          // covers.
          completed = true;
          return;
        }
        pollId = setTimeout(tryDismiss, 50);
      };
      tryDismiss();
    });

    return () => {
      cancelled = true;
      if (pollId !== undefined) clearTimeout(pollId);
      delete window.__compendiumLoaderOnSeen;
      if (!completed) {
        // This run's bootstrap flow was torn down before it reached a
        // terminal state (StrictMode's synchronous mount -> cleanup, or
        // any other very-early unmount) -- roll the latch back so the
        // NEXT mount starts the flow fresh instead of finding it falsely
        // "already started" by a run that never actually got anywhere.
        window.__compendiumLoaderVendorInitStarted = false;
      }
    };
  }, []);

  return (
    <div
      id="compendium-loader"
      className="loader"
      role="status"
      aria-live="polite"
      aria-label="Loading the compendium"
      data-user-id={canPersist ? "1" : ""}
      data-mode={mode}
      data-loader-config={LOADER_CONFIG_JSON}
    />
  );
}
