"use client";
import { useCallback, useLayoutEffect, useRef, useState, type MouseEvent, type ReactElement } from "react";

/** Pointer position and wrapper size, both in wrapper coordinates (w = 0 when there is no wrapper to clamp to). */
interface TipState { px: number; py: number; w: number; h: number; lines: string[] }
const OFFSET = 12;

/** Beside the pointer, flipped left / above when it would overflow the wrapper, then clamped inside it. */
export function placeTooltip(px: number, py: number, w: number, h: number, tw: number, th: number): { x: number; y: number } {
  let x = px + OFFSET; let y = py + OFFSET;
  if (w > 0) {
    if (x + tw > w) x = px - OFFSET - tw; // flip to the pointer's left
    if (y + th > h) y = py - OFFSET - th; // flip above the pointer
    x = Math.max(0, Math.min(x, Math.max(0, w - tw)));
    y = Math.max(0, Math.min(y, Math.max(0, h - th)));
  }
  return { x, y };
}

/**
 * Shared chart tooltip. `tooltip` must be rendered inside the chart's wrapper
 * (class `chart-wrap`, position: relative); `show` positions it from the
 * pointer, clamped to that wrapper. The placement runs after the tooltip has
 * rendered, so it measures the real box even on the first show (a guessed
 * size let a wide first tooltip run past the wrapper's edge). An empty
 * `lines` hides it.
 */
export function useChartTooltip(): { tooltip: ReactElement | null; show: (evt: MouseEvent, lines: string[]) => void; hide: () => void } {
  const [tip, setTip] = useState<TipState | null>(null);
  const elRef = useRef<HTMLDivElement | null>(null);
  const show = useCallback((evt: MouseEvent, lines: string[]) => {
    if (lines.length === 0) { setTip(null); return; }
    const target = evt.currentTarget as Element;
    const wrap = target.closest(".chart-wrap") as HTMLElement | null;
    const box = wrap?.getBoundingClientRect();
    setTip({ px: evt.clientX - (box?.left ?? 0), py: evt.clientY - (box?.top ?? 0), w: box?.width ?? 0, h: box?.height ?? 0, lines });
  }, []);
  const hide = useCallback(() => setTip(null), []);
  useLayoutEffect(() => {
    const el = elRef.current;
    if (!el || !tip) return;
    const { x, y } = placeTooltip(tip.px, tip.py, tip.w, tip.h, el.offsetWidth, el.offsetHeight);
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }, [tip]);
  const tooltip = tip && tip.lines.length > 0 ? (
    <div ref={elRef} className="chart-tooltip" role="tooltip" style={{ left: tip.px + OFFSET, top: tip.py + OFFSET }}>
      {tip.lines.map((l, i) => (<div key={i} className={i === 0 ? "chart-tooltip-title" : undefined}>{l}</div>))}
    </div>
  ) : null;
  return { tooltip, show, hide };
}
