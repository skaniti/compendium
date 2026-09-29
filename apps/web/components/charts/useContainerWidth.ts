"use client";
import { useCallback, useState } from "react";
import { DEFAULT_WIDTH } from "./scales";

/** Measures a wrapper div's pixel width via ResizeObserver; falls back to DEFAULT_WIDTH before measurement, on the server and in jsdom. */
export function useContainerWidth(): [(el: HTMLDivElement | null) => void, number] {
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const ref = useCallback((el: HTMLDivElement | null) => {
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.floor(entries[0]?.contentRect.width ?? 0);
      if (w > 0) setWidth(w);
    });
    ro.observe(el);
    // callback refs may return a cleanup in React 19
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}
