import { describe, expect, it } from "vitest";
import { passkeyErrorMessage } from "./passkey-client";
import {
  PASSKEY_CANCELLED_MESSAGE,
  PASSKEY_FAILED_MESSAGE,
  PASSKEY_SETUP_CANCELLED_MESSAGE,
  PASSKEY_SETUP_FAILED_MESSAGE,
} from "./login-messages";

function named(name: string, code?: string) {
  const e = new Error("x") as Error & { code?: string };
  e.name = name;
  if (code) e.code = code;
  return e;
}

describe("passkeyErrorMessage", () => {
  it("reads a cancel as cancelled", () => {
    expect(passkeyErrorMessage(named("NotAllowedError"), "login")).toBe(PASSKEY_CANCELLED_MESSAGE);
    expect(passkeyErrorMessage(named("AbortError"), "enroll")).toBe(PASSKEY_SETUP_CANCELLED_MESSAGE);
    expect(passkeyErrorMessage(named("WebAuthnError", "ERROR_CEREMONY_ABORTED"), "login")).toBe(PASSKEY_CANCELLED_MESSAGE);
  });

  it("reads anything else as a failure", () => {
    expect(passkeyErrorMessage(named("SecurityError"), "login")).toBe(PASSKEY_FAILED_MESSAGE);
    expect(passkeyErrorMessage("boom", "enroll")).toBe(PASSKEY_SETUP_FAILED_MESSAGE);
  });
});
