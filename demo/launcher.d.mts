// Ambient type declaration for launcher.mjs, so demo/server.test.ts
// type-checks under this repo's strict tsconfig (allowJs: false means tsc
// can't infer types straight from the .mjs source) -- same convention as
// server.d.mts. pickPort, isDirectEntry, and bootStub are exported/tested;
// the rest of launcher.mjs (mainly `main()`'s `next dev` half) is exercised
// by hand (Task 11), not imported by any .ts file.
export function pickPort(preferred: number): Promise<number>;

// `argv1` is typed optional/nullable to match `process.argv[1]`'s actual
// type (`string | undefined`) and the helper's explicit undefined-argv1
// handling (e.g. a REPL has no invoked script).
export function isDirectEntry(metaUrl: string, argv1: string | undefined): boolean;

// Boots the stub backend only (not `next dev`) -- see launcher.mjs's own
// doc comment on the export. `log` defaults to a no-op so tests can omit it.
export function bootStub(options?: {
  preferredPort?: number;
  log?: (...args: unknown[]) => void;
}): Promise<{ port: number; backendUrl: string; child: import("node:child_process").ChildProcess }>;
