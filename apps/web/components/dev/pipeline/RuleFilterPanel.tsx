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
      <div className="rule-filter-share">pages · {flow.total > 0 ? formatRatio(count / flow.total) : "—"} of captured</div>
      <p className="rule-filter-claim">Matched a fixed domain or URL rule before the LLM gate. Never sent to an LLM, by API or subscription, during processing, and never embedded or clustered unless you restore the page.</p>
      <div className="rule-filter-split">domain rules <span className="rule-filter-num">{fmt(detail("domain"))}</span> · URL pattern rules <span className="rule-filter-num">{fmt(detail("url_pattern"))}</span></div>
      <details className="rule-filter-rules">
        <summary>Rules: {config.counts.domains} domains · {config.counts.url_patterns} URL patterns · {config.counts.path_rules} path rules</summary>
        {config.lists_visible ? (
          <>
            <ul className="rule-filter-domains">{domains.map((d) => <li key={d}>{d}</li>)}</ul>
            <ul className="rule-filter-patterns">
              {config.url_patterns.map((u) => <li key={`${u.domain}${u.path}`}><span>{u.domain}</span> <span>{u.path}</span></li>)}
            </ul>
            <ul className="rule-filter-paths">{config.path_rules.map((r) => <li key={r}>{r}</li>)}</ul>
          </>
        ) : <p className="rule-filter-hidden">Rule lists are visible to admins.</p>}
      </details>
      <p className="rule-filter-footnote">Stored on your server as an audit row. Not yet covered: DQ bot reads, chat page lookups by id, LangSmith tracing, and stored extension text.</p>
    </section>
  );
}
