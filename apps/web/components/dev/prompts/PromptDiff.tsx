"use client";
import { lineDiff } from "@/lib/prompts";

const PREFIX = { add: "+ ", del: "− ", same: "  " } as const;

export default function PromptDiff({ registry, override }: { registry: string; override: string }) {
  return (
    <>
      <p className="prompts-note">− registry · + override</p>
      <pre className="config-prompt prompts-diff">
        {lineDiff(registry, override).map((l, i) => (
          <span key={i} className={`prompts-diff-line is-${l.op}`}>{`${PREFIX[l.op]}${l.text}\n`}</span>
        ))}
      </pre>
    </>
  );
}
