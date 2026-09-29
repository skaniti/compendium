import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";

// typographer:false -> no smart-punctuation substitutions (user preference).
// html:false (default) -> raw HTML in the source is escaped, not passed through.
const md = new MarkdownIt({ typographer: false, linkify: true, breaks: false });

// 2026-08-24 (prod-mode sweep item 3): in-answer links open in a new tab.
// Overriding the `link_open` renderer rule (rather than post-processing the
// rendered HTML string) catches BOTH token sources markdown-it's renderer
// funnels through the same rule: explicit `[title](url)` links AND bare
// URLs the `linkify: true` option above auto-links -- both produce
// `link_open` tokens, so one rule covers both without a second code path.
// `rel="noreferrer"` matches the pill anchor's own rel exactly
// (components/SearchBar.tsx's SourcePill, `rel="noreferrer"` -- no
// `noopener`, since `noreferrer` already implies `noopener` behavior per
// the HTML spec/all evergreen browsers, so there is no gap being carried
// over here). DOMPurify below is configured with `ADD_ATTR: ["target"]` so
// this rule's `target` attribute survives sanitization (see that call's
// own comment for why `target` specifically needs it) -- `rel` already
// passes through DOMPurify's default ALLOWED_ATTR list unchanged.
const defaultLinkOpenRender =
  md.renderer.rules.link_open ??
  function (tokens, idx, options, env, self) {
    return self.renderToken(tokens, idx, options);
  };
md.renderer.rules.link_open = function (tokens, idx, options, env, self) {
  const token = tokens[idx];
  const targetIdx = token.attrIndex("target");
  if (targetIdx < 0) token.attrPush(["target", "_blank"]);
  else token.attrs![targetIdx][1] = "_blank";
  const relIdx = token.attrIndex("rel");
  if (relIdx < 0) token.attrPush(["rel", "noreferrer"]);
  else token.attrs![relIdx][1] = "noreferrer";
  // Dash parity (search_stream.js parseInline): every in-answer link is a
  // .tag-pill, the same chip the source row uses, not a browser-default
  // blue underlined anchor -- which is unreadable on the dark palettes.
  // `class` is in DOMPurify's default ALLOWED_ATTR, so it survives sanitize.
  token.attrJoin("class", "tag-pill");
  return defaultLinkOpenRender(tokens, idx, options, env, self);
};

// Defense-in-depth: markdown-it (html:false) already escapes raw HTML, but the
// output is injected via dangerouslySetInnerHTML, so run DOMPurify as a second
// layer that strips any dangerous markup/attributes/URIs that could slip through
// (future config/plugin changes, markdown-it CVEs). Client-only render path, so
// window is always present when this runs. `ADD_ATTR: ["target"]` is required --
// DOMPurify's own default ALLOWED_ATTR already permits `rel`, but strips
// `target` unless explicitly added back (its documented reverse-tabnabbing
// safeguard against a bare `target="_blank"` with no `rel`); safe here since
// the renderer rule above always pairs it with `rel="noreferrer"`.
export function renderMarkdown(src: string): string {
  return DOMPurify.sanitize(md.render(src), { ADD_ATTR: ["target"] });
}
