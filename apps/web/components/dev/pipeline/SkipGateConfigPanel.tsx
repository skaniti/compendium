import type { SkipGateConfig } from "@/lib/types";
export default function SkipGateConfigPanel({ config }: { config: SkipGateConfig }) {
  return (
    <details className="dev-config-panel dev-panel">
      <summary>
        <span className="dev-config-title">Skip gate · LLM</span>
        <span className="dev-chip">{config.model}</span>
        <span className="dev-chip">{config.prompt_name}</span>
        <span className="dev-chip">{config.categories.length} categories + uncategorized</span>
      </summary>
      <div className="config-body">
        <div className="config-row"><span className="config-label">Model</span><span className="config-value">{config.model}</span></div>
        <div className="config-row"><span className="config-label">Temperature</span><span className="config-value">{config.temperature.toFixed(1)}</span></div>
        <div className="config-row"><span className="config-label">Prompt</span><span className="config-value">{config.prompt_name}</span></div>
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
