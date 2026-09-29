import { RANGE_KEYS, RANGE_LABELS } from "@/lib/pipeline";
import type { RangeKey } from "@/lib/types";
export default function RangePills({ value, onChange }: { value: RangeKey; onChange: (k: RangeKey) => void }) {
  return (
    <div className="trends-range-bar" role="group" aria-label="Window">
      {RANGE_KEYS.map((k) => (
        <button key={k} type="button" className={`trends-range-btn${k === value ? " active" : ""}`} aria-pressed={k === value} onClick={() => onChange(k)}>{RANGE_LABELS[k]}</button>
      ))}
    </div>
  );
}
