import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import AlmagestTuner from "./AlmagestTuner";
import { shippedParams, PARAM_RANGES, DRAFT_STORAGE_KEY } from "@/lib/almagest/params";

const REOPEN_STORAGE_KEY = "compendium_almagest_reopen";

describe("AlmagestTuner", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    (window as unknown as { __d3SetAlmagestPreview?: unknown }).__d3SetAlmagestPreview = vi.fn();
    (window as unknown as { __d3SetAlmagestTierTint?: unknown }).__d3SetAlmagestTierTint = vi.fn();
    vi.useFakeTimers();
  });
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
    expect(sessionStorage.getItem(REOPEN_STORAGE_KEY)).toBe("1");
  });
  it("reopens on first render when the post-bake reload flag is set, and clears it", () => {
    sessionStorage.setItem(REOPEN_STORAGE_KEY, "1");
    render(<AlmagestTuner />);
    expect(screen.getByRole("dialog", { name: /almagest/i })).toBeTruthy();
    expect(sessionStorage.getItem(REOPEN_STORAGE_KEY)).toBeNull();
  });
  it("clamps a tier param live: raising Mid's breakpoint above Display's keeps the invariant", () => {
    render(<AlmagestTuner />);
    fireEvent.click(screen.getByRole("button", { name: /almagest tuner/i }));
    fireEvent.click(screen.getByRole("button", { name: "Mid" }));
    const midBreakpoint = screen.getByLabelText(/breakpoint px value/i) as HTMLInputElement;
    fireEvent.change(midBreakpoint, { target: { value: String(PARAM_RANGES.tier.min.max) } });
    // The number input commits on blur, not per keystroke (see the
    // commit-on-blur test below) -- blur it to apply the clamp/invariant.
    fireEvent.blur(midBreakpoint);
    const midValue = Number(midBreakpoint.value);
    expect(midValue).toBeLessThanOrEqual(PARAM_RANGES.tier.min.max - 1);

    fireEvent.click(screen.getByRole("button", { name: "Display" }));
    const displayBreakpoint = screen.getByLabelText(/breakpoint px value/i) as HTMLInputElement;
    const displayValue = Number(displayBreakpoint.value);
    expect(displayValue).toBeGreaterThan(midValue);
    expect(displayValue).toBeLessThanOrEqual(PARAM_RANGES.tier.min.max);

    // The persisted draft reflects the same validated values, not the raw
    // out-of-range input.
    const draft = JSON.parse(localStorage.getItem(DRAFT_STORAGE_KEY)!);
    expect(draft.tiers.Mid.min).toBe(midValue);
    expect(draft.tiers.Display.min).toBe(displayValue);
  });
  it("commits the number input only on blur, so a clamp mid-typing can't corrupt the next keystroke", () => {
    render(<AlmagestTuner />);
    fireEvent.click(screen.getByRole("button", { name: /almagest tuner/i }));
    fireEvent.click(screen.getByRole("button", { name: "Mid" }));
    const stroke = screen.getByLabelText(/stroke value/i) as HTMLInputElement;

    // Types "3" then "6" as two real keystrokes would: the second change's
    // target.value is whatever the input currently displays plus the new
    // digit -- under the old per-keystroke-clamp bug, "3" (below the range
    // min of 4) would already have been clamped and re-rendered as "4"
    // before the second keystroke landed, producing "46"; buffering the
    // draft locally keeps it "3" until blur, so the second keystroke
    // produces "36".
    fireEvent.change(stroke, { target: { value: "3" } });
    fireEvent.change(stroke, { target: { value: stroke.value + "6" } });
    fireEvent.blur(stroke);
    expect(stroke.value).toBe("36");
    expect(JSON.parse(localStorage.getItem(DRAFT_STORAGE_KEY)!).tiers.Mid.stroke).toBe(36);

    // A genuinely out-of-range value still clamps, just at commit (blur)
    // time rather than per keystroke.
    fireEvent.change(stroke, { target: { value: "2" } });
    fireEvent.blur(stroke);
    expect(Number(stroke.value)).toBe(PARAM_RANGES.tier.stroke.min);
  });

  // Batch A (spec docs/project-plans/2026-09-13-183006-graph-interaction-followups/)
  it("the tint checkbox calls the tier-tint hook on and off", () => {
    const tint = (window as unknown as { __d3SetAlmagestTierTint: ReturnType<typeof vi.fn> }).__d3SetAlmagestTierTint;
    render(<AlmagestTuner />);
    fireEvent.click(screen.getByRole("button", { name: /almagest tuner/i }));
    const checkbox = screen.getByRole("checkbox", { name: /tint by tier/i }) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    fireEvent.click(checkbox);
    expect(tint).toHaveBeenLastCalledWith(true);
    fireEvent.click(checkbox);
    expect(tint).toHaveBeenLastCalledWith(false);
  });

  it("marks a tweaked row, badges its tab, updates the footer, and per-row reset clears the marker", () => {
    render(<AlmagestTuner />);
    fireEvent.click(screen.getByRole("button", { name: /almagest tuner/i }));
    expect(screen.getByText("matches last bake")).toBeTruthy();

    const midTab = screen.getByRole("button", { name: "Mid" });
    fireEvent.click(midTab);
    const stroke = screen.getByLabelText(/^stroke$/i) as HTMLInputElement;
    const baseline = Number(stroke.value);
    fireEvent.change(stroke, { target: { value: String(baseline + 1) } });

    const row = stroke.closest(".tuner-row")!;
    expect(row.className).toContain("tuner-row--tweaked");
    expect(midTab.querySelector(".tuner-tab-badge")?.textContent).toBe("1");
    expect(screen.getByText("1 changed since last bake")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /reset stroke/i }));
    expect(Number((screen.getByLabelText(/^stroke$/i) as HTMLInputElement).value)).toBe(baseline);
    expect(row.className).not.toContain("tuner-row--tweaked");
    expect(midTab.querySelector(".tuner-tab-badge")).toBeNull();
    expect(screen.getByText("matches last bake")).toBeTruthy();
  });

  it("the global reset still restores everything, clearing every tweak marker", () => {
    render(<AlmagestTuner />);
    fireEvent.click(screen.getByRole("button", { name: /almagest tuner/i }));
    fireEvent.click(screen.getByRole("button", { name: "Mid" }));
    const stroke = screen.getByLabelText(/^stroke$/i) as HTMLInputElement;
    fireEvent.change(stroke, { target: { value: String(Number(stroke.value) + 1) } });
    fireEvent.click(screen.getByRole("button", { name: "Display" }));
    const star = screen.getByLabelText(/^star$/i) as HTMLInputElement;
    fireEvent.change(star, { target: { value: "250" } });
    expect(screen.getByText(/changed since last bake/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /reset to shipped/i }));

    expect(screen.getByText("matches last bake")).toBeTruthy();
    expect((screen.getByLabelText(/^star$/i) as HTMLInputElement).value).toBe(String(shippedParams().tiers.Display.star));
    fireEvent.click(screen.getByRole("button", { name: "Mid" }));
    expect((screen.getByLabelText(/^stroke$/i) as HTMLInputElement).closest(".tuner-row")!.className).not.toContain(
      "tuner-row--tweaked",
    );
  });
});
