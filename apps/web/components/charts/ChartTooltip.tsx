"use client";
import { useCallback, useRef, useState, type MouseEvent, type ReactElement } from "react";

interface TipState { x: number; y: number; lines: string[] }
const OFFSET = 12;

/**
 * Shared chart tooltip. `tooltip` must be rendered inside the chart's wrapper
 * div (class `chart-wrap`, position: relative); `show` positions it from the
 * pointer, clamped to that wrapper. An empty `lines` hides it.
 */
export function useChartTooltip(): { tooltip: ReactElement | null; show: (evt: MouseEvent, lines: string[]) => void; hide: () => void } {
  const [tip, setTip] = useState<TipState | null>(null);
  const elRef = useRef<HTMLDivElement | null>(null);
  const show = useCallback((evt: MouseEvent, lines: string[]) => {
    if (lines.length === 0) { setTip(null); return; }
    const target = evt.currentTarget as Element;
    const wrap = target.closest(".chart-wrap") as HTMLElement | null;
    const box = wrap?.getBoundingClientRect();
    const w = box?.width ?? 0; const h = box?.height ?? 0;
    const px = evt.clientX - (box?.left ?? 0); const py = evt.clientY - (box?.top ?? 0);
    const tw = elRef.current?.offsetWidth ?? 160; const th = elRef.current?.offsetHeight ?? 50;
    let x = px + OFFSET; let y = py + OFFSET;
    if (box) {
      if (x + tw > w) x = px - OFFSET - tw; // flip to the pointer's left
      if (y + th > h) y = py - OFFSET - th; // flip above the pointer
      x = Math.max(0, Math.min(x, Math.max(0, w - tw)));
      y = Math.max(0, Math.min(y, Math.max(0, h - th)));
    }
    setTip({ x, y, lines });
  }, []);
  const hide = useCallback(() => setTip(null), []);
  const tooltip = tip && tip.lines.length > 0 ? (
    <div ref={elRef} className="chart-tooltip" role="tooltip" style={{ left: tip.x, top: tip.y }}>
      {tip.lines.map((l, i) => (<div key={i} className={i === 0 ? "chart-tooltip-title" : undefined}>{l}</div>))}
    </div>
  ) : null;
  return { tooltip, show, hide };
}
