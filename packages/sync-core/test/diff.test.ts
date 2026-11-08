import { describe, expect, it } from "vitest";
import { filterPatch, parseUnifiedDiff, patchHeader } from "../src/index.js";

const PATCH = [
  "diff --git a/f.txt b/f.txt",
  "old mode 100644",
  "new mode 100755",
  "index 1111111..2222222",
  "--- a/f.txt",
  "+++ b/f.txt",
  "@@ -1,4 +1,4 @@",
  " a",
  "-b",
  "+B",
  " c",
  " d",
  "@@ -10,3 +10,5 @@ function foo() {",
  " j",
  "+k1",
  "+k2",
  " l",
  " m",
  "@@ -20 +22 @@",
  "-t",
  "\\ No newline at end of file",
  "+T",
  "\\ No newline at end of file",
  "",
].join("\n");

describe("parseUnifiedDiff", () => {
  it("parses hunks with stable indices, default counts and section text", () => {
    const hunks = parseUnifiedDiff(PATCH);
    expect(hunks).toHaveLength(3);
    expect(hunks.map((h) => h.index)).toEqual([0, 1, 2]);
    expect(hunks[0]).toMatchObject({ oldStart: 1, oldLines: 4, newStart: 1, newLines: 4, header: "@@ -1,4 +1,4 @@" });
    expect(hunks[0]!.lines).toEqual([" a", "-b", "+B", " c", " d"]);
    expect(hunks[1]).toMatchObject({ oldStart: 10, oldLines: 3, newStart: 10, newLines: 5, header: "@@ -10,3 +10,5 @@ function foo() {" });
    expect(hunks[2]).toMatchObject({ oldStart: 20, oldLines: 1, newStart: 22, newLines: 1 });
    expect(hunks[2]!.lines).toEqual(["-t", "\\ No newline at end of file", "+T", "\\ No newline at end of file"]);
  });

  it("returns the file header separately and is deterministic", () => {
    expect(patchHeader(PATCH)[0]).toBe("diff --git a/f.txt b/f.txt");
    expect(parseUnifiedDiff(PATCH)).toEqual(parseUnifiedDiff(PATCH));
  });

  it("keeps body lines that look like headers and stops at the next file", () => {
    const text = [
      "diff --git a/x b/x",
      "--- a/x",
      "+++ b/x",
      "@@ -1,2 +1,2 @@",
      "-@@ -1 +1 @@",
      "+--- not a header",
      " diff --git inside content",
      "diff --git a/y b/y",
      "--- a/y",
      "+++ b/y",
      "@@ -1 +1 @@",
      "-1",
      "+2",
      "",
    ].join("\n");
    const hunks = parseUnifiedDiff(text);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.lines).toEqual(["-@@ -1 +1 @@", "+--- not a header", " diff --git inside content"]);
  });

  it("handles CRLF content and an empty patch", () => {
    const hunks = parseUnifiedDiff("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\r\n+b\r\n");
    expect(hunks[0]!.lines).toEqual(["-a\r", "+b\r"]);
    expect(parseUnifiedDiff("")).toEqual([]);
  });
});

describe("filterPatch", () => {
  const headers = (p: string): string[] => p.split("\n").filter((l) => l.startsWith("@@"));

  it("keeps selected hunks, drops mode lines and recomputes new-side hints (forward)", () => {
    const out = filterPatch(PATCH, [1, 2]);
    expect(out).not.toContain("old mode");
    expect(out).not.toContain("new mode");
    expect(out).toContain("index 1111111..2222222");
    // Hunk 0 (delta 0) dropped: hunk 1 still at +10; hunk 2 shifted by the +2 of hunk 1 only.
    expect(headers(out)).toEqual(["@@ -10,3 +10,5 @@ function foo() {", "@@ -20,1 +22,1 @@"]);
    expect(headers(filterPatch(PATCH, [2]))).toEqual(["@@ -20,1 +20,1 @@"]);
    expect(out.endsWith("\\ No newline at end of file\n")).toBe(true);
  });

  it("recomputes old-side hints for reverse application", () => {
    // Only hunk 2 is reverted from the new file: it sits at +22 and nothing before it is reverted.
    expect(headers(filterPatch(PATCH, [2], { reverse: true }))).toEqual(["@@ -22,1 +22,1 @@"]);
    // Hunks 1 and 2 reverted: after reverting hunk 1 (+2 lines) hunk 2 sits at 20.
    expect(headers(filterPatch(PATCH, [1, 2], { reverse: true }))).toEqual(["@@ -10,3 +10,5 @@ function foo() {", "@@ -20,1 +22,1 @@"]);
  });

  it("handles zero-length ranges (pure additions/deletions)", () => {
    const p = ["--- a/z", "+++ b/z", "@@ -0,0 +1,2 @@", "+x", "+y", "@@ -5,2 +7,0 @@", "-p", "-q", ""].join("\n");
    expect(headers(filterPatch(p, [1]))).toEqual(["@@ -5,2 +4,0 @@"]);
    expect(headers(filterPatch(p, [0, 1]))).toEqual(["@@ -0,0 +1,2 @@", "@@ -5,2 +6,0 @@"]);
  });

  it("can keep mode changes, returns '' for an empty selection and rejects bad indices", () => {
    expect(filterPatch(PATCH, [0], { keepModeChange: true })).toContain("new mode 100755");
    expect(filterPatch(PATCH, [])).toBe("");
    expect(() => filterPatch(PATCH, [3])).toThrow(/out of range/);
    expect(() => filterPatch(PATCH, [-1])).toThrow();
    expect(() => filterPatch(PATCH, [0.5])).toThrow();
  });

  it("dedupes and orders indices", () => {
    expect(filterPatch(PATCH, [2, 0, 2])).toBe(filterPatch(PATCH, [0, 2]));
  });
});
