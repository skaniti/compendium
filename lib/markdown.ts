import MarkdownIt from "markdown-it";

// typographer:false -> no smart-punctuation substitutions (user preference).
// html:false (default) -> raw HTML in the source is escaped, not passed through.
const md = new MarkdownIt({ typographer: false, linkify: true, breaks: false });

export function renderMarkdown(src: string): string {
  return md.render(src);
}
