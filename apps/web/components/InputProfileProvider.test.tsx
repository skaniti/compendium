import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import InputProfileProvider, {
  INPUT_PROFILE_STORAGE_KEY,
  useInputProfile,
  useOptionalInputProfile,
} from "./InputProfileProvider";

function Consumer() {
  const { profile, setProfile, detected, setDetected } = useInputProfile();
  return (
    <div>
      <span data-testid="profile">{profile}</span>
      <span data-testid="detected">{String(detected)}</span>
      <button onClick={() => setProfile("mouse")}>mouse</button>
      <button onClick={() => setProfile("trackpad")}>trackpad</button>
      <button onClick={() => setDetected("trackpad")}>detect</button>
    </div>
  );
}

describe("InputProfileProvider", () => {
  beforeEach(() => localStorage.removeItem(INPUT_PROFILE_STORAGE_KEY));
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    localStorage.removeItem(INPUT_PROFILE_STORAGE_KEY);
  });

  it("defaults to auto with nothing detected", () => {
    render(
      <InputProfileProvider>
        <Consumer />
      </InputProfileProvider>
    );
    expect(screen.getByTestId("profile")).toHaveTextContent("auto");
    expect(screen.getByTestId("detected")).toHaveTextContent("null");
  });

  it("reads the stored profile after mount", () => {
    localStorage.setItem(INPUT_PROFILE_STORAGE_KEY, "trackpad");
    render(
      <InputProfileProvider>
        <Consumer />
      </InputProfileProvider>
    );
    expect(screen.getByTestId("profile")).toHaveTextContent("trackpad");
  });

  it("ignores an invalid stored value", () => {
    localStorage.setItem(INPUT_PROFILE_STORAGE_KEY, "joystick");
    render(
      <InputProfileProvider>
        <Consumer />
      </InputProfileProvider>
    );
    expect(screen.getByTestId("profile")).toHaveTextContent("auto");
  });

  it("setProfile updates state and writes localStorage under compendium-input-profile", async () => {
    render(
      <InputProfileProvider>
        <Consumer />
      </InputProfileProvider>
    );
    await userEvent.click(screen.getByText("mouse"));
    expect(screen.getByTestId("profile")).toHaveTextContent("mouse");
    expect(localStorage.getItem("compendium-input-profile")).toBe("mouse");
  });

  it("still updates in memory when localStorage throws", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    render(
      <InputProfileProvider>
        <Consumer />
      </InputProfileProvider>
    );
    await userEvent.click(screen.getByText("trackpad"));
    expect(screen.getByTestId("profile")).toHaveTextContent("trackpad");
  });

  it("setDetected updates the detected value", () => {
    render(
      <InputProfileProvider>
        <Consumer />
      </InputProfileProvider>
    );
    act(() => screen.getByText("detect").click());
    expect(screen.getByTestId("detected")).toHaveTextContent("trackpad");
  });

  it("useInputProfile throws outside a provider; the optional hook returns null", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Consumer />)).toThrow(/InputProfileProvider/);
    err.mockRestore();
    function Opt() {
      return <span data-testid="opt">{String(useOptionalInputProfile())}</span>;
    }
    render(<Opt />);
    expect(screen.getByTestId("opt")).toHaveTextContent("null");
  });
});
