import { it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import StatusCards from "./StatusCards";
it("shows four cards with the archive ratio as xx.x%", () => {
  render(<StatusCards counts={{ active: 1271, pending: 2, archived: 30 }} ratio={0.2304} />);
  expect(screen.getByText("1,271")).toBeInTheDocument();
  for (const l of ["Active", "Pending", "Archived", "Archive Ratio"]) expect(screen.getByText(l)).toBeInTheDocument();
  expect(screen.getByText("23.0%")).toBeInTheDocument();
});
it("zero period shows 0 and 0.0%", () => {
  render(<StatusCards counts={{ active: 0, pending: 0, archived: 0 }} ratio={0} />);
  expect(screen.getByText("0.0%")).toBeInTheDocument();
  expect(screen.getAllByText("0")).toHaveLength(3);
});
