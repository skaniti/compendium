"use client";
import { useEffect, useRef, useState } from "react";
import type { Range } from "@/lib/almagest/params";

// Almagest graph tuner (Task 4): shared range+number slider primitive.
// `decimals` derives how many places the paired number input should show
// from the range's own step (a 0.01 step shows 2 decimals, a step of 1 or
// more shows none) so the two inputs always agree on precision without a
// second prop.
export interface SliderProps {
  id: string;
  label: string;
  value: number;
  range: Range;
  onChange: (v: number) => void;
  disabled?: boolean;
  hint?: string;
  // Batch A per-parameter reset (spec docs/project-plans/2026-09-13-183006-
  // graph-interaction-followups/): both optional and only rendered together
  // -- a caller that doesn't pass `onReset` gets today's row, unchanged.
  baseline?: number;
  onReset?: () => void;
}

export default function Slider({ id, label, value, range, onChange, disabled, hint, baseline, onReset }: SliderProps) {
  const decimals = range.step >= 1 ? 0 : String(range.step).split(".")[1]?.length ?? 2;
  const formatted = String(Number(value.toFixed(decimals)));

  // The number input keeps its own free-form draft text and does NOT call
  // onChange per keystroke -- only on blur (or Enter, via blur()). A
  // controlled number input that ran the parent's validateParams/clamp on
  // every keystroke corrupted multi-digit entry: typing "3" into a field
  // whose range min is 4 clamped the field to "4" immediately, so the
  // browser's *next* keydown event ("6") appended onto that already-clamped
  // rendered value ("4" + "6" = "46") instead of onto what the user actually
  // typed ("36"). Buffering the raw text locally and clamping once at commit
  // time fixes that. The range input is unaffected -- its own native
  // min/max/step keep every value in range already, so it keeps pushing
  // onChange live on every drag tick.
  const [text, setText] = useState(formatted);
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setText(formatted);
  }, [formatted]);

  function commit(): void {
    if (text.trim() === "") {
      setText(formatted);
      return;
    }
    const v = Number(text);
    if (Number.isFinite(v)) onChange(v);
    else setText(formatted);
  }

  // Batch A tweak marker: same condition the reset button's own `disabled`
  // uses below, reused rather than added as a separate prop -- a row is
  // "tweaked" exactly when its reset button would do something.
  const tweaked = onReset !== undefined && value !== baseline;

  return (
    <div className={tweaked ? "tuner-row tuner-row--tweaked" : "tuner-row"}>
      <label className="tuner-label" htmlFor={id}>{label}</label>
      <input id={id} type="range" min={range.min} max={range.max} step={range.step} value={value} disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))} aria-label={label} />
      <input
        className="tuner-num"
        type="number"
        min={range.min}
        max={range.max}
        step={range.step}
        value={text}
        disabled={disabled}
        aria-label={`${label} value`}
        onFocus={() => { focused.current = true; }}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => { focused.current = false; commit(); }}
        onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
      />
      {onReset ? (
        <button
          type="button"
          className="tuner-reset"
          aria-label={`Reset ${label}`}
          title={`Reset ${label} to last-baked value`}
          disabled={value === baseline}
          onClick={onReset}
        >
          ↺
        </button>
      ) : null}
      {hint ? <span className="tuner-hint">{hint}</span> : null}
    </div>
  );
}
