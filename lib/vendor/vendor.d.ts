// Vendored third-party scripts (lib/vendor/*.js) are framework-agnostic,
// dependency-free JS with no ES exports -- they're imported purely for
// their side effects (defining a custom element / attaching a window
// global), e.g. `import("@/lib/vendor/starry-sky.js")` in
// components/Starfield.tsx. `allowJs` is false project-wide
// (tsconfig.json), so plain .js files aren't part of the TS program and
// have no inferred module shape -- this ambient wildcard declaration is
// what lets the dynamic import resolve during type-checking. Covers any
// future lib/vendor/*.js file (e.g. mig-01 task 9's compendium-loader.js)
// without needing a new declaration per file.
declare module "@/lib/vendor/*.js";

// window.__compendiumLoader is the side-effect global lib/vendor/
// compendium-loader.js attaches once its internal DOM-poll finds
// #compendium-loader and initializes (mirrors window.StarrySky above, one
// file up). Two consumers share this ambient type rather than each
// declaring it locally: components/CompendiumLoader.tsx (registers
// __compendiumLoaderOnSeen, calls dismiss() once mounted) and
// components/Header.tsx (Settings -> Replay tutorial calls replay()). This
// file has no top-level import/export, so it's a global script -- a bare
// `interface Window` augmentation here merges into the global scope
// without needing a `declare global { ... }` wrapper.
interface Window {
  __compendiumLoader?: {
    el: HTMLElement;
    dismiss: () => void;
    replay: () => void;
    replayAsFirstRun: () => void;
  };
  // Bridges lib/vendor/compendium-loader.js's finishDismiss() (first-run
  // seen-flag persistence) back out to React -- see that file's header
  // comment for why this replaces Dash's window.dash_clientside.set_props
  // store write.
  __compendiumLoaderOnSeen?: () => void;
  // Explicit idempotence latch (mig-02 carryover) owned entirely by
  // components/CompendiumLoader.tsx's mount effect -- true once a mount's
  // vendor bootstrap (dynamic import + tryDismiss trigger) has reached a
  // TERMINAL state (found window.__compendiumLoader and dismissed it, or
  // gave up after MAX_TRIES), so a later remount's effect run skips
  // re-entering that flow instead of re-running it against a vendor
  // instance that already finished initializing (see that effect's own
  // comment for the hazard this prevents). Deliberately NOT set permanently
  // just because a run STARTED the flow: if a run's cleanup fires before
  // its flow reaches a terminal state (e.g. React StrictMode's dev-mode
  // synchronous mount -> cleanup -> mount, which this repo gets for free
  // since next.config.ts never overrides the App Router's
  // reactStrictMode-defaults-true), that run's own effect rolls this flag
  // back to false so the NEXT mount starts fresh -- otherwise the second,
  // real, persisted mount would see this already "started" by a run that
  // never got anywhere and skip initializing entirely, leaving the loader
  // curtain stuck up forever in every dev session. Window-scoped rather
  // than a module-level variable so it behaves identically to
  // window.__compendiumLoader's own lifetime (persists across a real
  // unmount/remount within the same page load, resets on an actual page
  // reload) -- and so it can be reset per-test the same way the other two
  // globals here already are.
  __compendiumLoaderVendorInitStarted?: boolean;
  // Task A1-4 (batch 03 graph canvas port): render-complete signal.
  // components/GraphCanvas.tsx sets this `true` once the canvas reaches its
  // first SETTLED state -- either its vendor's render() call returns
  // (render() is synchronous, so its return IS first paint, no rAF/async
  // tail to wait on) OR the canvas resolves to the empty state (payload
  // committed, zero nodes -- a first-time user with nothing captured yet is
  // still a settled canvas, and is exactly the loader's own first-run
  // audience; A1-4 fix, task-A1-4-report.md's "fix" section). Two write
  // sites in that one component, same flag, same "idempotent, later
  // same-value writes are a no-op" reasoning either way.
  // components/CompendiumLoader.tsx's tryDismiss loop polls this ALONGSIDE
  // window.__compendiumLoader before
  // calling dismiss() (see that effect's own comment) -- replaces the
  // mig-03 "vendor module finished initializing" stand-in trigger with the
  // real one. Window-scoped (not a callback GraphCanvas looks up) because
  // it mirrors the loader's own existing trigger-receiving shape: a level-
  // triggered flag polled from a poll loop, not an edge-triggered callback
  // -- so whichever of the two mounts/signals happens to resolve first, the
  // other's poll picks it up with no ordering dependency between the two
  // (unlike Header.tsx's replay()/GraphCanvas's onSelect, there is no
  // shared React ancestor to lift a callback prop through; CompendiumLoader
  // and GraphCanvas are siblings-of-siblings under AppShell). Same window-
  // scoped-not-module-level shape as __compendiumLoaderVendorInitStarted
  // above, for the same per-test-reset reason. Never cleared once set (not
  // torn down on GraphCanvas unmount) -- same lifetime as
  // window.__compendiumLoader itself: persists across a page's whole
  // lifetime, resets only on a real page reload. TODO(W3): superseded once
  // dismissal moves to the first worker `positions` batch instead of
  // render()'s synchronous return -- this flag and both its read/write
  // sites should be DELETED then, not layered under a second flag.
  __compendiumGraphRendered?: boolean;
}
