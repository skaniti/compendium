import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { it, expect, vi, beforeEach } from "vitest";
import * as api from "@/lib/prompts-api";
import PromptRegistry from "./PromptRegistry";
import { detail, summary } from "./test-fixtures";
vi.mock("@/lib/prompts-api");

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.fetchPromptDetail).mockResolvedValue(detail());
});
const tasks = summary().tasks;

it("tasks in order with live labels, pills, aria-pressed, meta", async () => {
  const { container } = render(<PromptRegistry tasks={tasks} selected="alpha_task_v2" onSelect={() => {}} admin={null} onChanged={() => {}} />);
  const groups = container.querySelectorAll(".prompts-task");
  expect(groups[0]).toHaveTextContent("Alpha task");
  expect(groups[0]).toHaveTextContent("live v2");
  expect(groups[1]).toHaveTextContent("Beta task");
  expect(groups[1]).toHaveTextContent("no live caller");
  const nav = within(screen.getByRole("navigation", { name: "Prompts by task" }));
  const v2 = nav.getAllByRole("button")[1];
  expect(v2).toHaveAttribute("aria-pressed", "true");
  expect(v2).toHaveTextContent("live");
  expect(nav.getAllByRole("button")[0]).toHaveTextContent("override");
  expect(nav.getAllByRole("button")[0]).toHaveAttribute("aria-pressed", "false");
  expect(nav.getAllByRole("button")).toHaveLength(3);
  expect(screen.getByText("3 prompts · 2 tasks · 1 overridden")).toBeInTheDocument();
  await screen.findByText("Registry text for {title}");
});
it("click selects by name; meta omits overridden at zero", async () => {
  const onSelect = vi.fn();
  const clean = tasks.map((t) => ({ ...t, prompts: t.prompts.map((p) => ({ ...p, overridden: false })) }));
  render(<PromptRegistry tasks={clean} selected={null} onSelect={onSelect} admin={null} onChanged={() => {}} />);
  await userEvent.click(screen.getAllByRole("button", { name: /^v1/ })[1]);
  expect(onSelect).toHaveBeenCalledWith("beta_task_v1");
  expect(screen.getByText("3 prompts · 2 tasks")).toBeInTheDocument();
});
