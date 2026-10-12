import { afterEach, describe, expect, it, vi } from "vitest";
import { onPasskeyHost, passkeyRpId, passkeysEnabled, requestHostName } from "./passkey-config";

const ON = { AUTH_REQUIRED: "1", TAILNET_LOGIN: "1", TAILNET_ASSERT_SECRET: "s".repeat(40), WEBAUTHN_RP_ID: "Owner.Example.com" };

function stub(env: Record<string, string>) {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
}

afterEach(() => vi.unstubAllEnvs());

describe("passkey config", () => {
  it("is off without a relying party or without the tailnet login", () => {
    stub({ ...ON, WEBAUTHN_RP_ID: "" });
    expect(passkeysEnabled()).toBe(false);
    stub({ ...ON, TAILNET_LOGIN: "0" });
    expect(passkeysEnabled()).toBe(false);
  });

  it("is on with both, and lower-cases the relying party", () => {
    stub(ON);
    expect(passkeysEnabled()).toBe(true);
    expect(passkeyRpId()).toBe("owner.example.com");
  });

  it.each([
    ["owner.example.com", "owner.example.com"],
    ["Owner.Example.com:443", "owner.example.com"],
    ["localhost:3012", "localhost"],
    ["[::1]:3000", "[::1]"],
  ])("host %s reads as %s", (host, name) => {
    expect(requestHostName(new Headers({ host }))).toBe(name);
  });

  it("falls back to the URL host", () => {
    expect(requestHostName(new Headers(), "https://owner.example.com/x")).toBe("owner.example.com");
  });

  it("matches only the relying-party host", () => {
    stub(ON);
    expect(onPasskeyHost(new Headers({ host: "owner.example.com" }))).toBe(true);
    expect(onPasskeyHost(new Headers({ host: "fallback.ts.example" }))).toBe(false);
  });
});
