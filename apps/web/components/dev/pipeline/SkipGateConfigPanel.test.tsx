import { render, screen } from "@testing-library/react";
import { it, expect } from "vitest";
import { OVERRIDE_SHOWN_NOTE, OVERRIDE_WITHHELD_NOTE } from "@/lib/prompts";
import type { PipelineFlow, SkipGateConfig } from "@/lib/types";
import SkipGateConfigPanel from "./SkipGateConfigPanel";
const config = { model: "model-x", temperature: 0, prompt_name: "skip_v1", prompt: "p", tools: [],
  categories: [{ id: "a", label: "A", description: "d" }, { id: "b", label: "B", description: "d" }] } as unknown as SkipGateConfig;
it("titles the summary and shows monospace chips", () => {
  const { container } = render(<SkipGateConfigPanel config={config} />);
  expect(container.querySelector("details.dev-config-panel.dev-panel")).toBeTruthy();
  expect(screen.getByText("Skip gate · LLM")).toBeInTheDocument();
  expect(container.querySelector("summary")).toHaveTextContent("model-x");
  expect(container.querySelector("summary")).toHaveTextContent("skip_v1");
  expect(container.querySelectorAll("summary .dev-chip")).toHaveLength(3);
  expect(container.querySelector("summary")).toHaveTextContent("2 categories + uncategorized");
});
const flowOf = (total: number, gate: number): PipelineFlow => ({ total, outcomes: [{ key: "gate", label: "Skipped by LLM gate", count: gate, top_domains: [] }], details: [], fates: [] });
it("shows the gate count, share and one-liner in the collapsed state", () => {
  const { container } = render(<SkipGateConfigPanel config={config} flow={flowOf(200, 50)} />);
  const details = container.querySelector("details") as HTMLDetailsElement;
  expect(details.open).toBe(false);
  const face = container.querySelector("summary .skip-gate-face") as HTMLElement;
  expect(face).toHaveTextContent("50");
  expect(face).toHaveTextContent("pages · 25.0% of captured");
  expect(face).toHaveTextContent("Decided by model-x over the API; pages it keeps go on to processing.");
  expect(face.querySelector(".rule-filter-number")).toBeTruthy();
});
it("shows a dash for the share when nothing was captured", () => {
  render(<SkipGateConfigPanel config={config} flow={flowOf(0, 0)} />);
  expect(screen.getByText("pages · — of captured")).toBeInTheDocument();
});
it("renders no face without a flow", () => {
  const { container } = render(<SkipGateConfigPanel config={config} />);
  expect(container.querySelector(".skip-gate-face")).toBeNull();
});
it.each([
  ["withheld", OVERRIDE_WITHHELD_NOTE],
  ["shown", OVERRIDE_SHOWN_NOTE],
] as const)("a %s override gets its note above the prompt", (state, note) => {
  const { container } = render(<SkipGateConfigPanel config={{ ...config, prompt_override: state }} />);
  const p = screen.getByText(note);
  expect(p).toHaveClass("config-note");
  expect(p.nextElementSibling).toBe(container.querySelector("pre.config-prompt"));
});
it("no override, or a payload without the field: no note", () => {
  for (const c of [config, { ...config, prompt_override: null }]) {
    const { container, unmount } = render(<SkipGateConfigPanel config={c} />);
    expect(container.querySelector(".config-note")).toBeNull();
    unmount();
  }
});
