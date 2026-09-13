import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import AlmagestTuner from "./AlmagestTuner";
import { shippedParams, DRAFT_STORAGE_KEY } from "@/lib/almagest/params";

describe("AlmagestTuner", () => {
  beforeEach(() => { localStorage.clear(); (window as unknown as { __d3SetAlmagestPreview?: unknown }).__d3SetAlmagestPreview = vi.fn(); vi.useFakeTimers(); });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it("is collapsed by default and opens from the Aa pill and Alt+A", () => {
    render(<AlmagestTuner />);
    expect(screen.queryByRole("dialog", { name: /almagest/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /almagest tuner/i }));
    expect(screen.getByRole("dialog", { name: /almagest/i })).toBeTruthy();
    fireEvent.keyDown(document, { key: "a", code: "KeyA", altKey: true });
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
    // Real-timer-scoped `waitFor` polling never fires while
    // vi.useFakeTimers() (set in beforeEach, above) is still active -- same
    // established convention as GraphCanvas.test.tsx's fake-timer tests
    // (~line 943): drive the fake clock inside `act` so React flushes the
    // resulting state updates, then assert directly.
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/dev/almagest/bake", expect.objectContaining({ method: "POST" }));
    expect(reload).toHaveBeenCalled();
  });
});
