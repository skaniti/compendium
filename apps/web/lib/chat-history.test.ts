import { describe, it, expect } from "vitest";
import {
  buildHistory,
  HISTORY_ASSISTANT_MIN,
  HISTORY_CHAR_BUDGET,
  HISTORY_ELLIPSIS,
  HISTORY_MAX_EXCHANGES,
  HISTORY_TURN_CAP,
  HISTORY_USER_MIN,
  type Exchange,
} from "./chat-history";

const sentences = (n: number, len = 60) =>
  Array.from({ length: n }, (_, i) => `S${i} ${"x".repeat(len)}.`).join(" ");
const total = (h: { content: string }[]) => h.reduce((s, t) => s + t.content.length, 0);

describe("buildHistory", () => {
  it("returns [] for no exchanges", () => {
    expect(buildHistory([])).toEqual([]);
  });

  it("keeps the newest exchange verbatim when it fits", () => {
    const ex: Exchange = { user: "u".repeat(1500), assistant: "a".repeat(1900) };
    const h = buildHistory([ex]);
    expect(h).toEqual([
      { role: "user", content: ex.user },
      { role: "assistant", content: ex.assistant },
    ]);
  });

  it("halves the assistant allowance per age step (k=1 -> 1000) and cuts user to the minimum", () => {
    const old: Exchange = { user: sentences(20), assistant: sentences(40) };
    const h = buildHistory([old, { user: "q", assistant: "a" }]);
    expect(h[0].content.length).toBeLessThanOrEqual(HISTORY_USER_MIN);
    expect(h[0].content.endsWith(HISTORY_ELLIPSIS)).toBe(true);
    expect(h[1].content.length).toBeLessThanOrEqual(1000);
    expect(h[1].content.length).toBeGreaterThan(900);
  });

  it("never condenses an assistant answer below the minimum allowance for old exchanges", () => {
    const exs: Exchange[] = Array.from({ length: 6 }, () => ({ user: "u", assistant: sentences(40) }));
    const h = buildHistory(exs);
    const oldestAssistant = h[1].content;
    expect(oldestAssistant.length).toBeLessThanOrEqual(HISTORY_ASSISTANT_MIN);
    expect(oldestAssistant.length).toBeGreaterThan(HISTORY_ASSISTANT_MIN / 2);
  });

  it("cuts at a sentence boundary and appends the ellipsis", () => {
    const first = "First sentence here" + " and it keeps going".repeat(8) + ".";
    const text = first + " Second sentence goes on and on and on " + "y".repeat(400);
    const h = buildHistory([{ user: text, assistant: "a" }, { user: "q", assistant: "a" }]);
    expect(h[0].content).toBe(first + HISTORY_ELLIPSIS);
  });

  it("falls back to a word boundary, then a hard cut", () => {
    const words = Array.from({ length: 200 }, () => "word").join(" ");
    const w = buildHistory([{ user: words, assistant: "a" }, { user: "q", assistant: "a" }])[0].content;
    expect(w.endsWith("word" + HISTORY_ELLIPSIS)).toBe(true);
    const hard = buildHistory([{ user: "z".repeat(900), assistant: "a" }, { user: "q", assistant: "a" }])[0].content;
    expect(hard.length).toBe(HISTORY_USER_MIN);
    expect(hard.endsWith(HISTORY_ELLIPSIS)).toBe(true);
  });

  it("stays inside the character budget and shrinks the oldest exchanges first", () => {
    const exs: Exchange[] = Array.from({ length: 5 }, (_, i) => ({
      user: `${i}` + "u".repeat(1900),
      assistant: `${i}` + "a".repeat(1900),
    }));
    const h = buildHistory(exs);
    expect(total(h)).toBeLessThanOrEqual(HISTORY_CHAR_BUDGET);
    expect(h).toHaveLength(10);
    // newest untouched, oldest condensed
    expect(h[8].content).toBe(exs[4].user);
    expect(h[9].content).toBe(exs[4].assistant);
    expect(h[0].content.length).toBeLessThan(exs[0].user.length);
  });

  it("drops the oldest only once every exchange with k >= 2 is at its minimums", () => {
    const one = { user: "u".repeat(1000), assistant: "a".repeat(1000) };
    const many: Exchange[] = Array.from({ length: 40 }, (_, i) => ({ ...one, user: `${i}` + one.user }));
    const h = buildHistory(many);
    expect(total(h)).toBeLessThanOrEqual(HISTORY_CHAR_BUDGET);
    expect(h.length).toBeLessThan(80);
    expect(h[h.length - 2].content.startsWith("39")).toBe(true);
    // the two newest are exempt from the minimum shrink
    expect(h[h.length - 1].content.length).toBeGreaterThan(HISTORY_ASSISTANT_MIN);
    // the surviving oldest is at its minimums
    expect(h[0].content.length).toBeLessThanOrEqual(HISTORY_USER_MIN);
    expect(h[1].content.length).toBeLessThanOrEqual(HISTORY_ASSISTANT_MIN);
    // fewer than the drop threshold does not drop
    expect(buildHistory(many.slice(0, 5))).toHaveLength(10);
  });

  it("keeps the newest verbatim in a 40-exchange chat", () => {
    const asst = Array.from({ length: 14 }, (_, i) => `Sentence ${i} ${"w".repeat(90)}.`).join(" ");
    const exs: Exchange[] = Array.from({ length: 40 }, () => ({ user: "q".repeat(100), assistant: asst }));
    const h = buildHistory(exs);
    expect(total(h)).toBeLessThanOrEqual(HISTORY_CHAR_BUDGET);
    expect(h[h.length - 1].content).toBe(asst);
    expect(h[h.length - 3].content.length).toBeLessThanOrEqual(1000);
    expect(h[h.length - 3].content.length).toBeGreaterThan(900);
    expect(h[1].content.length).toBeLessThanOrEqual(HISTORY_ASSISTANT_MIN);
    expect(h.length).toBeGreaterThan(10);
  });

  it("does not collapse to a stub when the first space is early", () => {
    const c = buildHistory([{ user: "a " + "x".repeat(500), assistant: "r" }, { user: "q", assistant: "a" }])[0].content;
    expect(c.length).toBe(HISTORY_USER_MIN);
  });

  it("trims whitespace before condensing", () => {
    const c = buildHistory([{ user: "   " + "x".repeat(500), assistant: "  r" }, { user: "q", assistant: "a" }]);
    expect(c[0].content.startsWith("x")).toBe(true);
    expect(c[1].content).toBe("r");
  });

  it("alternates roles, oldest first, with no empty content", () => {
    const exs: Exchange[] = [
      { user: "a", assistant: "b" },
      { user: "   ", assistant: "skipped" },
      { user: "c", assistant: "d" },
    ];
    const h = buildHistory(exs);
    expect(h.map((t) => t.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(h.every((t) => t.content.length > 0)).toBe(true);
    expect(HISTORY_TURN_CAP).toBe(2000);
  });

  it("caps at HISTORY_MAX_EXCHANGES, keeping the newest", () => {
    const exs: Exchange[] = Array.from({ length: 40 }, (_, i) => ({ user: `q${i}`, assistant: `a${i}` }));
    const h = buildHistory(exs);
    expect(HISTORY_MAX_EXCHANGES).toBe(30);
    expect(h).toHaveLength(60);
    expect(h[0].content).toBe("q10");
    expect(h[59].content).toBe("a39");
  });

  it("does not collapse to a stub on an early newline or sentence boundary", () => {
    const c = buildHistory([{ user: "Title\n" + "x".repeat(1500), assistant: "r" }, { user: "q", assistant: "a" }])[0].content;
    expect(c.length).toBe(HISTORY_USER_MIN);
    const d = buildHistory([{ user: "Hi. " + "x".repeat(500), assistant: "r" }, { user: "q", assistant: "a" }])[0].content;
    expect(d.length).toBe(HISTORY_USER_MIN);
  });
});
