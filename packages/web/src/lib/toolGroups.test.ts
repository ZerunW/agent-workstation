import { describe, expect, it } from "vitest";
import { liveLabel, summarizeTools, toolKind, type GroupTool } from "./toolGroups";

const bash = (command = "ls"): GroupTool => ({ name: "Bash", input: { command } });
const read = (file_path: string): GroupTool => ({ name: "Read", input: { file_path } });
const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");

describe("summarizeTools", () => {
  it("counts commands: 'a command' / 'N commands'", () => {
    expect(summarizeTools([bash()]).text).toBe("Ran a command");
    expect(summarizeTools([bash(), bash("pwd")]).text).toBe("Ran 2 commands");
  });

  it("names a single file by its base name and counts several", () => {
    expect(summarizeTools([read("/a/b/notes.md")]).text).toBe("Read notes.md");
    expect(summarizeTools([read("/a/x.ts"), read("/a/x.ts")]).text).toBe("Read x.ts");
    expect(summarizeTools([read("/a/1"), read("/a/2"), read("/a/3"), read("/a/4")]).text).toBe("Read 4 files");
    expect(summarizeTools([{ name: "Edit", input: { file_path: "/p/agent.test.ts", old_string: "a", new_string: "b" } }]).text).toMatch(/^Edited agent\.test\.ts/);
    expect(summarizeTools([{ name: "Write", input: { file_path: "/p/a.md", content: "x" } }, { name: "Write", input: { file_path: "/p/b.md", content: "y" } }]).text).toBe("Created 2 files");
  });

  it("joins parts with ', ' in order of first use and capitalises the first letter", () => {
    const s = summarizeTools([{ name: "Write", input: { file_path: "/p/notes.md", content: lines(36) } }, bash()]);
    expect(s.text).toBe("Created notes.md, ran a command");
    expect(s).toMatchObject({ added: 36, removed: 0, failed: 0 });
    expect(summarizeTools([read("/a/1"), read("/a/2"), read("/a/3"), read("/a/4"), { name: "WebSearch", input: { query: "q" } }]).text).toBe("Read 4 files, searched the web");
  });

  it("totals the diff of edits and writes", () => {
    const s = summarizeTools([
      { name: "Edit", input: { file_path: "/p/agent.test.ts", old_string: "const a = 1;", new_string: "const a = 2;" } },
      { name: "MultiEdit", input: { file_path: "/p/b.ts", edits: [{ old_string: "x\n", new_string: "x\ny\n" }] } },
    ]);
    expect(s.text).toBe("Edited 2 files");
    expect(s).toMatchObject({ added: 2, removed: 1 });
    expect(summarizeTools([{ name: "Edit", input: { file_path: "/p/agent.test.ts", old_string: "a", new_string: "b" } }])).toMatchObject({ text: "Edited agent.test.ts", added: 1, removed: 1 });
  });

  it("fetched pages, MCP servers (once each), failures", () => {
    expect(summarizeTools([{ name: "WebFetch", input: { url: "https://a.test" } }]).text).toBe("Fetched a page");
    expect(summarizeTools([{ name: "WebFetch", input: {} }, { name: "WebFetch", input: {} }]).text).toBe("Fetched 2 pages");
    expect(summarizeTools([{ name: "mcp__github__create_issue", input: {} }, { name: "mcp__github__list_prs", input: {} }]).text).toBe("Used github");
    expect(summarizeTools([bash(), { ...bash(), failed: true }, { ...bash(), failed: true }]).failed).toBe(2);
  });

  it("classifies tools by name; unknown names are other", () => {
    expect(toolKind("Bash")).toBe("bash");
    expect(toolKind("Grep")).toBe("search");
    expect(toolKind("mcp__github__x")).toBe("mcp");
    expect(toolKind("mystery")).toBe("other");
    expect(toolKind("run_command")).toBe("other");
  });
});

describe("liveLabel", () => {
  it("shows what the running call does", () => {
    expect(liveLabel({ name: "Bash", input: { command: "npx tsc --noEmit\nsecond line" } })).toBe("Running npx tsc --noEmit…");
    expect(liveLabel({ name: "Edit", input: { file_path: "/p/agent.test.ts" } })).toBe("Editing agent.test.ts…");
    expect(liveLabel({ name: "Write", input: { file_path: "/p/a.md" } })).toBe("Creating a.md…");
    expect(liveLabel({ name: "Read", input: { file_path: "/p/a.md" } })).toBe("Reading a.md…");
    expect(liveLabel({ name: "WebSearch", input: {} })).toBe("Searching the web…");
    expect(liveLabel({ name: "mcp__github__x", input: {} })).toBe("Using github…");
  });
});
