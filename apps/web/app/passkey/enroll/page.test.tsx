import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers()) }));
vi.mock("./EnrollClient", () => ({ default: () => null }));

import { headers } from "next/headers";
import EnrollPage from "./page";

async function readyFor(host: string, login: string | null): Promise<boolean> {
  const h: Record<string, string> = { host };
  if (login) h["tailscale-user-login"] = login;
  vi.mocked(headers).mockResolvedValue(new Headers(h) as never);
  const el = (await EnrollPage()) as { props: { ready: boolean } };
  return el.props.ready;
}

describe("EnrollPage ready", () => {
  afterEach(() => vi.unstubAllEnvs());

  function on() {
    vi.stubEnv("AUTH_REQUIRED", "1");
    vi.stubEnv("TAILNET_LOGIN", "1");
    vi.stubEnv("TAILNET_ASSERT_SECRET", "s".repeat(40));
    vi.stubEnv("WEBAUTHN_RP_ID", "owner.example.com");
  }

  it("is true with passkeys on, the RP host and a tailnet login", async () => {
    on();
    expect(await readyFor("owner.example.com", "me@tailnet")).toBe(true);
  });
  it("is false with passkeys off", async () => {
    on();
    vi.stubEnv("WEBAUTHN_RP_ID", "");
    expect(await readyFor("owner.example.com", "me@tailnet")).toBe(false);
  });
  it("is false on another host", async () => {
    on();
    expect(await readyFor("fallback.ts.example", "me@tailnet")).toBe(false);
  });
  it("is false without a tailnet login", async () => {
    on();
    expect(await readyFor("owner.example.com", null)).toBe(false);
  });
});
