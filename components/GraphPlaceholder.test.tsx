import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import GraphPlaceholder from "./GraphPlaceholder";

describe("GraphPlaceholder", () => {
  it("renders the d3-graph-container hosting the compendium-empty-state", () => {
    const { container } = render(<GraphPlaceholder />);

    const graphContainer = container.querySelector("#d3-graph-container");
    expect(graphContainer).toBeInTheDocument();

    const emptyState = graphContainer?.querySelector("#compendium-empty-state");
    expect(emptyState).toBeInTheDocument();
  });

  it("renders the ported empty-state copy and CTA", () => {
    render(<GraphPlaceholder />);

    expect(screen.getByText(/install the extension and start browsing/i)).toBeInTheDocument();
    expect(screen.getByText(/always your call/i)).toBeInTheDocument();

    const cta = screen.getByRole("link", { name: /get the extension/i });
    expect(cta).toBeInTheDocument();
    expect(cta).toHaveAttribute("href", "#");
  });
});
