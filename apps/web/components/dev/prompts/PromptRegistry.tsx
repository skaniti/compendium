"use client";
import { forwardRef } from "react";
import type { PromptsAdminStatus, PromptTask } from "@/lib/prompts";
import PromptViewer from "./PromptViewer";

interface Props {
  tasks: PromptTask[]; selected: string | null; onSelect: (name: string) => void;
  admin: PromptsAdminStatus | null; onChanged: () => void;
}

const PromptRegistry = forwardRef<HTMLElement, Props>(function PromptRegistry({ tasks, selected, onSelect, admin, onChanged }, ref) {
  const all = tasks.flatMap((t) => t.prompts);
  const overridden = all.filter((p) => p.overridden).length;
  return (
    <section className="dev-panel prompts-registry" id="prompts-registry" ref={ref}>
      <div className="dev-panel-head">
        <h3 className="dev-section-title">Prompt registry</h3>
        <span className="dev-panel-meta">{all.length} prompts · {tasks.length} tasks{overridden > 0 ? ` · ${overridden} overridden` : ""}</span>
      </div>
      <p className="prompts-caption">Every template in the registry, by task. The live version is the one the pipeline calls today.</p>
      <div className="prompts-grid">
        <nav className="prompts-nav" aria-label="Prompts by task">
          {tasks.map((t) => {
            const liveVersion = t.prompts.find((p) => p.name === t.live)?.version;
            return (
              <div className="prompts-task" key={t.task}>
                <div className="prompts-task-head">
                  <span className="prompts-task-label">{t.label}</span>
                  <span className="prompts-task-live">{t.live ? `live ${liveVersion ?? t.live}` : "no live caller"}</span>
                </div>
                <ul>
                  {t.prompts.map((p) => (
                    <li key={p.name}>
                      <button type="button" className="prompts-version" title={p.name} aria-pressed={p.name === selected} onClick={() => onSelect(p.name)}>
                        {p.version}
                        {p.live && <span className="prompts-pill is-live">live</span>}
                        {p.overridden && <span className="prompts-pill is-override">override</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </nav>
        {selected && <PromptViewer key={selected} name={selected} admin={admin} onChanged={onChanged} />}
      </div>
    </section>
  );
});

export default PromptRegistry;
