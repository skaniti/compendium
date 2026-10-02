"use client";
import { formatPriceCell, type ModelRow, type UnusedModel } from "@/lib/prompts";

interface Props { models: ModelRow[]; unused: UnusedModel[]; onSelectPrompt: (name: string) => void }

export default function ActiveModels({ models, unused, onSelectPrompt }: Props) {
  return (
    <section className="dev-panel prompts-models">
      <div className="dev-panel-head">
        <h3 className="dev-section-title">Active models</h3>
        <span className="dev-panel-meta">{models.length} stages</span>
      </div>
      <p className="prompts-caption">Read from the constants and settings each stage calls, so this list follows the code.</p>
      <div className="dev-table-wrap">
        <table className="dev-table prompts-models-table">
          <thead>
            <tr>
              <th>Stage</th><th className="prompts-col-detail">What it does</th><th>Model</th><th>Provider</th>
              <th>$ / 1M in · out</th><th>Prompt</th><th className="prompts-col-source">Source</th>
            </tr>
          </thead>
          <tbody>
            {models.map((m) => (
              <tr key={m.id}>
                <td>{m.use}</td>
                <td className="prompts-col-detail">{m.detail}</td>
                <td className="cell-mono">{m.model}</td>
                <td>{m.provider ?? "—"}</td>
                <td className="cell-mono">{formatPriceCell(m)}</td>
                <td>
                  {m.prompt
                    ? <button type="button" className="prompts-link" onClick={() => onSelectPrompt(m.prompt as string)}>{m.prompt}</button>
                    : "—"}
                </td>
                <td className="cell-mono prompts-col-source">{m.source}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {unused.length > 0 && (
        <p className="prompts-note">Declared in settings but never called: {unused.map((u) => `${u.model} (${u.source})`).join(", ")}.</p>
      )}
    </section>
  );
}
