import type { SkipGateConfig } from "@/lib/types";
export default function SkipGateConfigPanel({ config }: { config: SkipGateConfig }) {
  return (
    <details className="dev-config-panel">
      <summary>Skip gate config</summary>
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
      </div>
    </details>
  );
}
