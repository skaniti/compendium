import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { patchPreferences } from "@/lib/preferences";
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

vi.mock("@/lib/preferences", () => ({ patchPreferences: vi.fn() }));

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

  describe("persistence", () => {
    beforeEach(() => vi.mocked(patchPreferences).mockClear());

    function renderWith(props: { initialWindow?: "7" | "30" | "90" | "all"; canPersist?: boolean }) {
      return render(
        <TimeWindowProvider {...props}>
          <Consumer />
        </TimeWindowProvider>
      );
    }

    it("takes its initial value from initialWindow", () => {
      renderWith({ initialWindow: "90" });
      expect(screen.getByTestId("time-window")).toHaveTextContent("90");
    });

    it("patches time_window when canPersist and the value changes", async () => {
      renderWith({ canPersist: true });
      await userEvent.click(screen.getByText("set-30"));
      expect(patchPreferences).toHaveBeenCalledWith({ time_window: "30" });
      expect(patchPreferences).toHaveBeenCalledTimes(1);
    });

    it("does not patch when canPersist is false", async () => {
      renderWith({});
      await userEvent.click(screen.getByText("set-30"));
      expect(screen.getByTestId("time-window")).toHaveTextContent("30");
      expect(patchPreferences).not.toHaveBeenCalled();
    });

    it("does not patch when setting the same value", async () => {
      renderWith({ canPersist: true, initialWindow: "30" });
      await userEvent.click(screen.getByText("set-30"));
      expect(patchPreferences).not.toHaveBeenCalled();
    });
  });
});
