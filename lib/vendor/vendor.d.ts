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
