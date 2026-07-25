import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import NavProvider, { useNav } from "./NavProvider";
import { initialNavState } from "@/lib/nav";

// Thin context wrapper around lib/nav.ts's navReducer + resolveCanvasTapAction
// (both already have full transition-table coverage in lib/nav.test.ts) --
// this file only exercises the React wiring itself: state/dispatch exposure,
// the outside-provider guard (matches ThemeProvider/StarfieldProvider
// convention), and selectFromCanvas's binding to resolveCanvasTapAction.

function Consumer() {
  const { state, dispatch, selectFromCanvas } = useNav();
  return (
    <div>
      <span data-testid="selected">{state.selectedNodeId ?? "none"}</span>
      <span data-testid="filter-key">{state.filterWindowKey ?? "none"}</span>
      <span data-testid="filter-ids">{state.filterHighlightIds.join(",")}</span>
      <button onClick={() => dispatch({ type: "SELECT_NODE", id: "node-a" })}>select-node</button>
      <button onClick={() => dispatch({ type: "SET_WINDOW_FILTER", key: "win-1", nodeIds: ["a", "b"] })}>
        set-filter
      </button>
      <button onClick={() => selectFromCanvas("node", "canvas-node")}>canvas-node</button>
      <button onClick={() => selectFromCanvas("cluster", "canvas-cluster")}>canvas-cluster</button>
      <button onClick={() => selectFromCanvas(null)}>canvas-background</button>
      <button onClick={() => selectFromCanvas("node", undefined)}>canvas-missing-id</button>
    </div>
  );
}

function renderProvider() {
  return render(
    <NavProvider>
      <Consumer />
    </NavProvider>
  );
}

describe("NavProvider", () => {
  it("starts at initialNavState", () => {
    renderProvider();
    expect(screen.getByTestId("selected")).toHaveTextContent("none");
    expect(screen.getByTestId("filter-key")).toHaveTextContent("none");
    expect(screen.getByTestId("filter-ids")).toHaveTextContent("");
    expect(initialNavState.filterHighlightIds).toEqual([]);
  });

  it("dispatch drives the navReducer (SELECT_NODE, then SET_WINDOW_FILTER leaves selection untouched)", async () => {
    renderProvider();

    await userEvent.click(screen.getByText("select-node"));
    expect(screen.getByTestId("selected")).toHaveTextContent("node-a");

    await userEvent.click(screen.getByText("set-filter"));
    expect(screen.getByTestId("selected")).toHaveTextContent("node-a");
    expect(screen.getByTestId("filter-key")).toHaveTextContent("win-1");
    expect(screen.getByTestId("filter-ids")).toHaveTextContent("a,b");
  });

  it("selectFromCanvas('node', id) sets selection, filter untouched", async () => {
    renderProvider();
    await userEvent.click(screen.getByText("set-filter"));

    await userEvent.click(screen.getByText("canvas-node"));

    expect(screen.getByTestId("selected")).toHaveTextContent("canvas-node");
    expect(screen.getByTestId("filter-key")).toHaveTextContent("win-1");
  });

  it("selectFromCanvas('cluster', id) sets selection identically to node", async () => {
    renderProvider();

    await userEvent.click(screen.getByText("canvas-cluster"));

    expect(screen.getByTestId("selected")).toHaveTextContent("canvas-cluster");
  });

  it("selectFromCanvas(null) is a background tap -- clears BOTH selection and filter", async () => {
    renderProvider();
    await userEvent.click(screen.getByText("select-node"));
    await userEvent.click(screen.getByText("set-filter"));
    expect(screen.getByTestId("selected")).toHaveTextContent("node-a");
    expect(screen.getByTestId("filter-key")).toHaveTextContent("win-1");

    await userEvent.click(screen.getByText("canvas-background"));

    expect(screen.getByTestId("selected")).toHaveTextContent("none");
    expect(screen.getByTestId("filter-key")).toHaveTextContent("none");
    expect(screen.getByTestId("filter-ids")).toHaveTextContent("");
  });

  it("selectFromCanvas with a kind but a missing id is a no-op (Dash no_update) -- selection survives", async () => {
    renderProvider();
    await userEvent.click(screen.getByText("select-node"));
    expect(screen.getByTestId("selected")).toHaveTextContent("node-a");

    await userEvent.click(screen.getByText("canvas-missing-id"));

    expect(screen.getByTestId("selected")).toHaveTextContent("node-a");
  });

  it("throws when useNav is called outside a NavProvider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    function Bare() {
      useNav();
      return null;
    }
    expect(() => render(<Bare />)).toThrow(/NavProvider/);
    spy.mockRestore();
  });
});
