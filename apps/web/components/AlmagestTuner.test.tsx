import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import AlmagestTuner from "./AlmagestTuner";
import { shippedParams, DRAFT_STORAGE_KEY } from "@/lib/almagest/params";

// @testing-library/dom's waitFor() only takes its fake-timer-aware branch
// (which self-advances the clock instead of polling via a real setTimeout)
// when it detects a global `jest`; under Vitest that global doesn't exist,
// so waitFor()'s internal microtask-drain step schedules an un-advanced
// FAKE setTimeout(0) and hangs forever whenever vi.useFakeTimers() is still
// active (confirmed with a standalone `await waitFor(() => expect(true)
// .toBe(true))` repro -- hangs regardless of assertion content). The "bake"
// test below is the one case in this file that needs both (fake timers for
// the debounce tests earlier via the shared beforeEach, and waitFor here
// once the mocked fetch/reload settle) -- this file-scoped shim (the
// standard fix: https://github.com/testing-library/dom-testing-library/
// issues/939) makes that combination work without touching the shared
// vitest.setup.ts or any other test file's behavior.
(globalThis as unknown as { jest?: unknown }).jest = vi;

describe("AlmagestTuner", () => {
  beforeEach(() => { localStorage.clear(); (window as unknown as { __d3SetAlmagestPreview?: unknown }).__d3SetAlmagestPreview = vi.fn(); vi.useFakeTimers(); });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it("is collapsed by default and opens from the Aa pill and Alt+A", () => {
    render(<AlmagestTuner />);
    expect(screen.queryByRole("dialog", { name: /almagest/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /almagest tuner/i }));
    expect(screen.getByRole("dialog", { name: /almagest/i })).toBeTruthy();
    fireEvent.keyDown(document, { key: "a", altKey: true });
    expect(screen.queryByRole("dialog", { name: /almagest/i })).toBeNull();
  });
  it("pushes a debounced preview when preview is on and a slider moves, and null when preview goes off", () => {
    const push = (window as unknown as { __d3SetAlmagestPreview: ReturnType<typeof vi.fn> }).__d3SetAlmagestPreview;
    render(<AlmagestTuner />);
    fireEvent.click(screen.getByRole("button", { name: /almagest tuner/i }));
    fireEvent.click(screen.getByRole("switch", { name: /preview/i }));
    const star = screen.getByLabelText(/^star$/i) as HTMLInputElement;
    fireEvent.change(star, { target: { value: "250" } });
    vi.advanceTimersByTime(60);
    const last = push.mock.calls.at(-1)![0];
    expect(last.tiers.Display.star).toBe(250);
    fireEvent.click(screen.getByRole("switch", { name: /preview/i }));
    expect(push.mock.calls.at(-1)![0]).toBeNull();
  });
  it("reset returns to shipped and the draft persists in localStorage", () => {
    render(<AlmagestTuner />);
    fireEvent.click(screen.getByRole("button", { name: /almagest tuner/i }));
    const star = screen.getByLabelText(/^star$/i) as HTMLInputElement;
    fireEvent.change(star, { target: { value: "250" } });
    expect(JSON.parse(localStorage.getItem(DRAFT_STORAGE_KEY)!).tiers.Display.star).toBe(250);
    fireEvent.click(screen.getByRole("button", { name: /reset to shipped/i }));
    expect((screen.getByLabelText(/^star$/i) as HTMLInputElement).value).toBe(String(shippedParams().tiers.Display.star));
  });
  it("bake posts the params and reloads on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, version: "abc", log: "" }) });
    vi.stubGlobal("fetch", fetchMock);
    const reload = vi.fn();
    Object.defineProperty(window, "location", { value: { ...window.location, reload }, writable: true });
    render(<AlmagestTuner />);
    fireEvent.click(screen.getByRole("button", { name: /almagest tuner/i }));
    fireEvent.click(screen.getByRole("button", { name: /^bake$/i }));
    await vi.runAllTimersAsync();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/dev/almagest/bake", expect.objectContaining({ method: "POST" })));
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });
});
