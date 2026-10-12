import { describe, expect, it } from "vitest";
import { isPreAuthPath } from "./pre-auth-paths";

describe("isPreAuthPath", () => {
  it.each(["/login", "/passkey/enroll"])("is true for %s", (p) => {
    expect(isPreAuthPath(p)).toBe(true);
  });
  it.each(["/", "/passkey", "/passkey/enroll/x", "/login/x", "/graph"])("is false for %s", (p) => {
    expect(isPreAuthPath(p)).toBe(false);
  });
});
