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

  it("neutralizes raw HTML event-handler injection (no live tag survives)", () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)">');
    expect(html).not.toMatch(/<img[^>]*onerror/i);
  });

  // 2026-08-24 (prod-mode sweep item 3): in-answer links must open in a new
  // tab -- both explicit `[title](url)` markdown links and bare URLs the
  // `linkify: true` option auto-links, since both routes render through
  // markdown-it's shared `link_open` rule.
  describe("in-answer links open in a new tab (item 3)", () => {
    it("an explicit [title](url) link carries target=_blank and rel=noreferrer", () => {
      const html = renderMarkdown("[x](https://e.com)");
      const anchor = /<a\s[^>]*>/.exec(html)?.[0] ?? "";
      expect(anchor).toContain('href="https://e.com"');
      expect(anchor).toContain('target="_blank"');
      expect(anchor).toContain('rel="noreferrer"');
    });

    it("a bare linkified URL carries target=_blank and rel=noreferrer", () => {
      const html = renderMarkdown("see https://e.com for more");
      const anchor = /<a\s[^>]*>/.exec(html)?.[0] ?? "";
      expect(anchor).toContain('href="https://e.com"');
      expect(anchor).toContain('target="_blank"');
      expect(anchor).toContain('rel="noreferrer"');
    });

    it("rel matches the source-pill anchor's own rel exactly (SearchBar.tsx's SourcePill: rel=\"noreferrer\", no noopener)", () => {
      const html = renderMarkdown("[x](https://e.com)");
      // A stray "noopener" would mean this drifted from the pill anchor's
      // exact rel value the item explicitly calls out to match.
      expect(html).not.toContain("noopener");
      expect(html).toContain('rel="noreferrer"');
    });
  });
});
