import type { Snapshot } from "@agent-workstation/protocol";
import { describe, expect, it } from "vitest";
import { groupHistory, validRestorePath } from "./history";

const snap = (kind: Snapshot["kind"], at: string, ref = `${kind}-${at}`): Snapshot => ({ ref, sessionId: null, turn: null, at, message: `${kind} at ${at}`, kind });

describe("groupHistory", () => {
  it("groups by kind in display order (sync, snapshot, accept, trash), newest first, dropping empty kinds", () => {
    const groups = groupHistory([
      snap("trash", "2026-10-31T01:00:00Z"),
      snap("snapshot", "2026-10-31T03:00:00Z", "s1"),
      snap("sync", "2026-10-30T10:00:00Z"),
      snap("snapshot", "2026-10-31T05:00:00Z", "s2"),
      snap("sync", "2026-10-31T00:00:00Z"),
    ]);
    expect(groups.map((g) => g.kind)).toEqual(["sync", "snapshot", "trash"]);
    expect(groups[1]!.items.map((s) => s.ref)).toEqual(["s2", "s1"]);
    expect(groups[0]!.items.map((s) => s.at)).toEqual(["2026-10-31T00:00:00Z", "2026-10-30T10:00:00Z"]);
  });
  it("ignores kinds it does not know and handles an empty list", () => {
    expect(groupHistory([])).toEqual([]);
    expect(groupHistory([{ ...snap("sync", "2026-10-31T00:00:00Z"), kind: "weird" as never }])).toEqual([]);
  });
});

describe("validRestorePath", () => {
  it("accepts project-relative paths only", () => {
    expect(validRestorePath("src/app.ts")).toBe(true);
    expect(validRestorePath("  README.md ")).toBe(true);
    for (const bad of ["", "   ", "/etc/passwd", "../x", "a/../../b", "a\0b"]) expect(validRestorePath(bad)).toBe(false);
  });
});
