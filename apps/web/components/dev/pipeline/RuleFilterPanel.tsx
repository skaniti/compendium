import { formatRatio } from "@/lib/pipeline";
import type { PipelineFlow, RuleFilterConfig } from "@/lib/types";

const fmt = (n: number) => n.toLocaleString("en-US");

export default function RuleFilterPanel({ flow, config }: { flow: PipelineFlow; config: RuleFilterConfig }) {
  const count = flow.outcomes.find((o) => o.key === "rule_filter")?.count ?? 0;
  const detail = (key: string) => flow.details.find((d) => d.outcome === "rule_filter" && d.key === key)?.count ?? 0;
  const domains = [...config.domains, ...config.domain_suffixes];
  return (
    <section className="dev-panel rule-filter-panel">
      <h3 className="dev-section-title">Rule filter · no LLM</h3>
      <div className="rule-filter-count"><span className="rule-filter-number">{fmt(count)}</span></div>
      <div className="rule-filter-share">pages · {formatRatio(flow.total > 0 ? count / flow.total : 0)} of captured</div>
      <p className="rule-filter-claim">Matched a fixed domain or URL rule before the LLM gate. Never sent to an LLM, by API or subscription, during processing, and never embedded or clustered.</p>
      <div className="rule-filter-split">domain rules <span className="rule-filter-num">{fmt(detail("domain"))}</span> · URL pattern rules <span className="rule-filter-num">{fmt(detail("url_pattern"))}</span></div>
      <details className="rule-filter-rules">
        <summary>Rules: {domains.length} domains · {config.url_patterns.length} URL patterns · {config.path_rules.length} path rules</summary>
        <ul className="rule-filter-domains">{domains.map((d) => <li key={d}>{d}</li>)}</ul>
        <ul className="rule-filter-patterns">
          {config.url_patterns.map((u) => <li key={`${u.domain}${u.path}`}><span>{u.domain}</span> <span>{u.path}</span></li>)}
        </ul>
        <ul className="rule-filter-paths">{config.path_rules.map((r) => <li key={r}>{r}</li>)}</ul>
      </details>
      <p className="rule-filter-footnote">Stored on your server as an audit row. Not yet covered: DQ bot reads and LangSmith tracing.</p>
    </section>
  );
}
