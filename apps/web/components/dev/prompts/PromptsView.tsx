"use client";
import { useRef, useState } from "react";
import { usePeriodFetch } from "@/components/dev/pipeline/usePeriodFetch";
import { useSession } from "@/components/SessionProvider";
import { canSeeAdminViews } from "@/lib/dev-views";
import { STALE_API_MESSAGE } from "@/lib/overview";
import { initialPrompt } from "@/lib/prompts";
import { fetchPromptsSummary } from "@/lib/prompts-api";
import ActiveModels from "./ActiveModels";
import EvalHistory from "./EvalHistory";
import PromptRegistry from "./PromptRegistry";

export const PROMPTS_SUBTITLE = "Which model and which prompt each LLM stage runs, every prompt in the registry, and (for admins) local overrides and evaluation runs. Prompts are current state, so this view has no period.";
export const STALE_TEXT = "The API is older than this view; restart it to load prompts.";

export default function PromptsView() {
  const [reload, setReload] = useState(0);
  // A new key keeps the previous data on screen, so badges never blank out after a save.
  const { data, error } = usePeriodFetch(`prompts|${reload}`, fetchPromptsSummary);
  const { role, actingAsDemo } = useSession();
  const admin = !!data?.admin && canSeeAdminViews(role, actingAsDemo);
  const [selected, setSelected] = useState<string | null>(null);
  const registryRef = useRef<HTMLElement>(null);
  return (
    <>
      <div className="dev-view-header-band">
        <h2 className="dev-view-title">Prompts</h2>
        <p className="dev-view-subtitle">{PROMPTS_SUBTITLE}</p>
      </div>
      <div className="dev-view-body prompts-body">
        {error === STALE_API_MESSAGE ? <section className="dev-panel"><p className="dev-empty" role="alert">{STALE_TEXT}</p></section>
         : error && !data ? <p className="dev-empty" role="alert">Couldn&apos;t load prompts ({error}).</p>
         : !data ? <p className="dev-empty">Loading…</p>
         : <>
            <ActiveModels
              models={data.models}
              unused={data.unused_models}
              onSelectPrompt={(n) => { setSelected(n); registryRef.current?.scrollIntoView?.({ block: "start", behavior: "smooth" }); }}
            />
            <PromptRegistry
              ref={registryRef}
              tasks={data.tasks}
              selected={selected ?? initialPrompt(data.tasks)}
              onSelect={setSelected}
              admin={admin ? data.admin : null}
              onChanged={() => setReload((n) => n + 1)}
            />
            {admin && <EvalHistory />}
          </>}
      </div>
    </>
  );
}
