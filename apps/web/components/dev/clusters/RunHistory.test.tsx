import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { it, expect } from "vitest";
import RunHistory from "./RunHistory";
import { runOf, summary } from "./test-fixtures";

const bodyRows = (c: HTMLElement) => Array.from(c.querySelectorAll("tbody tr"));

it("meta, 10-row preview and the toggle", async () => {
  const { container } = render(<RunHistory runs={summary().runs} currentId={40} />);
  expect(screen.getByText("14 runs · 1 failed")).toBeInTheDocument();
  expect(bodyRows(container)).toHaveLength(10);
  await userEvent.click(screen.getByRole("button", { name: "Show all 14 runs" }));
  expect(bodyRows(container)).toHaveLength(14);
  await userEvent.click(screen.getByRole("button", { name: "Show fewer" }));
  expect(bodyRows(container)).toHaveLength(10);
});
it("status pills, cost, duration and dashes", () => {
  const { container } = render(<RunHistory runs={summary().runs} currentId={40} />);
  const rows = bodyRows(container);
  const pill = (i: number) => rows[i].querySelector(".clusters-run-status")?.textContent;
  expect([pill(0), pill(1), pill(2), pill(3)]).toEqual(["current", "failed", "kept", "archived"]);
  const cells = (i: number) => Array.from(rows[i].querySelectorAll("td")).map((td) => td.textContent);
  expect(cells(0)[4]).toBe("$0.0004");
  expect(cells(0)[5]).toBe("7.5s");
  expect([cells(1)[2], cells(1)[3], cells(1)[4], cells(1)[5]]).toEqual(["—", "—", "—", "—"]);
});
it("renders two labelled charts and the latest cluster count", () => {
  const { container } = render(<RunHistory runs={summary().runs} currentId={40} />);
  expect(container.querySelectorAll("svg")).toHaveLength(2);
  expect(container.querySelector('svg[aria-label="Clusters per run"]')).toBeTruthy();
  expect(container.querySelector('svg[aria-label="Noise pages per run"]')).toBeTruthy();
  const latest = summary().runs.items.find((r) => r.status === "completed")!;
  expect(container.querySelector(".clusters-runs-figure")?.textContent).toBe(String(latest.cluster_count));
});
it("says when the list is capped", () => {
  const items = Array.from({ length: 200 }, (_, i) => runOf(300 - i, "completed"));
  render(<RunHistory runs={{ total: 250, items }} currentId={300} />);
  expect(screen.getByText(/showing the latest 200/)).toBeInTheDocument();
});
it("only failed runs", () => {
  const { container } = render(<RunHistory runs={{ total: 2, items: [runOf(2, "failed"), runOf(1, "failed")] }} currentId={null} />);
  expect(screen.getByText("No finished runs yet.")).toBeInTheDocument();
  expect(container.querySelector("svg")).toBeNull();
});
