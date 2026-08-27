// Ambient type declarations for tokens.mjs, so demo/lib/tokens.test.ts and
// demo/server.test.ts type-check under this repo's strict tsconfig
// (allowJs: false means tsc can't infer types straight from the .mjs
// source). Kept minimal and hand-in-sync with tokens.mjs's actual exports
// -- see that file for behavior + rationale.
export interface MintTokenUser {
  id: number | string;
  email: string;
  role: string;
}

export interface MintTokenOptions {
  actingAsDemo?: boolean;
  ttlSec?: number;
}

export function mintToken(user: MintTokenUser, options?: MintTokenOptions): string;

export function decodeToken(token: unknown): Record<string, unknown> | null;

// Duck-typed against the subset of http.IncomingMessage this actually reads
// (just the Authorization header), so callers (including tests) can pass a
// plain object instead of standing up a real IncomingMessage.
export interface BearerCarrier {
  headers: { authorization?: string };
}
export function bearerFromRequest(req: BearerCarrier): string | null;
