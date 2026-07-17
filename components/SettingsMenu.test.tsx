import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SettingsMenu, { formatPaletteCaption } from "./SettingsMenu";
import * as ThemeProviderModule from "./ThemeProvider";
import { getSwatches } from "@/lib/theme";

describe("SettingsMenu", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("clicking a swatch calls setVariant with that swatch's name", async () => {
    const setVariant = vi.fn();
    vi.spyOn(ThemeProviderModule, "useTheme").mockReturnValue({ variant: "Green", setVariant });

    render(<SettingsMenu />);
    await userEvent.click(screen.getByTitle("Pink"));

    expect(setVariant).toHaveBeenCalledWith("Pink");
  });

  it("renders one swatch button per getSwatches() entry, in order", () => {
    vi.spyOn(ThemeProviderModule, "useTheme").mockReturnValue({
      variant: "Green",
      setVariant: vi.fn(),
    });

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
    vi.spyOn(ThemeProviderModule, "useTheme").mockReturnValue({
      variant: "Teal",
      setVariant: vi.fn(),
    });

    render(<SettingsMenu />);
    expect(screen.getByTitle("Teal")).toHaveClass("active");
    expect(screen.getByTitle("Pink")).not.toHaveClass("active");
  });

  it("shows the current variant name in #theme-active-name", () => {
    vi.spyOn(ThemeProviderModule, "useTheme").mockReturnValue({
      variant: "Blue",
      setVariant: vi.fn(),
    });

    const { container } = render(<SettingsMenu />);
    expect(container.querySelector("#theme-active-name")).toHaveTextContent("Blue");
  });

  it("renders the four starfield pills and does not throw when clicked with no handler wired", async () => {
    vi.spyOn(ThemeProviderModule, "useTheme").mockReturnValue({
      variant: "Green",
      setVariant: vi.fn(),
    });

    render(<SettingsMenu />);
    for (const label of ["none", "twinkle", "pan", "hyperspace"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    await userEvent.click(screen.getByText("hyperspace"));
  });

  it("calls onStarfieldChange when a starfield pill is clicked", async () => {
    vi.spyOn(ThemeProviderModule, "useTheme").mockReturnValue({
      variant: "Green",
      setVariant: vi.fn(),
    });
    const onStarfieldChange = vi.fn();

    render(<SettingsMenu onStarfieldChange={onStarfieldChange} />);
    await userEvent.click(screen.getByText("pan"));

    expect(onStarfieldChange).toHaveBeenCalledWith("pan");
  });

  it("calls onReplayTutorial when the replay-tutorial button is clicked", async () => {
    vi.spyOn(ThemeProviderModule, "useTheme").mockReturnValue({
      variant: "Green",
      setVariant: vi.fn(),
    });
    const onReplayTutorial = vi.fn();

    render(<SettingsMenu onReplayTutorial={onReplayTutorial} />);
    await userEvent.click(screen.getByText("Replay tutorial"));

    expect(onReplayTutorial).toHaveBeenCalledTimes(1);
  });

  it("renders the palette-picker trigger and dropdown structure", () => {
    vi.spyOn(ThemeProviderModule, "useTheme").mockReturnValue({
      variant: "Green",
      setVariant: vi.fn(),
    });

    const { container } = render(<SettingsMenu />);
    expect(container.querySelector(".palette-picker")).toBeInTheDocument();
    expect(container.querySelector(".palette-grid")).toBeInTheDocument();
    expect(container.querySelector(".palette-row.palette-row-dark")).toBeInTheDocument();
    expect(container.querySelector("#replay-tutorial-btn")).toBeInTheDocument();
  });

  it("renders the DISPLAY TUNERS section with the tuner-open button", () => {
    vi.spyOn(ThemeProviderModule, "useTheme").mockReturnValue({
      variant: "Green",
      setVariant: vi.fn(),
    });

    const { container } = render(<SettingsMenu />);
    expect(screen.getByText("DISPLAY TUNERS")).toBeInTheDocument();
    const btn = container.querySelector("#tuner-open-btn");
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveClass("palette-picker-action");
    expect(btn).toHaveTextContent("Open display tuners");
  });

  it("calls onOpenTuners when the tuner-open button is clicked, and does not throw with no handler wired", async () => {
    vi.spyOn(ThemeProviderModule, "useTheme").mockReturnValue({
      variant: "Green",
      setVariant: vi.fn(),
    });
    const onOpenTuners = vi.fn();

    render(<SettingsMenu onOpenTuners={onOpenTuners} />);
    await userEvent.click(screen.getByText("Open display tuners"));

    expect(onOpenTuners).toHaveBeenCalledTimes(1);
  });
});
