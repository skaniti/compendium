import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor, act } from "@testing-library/react";
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
  // The vendor-init idempotence latch (components/CompendiumLoader.tsx) is
  // window-scoped specifically so it resets per-test the same way the two
  // globals above do -- see its own comment in lib/vendor/vendor.d.ts.
  delete window.__compendiumLoaderVendorInitStarted;
  // Task A1-4: the graph render-complete signal (GraphCanvas.tsx) is the
  // same window-scoped shape as the three globals above, for the same
  // per-test-reset reason -- see its own comment in lib/vendor/vendor.d.ts.
  delete window.__compendiumGraphRendered;
});

function getRoot(): HTMLElement {
  const root = document.getElementById("compendium-loader");
  if (!root) throw new Error("#compendium-loader not found");
  return root;
}

async function waitForVendorReady(): Promise<void> {
  await waitFor(() => expect(window.__compendiumLoader).toBeDefined());
}

// Task A1-4: stands in for GraphCanvas.tsx's own render-complete write
// (`window.__compendiumGraphRendered = true`) -- tests below drive it
// directly rather than mounting a real GraphCanvas, mirroring how this
// file already drives window.__compendiumLoader.dismiss()/.replay()
// directly instead of mounting Header.tsx. This loader component's own
// contract with the flag is unchanged by batch 03 graph fix wave V4 item
// 3b: tryDismiss() still just polls the flag, regardless of which
// GraphCanvas.tsx write site sets it or when. Only WHO writes it and WHEN
// moved (from vendor.render()'s `onFirstPaint` -- "something painted" --
// to its `onSettleEnd` -- "fully settled" -- see GraphCanvas.tsx's own
// comments and its "render-complete signal" describe block in
// GraphCanvas.test.tsx for the retimed contract itself).
function markGraphRendered(): void {
  window.__compendiumGraphRendered = true;
}

// Real timers govern tryDismiss's 50ms poll (components/CompendiumLoader.tsx)
// -- this parks the microtask queue for a few poll intervals so a test can
// assert "still hasn't dismissed" without waiting out the full ~10s MAX_TRIES
// ceiling.
async function settleAFewPollTicks(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 160));
  });
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

