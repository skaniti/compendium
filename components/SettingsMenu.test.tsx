import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SettingsMenu from "./SettingsMenu";
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

    render(<SettingsMenu />);
    const swatches = getSwatches();
    const buttons = screen.getAllByRole("button", { name: /.+/ }).filter((b) =>
      swatches.some((s) => s.name === b.getAttribute("title")),
    );
    expect(buttons.map((b) => b.getAttribute("title"))).toEqual(swatches.map((s) => s.name));
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
});
