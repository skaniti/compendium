import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import TopicDetailPanel from "./TopicDetailPanel";

describe("TopicDetailPanel", () => {
  it("renders the panel-header-band with the Topic Detail label", () => {
    const { container } = render(<TopicDetailPanel />);

    const band = container.querySelector(".panel-header-band");
    expect(band).toBeInTheDocument();
    expect(band?.querySelector(".panel-header")).toHaveTextContent("Topic Detail");
  });

  it("renders the nothing-selected placeholder inside #detail-container", () => {
    const { container } = render(<TopicDetailPanel />);

    const detailContainer = container.querySelector("#detail-container");
    expect(detailContainer).toBeInTheDocument();

    const scroll = detailContainer?.querySelector(".panel-scroll");
    expect(scroll).toBeInTheDocument();

    const placeholder = scroll?.querySelector(".placeholder-text");
    expect(placeholder).toBeInTheDocument();
    expect(placeholder).toHaveTextContent("Click a node in the graph to see details.");
  });

  it("does not render the debug console or suggested-topics panel (batch mig-02)", () => {
    const { container } = render(<TopicDetailPanel />);

    expect(container.querySelector("#sc-debug-console")).not.toBeInTheDocument();
    expect(container.querySelector("#suggested-topics-panel")).not.toBeInTheDocument();
  });

  it("matches the exact placeholder copy via screen query", () => {
    render(<TopicDetailPanel />);

    expect(
      screen.getByText("Click a node in the graph to see details."),
    ).toBeInTheDocument();
  });
});
