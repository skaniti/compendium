import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import EnrollClient from "./EnrollClient";

vi.mock("@/lib/passkey-client", () => ({
  runPasskeyRegistration: vi.fn(),
  runPasskeyAuthentication: vi.fn(),
  passkeyErrorMessage: vi.fn(() => "Passkey setup was cancelled."),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("EnrollClient", () => {
  it("shows the unusable message without a token", async () => {
    window.history.replaceState(null, "", "/passkey/enroll");
    render(<EnrollClient ready />);
    expect(await screen.findByTestId("enroll-error")).toHaveTextContent("This enrollment link can't be used.");
    expect(screen.queryByTestId("enroll-create")).not.toBeInTheDocument();
  });

  it("shows the unusable message when not ready (wrong host, no tailnet, passkeys off)", async () => {
    window.history.replaceState(null, "", "/passkey/enroll#tok");
    render(<EnrollClient ready={false} />);
    expect(await screen.findByTestId("enroll-error")).toHaveTextContent("This enrollment link can't be used.");
  });

  it("takes the token from the fragment, removes it, and enrolls", async () => {
    window.history.replaceState(null, "", "/passkey/enroll#tok");
    const { runPasskeyRegistration } = await import("@/lib/passkey-client");
    vi.mocked(runPasskeyRegistration).mockResolvedValueOnce({ id: "x" } as never);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ options: { challenge: "c" } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ user: {} }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<EnrollClient ready />);
    await waitFor(() => expect(window.location.hash).toBe(""));
    fireEvent.click(await screen.findByTestId("enroll-create"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[0][0]).toBe("/api/auth/passkey/enroll/options");
    expect(fetchMock.mock.calls[1][0]).toBe("/api/auth/passkey/enroll/verify");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ token: "tok" });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ token: "tok", response: { id: "x" }, trustBrowser: true });
  });

  it("shows the cancel message when the passkey prompt is dismissed", async () => {
    window.history.replaceState(null, "", "/passkey/enroll#tok");
    const { runPasskeyRegistration } = await import("@/lib/passkey-client");
    vi.mocked(runPasskeyRegistration).mockRejectedValueOnce(Object.assign(new Error("x"), { name: "NotAllowedError" }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ options: {} }), { status: 200 })));
    render(<EnrollClient ready />);
    fireEvent.click(await screen.findByTestId("enroll-create"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Passkey setup was cancelled.");
  });

  it("keeps the token under Strict Mode's double effect run", async () => {
    window.history.replaceState(null, "", "/passkey/enroll#tok");
    const { runPasskeyRegistration } = await import("@/lib/passkey-client");
    vi.mocked(runPasskeyRegistration).mockResolvedValueOnce({ id: "x" } as never);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ options: { challenge: "c" } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ user: {} }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<StrictMode><EnrollClient ready /></StrictMode>);
    fireEvent.click(await screen.findByTestId("enroll-create"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ token: "tok" });
  });

  it("shows the setup-failed message when the request rejects", async () => {
    window.history.replaceState(null, "", "/passkey/enroll#tok");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new TypeError("network")));
    render(<EnrollClient ready />);
    fireEvent.click(await screen.findByTestId("enroll-create"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Passkey setup didn't work.");
  });
});
