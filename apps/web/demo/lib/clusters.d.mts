type ClusterRun = { id?: number; started_at: string | null; completed_at: string | null } & Record<string, unknown>;
export function shiftClustersFixtures(
  raw: { run: ClusterRun | null; runs: { items: ClusterRun[] } & Record<string, unknown> } & Record<string, unknown>,
  deltaDays: number,
): { run: ClusterRun | null; runs: { items: ClusterRun[] } & Record<string, unknown> } & Record<string, unknown>;
export function pageUnclustered(
  all: { total: number; pages: unknown[] } & Record<string, unknown>,
  params: URLSearchParams,
): { status: number; body: Record<string, unknown> };
export function membersFor(map: Record<string, unknown>, id: string | number): Record<string, unknown> | null;
