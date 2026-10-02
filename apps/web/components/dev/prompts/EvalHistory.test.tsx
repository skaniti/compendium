import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi, it, expect, beforeEach } from "vitest";
import * as api from "@/lib/prompts-api";
import EvalHistory from "./EvalHistory";
import { evalDetail, evalRow, evalRuns } from "./test-fixtures";

vi.mock("@/lib/prompts-api");

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.fetchEvalRun).mockResolvedValue(evalDetail());
});

const three = [
  evalRow(),
  evalRow({ run_id: "run-002", prompt_name: "beta_gate", prompt_version: "v1", delta: null, selection: null, cost_usd: 0.25 }),
  evalRow({ run_id: "run-003", prompt_name: "beta_gate", prompt_version: "v2" }),
];

it("not configured", async () => {
  vi.mocked(api.fetchEvalRuns).mockResolvedValue(evalRuns({ configured: false }));
  render(<EvalHistory />);
  expect(await screen.findByText("No evaluation runs here: this API has no EVAL_RUNS_DIR. Runs come from the evaluation harness and stay outside the repo.")).toBeInTheDocument();
});
it("unreadable", async () => {
  vi.mocked(api.fetchEvalRuns).mockResolvedValue(evalRuns({ configured: true, readable: false }));
  render(<EvalHistory />);
  expect(await screen.findByText("EVAL_RUNS_DIR is set, but the directory can't be read.")).toBeInTheDocument();
});
it("empty", async () => {
  vi.mocked(api.fetchEvalRuns).mockResolvedValue(evalRuns({ configured: true }));
  render(<EvalHistory />);
  expect(await screen.findByText("No runs in EVAL_RUNS_DIR yet.")).toBeInTheDocument();
});
it("fetch error", async () => {
  vi.mocked(api.fetchEvalRuns).mockRejectedValue(new Error("boom"));
  render(<EvalHistory />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load runs (boom).");
});
it("meta, rows, deltas", async () => {
  vi.mocked(api.fetchEvalRuns).mockResolvedValue(evalRuns({ configured: true, runs: three, skipped: 1 }));
  const { container } = render(<EvalHistory />);
  expect(await screen.findByText("3 runs · 1 unreadable")).toBeInTheDocument();
  const rows = container.querySelectorAll("tbody tr");
  expect(rows).toHaveLength(3);
  expect(rows[0]).toHaveTextContent("92.0% (50)");
  expect(rows[0]).toHaveTextContent("—");
  expect(rows[0]).toHaveTextContent("vs v1.0: sel +2.0 pts");
  expect(rows[0].querySelector(".prompts-delta.is-up")).toBeTruthy();
  expect(rows[1]).toHaveTextContent("$0.25");
  expect(rows[0].querySelector("td")).toHaveAttribute("title", "run-001");
});
it("vs previous omits a null side", async () => {
  const d = (selection: number | null, stress: number | null) => ({ vs_version: "v1.0", vs_run_id: "r0", selection, stress });
  vi.mocked(api.fetchEvalRuns).mockResolvedValue(evalRuns({ configured: true, runs: [
    evalRow({ run_id: "a", delta: d(0, null) }),
    evalRow({ run_id: "b", delta: d(null, 0.02) }),
    evalRow({ run_id: "c", delta: d(0.02, -0.01) }),
    evalRow({ run_id: "d", delta: d(null, null) }),
  ] }));
  const { container } = render(<EvalHistory />);
  await screen.findByText("4 runs");
  const vs = [...container.querySelectorAll("tbody tr")].map((r) => r.querySelectorAll("td")[8].textContent);
  expect(vs).toEqual(["vs v1.0: sel ±0.0 pts", "vs v1.0: str +2.0 pts", "vs v1.0: sel +2.0 pts · str \u22121.0 pts", "vs v1.0: —"]);
});
it("family chips filter", async () => {
  vi.mocked(api.fetchEvalRuns).mockResolvedValue(evalRuns({ configured: true, runs: three }));
  const { container } = render(<EvalHistory />);
  await screen.findByText("3 runs");
  await userEvent.click(screen.getByRole("button", { name: "beta_gate" }));
  expect(container.querySelectorAll("tbody tr")).toHaveLength(2);
  await userEvent.click(screen.getByRole("button", { name: "All" }));
  expect(container.querySelectorAll("tbody tr")).toHaveLength(3);
});
it("show all / fewer", async () => {
  const many = Array.from({ length: 16 }, (_, i) => evalRow({ run_id: `run-${i}` }));
  vi.mocked(api.fetchEvalRuns).mockResolvedValue(evalRuns({ configured: true, runs: many }));
  const { container } = render(<EvalHistory />);
  await userEvent.click(await screen.findByRole("button", { name: "Show all 16 runs" }));
  expect(container.querySelectorAll("tbody tr")).toHaveLength(16);
  await userEvent.click(screen.getByRole("button", { name: "Show fewer" }));
  expect(container.querySelectorAll("tbody tr")).toHaveLength(15);
});
it("one detail at a time", async () => {
  vi.mocked(api.fetchEvalRuns).mockResolvedValue(evalRuns({ configured: true, runs: three }));
  const { container } = render(<EvalHistory />);
  await screen.findByText("3 runs");
  const views = () => screen.getAllByRole("button", { name: /^(View|Hide)$/ });
  await userEvent.click(views()[0]);
  expect(container.querySelectorAll(".prompts-detail-row")).toHaveLength(1);
  expect(api.fetchEvalRun).toHaveBeenCalledWith("run-001");
  await userEvent.click(views()[1]);
  expect(container.querySelectorAll(".prompts-detail-row")).toHaveLength(1);
  expect(within(container.querySelector("tbody") as HTMLElement).getAllByRole("button", { name: "Hide" })).toHaveLength(1);
  expect(api.fetchEvalRun).toHaveBeenLastCalledWith("run-002");
});
