import { describe, expect, it } from "vitest";
import type { CommandInfo } from "@agent-workstation/protocol";
import { filterCommands, insertCommand, mentionAtCaret, slashQuery } from "./slash";
import { fuzzyMatch } from "./fuzzy";

const cmds: CommandInfo[] = [
  { name: "compact", description: "Compact the conversation", argumentHint: "[instructions]" },
  { name: "clear", description: "Clear history" },
  { name: "config", description: "Open settings" },
  { name: "usage", description: "Show plan usage limits" },
  { name: "review-pr", description: "Review a pull request", isSkill: true, argumentHint: "<number>" },
  { name: "init", description: "Create a CLAUDE.md" },
];

describe("slash palette", () => {
  it("lists everything (built-ins before skills) for an empty query", () => {
    const m = filterCommands(cmds, "");
    expect(m).toHaveLength(cmds.length);
    expect(m[m.length - 1]!.command.name).toBe("review-pr");
  });

  it("ranks prefix matches first", () => {
    expect(filterCommands(cmds, "c").map((m) => m.command.name).slice(0, 3).sort()).toEqual(["clear", "compact", "config"]);
    expect(filterCommands(cmds, "comp")[0]!.command.name).toBe("compact");
  });

  it("fuzzy-matches subsequences and reports highlight indexes", () => {
    const m = filterCommands(cmds, "cmp");
    expect(m[0]!.command.name).toBe("compact");
    expect(m[0]!.nameIndexes).toEqual([0, 2, 3]);
  });

  it("matches skills on word boundaries and on description as a fallback", () => {
    expect(filterCommands(cmds, "rpr")[0]!.command.name).toBe("review-pr");
    expect(filterCommands(cmds, "pull")[0]!.command.name).toBe("review-pr");
    expect(filterCommands(cmds, "zzz")).toEqual([]);
  });

  it("detects an active slash token only before the first whitespace", () => {
    expect(slashQuery("/com", 4)).toBe("com");
    expect(slashQuery("/compact now", 12)).toBeNull();
    expect(slashQuery("hello /x", 8)).toBeNull();
    expect(slashQuery("/", 1)).toBe("");
  });

  it("inserts the command with a trailing space", () => {
    expect(insertCommand(cmds[0]!)).toBe("/compact ");
  });

  it("detects @ mentions under the caret", () => {
    expect(mentionAtCaret("look at @src/ap", 15)).toEqual({ query: "src/ap", start: 8, end: 15 });
    expect(mentionAtCaret("mail me@example.com", 19)).toBeNull();
    expect(mentionAtCaret("@", 1)).toEqual({ query: "", start: 0, end: 1 });
  });

  it("fuzzyMatch prefers exact, then prefix, then subsequence", () => {
    const exact = fuzzyMatch("init", "init")!.score;
    const prefix = fuzzyMatch("in", "init")!.score;
    const sub = fuzzyMatch("it", "init")!.score;
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(sub);
    expect(fuzzyMatch("xyz", "init")).toBeNull();
  });
});
