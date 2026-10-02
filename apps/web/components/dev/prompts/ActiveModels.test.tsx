import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { it, expect, vi } from "vitest";
import ActiveModels from "./ActiveModels";
import { modelRow, summary } from "./test-fixtures";

const models = summary().models;

it("one row per model in order, price cell, dash for null", () => {
  const { container } = render(<ActiveModels models={models} unused={[]} onSelectPrompt={() => {}} />);
  const rows = container.querySelectorAll("tbody tr");
  expect(rows).toHaveLength(2);
  expect(rows[0]).toHaveTextContent("Stage A");
  expect(rows[1]).toHaveTextContent("Stage B");
  expect(rows[0]).toHaveTextContent("$0.15 · $0.60");
  expect(rows[1].querySelectorAll("td")[3]).toHaveTextContent("—");
  expect(rows[1].querySelectorAll("td")[4]).toHaveTextContent("—");
  expect(screen.getByText("2 stages")).toBeInTheDocument();
});
it("prompt button selects; none when prompt is null", async () => {
  const onSelect = vi.fn();
  render(<ActiveModels models={models} unused={[]} onSelectPrompt={onSelect} />);
  await userEvent.click(screen.getByRole("button", { name: "alpha_task_v2" }));
  expect(onSelect).toHaveBeenCalledWith("alpha_task_v2");
  expect(screen.getAllByRole("button")).toHaveLength(1);
});
it("footnote exact, omitted when empty", () => {
  const { rerender } = render(<ActiveModels models={[modelRow()]} unused={[{ model: "model-u", source: "settings.u" }, { model: "model-v", source: "settings.v" }]} onSelectPrompt={() => {}} />);
  expect(screen.getByText("Declared in settings but never called: model-u (settings.u), model-v (settings.v).")).toBeInTheDocument();
  rerender(<ActiveModels models={[modelRow()]} unused={[]} onSelectPrompt={() => {}} />);
  expect(screen.queryByText(/never called/)).toBeNull();
});
