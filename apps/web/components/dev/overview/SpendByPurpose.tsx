"use client";
import { Fragment, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { useChartTooltip } from "@/components/charts/ChartTooltip";
import { useContainerWidth } from "@/components/charts/useContainerWidth";
import { useOptionalTheme } from "@/components/ThemeProvider";
import { SPEND_COLORS } from "./colors";
import { CALLOUT_LEAD, CHAR_WIDTH, layoutSpendBar, pickInk, type Rgb } from "./spend-bar";
import { formatUsd, plural, shareOf } from "@/lib/overview";
import type { OverviewSpend, SpendPurpose, SpendPurposeKey } from "@/lib/types";

const MEASURE_SAMPLE = "$0.0000 · 00.0% · 0,000 calls";

/** Resolves any CSS colour (oklch, relative colour syntax, hex) to sRGB by painting one canvas pixel; null where canvas is unavailable (jsdom). */
function colorSampler(): ((css: string) => Rgb | null) | null {
  const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.canvas.width = ctx.canvas.height = 1;
  return (css) => {
    ctx.fillStyle = "#010203";
    ctx.fillStyle = css;
    if (ctx.fillStyle === "#010203") return null;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return [r, g, b];
  };
}

export default function SpendByPurpose({ spend }: { spend: OverviewSpend }) {
  const colors = SPEND_COLORS;
  const paid = spend.purposes.filter((p) => p.usd > 0);
  const paidTotal = paid.reduce((a, p) => a + p.usd, 0);
  const [barRef, barWidth] = useContainerWidth();
  const [charWidth, setCharWidth] = useState(CHAR_WIDTH);
  const [inks, setInks] = useState<Record<string, "dark" | "light">>({});
  const measureRef = useRef<HTMLSpanElement>(null);
  const segRefs = useRef(new Map<string, HTMLSpanElement>());
  const variant = useOptionalTheme()?.variant;
  const { tooltip, show, hide } = useChartTooltip();
  const byKey = new Map(paid.map((p) => [p.key as string, p]));
  const tipLines = (p: SpendPurpose) => [
    p.label,
    `${formatUsd(p.usd)} · ${shareOf(p.usd, spend.usd)} · ${plural(p.calls, "call")}`,
    ...p.event_types.map((t) => `${t.label} ${formatUsd(t.usd)} · ${plural(t.calls, "call")}`),
  ];
  // Segments and their callouts share one hover tooltip (the chart kit's), so a 3px segment is reachable through its callout.
  const tipHandlers = (p: SpendPurpose) => {
    const onMove = (e: MouseEvent) => show(e, tipLines(p));
    return { onMouseEnter: onMove, onMouseMove: onMove, onMouseLeave: hide };
  };

  const layout = layoutSpendBar(
    paid.map((p) => {
      const short = `${formatUsd(p.usd)} · ${shareOf(p.usd, spend.usd)}`;
      return { key: p.key, share: p.usd / paidTotal, short, full: `${short} · ${plural(p.calls, "call")}` };
    }),
    barWidth,
    charWidth,
  );
  const callouts = layout.flatMap((l) => (l.mode === "callout" ? [l] : []));
  const paidKeys = paid.map((p) => p.key).join();

  // Measure the label font's glyph width, and pick each segment's label ink against the palette's own --bg / --text.
  useLayoutEffect(() => {
    const m = measureRef.current;
    if (!m) return;
    const w = m.getBoundingClientRect().width / MEASURE_SAMPLE.length;
    if (w > 0) setCharWidth(w);
    const sample = colorSampler();
    if (!sample) return;
    const root = getComputedStyle(document.documentElement);
    const dark = sample(root.getPropertyValue("--bg").trim()), light = sample(root.getPropertyValue("--text").trim());
    if (!dark || !light) return;
    const next: Record<string, "dark" | "light"> = {};
    segRefs.current.forEach((el, key) => {
      const fill = sample(getComputedStyle(el).backgroundColor);
      if (fill) next[key] = pickInk(fill, dark, light);
    });
    setInks(next);
  }, [variant, paidKeys]);

  return (
    <section className="dev-panel overview-spend chart-wrap">
      <div className="dev-panel-head">
        <h3 className="dev-section-title">Spend by purpose</h3>
        <span className="dev-panel-meta">{formatUsd(spend.usd)} · {plural(spend.calls, "call")}</span>
      </div>
      {spend.purposes.length === 0 ? <p className="dev-empty dev-empty-inline">No LLM spend recorded in this period.</p> : <>
        {paid.length > 0 && (
          <div className="overview-spend-figure">
            {callouts.length > 0 && (
              <div className="overview-spend-callouts" aria-hidden="true">
                {/* The swatch carries identity; a tick joins only a callout that sits over its own segment (a leader from a
                    pushed-aside callout would run under its neighbour and read as that one's). */}
                {callouts.map((c) => (
                  <Fragment key={c.key}>
                    <span className="overview-spend-callout" style={{ left: c.left }} {...tipHandlers(byKey.get(c.key) as SpendPurpose)}>
                      <span className="swatch" style={{ background: colors[c.key as SpendPurposeKey] }} />
                      {c.text}
                    </span>
                    {c.center >= c.left + CALLOUT_LEAD && c.center <= c.left + c.width && <span className="overview-spend-tick" style={{ left: c.center }} />}
                  </Fragment>
                ))}
              </div>
            )}
            <div ref={barRef} className="overview-spend-bar" role="img" aria-label={`Spend by purpose: ${paid.map((p) => `${p.label} ${formatUsd(p.usd)}, ${shareOf(p.usd, spend.usd)}, ${plural(p.calls, "call")}`).join("; ")}`}>
              {paid.map((p, i) => {
                const l = layout[i];
                return (
                  <span
                    key={p.key}
                    ref={(el) => { if (el) segRefs.current.set(p.key, el); else segRefs.current.delete(p.key); }}
                    style={{ flexGrow: p.usd / paidTotal, flexBasis: 0, background: colors[p.key] }}
                    {...tipHandlers(p)}
                  >
                    {l.mode === "inside" && <span className={`overview-spend-seg-label ink-${inks[p.key] ?? "dark"}`}>{l.text}</span>}
                  </span>
                );
              })}
            </div>
            <span ref={measureRef} className="overview-spend-measure" aria-hidden="true">{MEASURE_SAMPLE}</span>
          </div>
        )}
        <ul className="overview-spend-list">
          {spend.purposes.map((p) => (
            <li key={p.key}>
              <span className="swatch" style={{ background: colors[p.key] }} />
              <span className="overview-spend-label">
                {p.label}
                {p.usd <= 0 && <span className="overview-spend-unbarred">{` ${formatUsd(p.usd)} · ${plural(p.calls, "call")}`}</span>}
              </span>
              {p.event_types.length > 0 && (
                <ul className="overview-spend-types">
                  {p.event_types.map((t) => <li key={t.key}>{`${t.label} ${formatUsd(t.usd)} · ${plural(t.calls, "call")}`}</li>)}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </>}
      {tooltip}
    </section>
  );
}
