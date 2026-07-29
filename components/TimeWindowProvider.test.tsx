import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TimeWindowProvider, { useTimeWindow } from "./TimeWindowProvider";

// Thin context wrapper around a plain useState -- mirrors NavProvider.test.tsx's
// coverage shape (default value, writer wiring, outside-provider guard) for
// the Next equivalent of Dash's `dcc.Store(id="graph-time-window", data="all")`.

function Consumer() {
  const { timeWindow, setTimeWindow } = useTimeWindow();
  return (
    <div>
      <span data-testid="time-window">{timeWindow}</span>
      <button onClick={() => setTimeWindow("7")}>set-7</button>
      <button onClick={() => setTimeWindow("30")}>set-30</button>
      <button onClick={() => setTimeWindow("90")}>set-90</button>
      <button onClick={() => setTimeWindow("all")}>set-all</button>
      <button onClick={() => setTimeWindow("365")}>set-365</button>
    </div>
  );
}

function renderProvider() {
  return render(
    <TimeWindowProvider>
      <Consumer />
    </TimeWindowProvider>
  );
}

describe("TimeWindowProvider", () => {
  it('defaults to "all" (Dash parity: graph-time-window Store initial data)', () => {
    renderProvider();
    expect(screen.getByTestId("time-window")).toHaveTextContent("all");
  });

  it("setTimeWindow writes the new value, readable by every consumer", async () => {
    renderProvider();

    await userEvent.click(screen.getByText("set-30"));
    expect(screen.getByTestId("time-window")).toHaveTextContent("30");

    await userEvent.click(screen.getByText("set-7"));
    expect(screen.getByTestId("time-window")).toHaveTextContent("7");
  });

  it('accepts the legacy "365" value even though no pill writes it', async () => {
    renderProvider();

    await userEvent.click(screen.getByText("set-365"));
    expect(screen.getByTestId("time-window")).toHaveTextContent("365");
  });

  it("throws when useTimeWindow is called outside a TimeWindowProvider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    function Bare() {
      useTimeWindow();
      return null;
    }
    expect(() => render(<Bare />)).toThrow(/TimeWindowProvider/);
    spy.mockRestore();
  });
});
