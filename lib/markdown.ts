import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";

// typographer:false -> no smart-punctuation substitutions (user preference).
// html:false (default) -> raw HTML in the source is escaped, not passed through.
const md = new MarkdownIt({ typographer: false, linkify: true, breaks: false });

// Defense-in-depth: markdown-it (html:false) already escapes raw HTML, but the
// output is injected via dangerouslySetInnerHTML, so run DOMPurify as a second
// layer that strips any dangerous markup/attributes/URIs that could slip through
// (future config/plugin changes, markdown-it CVEs). Client-only render path, so
// window is always present when this runs.
export function renderMarkdown(src: string): string {
  return DOMPurify.sanitize(md.render(src));
}
