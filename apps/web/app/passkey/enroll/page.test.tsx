import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers()),
  cookies: vi.fn(async () => ({ get: () => undefined })),
}));
vi.mock("./EnrollClient", () => ({ default: () => null }));

import { cookies, headers } from "next/headers";
import { TRUSTED_BROWSER_COOKIE } from "@/lib/tailnet-login";
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

  it("passes trusted=true only with a tailnet login and a non-empty trusted-browser cookie", async () => {
    on();
    const trustedOf = async (login: string | null, cookieValue: string | undefined) => {
      const h: Record<string, string> = { host: "owner.example.com" };
      if (login) h["tailscale-user-login"] = login;
      vi.mocked(headers).mockResolvedValue(new Headers(h) as never);
      vi.mocked(cookies).mockResolvedValue({
        get: (name: string) => (name === TRUSTED_BROWSER_COOKIE && cookieValue ? { name, value: cookieValue } : undefined),
      } as never);
      const el = (await EnrollPage()) as { props: { trusted: boolean } };
      return el.props.trusted;
    };
    expect(await trustedOf("me@tailnet", "abc")).toBe(true);
    expect(await trustedOf("me@tailnet", undefined)).toBe(false);
    expect(await trustedOf("me@tailnet", "")).toBe(false);
    expect(await trustedOf(null, "abc")).toBe(false);
  });
});
