"use client";
import { useState } from "react";
import { MAX_TEMPLATE_CHARS, type SaveOverrideResult } from "@/lib/prompts";
import { savePromptOverride } from "@/lib/prompts-api";

interface Props {
  name: string; liveText: string; registryText: string;
  onSaved: (result: SaveOverrideResult) => void; onCancel: () => void;
}

export default function PromptEditor({ name, liveText, registryText, onSaved, onCancel }: Props) {
  const [draft, setDraft] = useState(liveText);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = draft !== liveText;
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      onSaved(await savePromptOverride(name, draft));
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  };
  return (
    <>
      <textarea className="prompts-editor" spellCheck={false} rows={22} aria-label={`Override for ${name}`} value={draft} onChange={(e) => setDraft(e.target.value)} />
      <div className="prompts-editor-status">
        {draft.length.toLocaleString("en-US")} / {MAX_TEMPLATE_CHARS.toLocaleString("en-US")} characters · {changed ? "Unsaved changes" : "No changes"}
        {draft === registryText && changed && <> · Matches the registry text: saving clears the override.</>}
      </div>
      <div className="prompts-editor-actions">
        <button type="button" onClick={save} disabled={!changed || draft.trim() === "" || saving}>Save</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
      {error && <p className="prompts-note" role="alert">Couldn&apos;t save ({error}).</p>}
    </>
  );
}
