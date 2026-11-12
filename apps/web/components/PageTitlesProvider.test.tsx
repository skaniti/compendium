import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PageTitlesProvider, { usePageTitles, useOptionalPageTitles } from "./PageTitlesProvider";
import * as preferences from "@/lib/preferences";

function Consumer() {
  const { show, setShow } = usePageTitles();
  return (
    <div>
      <span data-testid="show">{String(show)}</span>
      <button onClick={() => setShow(true)}>on</button>
      <button onClick={() => setShow(false)}>off</button>
    </div>
  );
}

function OptionalConsumer() {
  return <span data-testid="optional">{String(useOptionalPageTitles())}</span>;
}

describe("PageTitlesProvider", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("defaults to off", () => {
    render(
      <PageTitlesProvider>
        <Consumer />
      </PageTitlesProvider>
    );
    expect(screen.getByTestId("show")).toHaveTextContent("false");
  });

  it("starts from initialShow", () => {
    render(
      <PageTitlesProvider initialShow>
        <Consumer />
      </PageTitlesProvider>
    );
    expect(screen.getByTestId("show")).toHaveTextContent("true");
  });

  it("setShow updates state and persists show_page_titles", async () => {
    const patch = vi.spyOn(preferences, "patchPreferences").mockResolvedValue(undefined);
    render(
      <PageTitlesProvider>
        <Consumer />
      </PageTitlesProvider>
    );

    await userEvent.click(screen.getByText("on"));
    expect(screen.getByTestId("show")).toHaveTextContent("true");
    expect(patch).toHaveBeenLastCalledWith({ show_page_titles: true });

    await userEvent.click(screen.getByText("off"));
    expect(screen.getByTestId("show")).toHaveTextContent("false");
    expect(patch).toHaveBeenLastCalledWith({ show_page_titles: false });
  });

  it("canPersist=false (demo) still updates state but never writes", async () => {
    const patch = vi.spyOn(preferences, "patchPreferences").mockResolvedValue(undefined);
    render(
      <PageTitlesProvider canPersist={false}>
        <Consumer />
      </PageTitlesProvider>
    );

    await userEvent.click(screen.getByText("on"));
    expect(screen.getByTestId("show")).toHaveTextContent("true");
    expect(patch).not.toHaveBeenCalled();
  });

  it("usePageTitles throws outside a provider; the optional hook returns null", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Consumer />)).toThrow(/PageTitlesProvider/);
    err.mockRestore();
    render(<OptionalConsumer />);
    expect(screen.getByTestId("optional")).toHaveTextContent("null");
  });
});
