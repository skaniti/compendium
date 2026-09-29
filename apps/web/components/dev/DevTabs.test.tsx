import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import DevTabs from "./DevTabs";

vi.mock("next/navigation", () => ({ usePathname: () => "/dev/pipeline" }));
vi.mock("@/components/SessionProvider", () => ({ useSession: () => ({ role: "admin", actingAsDemo: false, status: "hydrated" }) }));

describe("DevTabs", () => {
  it("renders one link per visible view and marks the active one", () => {
    render(<DevTabs />);
    const link = screen.getByRole("link", { name: /pipeline/i });
    expect(link).toHaveAttribute("href", "/dev/pipeline");
    expect(link.className).toContain("active");
  });
});
