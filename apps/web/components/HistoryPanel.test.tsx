import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import HistoryPanel from "./HistoryPanel";

// DiaryPanel (task 6) calls useNav(), which throws outside a NavProvider --
// these band/granularity-toggle tests predate the diary and don't want to
// stand up a NavProvider + mock fetchDiaryWindows just to render HistoryPanel.
// Mock the child directly (same tradeoff HistoryPanel.tsx's own now-removed
// TODO(mig-02) comment anticipated) and assert only that it receives the
// right `granularity` prop -- DiaryPanel's own behavior is covered by
// DiaryPanel.test.tsx.
vi.mock("./DiaryPanel", () => ({
  default: ({ granularity }: { granularity: string }) => (
    <div data-testid="diary-panel-mock" data-granularity={granularity} />
  ),
}));

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

  it("renders DiaryPanel inside #diary-container, passed the current granularity", async () => {
    const { container } = render(<HistoryPanel />);

    const diaryContainer = container.querySelector("#diary-container");
    expect(diaryContainer).toBeInTheDocument();
    const mock = diaryContainer?.querySelector('[data-testid="diary-panel-mock"]');
    expect(mock).toHaveAttribute("data-granularity", "day");

    await userEvent.click(screen.getByText("Month"));

    expect(diaryContainer?.querySelector('[data-testid="diary-panel-mock"]')).toHaveAttribute(
      "data-granularity",
      "month"
    );
  });
});
