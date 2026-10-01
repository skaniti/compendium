"use client";
import { useEffect, useState } from "react";
import RangePills from "@/components/dev/RangePills";
import { useTimeWindow } from "@/components/TimeWindowProvider";
import { rangeKeyFor } from "@/lib/pipeline";
import { fetchArchiveHealth, fetchSkipTrends } from "@/lib/api";
import type { ArchiveHealthSummary, RangeKey, SkipTrends } from "@/lib/types";
import ArchiveHealthSection from "./ArchiveHealthSection";
import SkipTrendsSection from "./SkipTrendsSection";

type Result<T> = { range: RangeKey; data: T | null; error: string | null };

function useWindowed<T>(fetcher: (r: RangeKey) => Promise<T>, range: RangeKey) {
  const [result, setResult] = useState<Result<T>>({ range, data: null, error: null });
  useEffect(() => {
    let cancelled = false;
    fetcher(range)
      .then((d) => { if (!cancelled) setResult({ range, data: d, error: null }); })
      .catch((e: Error) => { if (!cancelled) setResult((prev) => ({ range, data: prev.data, error: e.message })); });
    return () => { cancelled = true; };
  }, [fetcher, range]);
  // an error belongs to the window it failed in; a new window shows the previous data until it resolves
  return { data: result.data, error: result.range === range ? result.error : null };
}

export default function WindowedSections() {
  const { timeWindow, setTimeWindow } = useTimeWindow();
  const range = rangeKeyFor(timeWindow);
  const health = useWindowed<ArchiveHealthSummary>(fetchArchiveHealth, range);
  const trends = useWindowed<SkipTrends>(fetchSkipTrends, range);
  return (
    <>
      <RangePills value={timeWindow} onChange={setTimeWindow} />
      <ArchiveHealthSection data={health.data} error={health.error} />
      <SkipTrendsSection data={trends.data} error={trends.error} />
    </>
  );
}
