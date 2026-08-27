import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import TopicDetailPanel from "./TopicDetailPanel";

// TopicDetail (task 7) calls useNav()/useGraph(), which need a NavProvider
// and a mocked fetchGraph to render meaningfully -- these band/container
// tests don't want to stand up all of that just to render TopicDetailPanel.
// Mock the child directly (same tradeoff HistoryPanel.test.tsx takes with
// DiaryPanel) and assert only that it's mounted inside #detail-container --
// TopicDetail's own behavior is covered by TopicDetail.test.tsx.
vi.mock("./TopicDetail", () => ({
  default: () => <div data-testid="topic-detail-mock" />,
}));

describe("TopicDetailPanel", () => {
  it("renders the panel-header-band with the Topic Detail label", () => {
    const { container } = render(<TopicDetailPanel />);

    const band = container.querySelector(".panel-header-band");
    expect(band).toBeInTheDocument();
    expect(band?.querySelector(".panel-header")).toHaveTextContent("Topic Detail");
  });

  it("renders TopicDetail inside #detail-container", () => {
    const { container } = render(<TopicDetailPanel />);

    const detailContainer = container.querySelector("#detail-container");
    expect(detailContainer).toBeInTheDocument();
    expect(detailContainer?.querySelector('[data-testid="topic-detail-mock"]')).toBeInTheDocument();
  });

  it("does not render the debug console or suggested-topics panel (batch mig-02)", () => {
    const { container } = render(<TopicDetailPanel />);

    expect(container.querySelector("#sc-debug-console")).not.toBeInTheDocument();
    expect(container.querySelector("#suggested-topics-panel")).not.toBeInTheDocument();
  });

  it("renders exactly one TopicDetail instance", () => {
    render(<TopicDetailPanel />);
    expect(screen.getAllByTestId("topic-detail-mock")).toHaveLength(1);
  });
});
