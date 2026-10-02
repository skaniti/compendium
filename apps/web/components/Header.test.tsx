import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import * as api from "@/lib/api";
import Header from "./Header";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
vi.mock("./HeaderCards", () => ({ default: () => null }));
vi.mock("./SettingsMenu", () => ({ default: () => null }));
const sessionState = vi.hoisted(() => ({
  value: { role: "admin", actingAsDemo: false, account: "x", status: "hydrated" } as {
    role: string;
    actingAsDemo: boolean;
    account: string;
    status: string;
  },
}));
vi.mock("./SessionProvider", () => ({ useSession: () => sessionState.value }));

describe("Header dev/graph toggle", () => {
  it("graph mode: Dev link to the first dev view", () => {
    const { container } = render(<Header mode="graph" />);
    const link = container.querySelector("#dev-graph-toggle-btn");
    expect(link).toHaveAttribute("href", "/dev/overview");
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

describe("Header view-as-demo / return-to-admin controls", () => {
  const originalFlag = process.env.NEXT_PUBLIC_DEMO_ROLE_TOOLING;
  const originalLocation = window.location;
  let assignMock: ReturnType<typeof vi.fn>;

  function setSession(role: string, actingAsDemo: boolean): void {
    sessionState.value = { role, actingAsDemo, account: "x", status: "hydrated" };
  }

  beforeEach(() => {
    process.env.NEXT_PUBLIC_DEMO_ROLE_TOOLING = "1";
    setSession("admin", false);
    assignMock = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { pathname: "/dev/overview", search: "?a=1", hash: "#h", assign: assignMock },
    });
  });

  afterEach(() => {
    if (originalFlag === undefined) delete process.env.NEXT_PUBLIC_DEMO_ROLE_TOOLING;
    else process.env.NEXT_PUBLIC_DEMO_ROLE_TOOLING = originalFlag;
    Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
    vi.restoreAllMocks();
    setSession("admin", false);
  });

  it("admin with flag on: sees View as demo, not Return to admin", () => {
    render(<Header />);
    expect(screen.getByText("View as demo")).toBeInTheDocument();
    expect(screen.queryByText("Return to admin")).not.toBeInTheDocument();
  });

  it('flag "true" is accepted like "1"', () => {
    process.env.NEXT_PUBLIC_DEMO_ROLE_TOOLING = "true";
    render(<Header />);
    expect(screen.getByText("View as demo")).toBeInTheDocument();
  });

  it("acting as demo: sees Return to admin, not View as demo", () => {
    setSession("demo", true);
    render(<Header />);
    expect(screen.getByText("Return to admin")).toBeInTheDocument();
    expect(screen.queryByText("View as demo")).not.toBeInTheDocument();
  });

  it("plain demo and plain user: neither control", () => {
    for (const role of ["demo", "user"]) {
      setSession(role, false);
      const { unmount } = render(<Header />);
      expect(screen.queryByText("View as demo")).not.toBeInTheDocument();
      expect(screen.queryByText("Return to admin")).not.toBeInTheDocument();
      unmount();
    }
  });

  it("flag off: neither control, even for admin and acting-as-demo", () => {
    delete process.env.NEXT_PUBLIC_DEMO_ROLE_TOOLING;
    const { unmount } = render(<Header />);
    expect(screen.queryByText("View as demo")).not.toBeInTheDocument();
    unmount();
    setSession("demo", true);
    render(<Header />);
    expect(screen.queryByText("Return to admin")).not.toBeInTheDocument();
  });

  it("View as demo posts to /api/auth/view-as and reloads the current path", async () => {
    const spy = vi.spyOn(api, "apiFetch").mockResolvedValue(new Response(null, { status: 200 }));
    const { container } = render(<Header />);
    expect(container.querySelector("#view-as-demo-form")).not.toBeNull();
    fireEvent.click(screen.getByText("View as demo"));
    await waitFor(() => expect(assignMock).toHaveBeenCalledWith("/dev/overview?a=1#h"));
    expect(spy).toHaveBeenCalledWith("/api/auth/view-as", { method: "POST" });
  });

  it("Return to admin posts to /api/auth/return and reloads the current path", async () => {
    setSession("demo", true);
    const spy = vi.spyOn(api, "apiFetch").mockResolvedValue(new Response(null, { status: 200 }));
    const { container } = render(<Header />);
    expect(container.querySelector("#return-to-admin-form")).not.toBeNull();
    fireEvent.click(screen.getByText("Return to admin"));
    await waitFor(() => expect(assignMock).toHaveBeenCalledWith("/dev/overview?a=1#h"));
    expect(spy).toHaveBeenCalledWith("/api/auth/return", { method: "POST" });
  });

  it("non-ok response: logs and does not reload", async () => {
    vi.spyOn(api, "apiFetch").mockResolvedValue(new Response(null, { status: 403 }));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<Header />);
    fireEvent.click(screen.getByText("View as demo"));
    await waitFor(() => expect(errSpy).toHaveBeenCalledWith("view-as failed:", 403));
    expect(assignMock).not.toHaveBeenCalled();
  });
});
