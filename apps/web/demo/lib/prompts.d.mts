export declare const ADMIN_REQUIRED: string;
export declare const PROMPT_NOT_FOUND: string;
export declare const RUN_NOT_FOUND: string;
export declare const NOT_CONFIGURED: string;
export declare const ADMIN_STATUS: {
  overrides: { configured: boolean; readable: boolean; count: number };
  evals: { configured: boolean };
};
export declare const EVALS_NOT_CONFIGURED: { configured: boolean; readable: boolean; runs: unknown[]; skipped: number };
export declare function summaryFor<T extends Record<string, unknown>>(summary: T, adminContext: boolean): Omit<T, "admin"> & { admin: unknown };
export declare function detailFor(map: Record<string, Record<string, unknown>>, name: string, adminContext: boolean): Record<string, unknown> | null;
export declare function overrideWrite(
  map: Record<string, unknown>,
  name: string,
  adminContext: boolean,
): { status: number; body: { detail: string } };
export declare function evalsList(adminContext: boolean): { status: number; body: Record<string, unknown> };
export declare function evalDetail(adminContext: boolean): { status: number; body: { detail: string } };
