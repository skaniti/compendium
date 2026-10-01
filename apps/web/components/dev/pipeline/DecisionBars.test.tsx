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
it("shows decisions with pct of all pages, every bar in the highlight colour, reasons with hover title", () => {
  render(<DecisionBars summary={summary} />);
  expect(screen.getByText("60%")).toBeInTheDocument();           // 6 of 10
  const fills = document.querySelectorAll(".dev-bar-fill") as NodeListOf<HTMLElement>;
  expect(fills.length).toBe(5);
  fills.forEach((f) => expect(f.style.background).toBe("var(--highlight)"));
  expect(screen.getByTitle("login wall")).toBeInTheDocument();
});
it("shows percentages of archived pages on skip mechanisms and gate reasons", () => {
  render(<DecisionBars summary={{ ...summary, status_counts: { active: 0, pending: 0, archived: 10 }, total_pages: 20,
    skip_methods: [{ key: "domain_skip", label: "Domain Filter", count: 4 }],
    skip_gate_reasons: [{ reason: "login wall", count: 2 }] }} />);
  expect(screen.getByText("Domain Filter").closest(".dev-bar-row")).toHaveTextContent("4 40%");
  expect(screen.getByText("login wall").closest(".dev-bar-row")).toHaveTextContent("2 20%");
});
