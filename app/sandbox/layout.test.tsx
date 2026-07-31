import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";

// notFound() throws a Next-internal control-flow error under real
// next/navigation -- mocked here (rather than asserting on a thrown
// error) so the test pins the one thing this layout actually decides:
// whether notFound() gets called, gated on NODE_ENV. See that file's own
// comment for why the gate lives here (one check covers the whole
// app/sandbox/** tree).
const notFound = vi.fn();
vi.mock("next/navigation", () => ({ notFound: () => notFound() }));

afterEach(() => {
  vi.unstubAllEnvs();
  notFound.mockClear();
});

describe("SandboxLayout", () => {
  it("renders children when NODE_ENV is not production", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { default: SandboxLayout } = await import("./layout");
    render(<SandboxLayout>{<p>sandbox content</p>}</SandboxLayout>);
    expect(screen.getByText("sandbox content")).toBeInTheDocument();
    expect(notFound).not.toHaveBeenCalled();
  });

  it("calls notFound() when NODE_ENV is production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { default: SandboxLayout } = await import("./layout");
    render(<SandboxLayout>{<p>sandbox content</p>}</SandboxLayout>);
    expect(notFound).toHaveBeenCalledTimes(1);
  });
});
