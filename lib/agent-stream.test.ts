import { describe, it, expect } from "vitest";
import { extractEvents } from "./agent-stream";

describe("extractEvents", () => {
  it("parses status, token, complete from standard \\n\\n framing", () => {
    const buf =
      'data: {"type":"status","text":"Using search_compendium..."}\n\n' +
      'data: {"type":"token","text":"The "}\n\n' +
      'data: {"type":"token","text":"compendium"}\n\n' +
      'data: {"type":"complete","sources":["https://x"],"cluster_ids":[1],"images":[],"tool_calls_made":[{"iteration":1,"tool":"search_compendium","arguments":{"q":"x"},"result_preview":"..."}],"total_cost_usd":0.001,"iterations":1,"model":"gpt-4o-mini"}\n\n';
    const { events, rest } = extractEvents(buf);
    expect(events.map((e) => e.type)).toEqual(["status", "token", "token", "complete"]);
    expect(rest).toBe("");
  });

  it("tolerates single \\n framing", () => {
    const buf = 'data: {"type":"token","text":"a"}\ndata: {"type":"token","text":"b"}\n';
    const { events } = extractEvents(buf);
    expect(events).toHaveLength(2);
  });

  it("keeps a partial trailing line in rest", () => {
    const buf = 'data: {"type":"token","text":"a"}\n\ndata: {"type":"to';
    const { events, rest } = extractEvents(buf);
    expect(events).toHaveLength(1);
    expect(rest).toBe('data: {"type":"to');
  });

  it("ignores malformed and non-data lines", () => {
    const buf = ': keep-alive\n\ndata: not-json\n\ndata: {"type":"token","text":"ok"}\n\n';
    const { events } = extractEvents(buf);
    expect(events).toHaveLength(1);
  });
});
