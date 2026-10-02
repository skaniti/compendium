import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import DevTabs from "./DevTabs";

const session = vi.hoisted(() => ({ value: { role: "admin", actingAsDemo: false, status: "hydrated" } as Record<string, unknown> }));
vi.mock("next/navigation", () => ({ usePathname: () => "/dev/pipeline" }));
vi.mock("@/components/SessionProvider", () => ({ useSession: () => session.value }));

describe("DevTabs", () => {
  it("renders one link per live view and marks the active one", () => {
    render(<DevTabs />);
    const link = screen.getByRole("link", { name: /pipeline/i });
    expect(link).toHaveAttribute("href", "/dev/pipeline");
    expect(link.className).toContain("active");
  });
  it("admin: 3 links + 5 planned silhouettes without href", () => {
    session.value = { role: "admin", actingAsDemo: false, status: "hydrated" };
    const { container } = render(<DevTabs />);
    expect(screen.getAllByRole("link")).toHaveLength(3);
    const planned = container.querySelectorAll("span.dev-tab-planned[aria-disabled='true']");
    expect(planned).toHaveLength(5);
    planned.forEach((el) => expect(el).not.toHaveAttribute("href"));
  });
  it("plain demo: 3 links + 2 planned silhouettes", () => {
    session.value = { role: "demo", actingAsDemo: false, status: "hydrated" };
    const { container } = render(<DevTabs />);
    expect(screen.getAllByRole("link")).toHaveLength(3);
    const labels = [...container.querySelectorAll(".dev-tab-planned .hbar-nav-caption")].map((e) => e.textContent);
    expect(labels).toEqual(["Data", "Prompts"]);
  });
});
