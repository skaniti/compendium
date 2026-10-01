import { describe, it, expect, vi } from "vitest";
import type { ReactElement } from "react";

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
  const logs = { id: "logs", label: "Logs", href: "/dev/logs", access: "admin", status: "live", Icon: () => null };
  return { ...m, findDevView: (id: string) => [logs, ...m.DEV_VIEWS].find((v) => v.id === id) };
});
vi.mock("./views", async (orig) => {
  const m = await orig<typeof import("./views")>();
  return { DEV_VIEW_COMPONENTS: { ...m.DEV_VIEW_COMPONENTS, logs: () => <p>logs</p> } };
});

import AppShell from "@/components/AppShell";
import { getInitialSessionRole } from "@/lib/preferences.server";
import { DEV_VIEW_COMPONENTS } from "./views";
import DevViewPage from "./page";

const params = (view: string) => ({ params: Promise.resolve({ view }) });
const as = (role: "admin" | "demo" | "user" | null, actingAsDemo = false) =>
  vi.mocked(getInitialSessionRole).mockResolvedValueOnce({ role, actingAsDemo });

describe("/dev/[view]", () => {
  it("unknown view -> notFound", async () => {
    await expect(DevViewPage(params("nope"))).rejects.toThrow("NEXT_NOT_FOUND");
  });
  it.each([
    ["plain demo", "demo", false],
    ["user", "user", false],
    ["null role", null, false],
  ] as const)("admin-only view as %s -> notFound", async (_n, role, acting) => {
    as(role, acting);
    await expect(DevViewPage(params("logs"))).rejects.toThrow("NEXT_NOT_FOUND");
  });
  it("planned view -> notFound even for admin", async () => {
    as("admin", false);
    await expect(DevViewPage(params("data"))).rejects.toThrow("NEXT_NOT_FOUND");
  });
  it("pipeline renders inside the dev shell for plain demo", async () => {
    const el = (await DevViewPage(params("pipeline"))) as ReactElement<{ mode: string; children: ReactElement }>;
    expect(el.type).toBe(AppShell);
    expect(el.props.mode).toBe("dev");
    expect(el.props.children.type).toBe(DEV_VIEW_COMPONENTS.pipeline);
  });
  it.each([
    ["admin", "admin", false],
    ["acting-as-demo", "demo", true],
  ] as const)("admin-only view served for %s", async (_n, role, acting) => {
    as(role, acting);
    const el = (await DevViewPage(params("logs"))) as ReactElement<{ mode: string; children: ReactElement }>;
    expect(el.props.mode).toBe("dev");
    expect(el.props.children.type).toBe(DEV_VIEW_COMPONENTS.logs);
  });
});
