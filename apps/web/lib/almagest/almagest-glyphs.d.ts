// The Almagest generator (fonts/almagest/tools/almagest-glyphs.cjs) is a
// dependency-free UMD-style IIFE: `module.exports = API` under CommonJS and
// `globalThis.Almagest = API` always. `allowJs` is false and the file is
// eslint-ignored, so app code reaches it through a side-effect import (which
// runs the IIFE under any module system) and reads the global. These types
// cover only the surface the app uses; keep them in sync with the API object
// at the end of that file.
declare module "@/fonts/almagest/tools/almagest-glyphs.cjs" {}

declare global {
  var Almagest: import("./generator").AlmagestApi | undefined;
}
export {};
