import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAllSingleFlights, createSingleFlight } from "./refresh-single-flight";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createSingleFlight", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    clearAllSingleFlights();
    vi.useRealTimers();
  });

  it("shares one in-flight call between concurrent callers with the same key", async () => {
    const flight = createSingleFlight<string>({ retainMs: () => 0, shouldRetain: () => true });
    const gate = deferred<string>();
    const fn = vi.fn(() => gate.promise);

    const a = flight.run("k", fn);
    const b = flight.run("k", fn);
    gate.resolve("v");

    expect(await a).toBe("v");
    expect(await b).toBe("v");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not share between different keys", async () => {
    const flight = createSingleFlight<string>({ retainMs: () => 0, shouldRetain: () => true });
    const fn = vi.fn(async () => "v");
    await Promise.all([flight.run("a", fn), flight.run("b", fn)]);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("with retention off, a call after settle runs again", async () => {
    const flight = createSingleFlight<string>({ retainMs: () => 0, shouldRetain: () => true });
    const fn = vi.fn(async () => "v");
    await flight.run("k", fn);
    await flight.run("k", fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retains a settled value for retainMs, then runs again", async () => {
    const flight = createSingleFlight<string>({ retainMs: () => 10_000, shouldRetain: () => true });
    const fn = vi.fn(async () => "v");

    await flight.run("k", fn);
    vi.advanceTimersByTime(9_999);
    expect(await flight.run("k", fn)).toBe("v");
    expect(fn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2);
    await flight.run("k", fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retain a value the predicate rejects", async () => {
    const flight = createSingleFlight<string>({
      retainMs: () => 10_000,
      shouldRetain: (v) => v === "ok",
    });
    const fn = vi.fn(async () => "failed");
    await flight.run("k", fn);
    await flight.run("k", fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retain a rejection, and the rejection reaches every awaiting caller", async () => {
    const flight = createSingleFlight<string>({ retainMs: () => 10_000, shouldRetain: () => true });
    const gate = deferred<string>();
    const a = flight.run("k", () => gate.promise);
    const b = flight.run("k", () => gate.promise);
    const settled = Promise.allSettled([a, b]);
    gate.reject(new Error("boom"));
    expect((await settled).map((r) => r.status)).toEqual(["rejected", "rejected"]);

    const fn = vi.fn(async () => "v");
    expect(await flight.run("k", fn)).toBe("v");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("reads retainMs when the call settles, not when the flight is created", async () => {
    let ms = 10_000;
    const flight = createSingleFlight<string>({ retainMs: () => ms, shouldRetain: () => true });
    const fn = vi.fn(async () => "v");
    const pending = flight.run("k", fn);
    ms = 0;
    await pending;
    await flight.run("k", fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("clear() drops retained values and their timers", async () => {
    const flight = createSingleFlight<string>({ retainMs: () => 10_000, shouldRetain: () => true });
    const fn = vi.fn(async () => "v");
    await flight.run("k", fn);
    flight.clear();
    await flight.run("k", fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("clearAllSingleFlights() clears every flight", async () => {
    const one = createSingleFlight<string>({ retainMs: () => 10_000, shouldRetain: () => true });
    const two = createSingleFlight<string>({ retainMs: () => 10_000, shouldRetain: () => true });
    const fn = vi.fn(async () => "v");
    await one.run("k", fn);
    await two.run("k", fn);
    clearAllSingleFlights();
    await one.run("k", fn);
    await two.run("k", fn);
    expect(fn).toHaveBeenCalledTimes(4);
  });
});
