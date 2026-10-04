import PromptOverrideNote from "@/components/dev/PromptOverrideNote";
import { formatRatio } from "@/lib/pipeline";
import type { PipelineFlow, SkipGateConfig } from "@/lib/types";

const fmt = (n: number) => n.toLocaleString("en-US");

export default function SkipGateConfigPanel({ config, flow }: { config: SkipGateConfig; flow?: PipelineFlow }) {
  const count = flow?.outcomes.find((o) => o.key === "gate")?.count ?? 0;
  return (
    <details className="dev-config-panel dev-panel">
      <summary>
        <span className="dev-config-title">Skip gate · LLM</span>
        <span className="dev-chip">{config.model}</span>
        <span className="dev-chip">{config.prompt_name}</span>
        <span className="dev-chip">{config.categories.length} categories + uncategorized</span>
        {flow && (
          // inside <summary> so it stays visible while the panel is collapsed
          <div className="skip-gate-face">
            <div className="rule-filter-count"><span className="rule-filter-number">{fmt(count)}</span></div>
            <div className="rule-filter-share">pages · {flow.total > 0 ? formatRatio(count / flow.total) : "—"} of captured</div>
            <p className="rule-filter-claim">Decided by {config.model} over the API; pages it keeps go on to processing.</p>
          </div>
        )}
      </summary>
      <div className="config-body">
        <div className="config-row"><span className="config-label">Model</span><span className="config-value">{config.model}</span></div>
        <div className="config-row"><span className="config-label">Temperature</span><span className="config-value">{config.temperature.toFixed(1)}</span></div>
        <div className="config-row"><span className="config-label">Prompt</span><span className="config-value">{config.prompt_name}</span></div>
        <PromptOverrideNote state={config.prompt_override} />
        <pre className="config-prompt">{config.prompt}</pre>
        <div className="config-label">Tools</div>
        {config.tools.map((t) => (
          <div className="config-tool" key={t.name}>
            <div className="config-tool-name">{t.name}</div>
            <div className="config-tool-desc">{t.description}</div>
          </div>
        ))}
        <div className="config-label">Categories</div>
        {config.categories.map((c) => (
          <div className="config-tool" key={c.id}>
            <div className="config-tool-name">{c.label} <span className="config-cat-id">({c.id})</span></div>
            <div className="config-tool-desc">{c.description}</div>
          </div>
        ))}
      </div>
    </details>
  );
}
