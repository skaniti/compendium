import { OVERRIDE_SHOWN_NOTE, OVERRIDE_WITHHELD_NOTE, type PromptOverrideState } from "@/lib/prompts";

/** Above a read-only prompt in a config panel: says when the text is, or stands in for, a local override. */
export default function PromptOverrideNote({ state }: { state?: PromptOverrideState }) {
  if (!state) return null;
  return <p className="config-note">{state === "shown" ? OVERRIDE_SHOWN_NOTE : OVERRIDE_WITHHELD_NOTE}</p>;
}
