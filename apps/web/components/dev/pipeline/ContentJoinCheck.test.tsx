import { render, screen, waitFor } from "@testing-library/react";
import { vi, it, expect, beforeEach } from "vitest";
import * as api from "@/lib/api";
import type { ContentJoinCheckResult } from "@/lib/types";
import ContentJoinCheck from "./ContentJoinCheck";
vi.mock("@/lib/api");
const result = (o: Partial<ContentJoinCheckResult> = {}): ContentJoinCheckResult => ({ state: "clean", checked_at: "2026-10-22T07:30:00+00:00", count: 0, page_ids: [], ...o });
const mount = () => render(<ContentJoinCheck tz="UTC" />);
beforeEach(() => vi.resetAllMocks());

it("shows a quiet busy line while the check loads", () => {
  vi.mocked(api.fetchContentJoinCheck).mockReturnValue(new Promise(() => {}));
  const { container } = mount();
  expect(container.querySelector(".join-check")).toHaveAttribute("aria-busy", "true");
  expect(container).toHaveTextContent("Content joins: checking…");
});
it("clean: a quiet one-line status with the check time in the given zone", async () => {
  vi.mocked(api.fetchContentJoinCheck).mockResolvedValue(result());
  const { container } = mount();
  await screen.findByText(/Content joins: clean, checked Oct 22, 2026/);
  const el = container.querySelector(".join-check") as HTMLElement;
  expect(el).toHaveAttribute("data-state", "clean");
  expect(el.classList.contains("is-mismatch")).toBe(false);
  expect(el).toHaveAttribute("aria-busy", "false");
  expect(container.querySelector(".join-check-ids")).toBeNull();
});
it("the check time follows the given time zone", async () => {
  vi.mocked(api.fetchContentJoinCheck).mockResolvedValue(result({ checked_at: "2026-10-22T02:30:00+00:00" }));
  render(<ContentJoinCheck tz="America/New_York" />);
  await screen.findByText(/checked Oct 21, 2026/);
});
it("mismatches: stands out with the count, the page ids and the repair command", async () => {
  vi.mocked(api.fetchContentJoinCheck).mockResolvedValue(result({ state: "mismatches", count: 3, page_ids: [41, 42, 977] }));
  const { container } = mount();
  const el = (await waitFor(() => { const e = container.querySelector(".join-check.is-mismatch"); expect(e).toBeTruthy(); return e; })) as HTMLElement;
  expect(el).toHaveAttribute("data-state", "mismatches");
  expect(el).toHaveAttribute("role", "alert");
  expect(el).toHaveTextContent("Content joins: 3 pages point at another URL's content");
  expect(el).toHaveTextContent("checked Oct 22, 2026");
  const ids = el.querySelector(".join-check-ids") as HTMLElement;
  expect([...ids.querySelectorAll(".dev-chip")].map((c) => c.textContent)).toEqual(["41", "42", "977"]);
  expect(el).not.toHaveTextContent("more");
  expect(el.querySelector("code")).toHaveTextContent("python -m backend.scripts.repair_page_content_joins");
  expect(el).toHaveTextContent("dry run by default");
});
it("mismatches: one page reads singular; ids beyond the stored cap show as 'and N more'", async () => {
  vi.mocked(api.fetchContentJoinCheck).mockResolvedValue(result({ state: "mismatches", count: 1, page_ids: [7] }));
  const first = mount();
  await screen.findByText(/1 page points at another URL's content/);
  first.unmount();
  vi.mocked(api.fetchContentJoinCheck).mockResolvedValue(result({ state: "mismatches", count: 1234, page_ids: Array.from({ length: 20 }, (_, i) => i + 1) }));
  const { container } = mount();
  await screen.findByText(/1,234 pages point at another URL's content/);
  expect(container.querySelectorAll(".join-check-ids .dev-chip")).toHaveLength(20);
  expect(container.querySelector(".join-check-ids")).toHaveTextContent("and 1,214 more");
});
it("error: says the last nightly check failed to run", async () => {
  vi.mocked(api.fetchContentJoinCheck).mockResolvedValue(result({ state: "error" }));
  const { container } = mount();
  await screen.findByText(/Content joins: the nightly check failed to run on Oct 22, 2026/);
  expect(container.querySelector(".join-check")).toHaveAttribute("data-state", "error");
});
it("never: says no nightly run has checked yet", async () => {
  vi.mocked(api.fetchContentJoinCheck).mockResolvedValue(result({ state: "never", checked_at: null }));
  const { container } = mount();
  await screen.findByText("Content joins: not checked yet (the nightly run records it).");
  expect(container.querySelector(".join-check")).toHaveAttribute("data-state", "never");
});
it("a failed request shows a plain line with the reason", async () => {
  vi.mocked(api.fetchContentJoinCheck).mockRejectedValue(new Error("fetchContentJoinCheck failed: 404 Not Found"));
  const { container } = mount();
  await screen.findByText("Content joins: couldn't load the check (fetchContentJoinCheck failed: 404 Not Found).");
  expect(container.querySelector(".join-check")).toHaveAttribute("data-state", "unavailable");
});
it("renders no native title tooltips", async () => {
  vi.mocked(api.fetchContentJoinCheck).mockResolvedValue(result({ state: "mismatches", count: 2, page_ids: [1, 2] }));
  const { container } = mount();
  await screen.findByText(/pages point at another URL/);
  expect(container.querySelector("[title]")).toBeNull();
});
