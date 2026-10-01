export type SortState = "asc" | "desc" | "none";
/** One icon family for every sortable header: an up chevron over a down chevron; the active one is full strength. */
export default function SortIcon({ state }: { state: SortState }) {
  const up = state === "asc" ? 1 : state === "desc" ? 0.2 : 0.35;
  const down = state === "desc" ? 1 : state === "asc" ? 0.2 : 0.35;
  return (
    <svg className="sort-icon" data-state={state} viewBox="0 0 10 12" width={10} height={12} aria-hidden="true" focusable="false"
      style={{ width: 10, height: 12, marginLeft: 4, verticalAlign: "middle" }} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 5 L5 2 L8 5" opacity={up} />
      <path d="M2 7 L5 10 L8 7" opacity={down} />
    </svg>
  );
}
