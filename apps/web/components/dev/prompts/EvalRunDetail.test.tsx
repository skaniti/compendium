import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi, it, expect, beforeEach } from "vitest";
import * as api from "@/lib/prompts-api";
import EvalRunDetail from "./EvalRunDetail";
import { evalDetail, evalRow } from "./test-fixtures";

vi.mock("@/lib/prompts-api");

const run = evalRow();
const runs = [
  run,
  evalRow({ run_id: "run-000", prompt_version: "v1.0", timestamp: "2026-03-01T09:00:00" }),
  evalRow({ run_id: "run-b", prompt_name: "beta_gate", prompt_version: "v1" }),
];

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.fetchEvalRun).mockResolvedValue(evalDetail());
});

async function open(r = runs) {
  const view = render(<EvalRunDetail run={run} runs={r} />);
  await screen.findByText(/git abcdef1/);
  return view;
}

it("meta line", async () => {
  await open();
  expect(screen.getByText("model model-x · set set-a (1.1) · git abcdef1 · cost $1.50 · 20 calls · cache 3/10")).toBeInTheDocument();
});
it("selection block heading", async () => {
  await open();
  expect(screen.getByText("Selection · 4 fixtures · 75.0% accurate · 3 correct · 1 wrong · 0 errors")).toBeInTheDocument();
  expect(screen.getByText("Cost-weighted score 0.81")).toBeInTheDocument();
});
it("confusion matrix diag cells and caption", async () => {
  const { container } = await open();
  const tables = container.querySelectorAll("table.prompts-confusion");
  expect(tables).toHaveLength(2);
  expect(tables[0].querySelectorAll("td.is-diag")).toHaveLength(2);
  expect(within(tables[0] as HTMLElement).getByText("Rows: predicted · columns: expected")).toBeInTheDocument();
});
it("per-class floats", async () => {
  const { container } = await open();
  const first = container.querySelector(".prompts-classes") as HTMLElement;
  expect(within(first).getByText("0.75")).toBeInTheDocument();
  expect(within(first).getByText("0.80")).toBeInTheDocument();
});
it("stress threat table marks low only for 0.4", async () => {
  const { container } = await open();
  const rows = [...container.querySelectorAll(".prompts-threats tbody tr")];
  expect(rows).toHaveLength(2);
  expect(rows[0]).toHaveTextContent("alpha");
  expect(rows[0]).not.toHaveTextContent("low");
  expect(rows[1]).toHaveTextContent("zeta");
  expect(rows[1]).toHaveTextContent("40.0%");
  expect(rows[1]).toHaveTextContent("low");
});
it("fixtures toggle hides correct rows", async () => {
  const { container } = await open();
  expect(container.querySelectorAll(".prompts-fixtures tbody tr")).toHaveLength(3);
  await userEvent.click(screen.getByRole("button", { name: "Wrong and errors" }));
  expect(container.querySelectorAll(".prompts-fixtures tbody tr")).toHaveLength(2);
  expect(screen.queryByText("fx-001")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "All fixtures" }));
  expect(container.querySelectorAll(".prompts-fixtures tbody tr")).toHaveLength(3);
});
it("fixtures_total note", async () => {
  vi.mocked(api.fetchEvalRun).mockResolvedValue(evalDetail({ fixtures_total: 500 }));
  await open();
  expect(screen.getByText("Showing the first 3 of 500 fixtures.")).toBeInTheDocument();
});
it("compare sits before the fixtures table, notes last", async () => {
  vi.mocked(api.fetchEvalRun).mockResolvedValue(evalDetail({ notes: "hello there" }));
  const { container } = await open();
  const compare = container.querySelector(".prompts-compare-block") as Element;
  const fixtures = container.querySelector(".prompts-fixtures") as Element;
  const notes = screen.getByText("Notes: hello there");
  expect(compare.compareDocumentPosition(fixtures) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(fixtures.compareDocumentPosition(notes) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
it("notes line", async () => {
  vi.mocked(api.fetchEvalRun).mockResolvedValue(evalDetail({ notes: "hello there" }));
  await open();
  expect(screen.getByText("Notes: hello there")).toBeInTheDocument();
});
it("compare lists same-family runs, fetches and shows delta", async () => {
  await open();
  const select = screen.getByLabelText("Compare with") as HTMLSelectElement;
  const opts = [...select.options].map((o) => o.value);
  expect(opts).toEqual(["", "run-000"]);
  vi.mocked(api.fetchEvalRun).mockResolvedValueOnce(evalDetail({
    run_id: "run-000",
    metrics: { selection: { ...evalDetail().metrics.selection!, accuracy: 0.65 } },
  }));
  await userEvent.selectOptions(select, "run-000");
  expect(api.fetchEvalRun).toHaveBeenLastCalledWith("run-000");
  const cell = await screen.findByText("Selection accuracy");
  expect(cell.closest("tr")).toHaveTextContent("+10.0 pts");
});
it("compare hidden without family peers", async () => {
  await open([run]);
  expect(screen.queryByLabelText("Compare with")).toBeNull();
});
it("error alert", async () => {
  vi.mocked(api.fetchEvalRun).mockRejectedValue(new Error("nope"));
  render(<EvalRunDetail run={run} runs={runs} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load run (nope).");
});
it("loading", () => {
  vi.mocked(api.fetchEvalRun).mockReturnValue(new Promise(() => {}));
  render(<EvalRunDetail run={run} runs={runs} />);
  expect(screen.getByText("Loading…")).toBeInTheDocument();
});
