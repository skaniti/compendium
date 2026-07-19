import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import HistoryPanel from "./HistoryPanel";

describe("HistoryPanel", () => {
  it("renders the panel-header-band with the History label", () => {
    const { container } = render(<HistoryPanel />);

    const band = container.querySelector(".panel-header-band");
    expect(band).toBeInTheDocument();
    expect(band?.querySelector(".panel-header")).toHaveTextContent("History");
  });

  it("renders a granularity-selector with Day/Week/Month buttons, in order", () => {
    const { container } = render(<HistoryPanel />);

    const selector = container.querySelector(".granularity-selector");
    expect(selector).toBeInTheDocument();

    const buttons = Array.from(selector?.querySelectorAll(".granularity-btn") ?? []);
    expect(buttons).toHaveLength(3);
    expect(buttons.map((b) => b.querySelector(".gran-full")?.textContent)).toEqual([
      "Day",
      "Week",
      "Month",
    ]);
    expect(buttons.map((b) => b.querySelector(".gran-short")?.textContent)).toEqual([
      "D",
      "W",
      "M",
    ]);
  });

  it("defaults to day active, matching the granularity store's default", () => {
    render(<HistoryPanel />);

    expect(screen.getByText("Day").closest("button")).toHaveClass("active");
    expect(screen.getByText("Week").closest("button")).not.toHaveClass("active");
    expect(screen.getByText("Month").closest("button")).not.toHaveClass("active");
  });

  it("clicking a granularity button moves the active class to it", async () => {
    render(<HistoryPanel />);

    await userEvent.click(screen.getByText("Week"));

    expect(screen.getByText("Week").closest("button")).toHaveClass("active");
    expect(screen.getByText("Day").closest("button")).not.toHaveClass("active");
    expect(screen.getByText("Month").closest("button")).not.toHaveClass("active");

    await userEvent.click(screen.getByText("Month"));

    expect(screen.getByText("Month").closest("button")).toHaveClass("active");
    expect(screen.getByText("Week").closest("button")).not.toHaveClass("active");
  });
});
