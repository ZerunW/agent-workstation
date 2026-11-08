import { Text } from "@codemirror/state";
import { Chunk } from "@codemirror/merge";
import type { Hunk } from "@agent-workstation/protocol";
import { describe, expect, it } from "vitest";
import { buildDiff } from "../../lib/lineDiff";
import { chunkInfo, chunkLineRange, hunkChangedLines, mapChunkToHunks, minimalChange } from "./chunks";

const hunk = (index: number, oldStart: number, newStart: number, lines: string[]): Hunk => ({
  index,
  oldStart,
  newStart,
  oldLines: lines.filter((l) => l[0] !== "+").length,
  newLines: lines.filter((l) => l[0] !== "-").length,
  header: "@@",
  lines,
});

describe("hunkChangedLines", () => {
  it("numbers removed lines on the old side and added lines on the new side, skipping context", () => {
    const h = hunk(0, 10, 12, [" ctx", "-gone", "+new1", "+new2", " ctx"]);
    expect(hunkChangedLines(h)).toEqual({ removed: [11], added: [13, 14] });
  });
});

describe("mapChunkToHunks", () => {
  const hunks = [hunk(0, 3, 3, [" a", "-b", "+B", " c"]), hunk(1, 40, 41, [" x", "+inserted", " y"]), hunk(2, 90, 92, [" p", "-q", " r"])];

  it("maps by overlapping changed lines (replacement, insertion, deletion)", () => {
    expect(mapChunkToHunks({ index: 0, oldStartLine: 4, oldEndLine: 4, newStartLine: 4, newEndLine: 4 }, hunks)).toEqual([0]);
    // pure insertion: empty old side (end = start - 1)
    expect(mapChunkToHunks({ index: 1, oldStartLine: 40, oldEndLine: 39, newStartLine: 42, newEndLine: 42 }, hunks)).toEqual([1]);
    // pure deletion: empty new side
    expect(mapChunkToHunks({ index: 2, oldStartLine: 91, oldEndLine: 91, newStartLine: 93, newEndLine: 92 }, hunks)).toEqual([2]);
  });

  it("returns every hunk a merged chunk spans", () => {
    expect(mapChunkToHunks({ index: 0, oldStartLine: 4, oldEndLine: 41, newStartLine: 4, newEndLine: 42 }, hunks)).toEqual([0, 1]);
  });

  it("falls back to the nearest hunk, and to the ordinal without hunks", () => {
    expect(mapChunkToHunks({ index: 5, oldStartLine: 60, oldEndLine: 60, newStartLine: 61, newEndLine: 61 }, hunks)).toEqual([1]);
    expect(mapChunkToHunks({ index: 5, oldStartLine: 1, oldEndLine: 1, newStartLine: 1, newEndLine: 1 }, undefined)).toEqual([5]);
    expect(mapChunkToHunks({ index: 3, oldStartLine: 1, oldEndLine: 1, newStartLine: 1, newEndLine: 1 }, [])).toEqual([3]);
  });

  it("agrees with the hunks of the repo's own line diff", () => {
    const oldText = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    const lines = oldText.trimEnd().split("\n");
    lines[2] = "line three";
    lines.splice(25, 0, "added");
    const newText = lines.join("\n") + "\n";
    const { hunks: hv } = buildDiff(oldText, newText);
    const hs: Hunk[] = hv.map((h, index) => {
      const m = /@@ -(\d+),\d+ \+(\d+),(\d+) @@/.exec(h.header)!;
      return { index, oldStart: +m[1]!, oldLines: 0, newStart: +m[2]!, newLines: +m[3]!, header: h.header, lines: h.rows.map((r) => (r.kind === "add" ? "+" : r.kind === "del" ? "-" : " ") + r.text) };
    });
    expect(hs.length).toBe(2);
    expect(mapChunkToHunks({ index: 0, oldStartLine: 3, oldEndLine: 3, newStartLine: 3, newEndLine: 3 }, hs)).toEqual([0]);
    expect(mapChunkToHunks({ index: 1, oldStartLine: 25, oldEndLine: 24, newStartLine: 26, newEndLine: 26 }, hs)).toEqual([1]);
  });
});

describe("chunkLineRange / chunkInfo", () => {
  const docA = Text.of(["a", "b", "c", "d"]);
  const docB = Text.of(["a", "B", "x", "c", "d"]);

  it("converts chunk offsets to 1-based inclusive line ranges (empty side => end = start - 1)", () => {
    // replace line 2 ("b") with lines 2-3 ("B", "x"): A [2,4), B [2,6)
    expect(chunkLineRange(docA, 2, 4, 3)).toEqual({ start: 2, end: 2 });
    expect(chunkLineRange(docB, 2, 6, 5)).toEqual({ start: 2, end: 3 });
    expect(chunkLineRange(docA, 2, 2, 2)).toEqual({ start: 2, end: 1 });
  });

  it("builds a full DiffChunkInfo with hunk indexes", () => {
    const chunk = new Chunk([], 2, 4, 2, 6);
    const info = chunkInfo(chunk, 0, docA, docB, [hunk(7, 1, 1, [" a", "-b", "+B", "+x", " c"])]);
    expect(info).toMatchObject({ index: 0, fromA: 2, toA: 4, fromB: 2, toB: 6, oldStartLine: 2, oldEndLine: 2, newStartLine: 2, newEndLine: 3, hunkIndexes: [7] });
  });
});

describe("minimalChange", () => {
  it("returns null for equal strings and trims the common prefix/suffix", () => {
    expect(minimalChange("abc", "abc")).toBeNull();
    expect(minimalChange("hello world", "hello brave world")).toEqual({ from: 6, to: 6, insert: "brave " });
    expect(minimalChange("abcdef", "abXef")).toEqual({ from: 2, to: 4, insert: "X" });
    expect(minimalChange("", "new")).toEqual({ from: 0, to: 0, insert: "new" });
    expect(minimalChange("gone", "")).toEqual({ from: 0, to: 4, insert: "" });
  });
});
