"use client";
import { fetchContentJoinCheck } from "@/lib/api";
import { STALE_API_MESSAGE } from "@/lib/overview";
import { usePeriodFetch } from "./usePeriodFetch";

export const REPAIR_COMMAND = "python -m backend.scripts.repair_page_content_joins";
const num = (n: number) => n.toLocaleString("en-US");

function dayIn(iso: string | null, tz: string): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("en-US", { timeZone: tz, year: "numeric", month: "short", day: "numeric" });
  } catch {
    return iso.slice(0, 10);
  }
}

/**
 * The latest nightly page/content join check (not range-scoped): a quiet line when clean, a panel with the
 * affected page ids and the repair command when pages are joined to another URL's content row.
 */
export default function ContentJoinCheck({ tz }: { tz: string }) {
  const { data, error } = usePeriodFetch("content-join-check", fetchContentJoinCheck);
  if (error === STALE_API_MESSAGE) return <p className="join-check" data-state="stale" aria-busy="false">Content joins: the API is older than this view; restart it to load the check.</p>;
  if (error) return <p className="join-check" data-state="unavailable" aria-busy="false">Content joins: couldn&apos;t load the check ({error}).</p>;
  if (!data) return <p className="join-check" aria-busy="true">Content joins: checking…</p>;
  const day = dayIn(data.checked_at, tz);
  if (data.state === "mismatches") {
    const more = data.count - data.page_ids.length;
    return (
      <section className="join-check dev-panel is-mismatch" role="alert" data-state="mismatches" aria-busy="false">
        <p className="join-check-head">
          <strong>Content joins: {num(data.count)} {data.count === 1 ? "page points" : "pages point"} at another URL&apos;s content</strong>
          {day && <span className="join-check-when"> · checked {day}</span>}
        </p>
        <div className="join-check-ids">
          {data.page_ids.map((id) => <span key={id} className="dev-chip">{id}</span>)}
          {more > 0 && <span className="join-check-more">and {num(more)} more</span>}
        </div>
        <p className="join-check-fix">Repair: <code>{REPAIR_COMMAND}</code> (dry run by default).</p>
      </section>
    );
  }
  const text = data.state === "clean" ? `Content joins: clean, checked ${day}`
    : data.state === "error" ? `Content joins: the nightly check failed to run${day ? ` on ${day}` : ""}.`
    : "Content joins: not checked yet (the nightly run records it).";
  return <p className="join-check" data-state={data.state} aria-busy="false">{text}</p>;
}
