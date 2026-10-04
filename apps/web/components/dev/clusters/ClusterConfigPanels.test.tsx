import { render, screen } from "@testing-library/react";
import { it, expect } from "vitest";
import { OVERRIDE_SHOWN_NOTE, OVERRIDE_WITHHELD_NOTE } from "@/lib/prompts";
import ClusterConfigPanels from "./ClusterConfigPanels";
import { summary } from "./test-fixtures";

const config = () => summary().config;

it("two closed details with chips in the summaries", () => {
  const { container } = render(<ClusterConfigPanels config={config()} />);
  const details = container.querySelectorAll("details");
  expect(details).toHaveLength(2);
  details.forEach((d) => expect(d.open).toBe(false));
  const chips = (i: number) => Array.from(details[i].querySelectorAll("summary .dev-chip")).map((c) => c.textContent);
  expect(chips(0)).toEqual(["embed-small", "min size 2", "eom", "cosine"]);
  expect(chips(1)).toEqual(["namer-mini", "temp 0.3", "cluster_naming_v1"]);
});
it("body rows and the prompt", () => {
  const { container } = render(<ClusterConfigPanels config={config()} />);
  for (const t of ["2 · this run 2 (max(2, pages ÷ 150))", "cosine (precomputed)", "15%", "up to 10 pages per cluster"]) {
    expect(screen.getByText(t)).toBeInTheDocument();
  }
  expect(container.querySelector("pre.config-prompt")).toHaveTextContent("Name this cluster of {n_pages} pages.");
});
it("euclidean distance names the UMAP settings", () => {
  const c = config();
  render(<ClusterConfigPanels config={{ ...c, clustering: { ...c.clustering, metric: "euclidean", umap_dims: 5, umap_n_neighbors: 30 } }} />);
  expect(screen.getByText("euclidean on UMAP-5 (nn=30)")).toBeInTheDocument();
});
it("missing prompt", () => {
  const c = config();
  render(<ClusterConfigPanels config={{ ...c, naming: { ...c.naming, prompt: null } }} />);
  expect(screen.getByText("Prompt template not found.")).toBeInTheDocument();
});
it("no effective min size", () => {
  const c = config();
  render(<ClusterConfigPanels config={{ ...c, clustering: { ...c.clustering, effective_min_cluster_size: null } }} />);
  expect(screen.getByText("2 (max(2, pages ÷ 150))")).toBeInTheDocument();
});
it("a withheld naming override gets its note; no prompt, no note", () => {
  const c = config();
  const { container, unmount } = render(<ClusterConfigPanels config={{ ...c, naming: { ...c.naming, prompt_override: "withheld" } }} />);
  expect(screen.getByText(OVERRIDE_WITHHELD_NOTE)).toHaveClass("config-note");
  expect(container.querySelector("pre.config-prompt")).toBeTruthy();
  unmount();
  const r = render(<ClusterConfigPanels config={{ ...c, naming: { ...c.naming, prompt: null, prompt_override: "withheld" } }} />);
  expect(r.container.querySelector(".config-note")).toBeNull();
});
it("a shown naming override gets its note; a payload without the field gets none", () => {
  const c = config();
  const { unmount } = render(<ClusterConfigPanels config={{ ...c, naming: { ...c.naming, prompt_override: "shown" } }} />);
  expect(screen.getByText(OVERRIDE_SHOWN_NOTE)).toHaveClass("config-note");
  unmount();
  const r = render(<ClusterConfigPanels config={c} />);
  expect("prompt_override" in c.naming).toBe(false);
  expect(r.container.querySelector(".config-note")).toBeNull();
});
