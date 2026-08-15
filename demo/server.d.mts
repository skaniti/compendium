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
