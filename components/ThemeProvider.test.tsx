import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ThemeProvider, { useTheme } from "./ThemeProvider";
import * as preferences from "@/lib/preferences";
import { DEFAULT_VARIANT, generateCssText, getTokens } from "@/lib/theme";

const STORAGE_KEY = "compendium-theme";

function Consumer() {
  const { variant, setVariant } = useTheme();
  return (
    <div>
      <span data-testid="variant">{variant}</span>
      <button onClick={() => setVariant("Pink")}>pink</button>
      <button onClick={() => setVariant("Teal")}>teal</button>
    </div>
  );
}

function renderProvider() {
  document.body.innerHTML = '<style id="theme-root"></style><div id="root"></div>';
  return render(
    <ThemeProvider>
      <Consumer />
    </ThemeProvider>
  );
}

describe("ThemeProvider", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    vi.spyOn(preferences, "getPreferences").mockResolvedValue({});
    vi.spyOn(preferences, "patchPreferences").mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("initializes to DEFAULT_VARIANT when localStorage is empty", async () => {
    renderProvider();
    expect(screen.getByTestId("variant")).toHaveTextContent(DEFAULT_VARIANT);
    await waitFor(() => expect(preferences.getPreferences).toHaveBeenCalled());
  });

  it("setVariant rewrites the #theme-root style tag content", async () => {
    renderProvider();
    await userEvent.click(screen.getByText("pink"));

    expect(document.getElementById("theme-root")?.textContent).toBe(
      generateCssText(getTokens("Pink"))
    );
    expect(screen.getByTestId("variant")).toHaveTextContent("Pink");
  });

  it("setVariant persists the variant name to localStorage under compendium-theme", async () => {
    renderProvider();
    await userEvent.click(screen.getByText("pink"));

    expect(localStorage.getItem(STORAGE_KEY)).toBe("Pink");
  });

  it("debounces the PATCH: rapid setVariant calls coalesce into a single request", async () => {
    vi.useFakeTimers();
    renderProvider();

    act(() => fireEvent.click(screen.getByText("pink")));
    act(() => fireEvent.click(screen.getByText("teal")));

    expect(preferences.patchPreferences).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(preferences.patchPreferences).toHaveBeenCalledTimes(1);
    expect(preferences.patchPreferences).toHaveBeenCalledWith({ theme: "Teal" });
  });

  it("applies the server's theme on mount when it differs from localStorage, and writes it back", async () => {
    localStorage.setItem(STORAGE_KEY, "Pink");
    vi.spyOn(preferences, "getPreferences").mockResolvedValue({ theme: "Teal" });

    renderProvider();

    await waitFor(() => expect(screen.getByTestId("variant")).toHaveTextContent("Teal"));
    expect(document.getElementById("theme-root")?.textContent).toBe(
      generateCssText(getTokens("Teal"))
    );
    expect(localStorage.getItem(STORAGE_KEY)).toBe("Teal");
  });

  it("normalizes a legacy/stale server theme name before applying it", async () => {
    vi.spyOn(preferences, "getPreferences").mockResolvedValue({ theme: "Pink Dark" });

    renderProvider();

    await waitFor(() => expect(screen.getByTestId("variant")).toHaveTextContent("Pink"));
  });

  it("does not PATCH back to the server after server-wins hydration", async () => {
    vi.spyOn(preferences, "getPreferences").mockResolvedValue({ theme: "Teal" });

    renderProvider();

    await waitFor(() => expect(screen.getByTestId("variant")).toHaveTextContent("Teal"));
    expect(preferences.patchPreferences).not.toHaveBeenCalled();
  });

  it("keeps the user's variant when a slow-resolving GET arrives after an explicit setVariant call, and still lets the pending PATCH fire", async () => {
    // Batch-02 carryover fix for a residual race left by the server-wins
    // reconciliation above: a SLOW mount-time GET that resolves AFTER the
    // user has already picked a palette used to overwrite that fresh
    // choice (server "won" against a value it predates) AND cancel the
    // debounced PATCH that would have persisted it -- silently reverting
    // the user's click until reload, with no way for their choice to ever
    // reach the server. The user-dirty ref now makes the user's own
    // explicit choice win outright once they've made one.
    vi.useFakeTimers();
    let resolveGetPreferences!: (value: Record<string, unknown>) => void;
    vi.spyOn(preferences, "getPreferences").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveGetPreferences = resolve;
        })
    );

    renderProvider();

    // User picks "Pink" while the mount-time GET is still in flight; this
    // schedules a debounced PATCH({theme: "Pink"}).
    act(() => fireEvent.click(screen.getByText("pink")));
    expect(screen.getByTestId("variant")).toHaveTextContent("Pink");

    // Server responds with a stale value (persisted before the user's
    // click) after the user's pick -- must NOT overwrite it.
    await act(async () => {
      resolveGetPreferences({ theme: "Teal" });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId("variant")).toHaveTextContent("Pink");
    expect(document.getElementById("theme-root")?.textContent).toBe(
      generateCssText(getTokens("Pink"))
    );
    expect(localStorage.getItem(STORAGE_KEY)).toBe("Pink");

    // The debounced PATCH for the user's own choice was never touched by
    // the (skipped) server-wins branch, so it still fires normally.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(preferences.patchPreferences).toHaveBeenCalledTimes(1);
    expect(preferences.patchPreferences).toHaveBeenCalledWith({ theme: "Pink" });
  });

  it("still re-asserts onto every #theme-root node when a slow GET resolves after the user's own click", async () => {
    // Same slow-GET-after-click race as above, but exercising the
    // duplicate-node scenario (74c4da0) -- the user-dirty branch must keep
    // reasserting onto every node, not just skip DOM work entirely.
    document.body.innerHTML =
      '<style id="theme-root"></style>' +
      '<style id="theme-root">stale-stand-in-for-a-different-palette</style>' +
      '<div id="root"></div>';
    let resolveGetPreferences!: (value: Record<string, unknown>) => void;
    vi.spyOn(preferences, "getPreferences").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveGetPreferences = resolve;
        })
    );

    render(
      <ThemeProvider>
        <Consumer />
      </ThemeProvider>
    );

    await userEvent.click(screen.getByText("teal"));

    await act(async () => {
      resolveGetPreferences({ theme: "Pink" });
      await Promise.resolve();
      await Promise.resolve();
    });

    const expectedCss = generateCssText(getTokens("Teal"));
    document.querySelectorAll("style#theme-root").forEach((node) => {
      expect(node.textContent).toBe(expectedCss);
    });
  });

  it("leaves the current variant intact if getPreferences rejects", async () => {
    vi.spyOn(preferences, "getPreferences").mockRejectedValue(new Error("network down"));

    renderProvider();

    await waitFor(() => expect(preferences.getPreferences).toHaveBeenCalled());
    expect(screen.getByTestId("variant")).toHaveTextContent(DEFAULT_VARIANT);
  });

  it("setVariant rewrites EVERY #theme-root node, not just the first (React-inserted duplicate)", async () => {
    // Regression for the confirmed live bug: React hydration inserts a
    // SECOND #theme-root into <head> alongside the server-emitted one the
    // pre-paint bootstrap mutated. document.getElementById returns only the
    // FIRST node, so a single-node write left the cascade-winning LAST node
    // stuck on stale CSS -- a palette pick that visibly did nothing.
    document.body.innerHTML =
      '<style id="theme-root"></style><style id="theme-root"></style><div id="root"></div>';
    render(
      <ThemeProvider>
        <Consumer />
      </ThemeProvider>
    );

    await userEvent.click(screen.getByText("pink"));

    const nodes = document.querySelectorAll("style#theme-root");
    expect(nodes).toHaveLength(2);
    const expectedCss = generateCssText(getTokens("Pink"));
    nodes.forEach((node) => expect(node.textContent).toBe(expectedCss));
  });

  it("re-asserts onto a stale duplicate #theme-root node after hydration, even when the server value matches the current variant", async () => {
    // Same duplicate-node scenario, but exercising the hydration effect's
    // early-return path (server value === current variant) rather than
    // setVariant -- this is the branch that used to skip applyToDom
    // entirely, leaving a React-inserted stale second node uncorrected
    // forever since nothing else ever re-asserts onto it.
    document.body.innerHTML =
      '<style id="theme-root"></style>' +
      '<style id="theme-root">stale-stand-in-for-a-different-palette</style>' +
      '<div id="root"></div>';
    vi.spyOn(preferences, "getPreferences").mockResolvedValue({ theme: DEFAULT_VARIANT });

    render(
      <ThemeProvider>
        <Consumer />
      </ThemeProvider>
    );

    await waitFor(() => expect(preferences.getPreferences).toHaveBeenCalled());

    const expectedCss = generateCssText(getTokens(DEFAULT_VARIANT));
    await waitFor(() => {
      document.querySelectorAll("style#theme-root").forEach((node) => {
        expect(node.textContent).toBe(expectedCss);
      });
    });
  });

  it("throws when useTheme is called outside a ThemeProvider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    function Bare() {
      useTheme();
      return null;
    }
    expect(() => render(<Bare />)).toThrow(/ThemeProvider/);
    spy.mockRestore();
  });
});
