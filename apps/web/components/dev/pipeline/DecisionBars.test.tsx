import { it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import DecisionBars from "./DecisionBars";
import type { PipelineSummary } from "@/lib/types";
const summary: PipelineSummary = {
  status_counts: { active: 3, pending: 1, archived: 6 }, total_pages: 10,
  decisions: [{ key: "skipped", label: "Skipped", count: 6, evaluated: true }, { key: "pending", label: "Pending", count: 1, evaluated: false }],
  skip_methods: [{ key: "domain_skip", label: "Domain filter", count: 4 }, { key: "skip_gate", label: "LLM skip gate", count: 2 }],
  skip_gate_reasons: [{ reason: "login wall", count: 2 }],
  skip_gate_config: { model: "m", temperature: 0, prompt_name: "skip_gate_v2_3", prompt: "p", tools: [] },
};
it("shows decisions with pct of all pages, mechanisms with Dash fills, reasons with hover title", () => {
  render(<DecisionBars summary={summary} />);
  expect(screen.getByText("60%")).toBeInTheDocument();           // 6 of 10
  const fills = document.querySelectorAll(".dev-bar-fill") as NodeListOf<HTMLElement>;
  expect(fills[1].style.background).toBe("rgb(43, 46, 52)");    // #2b2e34 not-evaluated
  expect(fills[2].style.background).toBe("var(--panel-caption)"); // Domain filter
  expect(screen.getByTitle("login wall")).toBeInTheDocument();
});
