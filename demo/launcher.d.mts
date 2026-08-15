// Ambient type declaration for launcher.mjs, so demo/server.test.ts
// type-checks under this repo's strict tsconfig (allowJs: false means tsc
// can't infer types straight from the .mjs source) -- same convention as
// server.d.mts. Only pickPort is exported/tested; the rest of launcher.mjs
// is exercised by hand (Task 11), not imported by any .ts file.
export function pickPort(preferred: number): Promise<number>;
