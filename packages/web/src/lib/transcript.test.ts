import { describe, expect, it } from "vitest";
import { assistant, resultMsg, stored, toolResult, userText } from "../test/fixtures";
import { buildTranscript, emptyPartial, foldDelta, parsePartialJson, partialFromSnapshot, reconcilePartial } from "./transcript";
import { extractEdit } from "./toolSummary";
import { buildDiff } from "./lineDiff";

describe("buildTranscript", () => {
  it("renders user text, assistant text and merges consecutive assistant messages", () => {
    const { items } = buildTranscript([userText(1, "hi"), assistant(2, [{ type: "text", text: "Hello" }]), assistant(3, [{ type: "text", text: "More" }])]);
    expect(items.map((i) => i.kind)).toEqual(["user", "assistant"]);
    const a = items[1]!;
    expect(a.kind === "assistant" && a.blocks.map((b) => b.type)).toEqual(["text", "text"]);
    expect(a.kind === "assistant" && a.endSeq).toBe(3);
  });

  it("carries uuids, times and the final text for the per-message actions", () => {
    const { items } = buildTranscript([
      userText(1, "go", "uu-1"),
      assistant(2, [{ type: "text", text: "Let me look." }]),
      assistant(3, [{ type: "tool_use", id: "t1", name: "Bash", input: {} }]),
      toolResult(4, "t1", "out"),
      assistant(5, [
        { type: "text", text: "One" },
        { type: "text", text: "Two" },
      ]),
      assistant(6, [{ type: "tool_use", id: "t2", name: "Bash", input: {} }]),
    ]);
    const u = items[0]!;
    const a = items[1]!;
    expect(u.kind === "user" && [u.uuid, u.at]).toEqual(["uu-1", new Date(1_700_000_001_000).toISOString()]);
    if (a.kind !== "assistant") throw new Error("assistant expected");
    expect(a.uuids).toEqual(["u-2", "u-3", "u-5", "u-6"]);
    expect(a.uuid).toBe("u-6"); // the last message merged in
    expect(a.at).toBe(new Date(1_700_000_006_000).toISOString());
    expect(a.finalText).toBe("One\n\nTwo"); // the last message that has text, nothing from tools or earlier messages
  });

  it("shows the typed text and file chips from `hub`, not the path note Claude received", () => {
    const sent = stored(1, "user", {
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "what is this\n\nAttached files (paths relative to the working directory):\n- inbox/a.pdf (5 bytes)" }] },
      parent_tool_use_id: null,
      hub: { text: "what is this", attachments: [{ type: "file_ref", path: "inbox/a.pdf", name: "a.pdf", size: 5, mediaType: "application/pdf" }] },
    });
    const [u] = buildTranscript([sent]).items;
    expect(u?.kind === "user" && u.text).toBe("what is this");
    expect(u?.kind === "user" && u.files).toEqual([{ type: "file_ref", path: "inbox/a.pdf", name: "a.pdf", size: 5, mediaType: "application/pdf" }]);
    // an attachment-only message (no text) still shows up, as chips
    const only = stored(2, "user", { type: "user", message: { role: "user", content: [{ type: "text", text: "Attached files:\n- inbox/b.txt" }] }, parent_tool_use_id: null, hub: { text: "", attachments: [{ type: "file_ref", path: "inbox/b.txt", name: "b.txt", size: 1, mediaType: "text/plain" }] } });
    const items = buildTranscript([only]).items;
    expect(items.length).toBe(1);
    expect(items[0]?.kind === "user" && items[0].text).toBe("");
    // messages from before `hub` existed keep rendering from the blocks
    const [old] = buildTranscript([userText(3, "plain")]).items;
    expect(old?.kind === "user" && old.files).toEqual([]);
  });

  it("pairs tool_use with the tool_result from the next user message and hides the result-only user message", () => {
    const { items, tools } = buildTranscript([
      userText(1, "run it"),
      assistant(2, [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } }]),
      toolResult(3, "tu1", [{ type: "text", text: "a.txt\nb.txt" }]),
      assistant(4, [{ type: "text", text: "done" }]),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["user", "assistant"]);
    const tool = tools.get("tu1")!;
    expect(tool.result?.text).toBe("a.txt\nb.txt");
    expect(tool.result?.isError).toBe(false);
    const a = items[1]!;
    expect(a.kind === "assistant" && a.blocks.map((b) => b.type)).toEqual(["tool", "text"]);
  });

  it("attaches a result that arrives before its tool_use (out-of-order delivery)", () => {
    const { tools } = buildTranscript([toolResult(5, "late", "ok"), assistant(2, [{ type: "tool_use", id: "late", name: "Read", input: { file_path: "/x" } }])]);
    expect(tools.get("late")?.result?.text).toBe("ok");
  });

  it("marks error results", () => {
    const { tools } = buildTranscript([assistant(1, [{ type: "tool_use", id: "t", name: "Bash", input: {} }]), toolResult(2, "t", "boom", true)]);
    expect(tools.get("t")?.result?.isError).toBe(true);
  });

  it("emits result dividers with duration/cost/turns", () => {
    const { items } = buildTranscript([userText(1, "x"), resultMsg(2)]);
    const r = items[1]!;
    expect(r.kind).toBe("result");
    if (r.kind === "result") {
      expect(r.durationMs).toBe(12_300);
      expect(r.costUsd).toBeCloseTo(0.0123);
      expect(r.numTurns).toBe(3);
      expect(r.isError).toBe(false);
    }
  });

  it("flags error results", () => {
    const { items } = buildTranscript([resultMsg(1, { subtype: "error_max_turns", is_error: true })]);
    const r = items[0]!;
    expect(r.kind === "result" && r.isError).toBe(true);
  });

  it("renders compact boundaries and resets as dividers", () => {
    const { items } = buildTranscript([stored(1, "system", { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 1234 } }), stored(2, "reset", {})]);
    expect(items.map((i) => i.kind === "divider" && i.variant)).toEqual(["compact", "reset"]);
  });

  it("renders hub system messages (process died, stop timeout, cancelled) and SDK local output / informational", () => {
    const sys = (seq: number, body: Record<string, unknown>) => stored(seq, "system", { type: "system", ...body });
    const { items } = buildTranscript([
      sys(1, { subtype: "hub_process_died", error: "OOM" }),
      sys(2, { subtype: "hub_stop_timeout" }),
      sys(3, { subtype: "hub_cancelled", message_uuids: ["a", "b"], reason: "stop" }),
      sys(4, { subtype: "local_command_output", content: "Compacted" }),
      sys(5, { subtype: "informational", content: "Heads up", level: "warning" }),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["notice", "notice", "notice", "local_output", "notice"]);
    expect(items[0]).toMatchObject({ tone: "error" });
    expect(items[0]!.kind === "notice" && items[0]!.text).toContain("OOM");
    expect(items[1]).toMatchObject({ tone: "warn" });
    expect(items[2]!.kind === "notice" && items[2]!.text).toContain("2 queued");
    expect(items[4]).toMatchObject({ tone: "warn", text: "Heads up" });
  });

  it("hides init/status system messages and synthetic user messages", () => {
    const { items } = buildTranscript([stored(1, "system", { type: "system", subtype: "init" }), stored(2, "user", { type: "user", isSynthetic: true, message: { role: "user", content: "internal" } })]);
    expect(items).toHaveLength(0);
  });

  it("nests sub-agent messages under their Task tool and keeps them out of the main list", () => {
    const { items, tools } = buildTranscript([
      assistant(1, [{ type: "tool_use", id: "task1", name: "Task", input: { description: "dig" } }]),
      assistant(2, [{ type: "text", text: "sub says hi" }], { parent_tool_use_id: "task1" }),
      toolResult(3, "task1", "finished"),
    ]);
    expect(items).toHaveLength(1);
    expect(tools.get("task1")?.children).toHaveLength(1);
  });

  it("turns slash command echo tags into command / local output items", () => {
    const { items } = buildTranscript([
      userText(1, "<command-name>/compact</command-name><command-args>keep tests</command-args>"),
      userText(2, "<local-command-stdout>Compacted</local-command-stdout>"),
    ]);
    expect(items[0]!.kind === "user" && items[0]!.text).toBe("/compact keep tests");
    expect(items[1]!.kind).toBe("local_output");
  });

  it("is order independent", () => {
    const a = [userText(1, "a"), assistant(2, [{ type: "text", text: "b" }]), resultMsg(3)];
    expect(buildTranscript([...a].reverse()).items.map((i) => i.kind)).toEqual(buildTranscript(a).items.map((i) => i.kind));
  });
});

