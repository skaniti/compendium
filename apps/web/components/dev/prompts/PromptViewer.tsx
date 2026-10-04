"use client";
import { useEffect, useId, useState, type MouseEvent } from "react";
import { useHoverTooltip } from "@/components/charts/HoverTooltip";
import type { PromptDetail, PromptsAdminStatus, SaveOverrideResult } from "@/lib/prompts";
import { fetchPromptDetail, resetPromptOverride } from "@/lib/prompts-api";
import PromptDiff from "./PromptDiff";
import PromptEditor from "./PromptEditor";

interface Props { name: string; admin: PromptsAdminStatus | null; onChanged: () => void; editLocked?: boolean }
type Loaded = { name: string; data: PromptDetail | null; error: string | null };

export const EDIT_LOCKED_TEXT = "Editing is disabled in demo view";

export default function PromptViewer({ name, admin: adminStatus, onChanged, editLocked = false }: Props) {
  // A demo session never gets the admin tools, whatever it is passed.
  const admin = editLocked ? null : adminStatus;
  const [rev, setRev] = useState(0);
  const [loaded, setLoaded] = useState<Loaded>({ name, data: null, error: null });
  const [editing, setEditing] = useState(false);
  const [comparing, setComparing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [status, setStatus] = useState<string[]>([]);
  const [resetError, setResetError] = useState<string | null>(null);
  // Any demo session, an admin viewing as demo included, sees the same
  // registry view and an Edit override button greyed out, with the chart-kit
  // tooltip saying why (same as the recluster lock, 2026-10-04); a hidden
  // description carries the reason for keyboard and screen readers.
  const lockTip = useHoverTooltip();
  const lockNoteId = useId();
  const showLockTip = (e: MouseEvent) => lockTip.show(e, [EDIT_LOCKED_TEXT]);

  useEffect(() => {
    let cancelled = false;
    fetchPromptDetail(name)
      .then((d) => { if (!cancelled) setLoaded({ name, data: d, error: null }); })
      .catch((e: Error) => { if (!cancelled) setLoaded((p) => ({ name, data: p.name === name ? p.data : null, error: e.message })); });
    return () => { cancelled = true; };
  }, [name, rev]);

  if (loaded.name === name && loaded.error) return <p className="dev-empty" role="alert">Couldn&apos;t load {name} ({loaded.error}).</p>;
  const detail = loaded.name === name ? loaded.data : null;
  if (!detail) return <p className="dev-empty">Loading…</p>;

  const override = admin && typeof detail.override === "string" ? detail.override : null;
  const liveText = admin ? (detail.override ?? detail.registry_template) : detail.registry_template;

  const onSaved = (r: SaveOverrideResult) => {
    setEditing(false);
    setComparing(false);
    setStatus(r.cleared
      ? ["Matches the registry text; override cleared."]
      : [`Saved override for ${name}.`, ...(r.missing_placeholders.length ? [`This override doesn't use: ${r.missing_placeholders.map((p) => `{${p}}`).join(", ")}.`] : [])]);
    setRev((n) => n + 1);
    onChanged();
  };
  const doReset = async () => {
    setConfirming(false);
    setResetError(null);
    try {
      await resetPromptOverride(name);
      setComparing(false);
      setStatus([`Reset ${name} to the registry text.`]);
      setRev((n) => n + 1);
      onChanged();
    } catch (e) {
      setResetError((e as Error).message);
    }
  };

  return (
    <div className="prompts-viewer">
      <div className="prompts-viewer-head">
        <code className="prompts-name">{name}</code>
        {detail.live && <span className="prompts-pill is-live">live</span>}
        {detail.overridden && <span className="prompts-pill is-override">override</span>}
        {!detail.task_has_live && <span className="prompts-pill is-muted">no live caller</span>}
      </div>
      <p className="prompts-desc">{detail.description}</p>
      <div className="prompts-meta">
        <span><span className="prompts-meta-label">Techniques</span> {detail.techniques.map((t) => <span key={t} className="dev-chip">{t}</span>)}</span>
        <span><span className="prompts-meta-label">Fills</span> {detail.placeholders.length
          ? detail.placeholders.map((p) => <span key={p} className="dev-chip">{`{${p}}`}</span>)
          : <span>No placeholders</span>}</span>
      </div>
      {!admin && detail.overridden && (
        <p className="prompts-note">This deployment runs a local override of this prompt. Its text is visible to admins only; below is the registry text.</p>
      )}
      {admin && !admin.overrides.configured && (
        <p className="prompts-note">Editing is off: this API has no PROMPT_OVERRIDES_PATH. Set it to a file outside the repo to enable overrides.</p>
      )}
      {admin && admin.overrides.configured && !admin.overrides.readable && (
        <p className="prompts-note">The override file can&apos;t be read, so LLM calls use the registry text. Fix or remove it on the server to edit overrides.</p>
      )}
      {admin && admin.overrides.configured && admin.overrides.readable && !editing && (
        <div className="prompts-toolbar">
          <button type="button" onClick={() => { setEditing(true); setComparing(false); setConfirming(false); }}>Edit override</button>
          {override !== null && (
            <button type="button" aria-pressed={comparing} onClick={() => { setComparing((c) => !c); setEditing(false); }}>Compare with registry</button>
          )}
          {override !== null && <button type="button" onClick={() => setConfirming(true)}>Reset to registry</button>}
          {confirming && (
            <span className="prompts-confirm">
              Reset {name} to the registry text? <button type="button" onClick={doReset}>Reset</button> <button type="button" onClick={() => setConfirming(false)}>Cancel</button>
            </span>
          )}
        </div>
      )}
      {editLocked && (
        <div className="prompts-toolbar">
          <button type="button" aria-disabled="true" aria-describedby={lockNoteId} onMouseEnter={showLockTip} onMouseMove={showLockTip} onMouseLeave={lockTip.hide}>Edit override</button>
          <span id={lockNoteId} hidden>{EDIT_LOCKED_TEXT}</span>
          {lockTip.tooltip}
        </div>
      )}
      {resetError && <p className="prompts-note" role="alert">Couldn&apos;t reset ({resetError}).</p>}
      {editing && admin
        ? <PromptEditor name={name} liveText={liveText} registryText={detail.registry_template} onSaved={onSaved} onCancel={() => setEditing(false)} />
        : comparing && override !== null
          ? <PromptDiff registry={detail.registry_template} override={override} />
          : <pre className="config-prompt prompts-template">{liveText}</pre>}
      <div className="prompts-status" aria-live="polite">{status.map((s) => <div key={s}>{s}</div>)}</div>
    </div>
  );
}
