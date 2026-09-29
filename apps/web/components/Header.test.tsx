import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import Header from "./Header";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
vi.mock("./HeaderCards", () => ({ default: () => null }));
vi.mock("./SettingsMenu", () => ({ default: () => null }));
vi.mock("./SessionProvider", () => ({
  useSession: () => ({ role: "admin", actingAsDemo: false, account: "x", status: "hydrated" }),
}));

describe("Header dev/graph toggle", () => {
  it("graph mode: Dev link to the first dev view", () => {
    const { container } = render(<Header mode="graph" />);
    const link = container.querySelector("#dev-graph-toggle-btn");
    expect(link).toHaveAttribute("href", "/dev/pipeline");
    expect(screen.getByText("Dev")).toBeInTheDocument();
    expect(container.querySelector("#mode-switch-bar")?.className).toContain("mode-graph");
  });
  it("dev mode: Graph link back to /", () => {
    const { container } = render(<Header mode="dev" />);
    expect(container.querySelector("#dev-graph-toggle-btn")).toHaveAttribute("href", "/");
    expect(screen.getByText("Graph")).toBeInTheDocument();
    expect(container.querySelector("#mode-switch-bar")?.className).toContain("mode-dev");
  });
});
