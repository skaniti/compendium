"use client";
import type { Range } from "@/lib/almagest/params";

// Almagest graph tuner (Task 4): shared range+number slider primitive.
// `decimals` derives how many places the paired number input should show
// from the range's own step (a 0.01 step shows 2 decimals, a step of 1 or
// more shows none) so the two inputs always agree on precision without a
// second prop.
export interface SliderProps { id: string; label: string; value: number; range: Range; onChange: (v: number) => void; disabled?: boolean; hint?: string }

export default function Slider({ id, label, value, range, onChange, disabled, hint }: SliderProps) {
  const decimals = range.step >= 1 ? 0 : String(range.step).split(".")[1]?.length ?? 2;
  return (
    <div className="tuner-row">
      <label className="tuner-label" htmlFor={id}>{label}</label>
      <input id={id} type="range" min={range.min} max={range.max} step={range.step} value={value} disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))} aria-label={label} />
      <input className="tuner-num" type="number" min={range.min} max={range.max} step={range.step} value={Number(value.toFixed(decimals))}
        disabled={disabled} aria-label={`${label} value`} onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) onChange(v); }} />
      {hint ? <span className="tuner-hint">{hint}</span> : null}
    </div>
  );
}
