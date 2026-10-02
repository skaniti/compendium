import { render, screen } from "@testing-library/react";
import { it, expect } from "vitest";
import PromptDiff from "./PromptDiff";

it("legend and prefixed lines for a one-line change", () => {
  const { container } = render(<PromptDiff registry={"a\nb\nc"} override={"a\nB\nc"} />);
  expect(screen.getByText("− registry · + override")).toBeInTheDocument();
  const lines = [...container.querySelectorAll(".prompts-diff-line")];
  expect(lines.map((l) => l.className)).toEqual([
    "prompts-diff-line is-same", "prompts-diff-line is-del", "prompts-diff-line is-add", "prompts-diff-line is-same",
  ]);
  expect(lines.map((l) => l.textContent)).toEqual(["  a\n", "− b\n", "+ B\n", "  c\n"]);
});
