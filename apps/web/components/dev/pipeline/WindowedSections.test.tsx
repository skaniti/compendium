import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi, it, expect } from "vitest";
import * as api from "@/lib/api";
import WindowedSections from "./WindowedSections";
vi.mock("@/lib/api");
const health = { active_count: 224, archived_count: 1164, by_reason: [{ reason: "skip_gate", count: 662, top_domains: [{ domain: "docs.example.net", count: 169 }, { domain: "example.org", count: 150 }, { domain: "shop.example.com", count: 82 }, { domain: "x.example", count: 1 }] }],
  per_capture: [{ capture_id: "c1", started_at: "2026-08-01T10:00:00+00:00", archived: 1, total: 2, rate: 0.5 }] };
const trends = { range: "30d", skip_rate: [{ day: "2026-08-01", total: 3, skipped: 1 }], skip_reasons: [{ day: "2026-08-01", reason: "login wall", cnt: 2 }] };
it("fetches both sections with the default 30d window and re-fetches on pill change", async () => {
  vi.mocked(api.fetchArchiveHealth).mockResolvedValue(health);
  vi.mocked(api.fetchSkipTrends).mockResolvedValue(trends);
  render(<WindowedSections />);
  await screen.findByText("83.9%");
  expect(screen.getByText("docs.example.net (169), example.org (150), shop.example.com (82)")).toBeInTheDocument();
  expect(screen.getByText("LLM Skip Gate")).toBeInTheDocument();
  expect(screen.getByText("662").parentElement).toHaveTextContent("662 57%"); // of archived_count 1164
  expect(api.fetchArchiveHealth).toHaveBeenCalledWith("30d");
  expect(api.fetchSkipTrends).toHaveBeenCalledWith("30d");
  await userEvent.click(screen.getByRole("button", { name: "All time" }));
  await waitFor(() => expect(api.fetchSkipTrends).toHaveBeenLastCalledWith("all"));
  expect(api.fetchArchiveHealth).toHaveBeenLastCalledWith("all");
});
it("renders honest empty captions", async () => {
  vi.mocked(api.fetchArchiveHealth).mockResolvedValue({ active_count: 0, archived_count: 0, by_reason: [], per_capture: [] });
  vi.mocked(api.fetchSkipTrends).mockResolvedValue({ range: "30d", skip_rate: [], skip_reasons: [] });
  render(<WindowedSections />);
  await screen.findByText("No archived pages in this window.");
  expect(screen.getByText("No captures in this window.")).toBeInTheDocument();
  expect(screen.getByText("No evaluated pages in this window.")).toBeInTheDocument();
  expect(screen.getByText("No skipped pages in this window.")).toBeInTheDocument();
});
it("a health failure does not hide the trends section", async () => {
  vi.mocked(api.fetchArchiveHealth).mockRejectedValue(new Error("boom"));
  vi.mocked(api.fetchSkipTrends).mockResolvedValue(trends);
  render(<WindowedSections />);
  await screen.findByText(/Couldn't load archive health \(boom\)/);
  expect(await screen.findByText("Skip reason mix")).toBeInTheDocument();
});
it("shows the empty-captures caption when every capture lacks started_at", async () => {
  vi.mocked(api.fetchArchiveHealth).mockResolvedValue({ ...health, per_capture: [{ capture_id: "c9", started_at: null, archived: 0, total: 1, rate: 0 }] });
  vi.mocked(api.fetchSkipTrends).mockResolvedValue(trends);
  render(<WindowedSections />);
  expect(await screen.findByText("No captures in this window.")).toBeInTheDocument();
});
