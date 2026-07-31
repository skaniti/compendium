import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import SandboxOverlayChip from "./SandboxOverlayChip";

// Presentational-only (Task S1): pending states (null nodeCount/elapsedMs,
// the "fetch in flight" case both sandbox pages start in) and the settled
// state once a fetch resolves.

describe("SandboxOverlayChip", () => {
  it("renders placeholders while nodeCount/elapsedMs are still null", () => {
    render(<SandboxOverlayChip variant="A1: port-intact" nodeCount={null} elapsedMs={null} />);
    expect(screen.getByText("A1: port-intact")).toBeInTheDocument();
    expect(screen.getByText("nodes: …")).toBeInTheDocument();
    expect(screen.getByText("time-to-first-dots: …")).toBeInTheDocument();
  });

  it("renders the node count and elapsed ms once resolved", () => {
    render(<SandboxOverlayChip variant="A2: react-owned" nodeCount={42} elapsedMs={123.456} />);
    expect(screen.getByText("A2: react-owned")).toBeInTheDocument();
    expect(screen.getByText("nodes: 42")).toBeInTheDocument();
    expect(screen.getByText("time-to-first-dots: 123.5ms")).toBeInTheDocument();
  });
});
