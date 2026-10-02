"use client";
import { useEffect, useState } from "react";

type Result<T> = { key: string; data: T | null; error: string | null };

/**
 * Fetches once per `key` (the period: range + tz + anything else the request depends on).
 * A new key keeps the previous data on screen (`busy` is true) until it resolves; an error belongs to the key it failed in.
 */
export function usePeriodFetch<T>(key: string, fetcher: () => Promise<T>): { data: T | null; error: string | null; busy: boolean } {
  const [result, setResult] = useState<Result<T>>({ key, data: null, error: null });
  useEffect(() => {
    let cancelled = false;
    fetcher()
      .then((d) => { if (!cancelled) setResult({ key, data: d, error: null }); })
      .catch((e: Error) => { if (!cancelled) setResult((prev) => ({ key, data: prev.data, error: e.message })); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is the complete identity of the request
  }, [key]);
  return { data: result.data, error: result.key === key ? result.error : null, busy: result.key !== key };
}
