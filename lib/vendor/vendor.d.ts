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
  // components/CompendiumLoader.tsx's mount effect -- true once that
  // effect has started the vendor bootstrap (dynamic import + tryDismiss
  // trigger) once, so a later remount's effect run skips re-entering that
  // flow instead of re-running it against a vendor instance that already
  // finished initializing (see that effect's own comment for the hazard
  // this prevents). Window-scoped rather than a module-level variable so
  // it behaves identically to window.__compendiumLoader's own lifetime
  // (persists across a real unmount/remount within the same page load,
  // resets on an actual page reload) -- and so it can be reset per-test
  // the same way the other two globals here already are.
  __compendiumLoaderVendorInitStarted?: boolean;
}
