import { render, screen } from "@testing-library/react";
import { it, expect } from "vitest";
import type { SkipGateConfig } from "@/lib/types";
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
