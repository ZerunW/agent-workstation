import { describe, expect, it } from "vitest";
import {
  defaultExcludes,
  pairRenames,
  parseLsTreeZ,
  parseNumstatZ,
  parsePorcelainV2,
  porcelainToChanges,
  renderExcludeFile,
  type ChangeRecord,
} from "../src/index.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const Z = "0".repeat(40);

describe("parsePorcelainV2", () => {
  it("parses every entry kind, keeping spaces and CJK in paths", () => {
    const raw = Buffer.from(
      [
        "# branch.oid " + A,
        `1 M. N... 100644 100644 100644 ${A} ${B} my file.txt`,
        `2 R. N... 100644 100755 100755 ${A} ${A} R100 新 目录/名 字.txt`,
        "old name.txt",
        "? 中文 目录/a b.txt",
        "! ignored dir/x",
        `u UU N... 100644 100644 100644 100644 ${A} ${B} ${A} conflict.txt`,
        "",
      ].join("\0"),
      "utf8",
    );
    const e = parsePorcelainV2(raw);
    expect(e).toHaveLength(6);
    expect(e[0]).toEqual({ kind: "header", text: "branch.oid " + A });
    expect(e[1]).toMatchObject({ kind: "ordinary", xy: "M.", modeHead: 0o100644, oidHead: A, oidIndex: B, path: "my file.txt" });
    expect(e[2]).toMatchObject({ kind: "renamed", xy: "R.", score: "R100", modeIndex: 0o100755, path: "新 目录/名 字.txt", origPath: "old name.txt" });
    expect(e[3]).toEqual({ kind: "untracked", path: "中文 目录/a b.txt" });
    expect(e[4]).toEqual({ kind: "ignored", path: "ignored dir/x" });
    expect(e[5]).toMatchObject({ kind: "unmerged", xy: "UU", path: "conflict.txt" });
  });

  it("accepts a string and an empty input", () => {
    expect(parsePorcelainV2("")).toEqual([]);
    expect(parsePorcelainV2("? x\0")).toEqual([{ kind: "untracked", path: "x" }]);
  });
});

describe("porcelainToChanges", () => {
  it("maps staged (X) and unstaged (Y) codes", () => {
    const raw = [
      `1 A. N... 000000 100644 100644 ${Z} ${A} added.txt`,
      `1 M. N... 100644 100644 100644 ${A} ${B} mod.txt`,
      `1 D. N... 100644 000000 000000 ${A} ${Z} del.txt`,
      `1 T. N... 100644 120000 120000 ${A} ${B} link`,
      `1 .M N... 100644 100644 100644 ${A} ${A} unreadable.txt`,
      `2 R. N... 100644 100644 100644 ${A} ${B} R87 new.txt`,
      "old.txt",
      "? big.bin",
      "? nested-repo/",
      "",
    ].join("\0");
    const c = porcelainToChanges(parsePorcelainV2(raw));
    expect(c).toEqual([
      { path: "added.txt", status: "added", oldMode: 0, newMode: 0o100644, oldOid: null, newOid: A },
      { path: "mod.txt", status: "modified", oldMode: 0o100644, newMode: 0o100644, oldOid: A, newOid: B },
      { path: "del.txt", status: "deleted", oldMode: 0o100644, newMode: 0, oldOid: A, newOid: null },
      { path: "link", status: "typechange", oldMode: 0o100644, newMode: 0o120000, oldOid: A, newOid: B },
      { path: "unreadable.txt", status: "modified", oldMode: 0o100644, newMode: 0o100644, oldOid: A, newOid: null, unstaged: true },
      { path: "new.txt", oldPath: "old.txt", status: "renamed", oldMode: 0o100644, newMode: 0o100644, oldOid: A, newOid: B },
      { path: "big.bin", status: "added", oldMode: 0, newMode: 0, oldOid: null, newOid: null, unstaged: true },
    ]);
  });
});

describe("pairRenames", () => {
  const del = (p: string, oid: string, mode = 0o100644): ChangeRecord => ({ path: p, status: "deleted", oldMode: mode, newMode: 0, oldOid: oid, newOid: null });
  const add = (p: string, oid: string | null, mode = 0o100644, unstaged = false): ChangeRecord => ({
    path: p,
    status: "added",
    oldMode: 0,
    newMode: mode,
    oldOid: null,
    newOid: oid,
    ...(unstaged ? { unstaged: true } : {}),
  });

  it("pairs exact delete/add pairs and leaves the rest alone (sorted output)", () => {
    const out = pairRenames([add("z new.txt", A), del("a old.txt", A), del("gone.txt", B), add("other.txt", "c".repeat(40))]);
    expect(out).toEqual([
      { path: "gone.txt", status: "deleted", oldMode: 0o100644, newMode: 0, oldOid: B, newOid: null },
      { path: "other.txt", status: "added", oldMode: 0, newMode: 0o100644, oldOid: null, newOid: "c".repeat(40) },
      { path: "z new.txt", oldPath: "a old.txt", status: "renamed", oldMode: 0o100644, newMode: 0o100644, oldOid: A, newOid: A },
    ]);
  });

  it("is deterministic with several candidates and respects file type / staging", () => {
    const out = pairRenames([del("b", A), del("a", A), add("y", A), add("x", A), add("link", B, 0o120000), del("file", B), add("u", A, 0o100644, true)]);
    const renames = out.filter((r) => r.status === "renamed").map((r) => `${r.oldPath}->${r.path}`);
    expect(renames).toEqual(["a->x", "b->y"]);
    expect(out.find((r) => r.path === "link")?.status).toBe("added");
    expect(out.find((r) => r.path === "file")?.status).toBe("deleted");
    expect(out.find((r) => r.path === "u")?.status).toBe("added");
  });

  it("keeps an executable-bit change paired (same file type)", () => {
    const out = pairRenames([del("run", A, 0o100644), add("bin/run", A, 0o100755)]);
    expect(out).toEqual([{ path: "bin/run", oldPath: "run", status: "renamed", oldMode: 0o100644, newMode: 0o100755, oldOid: A, newOid: A }]);
  });
});

describe("parseNumstatZ / parseLsTreeZ", () => {
  it("parses text, binary and rename entries (tabs in names)", () => {
    const raw = "1\t2\tpath with\ttab\0-\t-\tbin.png\0" + "3\t0\t\0old 名.txt\0new 名.txt\0";
    expect(parseNumstatZ(raw)).toEqual([
      { path: "path with\ttab", additions: 1, deletions: 2, binary: false },
      { path: "bin.png", additions: 0, deletions: 0, binary: true },
      { path: "new 名.txt", oldPath: "old 名.txt", additions: 3, deletions: 0, binary: false },
    ]);
  });

  it("parses ls-tree -z", () => {
    expect(parseLsTreeZ(`100755 blob ${A}\tbin/run me` + "\u0000" + `040000 tree ${B}\tdir` + "\u0000")).toEqual([
      { mode: 0o100755, type: "blob", oid: A, path: "bin/run me" },
      { mode: 0o40000, type: "tree", oid: B, path: "dir" },
    ]);
  });
});

describe("defaultExcludes", () => {
  it("contains the documented defaults and renders caller patterns after them", () => {
    for (const p of [".git", "node_modules/", "build/", "dist/", ".DS_Store", "__pycache__/", ".venv/", "target/"]) {
      expect(defaultExcludes).toContain(p);
    }
    const file = renderExcludeFile(["*.log", "!build/", "bad\nline"]);
    expect(file.indexOf("*.log")).toBeGreaterThan(file.indexOf("target/"));
    expect(file).toContain("!build/");
    expect(file).toContain("badline");
  });
});
