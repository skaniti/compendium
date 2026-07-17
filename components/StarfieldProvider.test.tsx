import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import StarfieldProvider, {
  useStarfield,
  DEFAULT_STARFIELD_VARIANT,
  STARFIELD_VARIANTS,
} from "./StarfieldProvider";
import * as preferences from "@/lib/preferences";

function Consumer() {
  const { variant, setVariant } = useStarfield();
  return (
    <div>
      <span data-testid="variant">{variant}</span>
      <button onClick={() => setVariant("pan")}>pan</button>
      <button onClick={() => setVariant("hyperspace")}>hyperspace</button>
      <button onClick={() => setVariant("bogus")}>bogus</button>
    </div>
  );
}

function renderProvider(initialVariant?: string) {
  return render(
    <StarfieldProvider initialVariant={initialVariant}>
      <Consumer />
    </StarfieldProvider>
  );
}

describe("StarfieldProvider", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("exposes the four Dash-validated starfield variants", () => {
    expect(STARFIELD_VARIANTS).toEqual(["none", "twinkle", "pan", "hyperspace"]);
  });

  it("initializes to the given initialVariant", () => {
    vi.spyOn(preferences, "patchPreferences").mockResolvedValue(undefined);
    renderProvider("pan");

    expect(screen.getByTestId("variant")).toHaveTextContent("pan");
  });

  it("defaults to DEFAULT_STARFIELD_VARIANT when no initialVariant is given", () => {
    vi.spyOn(preferences, "patchPreferences").mockResolvedValue(undefined);
    renderProvider();

    expect(screen.getByTestId("variant")).toHaveTextContent(DEFAULT_STARFIELD_VARIANT);
  });

  it("normalizes an unrecognized initialVariant down to the default", () => {
    vi.spyOn(preferences, "patchPreferences").mockResolvedValue(undefined);
    renderProvider("not-a-real-variant");

    expect(screen.getByTestId("variant")).toHaveTextContent(DEFAULT_STARFIELD_VARIANT);
  });

  it("setVariant updates the context value", async () => {
    vi.spyOn(preferences, "patchPreferences").mockResolvedValue(undefined);
    renderProvider("twinkle");

    await userEvent.click(screen.getByText("pan"));

    expect(screen.getByTestId("variant")).toHaveTextContent("pan");
  });

  it("setVariant persists via patchPreferences with the bare-partial {starfield: v} shape", async () => {
    const patchPreferences = vi.spyOn(preferences, "patchPreferences").mockResolvedValue(undefined);
    renderProvider("twinkle");

    await userEvent.click(screen.getByText("hyperspace"));

    // Exact call shape -- patchPreferences wraps this itself (lib/preferences.ts),
    // callers always pass the bare partial with the Dash-compatible key.
    expect(patchPreferences).toHaveBeenCalledTimes(1);
    expect(patchPreferences).toHaveBeenCalledWith({ starfield: "hyperspace" });
  });

  it("normalizes an invalid setVariant call to the default, both in state and in the persisted value", async () => {
    const patchPreferences = vi.spyOn(preferences, "patchPreferences").mockResolvedValue(undefined);
    renderProvider("twinkle");

    await userEvent.click(screen.getByText("bogus"));

    expect(screen.getByTestId("variant")).toHaveTextContent(DEFAULT_STARFIELD_VARIANT);
    expect(patchPreferences).toHaveBeenCalledWith({ starfield: DEFAULT_STARFIELD_VARIANT });
  });

  it("throws when useStarfield is called outside a StarfieldProvider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    function Bare() {
      useStarfield();
      return null;
    }
    expect(() => render(<Bare />)).toThrow(/StarfieldProvider/);
    spy.mockRestore();
  });
});
