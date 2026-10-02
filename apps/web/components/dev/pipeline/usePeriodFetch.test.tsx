import { renderHook, act, waitFor } from "@testing-library/react";
import { it, expect } from "vitest";
import { usePeriodFetch } from "./usePeriodFetch";

const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };

it("an older period resolving after a newer one never overwrites it", async () => {
  const a = deferred<string>(); const b = deferred<string>();
  const { result, rerender } = renderHook(({ k }) => usePeriodFetch(k, () => (k === "A" ? a.promise : b.promise)), { initialProps: { k: "A" } });
  rerender({ k: "B" });
  await act(async () => { b.resolve("data-B"); });
  await waitFor(() => expect(result.current.data).toBe("data-B"));
  await act(async () => { a.resolve("data-A"); });
  expect(result.current.data).toBe("data-B");
  expect(result.current.busy).toBe(false);
});
it("reports busy from the key change until the new response arrives", async () => {
  const a = deferred<string>(); const b = deferred<string>();
  const { result, rerender } = renderHook(({ k }) => usePeriodFetch(k, () => (k === "A" ? a.promise : b.promise)), { initialProps: { k: "A" } });
  await act(async () => { a.resolve("A"); });
  expect(result.current.busy).toBe(false);
  rerender({ k: "B" });
  expect(result.current.busy).toBe(true);
  expect(result.current.data).toBe("A"); // previous data stays on screen
  await act(async () => { b.resolve("B"); });
  expect(result.current.busy).toBe(false);
});
