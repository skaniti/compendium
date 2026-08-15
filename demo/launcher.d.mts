// Ambient type declaration for launcher.mjs, so demo/server.test.ts
// type-checks under this repo's strict tsconfig (allowJs: false means tsc
// can't infer types straight from the .mjs source) -- same convention as
// server.d.mts. Only pickPort and isDirectEntry are exported/tested; the
// rest of launcher.mjs is exercised by hand (Task 11), not imported by any
// .ts file.
export function pickPort(preferred: number): Promise<number>;

// `argv1` is typed optional/nullable to match `process.argv[1]`'s actual
// type (`string | undefined`) and the helper's explicit undefined-argv1
// handling (e.g. a REPL has no invoked script).
export function isDirectEntry(metaUrl: string, argv1: string | undefined): boolean;
