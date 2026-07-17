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

  it("leaves the current variant intact if getPreferences rejects", async () => {
    vi.spyOn(preferences, "getPreferences").mockRejectedValue(new Error("network down"));

    renderProvider();

    await waitFor(() => expect(preferences.getPreferences).toHaveBeenCalled());
    expect(screen.getByTestId("variant")).toHaveTextContent(DEFAULT_VARIANT);
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
