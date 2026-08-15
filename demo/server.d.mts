// Ambient type declaration for server.mjs, so demo/server.test.ts type-checks
// under this repo's strict tsconfig (allowJs: false means tsc can't infer
// types straight from the .mjs source). Kept minimal and hand-in-sync with
// server.mjs's actual exported interface -- see that file for behavior.
export interface StartServerOptions {
  port?: number;
  fixturesDir?: string;
}

export interface StartedServer {
  port: number;
  close(): Promise<void>;
}

export function startServer(options?: StartServerOptions): Promise<StartedServer>;

// Task 5: exported for Task 6's write gate. Duck-typed against the subset
// of http.IncomingMessage actually read (just the Authorization header) --
// see demo/lib/tokens.d.mts's BearerCarrier, which this matches exactly.
export interface BearerCarrier {
  headers: { authorization?: string };
}
export function isPlainDemo(req: BearerCarrier): boolean;
