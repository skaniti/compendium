// Ambient type declaration for server.mjs, so demo/server.test.ts type-checks
// under this repo's strict tsconfig (allowJs: false means tsc can't infer
// types straight from the .mjs source). Kept minimal and hand-in-sync with
// server.mjs's actual exported interface -- see that file for behavior.
export interface StartServerOptions {
  port?: number;
  fixturesDir?: string;
  // Task 6: injectable delay for POST /api/recluster (default 2000ms,
  // matching the real ~2s backend recluster). Tests pass a small/zero value
  // so the suite doesn't pay the real delay -- see server.mjs's `gated`
  // POST /api/recluster handler.
  reclusterDelayMs?: number;
  // Task 7: injectable pacing (ms) between re-emitted token events for
  // POST /api/agent/query-stream (default 15, matching the brief's "~15ms
  // pacing" contract). status/complete frames are never delayed. Tests pass
  // a small/zero value so reading a whole fixture's stream (hundreds of
  // token events) doesn't blow the test budget.
  chatTokenDelayMs?: number;
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
