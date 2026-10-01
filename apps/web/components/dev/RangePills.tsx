"use client";
import type { TimeWindow } from "@/lib/types";

const OPTIONS: { value: TimeWindow; label: string }[] = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "all", label: "All time" },
];

export default function RangePills({ value, onChange }: { value: TimeWindow; onChange: (k: TimeWindow) => void }) {
  return (
    <div className="trends-range-bar" role="group" aria-label="Window">
      {OPTIONS.map((o) => (
        <button key={o.value} type="button" className={`trends-range-btn${o.value === value ? " active" : ""}`} aria-pressed={o.value === value} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}
