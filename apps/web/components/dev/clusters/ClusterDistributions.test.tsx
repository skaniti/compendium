import { render, screen } from "@testing-library/react";
import { it, expect } from "vitest";
import ClusterDistributions from "./ClusterDistributions";
import { summary } from "./test-fixtures";

const props = () => { const s = summary(); return { clusters: s.clusters, edges: s.edges, threshold: 0.15, maxEdges: 3 }; };

it("two titled panels with their captions", () => {
  const { container } = render(<ClusterDistributions {...props()} />);
  expect(screen.getByRole("heading", { name: "Cluster sizes" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Similarity between clusters" })).toBeInTheDocument();
  expect(screen.getByText("Pages per cluster in the current run.")).toBeInTheDocument();
  expect(screen.getByText("Cosine similarity of cluster centroids. Edges are kept above 15%, at most 3 per cluster; the graph draws them as links.")).toBeInTheDocument();
  expect(container.querySelectorAll("svg").length).toBeGreaterThanOrEqual(2);
});
it("no edges", () => {
  render(<ClusterDistributions {...props()} edges={{ count: 0, min: null, max: null, mean: null, bins: [] }} />);
  expect(screen.getByText("No similarity edges in this run.")).toBeInTheDocument();
});
it("no clusters", () => {
  render(<ClusterDistributions {...props()} clusters={[]} />);
  expect(screen.getByText("No clusters in this run.")).toBeInTheDocument();
});
