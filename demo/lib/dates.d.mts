// Ambient type declarations for dates.mjs, so demo/lib/dates.test.ts type-checks
// under this repo's strict tsconfig (allowJs: false means tsc can't infer
// types straight from the .mjs source). Kept minimal and hand-in-sync with
// dates.mjs's actual exports -- see that file for behavior + rationale.
export function isoDateStr(d: Date): string;
export function parseIsoDateUTC(s: string): Date;
export function addDaysUTC(d: Date, days: number): Date;
export function isoWeekKey(d: Date): string;
export function weekMonday(d: Date): Date;
export function mondayOfIsoWeekKey(key: string): Date;
export function formatDayLabel(dateStr: string): string;
export function formatWeekLabel(monday: Date): string;
export function formatMonthLabel(monthKey: string): string;
export function computeDeltaDays(anchorIsoDate: string, now?: Date): number;
export function shiftIsoDateTime(iso: string | null | undefined, deltaDays: number): string | null | undefined;
export function shiftDayKeyLabel(key: string, deltaDays: number): { key: string; label: string };
export function shiftWeekKeyLabel(key: string, deltaDays: number): { key: string; label: string };
export function shiftMonthKeyLabel(key: string, deltaDays: number): { key: string; label: string };

export interface DiaryWindowLike {
  key: string;
  label: string;
  [k: string]: unknown;
}
export function shiftDiaryWindow<T extends DiaryWindowLike>(
  window: T,
  granularity: "day" | "week" | "month",
  deltaDays: number
): T;
