import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useHoverTooltip } from "./HoverTooltip";

function Target({ lines }: { lines: string[] }) {
  const { tooltip, show, hide } = useHoverTooltip();
  return (
    <div className="hbar-card" style={{ overflow: "hidden" }}>
      <button type="button" onMouseEnter={(e) => show(e, lines)} onMouseMove={(e) => show(e, lines)} onMouseLeave={hide}>
        x
      </button>
      {tooltip}
    </div>
  );
}

describe("useHoverTooltip", () => {
  it("shows the chart-kit tooltip on hover, portalled to <body> and fixed to the viewport, and hides it on leave", () => {
    const { container } = render(<Target lines={["Recluster is disabled in demo view"]} />);
    expect(screen.queryByRole("tooltip")).toBeNull();

    fireEvent.mouseEnter(screen.getByRole("button"), { clientX: 40, clientY: 30 });
    const tip = screen.getByRole("tooltip");
    expect(tip).toHaveTextContent("Recluster is disabled in demo view");
    expect(tip).toHaveClass("chart-tooltip", "chart-tooltip-fixed");
    // Outside the hovered element's (clipping) container.
    expect(container.contains(tip)).toBe(false);
    expect(tip.style.left).toBe("52px");
    expect(tip.style.top).toBe("42px");

    fireEvent.mouseLeave(screen.getByRole("button"));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("clamps to the viewport: near the right edge it flips to the pointer's left", () => {
    render(<Target lines={["wide"]} />);
    const tip = () => screen.getByRole("tooltip");
    fireEvent.mouseEnter(screen.getByRole("button"), { clientX: window.innerWidth - 5, clientY: 30 });
    // jsdom has no layout (offsetWidth 0), so the flip lands on the pointer minus the offset.
    expect(tip().style.left).toBe(`${window.innerWidth - 5 - 12}px`);
  });

  it("an empty line list shows nothing", () => {
    render(<Target lines={[]} />);
    fireEvent.mouseEnter(screen.getByRole("button"), { clientX: 40, clientY: 30 });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});
