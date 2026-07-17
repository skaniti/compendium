import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import CompendiumLoader from "./CompendiumLoader";
import * as preferences from "@/lib/preferences";

// The vendor module (lib/vendor/compendium-loader.js) auto-initializes via
// its own internal setInterval poll for #compendium-loader, then attaches
// window.__compendiumLoader once. A dynamic import() of the same specifier
// is cached across tests in one file (ESM module cache), so without a
// reset the SECOND test's freshly-rendered #compendium-loader div would
// never get found -- the first test's poll already ran to completion and
// cleared itself. Resetting the module registry before each test forces a
// fresh top-level run (fresh setInterval, fresh poll) against whichever
// div is in the DOM for that test. Mirrors Starfield.test.tsx's approach
// of letting the real vendored script run in jsdom rather than mocking it.
beforeEach(() => {
  vi.resetModules();
  // finishDismiss()'s persistence hook calls this (see
  // lib/vendor/compendium-loader.js's header comment on the edit) --
  // mocked so no real fetch fires in jsdom, same convention
  // Starfield.test.tsx/StarfieldProvider.test.tsx use for patchPreferences.
  vi.spyOn(preferences, "patchPreferences").mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete window.__compendiumLoader;
  delete window.__compendiumLoaderOnSeen;
});

function getRoot(): HTMLElement {
  const root = document.getElementById("compendium-loader");
  if (!root) throw new Error("#compendium-loader not found");
  return root;
}

async function waitForVendorReady(): Promise<void> {
  await waitFor(() => expect(window.__compendiumLoader).toBeDefined());
}

describe("CompendiumLoader mode selection", () => {
  it('renders data-mode="first-run" when the seen-preference is false', () => {
    render(<CompendiumLoader initialHasSeen={false} />);

    expect(getRoot()).toHaveAttribute("data-mode", "first-run");
  });

  it('renders data-mode="return" when the seen-preference is true', () => {
    render(<CompendiumLoader initialHasSeen={true} />);

    expect(getRoot()).toHaveAttribute("data-mode", "return");
  });

  it('defaults to data-mode="first-run" when initialHasSeen is omitted', () => {
    render(<CompendiumLoader />);

    expect(getRoot()).toHaveAttribute("data-mode", "first-run");
  });

  it("renders the loader root with the expected static attributes", () => {
    render(<CompendiumLoader initialHasSeen={false} />);

    const root = getRoot();
    expect(root).toHaveClass("loader");
    expect(root).toHaveAttribute("role", "status");
    expect(root).toHaveAttribute("aria-live", "polite");
  });
});

describe("CompendiumLoader replay", () => {
  it("replay() resets the dismissed/loaded classes and re-arms the cycle", async () => {
    render(<CompendiumLoader initialHasSeen={true} canPersist={false} />);
    await waitForVendorReady();

    const root = getRoot();

    // 'return' mode has no animation to protect, so dismiss() finalizes
    // immediately (mirrors the vendor module's own MutationObserver
    // branch: `cycleComplete || mode === 'return'`).
    window.__compendiumLoader!.dismiss();
    await waitFor(() => expect(root).toHaveClass("loader-dismiss"));

    window.__compendiumLoader!.replay();

    expect(root).not.toHaveClass("loader-dismiss");
    expect(root).not.toHaveClass("loaded");
    expect(root).toHaveAttribute("data-mode", "replay");
    root.querySelectorAll(".panel").forEach((panel) => {
      expect(panel).not.toHaveClass("in");
    });
    root.querySelectorAll(".progress span").forEach((dot) => {
      expect(dot).not.toHaveClass("on");
    });
  });
});

describe("CompendiumLoader dismiss trigger (this batch's stand-in)", () => {
  it("calls window.__compendiumLoader.dismiss() once the vendor module is ready", async () => {
    render(<CompendiumLoader initialHasSeen={true} canPersist={false} />);
    await waitForVendorReady();

    // 'return' mode: dismiss() finalizes synchronously via the
    // MutationObserver, so seeing loader-dismiss confirms the mount
    // effect actually called dismiss() (TODO(mig-03) stand-in trigger),
    // not just that the vendor module loaded.
    await waitFor(() => expect(getRoot()).toHaveClass("loader-dismiss"));
  });
});

describe("CompendiumLoader seen-flag persistence", () => {
  it("registers window.__compendiumLoaderOnSeen so the vendor module can persist the boolean seen flag", async () => {
    render(<CompendiumLoader initialHasSeen={false} canPersist={true} />);
    await waitForVendorReady();

    expect(typeof window.__compendiumLoaderOnSeen).toBe("function");

    window.__compendiumLoaderOnSeen!();

    // Boolean true, not a timestamp -- corrected fact #1: Dash persists
    // {compendium_loader_seen: True}, matched here exactly.
    expect(preferences.patchPreferences).toHaveBeenCalledWith({
      compendium_loader_seen: true,
    });
  });
});
