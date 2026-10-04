"use client";
import { useCallback, useLayoutEffect, useRef, useState, type MouseEvent, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { placeTooltip } from "./ChartTooltip";

interface TipState { px: number; py: number; lines: string[] }
const OFFSET = 12;

/**
 * The chart kit's tooltip for any hover target outside a chart (buttons,
 * header controls): the same `chart-tooltip` look, fixed to the viewport and
 * portalled to <body> so no header or panel clips it, placed beside the
 * pointer with the chart kit's flip-and-clamp rule against the viewport.
 * Compendium uses this instead of native `title` tooltips (2026-10-04); give
 * the target an aria-label for screen readers. Same API as useChartTooltip:
 * render `tooltip` anywhere, wire `show` to mouseenter/mousemove and `hide`
 * to mouseleave. An empty `lines` hides it.
 */
export function useHoverTooltip(): { tooltip: ReactElement | null; show: (evt: MouseEvent, lines: string[]) => void; hide: () => void } {
  const [tip, setTip] = useState<TipState | null>(null);
  const elRef = useRef<HTMLDivElement | null>(null);
  const show = useCallback((evt: MouseEvent, lines: string[]) => {
    setTip(lines.length === 0 ? null : { px: evt.clientX, py: evt.clientY, lines });
  }, []);
  const hide = useCallback(() => setTip(null), []);
  useLayoutEffect(() => {
    const el = elRef.current;
    if (!el || !tip) return;
    const { x, y } = placeTooltip(tip.px, tip.py, window.innerWidth, window.innerHeight, el.offsetWidth, el.offsetHeight);
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }, [tip]);
  const tooltip = tip ? createPortal(
    <div ref={elRef} className="chart-tooltip chart-tooltip-fixed" role="tooltip" style={{ left: tip.px + OFFSET, top: tip.py + OFFSET }}>
      {tip.lines.map((l, i) => (<div key={i} className={i === 0 && tip.lines.length > 1 ? "chart-tooltip-title" : undefined}>{l}</div>))}
    </div>,
    document.body,
  ) : null;
  return { tooltip, show, hide };
}