describe("Edit diffs", () => {
  it("extracts Edit / MultiEdit / Write specs", () => {
    expect(extractEdit("Edit", { file_path: "a.ts", old_string: "x", new_string: "y" })?.edits).toEqual([{ oldText: "x", newText: "y" }]);
    expect(extractEdit("MultiEdit", { file_path: "a.ts", edits: [{ old_string: "1", new_string: "2" }, { old_string: "3", new_string: "4" }] })?.edits).toHaveLength(2);
    const w = extractEdit("Write", { file_path: "a.ts", content: "hello\n" });
    expect(w?.isWrite).toBe(true);
    expect(extractEdit("Bash", { command: "ls" })).toBeNull();
  });

  it("builds unified rows with line numbers and stats", () => {
    const { hunks, stats } = buildDiff("one\ntwo\nthree\n", "one\nTWO\nthree\nfour\n");
    expect(stats).toEqual({ additions: 2, deletions: 1 });
    const rows = hunks.flatMap((h) => h.rows);
    expect(rows.find((r) => r.kind === "del")).toMatchObject({ text: "two", oldNo: 2, newNo: null });
    expect(rows.filter((r) => r.kind === "add").map((r) => r.text)).toEqual(["TWO", "four"]);
  });
});

describe("delta folding", () => {
  const id = "m1";
  it("appends text chunks and keeps block order text -> tool", () => {
    let p = emptyPartial();
    p = foldDelta(p, { part: "text", messageId: id, text: "Hel" });
    p = foldDelta(p, { part: "text", messageId: id, text: "lo" });
    p = foldDelta(p, { part: "tool_use_start", messageId: id, toolUseId: "t1", toolName: "Bash" });
    p = foldDelta(p, { part: "tool_use_input", messageId: id, toolUseId: "t1", partialJson: '{"comm' });
    p = foldDelta(p, { part: "tool_use_input", messageId: id, toolUseId: "t1", partialJson: 'and":"ls"}' });
    expect(p.blocks).toEqual([
      { type: "text", text: "Hello" },
      { type: "tool_use", toolUseId: "t1", toolName: "Bash", partialJson: '{"command":"ls"}' },
    ]);
    expect(parsePartialJson((p.blocks[1] as { partialJson: string }).partialJson)).toEqual({ command: "ls" });
  });

  it("keeps thinking and text as separate blocks", () => {
    let p = emptyPartial();
    p = foldDelta(p, { part: "thinking", messageId: id, text: "hmm" });
    p = foldDelta(p, { part: "text", messageId: id, text: "answer" });
    expect(p.blocks.map((b) => b.type)).toEqual(["thinking", "text"]);
  });

  it("ignores the usage part: it carries no content and never resets the partial", () => {
    let p = foldDelta(emptyPartial(), { part: "text", messageId: id, text: "Hello" });
    const before = p;
    expect(foldDelta(p, { part: "usage", messageId: id, outputTokens: 5, turnOutputTokens: 5 })).toBe(before);
    // not even a usage for a different message drops what is streaming
    p = foldDelta(p, { part: "usage", messageId: "other", outputTokens: 1, turnOutputTokens: 6 });
    expect(p.blocks).toEqual([{ type: "text", text: "Hello" }]);
    expect(p.messageId).toBe(id);
  });

  it("starts fresh when a new messageId begins", () => {
    let p = foldDelta(emptyPartial(), { part: "text", messageId: "a", text: "old" });
    p = foldDelta(p, { part: "message_end", messageId: "a" });
    expect(p.ended).toBe(true);
    p = foldDelta(p, { part: "text", messageId: "b", text: "new" });
    expect(p.blocks).toEqual([{ type: "text", text: "new" }]);
    expect(p.messageId).toBe("b");
    expect(p.ended).toBe(false);
  });

  it("repairs truncated JSON for live summaries", () => {
    expect(parsePartialJson('{"file_path":"/a/b.ts","old_str')).toEqual({ file_path: "/a/b.ts" });
    expect(parsePartialJson('{"a":"x')).toEqual({ a: "x" });
    expect(parsePartialJson("")).toEqual({});
  });

  it("reconciles persisted blocks out of the partial, block by block", () => {
    let p = emptyPartial();
    p = foldDelta(p, { part: "text", messageId: id, text: "first" });
    p = foldDelta(p, { part: "tool_use_start", messageId: id, toolUseId: "t1", toolName: "Bash" });
    // assistant message with only the text block is persisted: tool stays streaming
    const afterText = reconcilePartial(p, { message: { content: [{ type: "text", text: "first" }] } });
    expect(afterText.blocks.map((b) => b.type)).toEqual(["tool_use"]);
    const afterTool = reconcilePartial(afterText, { message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] } });
    expect(afterTool.blocks).toEqual([]);
  });

  it("builds a partial from a snapshot", () => {
    const p = partialFromSnapshot({ messageId: "m", text: "so far", thinking: "", currentTool: { toolUseId: "t", toolName: "Read", partialJson: "{" } });
    expect(p.blocks.map((b) => b.type)).toEqual(["text", "tool_use"]);
  });
});
