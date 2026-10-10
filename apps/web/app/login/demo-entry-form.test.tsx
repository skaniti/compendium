import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

let capturedScriptOnError: (() => void) | undefined;
vi.mock("next/script", () => ({
  default: (props: { onError?: () => void }) => {
    capturedScriptOnError = props.onError;
    return null;
  },
}));

import DemoEntryForm from "./DemoEntryForm";
import { BACKEND_UNREACHABLE_MESSAGE, WIDGET_FAILED_MESSAGE } from "@/lib/login-messages";

type TurnstileCallback = (token: string) => void;

describe("DemoEntryForm", () => {
  let callback: TurnstileCallback | null;
  let renderOptions: { appearance?: string; "error-callback"?: () => void } | null;
  const reset = vi.fn();
  const fetchMock = vi.fn();

  beforeEach(() => {
    callback = null;
    capturedScriptOnError = undefined;
    renderOptions = null;
    reset.mockClear();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    (window as unknown as { turnstile: unknown }).turnstile = {
      render: (_el: HTMLElement, opts: { callback: TurnstileCallback; appearance?: string; "error-callback"?: () => void }) => {
        renderOptions = opts;
        callback = opts.callback;
        return "widget-1";
      },
      reset,
      remove: vi.fn(),
    };
    Object.defineProperty(window, "location", { value: { href: "", assign: vi.fn() }, writable: true });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("keeps the button disabled until the widget supplies a token", () => {
    render(<DemoEntryForm siteKey="1x00000000000000000000AA" />);
    const button = screen.getByRole("button", { name: /enter demo/i });
    expect(button).toBeDisabled();
    act(() => callback!("tok-1"));
    expect(button).not.toBeDisabled();
  });

  it("renders the widget interaction-only so most visitors see nothing", () => {
    render(<DemoEntryForm siteKey="1x00000000000000000000AA" />);
    expect(renderOptions?.appearance).toBe("interaction-only");
  });

  it("posts the token and reloads to / on success", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ user: {} }) });
    render(<DemoEntryForm siteKey="1x00000000000000000000AA" />);
    act(() => callback!("tok-1"));
    fireEvent.click(screen.getByRole("button", { name: /enter demo/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/auth/demo");
    expect(JSON.parse(init.body as string)).toEqual({ turnstileToken: "tok-1" });
    await waitFor(() => expect(window.location.href).toBe("/"));
  });

  it("shows the error, resets the widget and disables the button after a 403", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: "The challenge did not pass. Reload and try again." }) });
    render(<DemoEntryForm siteKey="1x00000000000000000000AA" />);
    act(() => callback!("tok-1"));
    fireEvent.click(screen.getByRole("button", { name: /enter demo/i }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/did not pass/i));
    expect(reset).toHaveBeenCalledWith("widget-1");
    expect(screen.getByRole("button", { name: /enter demo/i })).toBeDisabled();
  });

  it("keeps the button disabled after a successful entry while the navigation is pending", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ user: {} }) });
    render(<DemoEntryForm siteKey="1x00000000000000000000AA" />);
    act(() => callback!("tok-1"));
    fireEvent.click(screen.getByRole("button", { name: /entering|enter demo/i }));
    await waitFor(() => expect(window.location.href).toBe("/"));
    expect(screen.getByRole("button")).toBeDisabled();
  });

  it("shows the unreachable copy and resets the widget when fetch rejects", async () => {
    fetchMock.mockRejectedValue(new TypeError("network"));
    render(<DemoEntryForm siteKey="1x00000000000000000000AA" />);
    act(() => callback!("tok-1"));
    fireEvent.click(screen.getByRole("button", { name: /enter demo/i }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(BACKEND_UNREACHABLE_MESSAGE));
    expect(reset).toHaveBeenCalledWith("widget-1");
  });

  it("shows the widget-failed copy from the widget error-callback", () => {
    render(<DemoEntryForm siteKey="1x00000000000000000000AA" />);
    act(() => renderOptions!["error-callback"]!());
    expect(screen.getByRole("alert")).toHaveTextContent(WIDGET_FAILED_MESSAGE);
  });

  it("shows the widget-failed copy when the script fails to load", () => {
    render(<DemoEntryForm siteKey="1x00000000000000000000AA" />);
    act(() => capturedScriptOnError!());
    expect(screen.getByRole("alert")).toHaveTextContent(WIDGET_FAILED_MESSAGE);
  });
});
