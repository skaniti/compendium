import { describe, it, expect, vi } from "vitest";

const { notFound } = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));
vi.mock("next/navigation", () => ({ notFound }));
vi.mock("@/lib/preferences.server", () => ({ getInitialSessionRole: vi.fn(async () => ({ role: "demo", actingAsDemo: false })) }));
vi.mock("@/components/AppShell", () => ({ default: ({ children }: { children: React.ReactNode }) => <div data-testid="shell">{children}</div> }));
vi.mock("@/lib/dev-views", async (orig) => {
  const m = await orig<typeof import("@/lib/dev-views")>();
  const logs = { id: "logs", label: "Logs", href: "/dev/logs", access: "admin", Icon: () => null, View: () => <p>logs</p> };
  return { ...m, DEV_VIEWS: [...m.DEV_VIEWS, logs],
    findDevView: (id: string) => [...m.DEV_VIEWS, logs].find((v) => v.id === id) };
});

import DevViewPage from "./page";

describe("/dev/[view]", () => {
  it("unknown view -> notFound", async () => {
    await expect(DevViewPage({ params: Promise.resolve({ view: "nope" }) })).rejects.toThrow("NEXT_NOT_FOUND");
  });
  it("admin-only view as plain demo -> notFound", async () => {
    await expect(DevViewPage({ params: Promise.resolve({ view: "logs" }) })).rejects.toThrow("NEXT_NOT_FOUND");
  });
  it("pipeline renders inside the shell", async () => {
    const el = await DevViewPage({ params: Promise.resolve({ view: "pipeline" }) });
    expect(el).toBeTruthy();
  });
});
