import { describe, expect, it } from "vitest";
import { askPayload, headingId, parseReadme, plainText, readSse, tableOfContents } from "./readme";

const stream = (...chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      for (const x of chunks) c.enqueue(enc.encode(x));
      c.close();
    },
  });

describe("parseReadme", () => {
  it("plain Markdown stays one block", () => {
    expect(parseReadme("# A\n\ntext")).toEqual([{ kind: "md", text: "# A\n\ntext" }]);
  });

  it("splits <details>/<summary> into folded sections between Markdown runs", () => {
    const blocks = parseReadme("intro\n\n<details>\n<summary>More **detail**</summary>\n\nbody `x`\n\n</details>\n\noutro");
    expect(blocks).toEqual([
      { kind: "md", text: "intro\n" },
      { kind: "details", summary: "More detail", open: false, body: [{ kind: "md", text: "\nbody `x`\n" }] },
      { kind: "md", text: "\noutro" },
    ]);
  });

  it("supports `open`, a one-line form and nesting", () => {
    const blocks = parseReadme("<details open><summary>Outer</summary>\na\n<details>\n<summary>Inner</summary>\nb\n</details>\n</details>");
    expect(blocks).toHaveLength(1);
    const outer = blocks[0];
    if (outer.kind !== "details") throw new Error("expected details");
    expect(outer).toMatchObject({ summary: "Outer", open: true });
    expect(outer.body.map((b) => b.kind)).toEqual(["md", "details"]);
  });

  it("leaves tags inside code fences alone", () => {
    const md = "```html\n<details>\n<summary>x</summary>\n</details>\n```";
    expect(parseReadme(md)).toEqual([{ kind: "md", text: md }]);
  });

  it("closes an unclosed section at the end", () => {
    expect(parseReadme("<details>\n<summary>S</summary>\nbody")).toEqual([{ kind: "details", summary: "S", open: false, body: [{ kind: "md", text: "body" }] }]);
  });
});

describe("table of contents", () => {
  it("lists ## headings outside code and folded sections", () => {
    const blocks = parseReadme("# Title\n\n## One\n\n### Sub\n\n```\n## not a heading\n```\n\n<details>\n<summary>S</summary>\n## hidden\n</details>\n\n## Two `code`\n");
    expect(tableOfContents(blocks)).toEqual([
      { id: "readme-one", text: "One" },
      { id: "readme-two-code", text: "Two code" },
    ]);
  });

  it("heading ids and plain text agree", () => {
    expect(headingId(plainText("Chat & [Code](x) **now**"))).toBe("readme-chat-code-now");
    expect(headingId("")).toBe("readme-section");
  });
});

describe("askPayload", () => {
  it("keeps the last 20 turns, starting with a user turn, each at most 4000 chars", () => {
    const history = Array.from({ length: 25 }, (_, i) => ({ role: i % 2 === 0 ? ("user" as const) : ("assistant" as const), text: "x".repeat(5000) }));
    const out = askPayload(history);
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out[0].role).toBe("user");
    expect(out.at(-1)?.role).toBe("user");
    expect(out.every((m) => m.text.length === 4000)).toBe(true);
  });
});

describe("readSse", () => {
  const collect = async (s: ReadableStream<Uint8Array>) => {
    const out = [];
    for await (const e of readSse(s)) out.push(e);
    return out;
  };

  it("parses events split across chunks, CRLF and a final event without a blank line", async () => {
    const events = await collect(stream('event: delta\ndata: {"te', 'xt":"a"}\r\n\r\nevent: delta\ndata: {"text":"b"}\n\n', 'event: done\ndata: {"costUsd":0}'));
    expect(events).toEqual([
      { event: "delta", data: '{"text":"a"}' },
      { event: "delta", data: '{"text":"b"}' },
      { event: "done", data: '{"costUsd":0}' },
    ]);
  });
});
