import { SPEND_COLORS } from "./colors";
import { formatUsd, plural, shareOf } from "@/lib/overview";
import type { OverviewSpend } from "@/lib/types";

export default function SpendByPurpose({ spend }: { spend: OverviewSpend }) {
  const colors = SPEND_COLORS;
  const paid = spend.purposes.filter((p) => p.usd > 0);
  const paidTotal = paid.reduce((a, p) => a + p.usd, 0);
  return (
    <section className="dev-panel overview-spend">
      <div className="dev-panel-head">
        <h3 className="dev-section-title">Spend by purpose</h3>
        <span className="dev-panel-meta">{formatUsd(spend.usd)} · {plural(spend.calls, "call")}</span>
      </div>
      {spend.purposes.length === 0 ? <p className="dev-empty dev-empty-inline">No LLM spend recorded in this period.</p> : <>
        {paid.length > 0 && (
          <div className="overview-spend-bar" role="img" aria-label="Spend by purpose">
            {paid.map((p) => <span key={p.key} style={{ flexGrow: p.usd / paidTotal, flexBasis: 0, background: colors[p.key] }} title={`${p.label}: ${formatUsd(p.usd)}`} />)}
          </div>
        )}
        <ul className="overview-spend-list">
          {spend.purposes.map((p) => (
            <li key={p.key}>
              <span className="swatch" style={{ background: colors[p.key] }} />
              <span className="overview-spend-label">{p.label}</span>
              <span className="overview-spend-usd">{formatUsd(p.usd)}</span>
              <span className="overview-spend-pct">{shareOf(p.usd, spend.usd)}</span>
              <span className="overview-spend-calls">{plural(p.calls, "call")}</span>
              {p.event_types.length > 0 && (
                <ul className="overview-spend-types">
                  {p.event_types.map((t) => <li key={t.key}>{`${t.label} ${formatUsd(t.usd)} · ${plural(t.calls, "call")}`}</li>)}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </>}
    </section>
  );
}
