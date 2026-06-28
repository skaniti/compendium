import { describe, it, expect } from "vitest";
import { renderMarkdown } from "./markdown";

describe("renderMarkdown", () => {
  it("renders bold and links", () => {
    const html = renderMarkdown("**hi** [x](https://e.com)");
    expect(html).toContain("<strong>hi</strong>");
    expect(html).toContain('href="https://e.com"');
  });

  it("does NOT apply typographer substitutions (faithful)", () => {
    expect(renderMarkdown("(c)")).toContain("(c)"); // not the copyright glyph
  });

  it("escapes raw HTML (no injection)", () => {
    expect(renderMarkdown("<script>x</script>")).not.toContain("<script>");
  });
});
