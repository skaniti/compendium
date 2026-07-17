import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SettingsMenu, { formatPaletteCaption } from "./SettingsMenu";
import * as ThemeProviderModule from "./ThemeProvider";
import * as StarfieldProviderModule from "./StarfieldProvider";
import { getSwatches } from "@/lib/theme";

// SettingsMenu now consumes StarfieldProvider's context directly (mig-01
// task 8, same pattern as the THEME section's useTheme()) -- every test
// needs it mocked or the render throws "must be used within a
// StarfieldProvider". A sensible default lives in beforeEach; tests that
// care about the starfield variant/click behavior override it locally.
function mockStarfield(variant = "twinkle", setVariant = vi.fn()) {
  vi.spyOn(StarfieldProviderModule, "useStarfield").mockReturnValue({ variant, setVariant });
  return setVariant;
}

function mockTheme(variant = "Green", setVariant = vi.fn()) {
  vi.spyOn(ThemeProviderModule, "useTheme").mockReturnValue({ variant, setVariant });
  return setVariant;
}

describe("SettingsMenu", () => {
  beforeEach(() => {
    mockStarfield();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("clicking a swatch calls setVariant with that swatch's name", async () => {
    const setVariant = mockTheme("Green");

    render(<SettingsMenu />);
    await userEvent.click(screen.getByTitle("Pink"));

    expect(setVariant).toHaveBeenCalledWith("Pink");
  });

  it("renders one swatch button per getSwatches() entry, in order", () => {
    mockTheme("Green");

    const { container } = render(<SettingsMenu />);
    const swatches = getSwatches();
    // Scoped to the real swatch buttons by class (not a title-text filter,
    // which would silently drop a swatch whose formatted caption happens
    // to not match its raw name -- e.g. a legacy " Dark"-suffixed entry).
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>(".palette-swatch"));
    expect(buttons).toHaveLength(swatches.length);
    expect(buttons.map((b) => b.title)).toEqual(swatches.map((s) => formatPaletteCaption(s.name)));
  });

  it("marks the active-variant swatch with the .active class", () => {
    mockTheme("Teal");

    render(<SettingsMenu />);
    expect(screen.getByTitle("Teal")).toHaveClass("active");
    expect(screen.getByTitle("Pink")).not.toHaveClass("active");
  });

  it("shows the current variant name in #theme-active-name", () => {
    mockTheme("Blue");

    const { container } = render(<SettingsMenu />);
    expect(container.querySelector("#theme-active-name")).toHaveTextContent("Blue");
  });

  it("renders the four starfield pills", () => {
    mockTheme();

    render(<SettingsMenu />);
    for (const label of ["none", "twinkle", "pan", "hyperspace"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it("marks the active-variant starfield pill with the .active class", () => {
    mockTheme();
    mockStarfield("pan");

    render(<SettingsMenu />);
    expect(screen.getByText("pan")).toHaveClass("active");
    expect(screen.getByText("twinkle")).not.toHaveClass("active");
    expect(screen.getByText("none")).not.toHaveClass("active");
    expect(screen.getByText("hyperspace")).not.toHaveClass("active");
  });

  it("calls the starfield context's setVariant when a pill is clicked", async () => {
    mockTheme();
    const setStarfieldVariant = mockStarfield("twinkle");

    render(<SettingsMenu />);
    await userEvent.click(screen.getByText("hyperspace"));

    expect(setStarfieldVariant).toHaveBeenCalledWith("hyperspace");
  });

  it("does not throw when a starfield pill is clicked", async () => {
    mockTheme();
    mockStarfield();

    render(<SettingsMenu />);
    await userEvent.click(screen.getByText("none"));
    await userEvent.click(screen.getByText("pan"));
  });

  it("calls onReplayTutorial when the replay-tutorial button is clicked", async () => {
    mockTheme();
    const onReplayTutorial = vi.fn();

    render(<SettingsMenu onReplayTutorial={onReplayTutorial} />);
    await userEvent.click(screen.getByText("Replay tutorial"));

    expect(onReplayTutorial).toHaveBeenCalledTimes(1);
  });

  it("renders the palette-picker trigger and dropdown structure", () => {
    mockTheme();

    const { container } = render(<SettingsMenu />);
    expect(container.querySelector(".palette-picker")).toBeInTheDocument();
    expect(container.querySelector(".palette-grid")).toBeInTheDocument();
    expect(container.querySelector(".palette-row.palette-row-dark")).toBeInTheDocument();
    expect(container.querySelector("#replay-tutorial-btn")).toBeInTheDocument();
  });

  it("renders the DISPLAY TUNERS section with the tuner-open button", () => {
    mockTheme();

    const { container } = render(<SettingsMenu />);
    expect(screen.getByText("DISPLAY TUNERS")).toBeInTheDocument();
    const btn = container.querySelector("#tuner-open-btn");
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveClass("palette-picker-action");
    expect(btn).toHaveTextContent("Open display tuners");
  });

  it("calls onOpenTuners when the tuner-open button is clicked, and does not throw with no handler wired", async () => {
    mockTheme();
    const onOpenTuners = vi.fn();

    render(<SettingsMenu onOpenTuners={onOpenTuners} />);
    await userEvent.click(screen.getByText("Open display tuners"));

    expect(onOpenTuners).toHaveBeenCalledTimes(1);
  });
});