describe("CompendiumLoader dismiss trigger (Task A1-4: graph render-complete, replaces the mig-03 stand-in)", () => {
  it("does NOT dismiss once the vendor is ready alone -- the graph render-complete signal is still pending", async () => {
    render(<CompendiumLoader initialHasSeen={true} canPersist={false} />);
    await waitForVendorReady();

    // Several poll ticks pass with window.__compendiumGraphRendered still
    // unset -- tryDismiss must keep polling, not fire on vendor-ready alone
    // (that was the OLD stand-in behavior this task replaces).
    await settleAFewPollTicks();
    expect(getRoot()).not.toHaveClass("loader-dismiss");
  });

  it("dismisses once window.__compendiumGraphRendered turns true after the vendor is already ready", async () => {
    render(<CompendiumLoader initialHasSeen={true} canPersist={false} />);
    await waitForVendorReady();
    await settleAFewPollTicks();
    expect(getRoot()).not.toHaveClass("loader-dismiss");

    markGraphRendered();

    // 'return' mode: dismiss() finalizes synchronously via the
    // MutationObserver, so seeing loader-dismiss confirms the mount
    // effect's tryDismiss loop actually called dismiss() once BOTH
    // conditions were true, not just that the vendor module loaded.
    await waitFor(() => expect(getRoot()).toHaveClass("loader-dismiss"));
  });

  it("dismisses even when the render-complete signal is already true BEFORE the vendor becomes ready (order-independent)", async () => {
    markGraphRendered();
    render(<CompendiumLoader initialHasSeen={true} canPersist={false} />);

    await waitForVendorReady();
    await waitFor(() => expect(getRoot()).toHaveClass("loader-dismiss"));
  });

  it("a LATER render-complete signal (a graphVersion-bump re-render) does not re-trigger dismiss() or resurrect the loader", async () => {
    render(<CompendiumLoader initialHasSeen={true} canPersist={false} />);
    await waitForVendorReady();
    markGraphRendered();
    await waitFor(() => expect(getRoot()).toHaveClass("loader-dismiss"));

    // Swap in a spy AFTER the first (real) dismiss -- tryDismiss's own poll
    // loop has already reached its terminal `completed` state by now (same
    // latch the "vendor init guard" tests below exercise), so a later
    // signal must be a pure no-op: nothing is still polling to react to it.
    const dismissSpy = vi.fn();
    window.__compendiumLoader!.dismiss = dismissSpy;

    markGraphRendered(); // already true; re-asserting stands in for a second render's write

    await settleAFewPollTicks();
    expect(dismissSpy).not.toHaveBeenCalled();
    expect(getRoot()).toHaveClass("loader-dismiss");
  });

  // Fix round 1 (F2, reviewer finding): pre-fix, exhausting the poll
  // budget gave up SILENTLY -- window.__compendiumGraphRendered never
  // turning true (a load that never settles, or one still genuinely
  // settling when the ceiling arrives) left the loader's full-screen,
  // pointer-events-active curtain stuck up forever over an app that may
  // have gone on to render fine. Same failsafe philosophy as
  // GraphCanvas.tsx's own settle-veil 15s force-drop: degrade to a
  // visible app, never a stuck curtain.
  //
  // Timer strategy (deliberately NOT this repo's usual fake-timer
  // convention, and NOT fake-from-mount either -- both were tried and
  // rejected, see below):
  //  - Vendor readiness (window.__compendiumLoader appearing) is awaited
  //    with REAL timers via waitForVendorReady(), same as every other test
  //    in this file. Installing fake timers BEFORE mount and advancing
  //    past this step instead is flaky: the dynamic import()'s own
  //    resolution can depend on genuine, uncached transform/compile work
  //    the FIRST time this module loads in an isolated test run (no prior
  //    test having warmed that cache) -- real wall-clock time that a
  //    LOGICAL fake-clock advance does not actually wait out, so a fixed
  //    "advance by 500ms" budget passes when run after other tests
  //    (transform already cached) but fails when run in isolation.
  //  - Fake timers are installed only AFTER vendor-readiness, for the
  //    LONG budget-exhaustion stretch, which has no such real-I/O
  //    dependency (pure setTimeout(tryDismiss, 50) self-rescheduling).
  //    BUT: by the time `waitForVendorReady()` resolves, tryDismiss() has
  //      already run once synchronously and scheduled its OWN next tick
  //      via the REAL (not-yet-faked) setTimeout -- a timer already
  //      scheduled under real timers keeps firing on the real clock even
  //      after `vi.useFakeTimers()` swaps the global over, so advancing
  //      the FAKE clock alone would never actually tick this pending
  //      callback. The short real-time bridge wait below (via a captured
  //      REAL setTimeout reference, taken before the swap) lets that one
  //      already-pending real tick fire naturally; every tick AFTER that
  //      one reads the (by-then-faked) global `setTimeout` when it
  //      reschedules itself, so the chain lands entirely on the fake
  //      clock from there on and the rest of the budget can be
  //      fast-forwarded deterministically.
  it("F2: force-dismisses (with a console.warn) once the poll budget is exhausted, instead of latching a stuck curtain", async () => {
    const realSetTimeout = globalThis.setTimeout;
    render(<CompendiumLoader initialHasSeen={true} canPersist={false} />);
    await waitForVendorReady();
    // window.__compendiumGraphRendered deliberately never set -- simulates
    // a load that never signals settled.
    expect(getRoot()).not.toHaveClass("loader-dismiss");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      // Bridges the one poll tick already scheduled under real timers
      // (see this test's own header comment) -- 200ms of genuine real
      // wait comfortably clears its 50ms interval.
      await act(async () => {
        await new Promise((resolve) => realSetTimeout(resolve, 200));
      });

      await act(async () => {
        // MAX_TRIES (300) * the 50ms poll interval -- CompendiumLoader.tsx's
        // own comment explains why this ceiling is aligned with
        // GraphCanvas.tsx's settle-veil failsafe (both 15s). A little
        // extra margin covers the bridge wait's own already-elapsed ticks.
        await vi.advanceTimersByTimeAsync(15_500);
      });

      expect(getRoot()).toHaveClass("loader-dismiss");
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toMatch(/force-dismissing after the poll budget/i);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("CompendiumLoader vendor init guard (remount)", () => {
  it("skips re-running the vendor import/tryDismiss flow on a second mount once the vendor is already initialized", async () => {
    // Regression for the mig-02 carryover fold-in: this simulates a
    // sequential remount (unmount then a fresh mount) within the SAME
    // module lifetime -- exactly the scenario a future client-side
    // navigation would produce. Without the guard, the second mount's
    // effect would re-run the import().then(tryDismiss) flow and call
    // window.__compendiumLoader.dismiss() again (harmless only because
    // nothing has actually remounted in production yet).
    const { unmount } = render(<CompendiumLoader initialHasSeen={true} canPersist={false} />);
    await waitForVendorReady();
    markGraphRendered(); // Task A1-4: dismiss now also gates on this
    // 'return' mode dismisses synchronously via the MutationObserver --
    // confirms the FIRST mount's tryDismiss trigger actually ran.
    await waitFor(() => expect(getRoot()).toHaveClass("loader-dismiss"));

    unmount();

    // Swap in a spy AFTER the first mount's init completed -- if the
    // guard is missing, a second mount's tryDismiss will call this again
    // (window.__compendiumLoader itself survives the unmount; only
    // __compendiumLoaderOnSeen is torn down by this component's cleanup).
    const dismissSpy = vi.fn();
    window.__compendiumLoader!.dismiss = dismissSpy;

    render(<CompendiumLoader initialHasSeen={true} canPersist={false} />);

    // Flush the microtask chain a re-entered import().then(tryDismiss)
    // would run through if the guard were missing (the import is already
    // cached, so no real async delay stands between re-entering the flow
    // and calling dismiss() again).
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(dismissSpy).not.toHaveBeenCalled();
  });

  it("still re-registers window.__compendiumLoaderOnSeen on the second mount (unlike the guarded import/tryDismiss flow)", async () => {
    // The seen-flag persistence hook must NOT be swept up in the same
    // once-ever guard: this component's own cleanup deletes it on every
    // unmount, so a remount needs it put back or finishDismiss() would
    // silently stop persisting the seen-flag after any unmount/remount.
    const { unmount } = render(<CompendiumLoader initialHasSeen={false} canPersist={true} />);
    await waitForVendorReady();

    unmount();
    expect(window.__compendiumLoaderOnSeen).toBeUndefined();

    render(<CompendiumLoader initialHasSeen={false} canPersist={true} />);

    expect(typeof window.__compendiumLoaderOnSeen).toBe("function");
  });

  it("still initializes and dismisses after a React StrictMode-shaped mount -> immediate cleanup -> mount cycle", async () => {
    // Regression: Next's App Router defaults reactStrictMode to true, and
    // this repo's next.config.ts never overrides it, so every dev mount
    // runs effect -> cleanup -> effect SYNCHRONOUSLY (React double-invokes
    // effects in dev to surface exactly this class of bug), before the
    // dynamic import's microtask chain gets a single turn. Calling
    // unmount() immediately after render() below (no `await` in between)
    // reproduces that exact ordering: the first run's cleanup fires
    // before its import().then() has resolved.
    //
    // Without rolling the vendor-init latch back when a flow is torn down
    // before completing, the first run would set the latch and then be
    // cancelled before tryDismiss ever ran (so its own later-resolving
    // .then() callback is a no-op forever, guarded by its `cancelled`
    // closure); the second (real, persisted) run would see the latch
    // already set and skip starting its own flow entirely -- net result,
    // the curtain never dismisses, in every dev session.
    const { unmount } = render(<CompendiumLoader initialHasSeen={true} canPersist={false} />);
    unmount();

    render(<CompendiumLoader initialHasSeen={true} canPersist={false} />);

    await waitForVendorReady();
    markGraphRendered(); // Task A1-4: dismiss now also gates on this
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
