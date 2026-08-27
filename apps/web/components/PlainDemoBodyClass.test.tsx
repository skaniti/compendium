import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import PlainDemoBodyClass from "./PlainDemoBodyClass";
import * as SessionProviderModule from "@/components/SessionProvider";
import type { SessionRole } from "@/components/SessionProvider";

// Ports app.py's plain-demo-class-dummy clientside callback:
//   isPlainDemo = ctx.role === 'demo' && ctx.admin_launched_demo !== true
//   document.body.classList.toggle('plain-demo', isPlainDemo)
// Mocks the hook directly (SearchBar.test.tsx's convention) rather than
// standing up a real SessionProvider -- this test only cares about the
// role/actingAsDemo -> body class mapping, not session hydration itself.
function mockSession(overrides: { role?: SessionRole | null; actingAsDemo?: boolean } = {}) {
  vi.spyOn(SessionProviderModule, "useSession").mockReturnValue({
    role: overrides.role ?? null,
    account: "test@example.com",
    actingAsDemo: overrides.actingAsDemo ?? false,
    adminOriginEmail: undefined,
    showNoise: false,
    status: "hydrated",
    refresh: vi.fn(),
  });
}

describe("PlainDemoBodyClass", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    document.body.className = "";
  });

  afterEach(() => {
    cleanup();
    document.body.className = "";
  });

  it("adds .plain-demo for a direct demo login (role demo, not acting)", () => {
    mockSession({ role: "demo", actingAsDemo: false });
    render(<PlainDemoBodyClass />);

    expect(document.body.classList.contains("plain-demo")).toBe(true);
  });

  it("does NOT add .plain-demo for an admin-launched acting-as-demo session", () => {
    mockSession({ role: "demo", actingAsDemo: true });
    render(<PlainDemoBodyClass />);

    expect(document.body.classList.contains("plain-demo")).toBe(false);
  });

  it("does NOT add .plain-demo for an admin session", () => {
    mockSession({ role: "admin", actingAsDemo: false });
    render(<PlainDemoBodyClass />);

    expect(document.body.classList.contains("plain-demo")).toBe(false);
  });

  it("does NOT add .plain-demo for a plain user session", () => {
    mockSession({ role: "user", actingAsDemo: false });
    render(<PlainDemoBodyClass />);

    expect(document.body.classList.contains("plain-demo")).toBe(false);
  });

  it("does NOT add .plain-demo while the role is unresolved (null)", () => {
    mockSession({ role: null });
    render(<PlainDemoBodyClass />);

    expect(document.body.classList.contains("plain-demo")).toBe(false);
  });

  it("leaves other body classes alone", () => {
    document.body.classList.add("some-other-class");
    mockSession({ role: "demo", actingAsDemo: false });
    render(<PlainDemoBodyClass />);

    expect(document.body.classList.contains("plain-demo")).toBe(true);
    expect(document.body.classList.contains("some-other-class")).toBe(true);
  });

  it("removes .plain-demo on unmount", () => {
    mockSession({ role: "demo", actingAsDemo: false });
    const { unmount } = render(<PlainDemoBodyClass />);
    expect(document.body.classList.contains("plain-demo")).toBe(true);

    unmount();
    expect(document.body.classList.contains("plain-demo")).toBe(false);
  });

  it("removes .plain-demo when the session transitions away from direct demo (e.g. hydration resolves to admin)", () => {
    mockSession({ role: "demo", actingAsDemo: false });
    const { rerender } = render(<PlainDemoBodyClass />);
    expect(document.body.classList.contains("plain-demo")).toBe(true);

    mockSession({ role: "admin", actingAsDemo: false });
    rerender(<PlainDemoBodyClass />);
    expect(document.body.classList.contains("plain-demo")).toBe(false);
  });
});
