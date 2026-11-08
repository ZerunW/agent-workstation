import type { FileEntry } from "@agent-workstation/protocol";
import { describe, expect, it } from "vitest";
import type { ChangedFile } from "../../store/changed";
import { ancestorsOf, dirOfEntry, flattenRows, foldersToReveal, imageMimeForPath, isChangedEntry, scopeChanged, sortEntries, summarizeTree, validFolderName, type DirState } from "./fileTree";

const e = (path: string, kind: FileEntry["kind"] = "file", size = 10): FileEntry => ({ path, name: path.split("/").pop()!, kind, size, mtime: "2026-10-31T00:00:00Z" });
const loaded = (...entries: FileEntry[]): DirState => ({ entries, loading: false, error: null });
const ch = (kind: ChangedFile["kind"] = "change"): ChangedFile => ({ kind, at: "2026-10-31T00:00:00Z", sessionId: null });

describe("root scoping", () => {
  it("flattens from the root and scopes changed paths to it", () => {
    const dirs: Record<string, DirState> = { "p/x": loaded(e("p/x/a.md"), e("p/x/s", "dir")), "": loaded(e("p", "dir")) };
    expect(flattenRows(dirs, new Set(), { root: "p/x" }).map((r) => (r.kind === "entry" ? r.entry.path : r.status))).toEqual(["p/x/s", "p/x/a.md"]);
    const changed = { "p/x/s/b.md": ch(), "p/y/c.md": ch(), "p/xx/d.md": ch() };
    expect(scopeChanged(changed, "p/x")).toEqual({ "p/x/s/b.md": ch() });
    expect(foldersToReveal(changed, "p/x")).toEqual(["p/x/s"]);
    expect(scopeChanged(changed, "")).toBe(changed);
  });
});

describe("sortEntries", () => {
  it("puts folders first, then natural case-insensitive order", () => {
    const sorted = sortEntries([e("b.txt"), e("img10.png"), e("zeta", "dir"), e("Img2.png"), e("alpha", "dir"), e("a.txt"), e("link", "symlink")]);
    expect(sorted.map((x) => x.name)).toEqual(["alpha", "zeta", "a.txt", "b.txt", "Img2.png", "img10.png", "link"]);
  });
  it("does not mutate its input", () => {
    const input = [e("b"), e("a")];
    sortEntries(input);
    expect(input.map((x) => x.name)).toEqual(["b", "a"]);
  });
});

describe("flattenRows (lazy tree)", () => {
  const dirs: Record<string, DirState> = {
    "": loaded(e("docs", "dir"), e("inbox", "dir"), e("readme.md")),
    docs: loaded(e("docs/a.md"), e("docs/sub", "dir")),
  };

  it("hides children of collapsed folders", () => {
    const rows = flattenRows(dirs, new Set());
    expect(rows.map((r) => (r.kind === "entry" ? r.entry.path : r.status))).toEqual(["docs", "inbox", "readme.md"]);
  });

  it("shows loaded children of expanded folders with depth", () => {
    const rows = flattenRows(dirs, new Set(["docs"]));
    const entries = rows.filter((r) => r.kind === "entry").map((r) => (r.kind === "entry" ? [r.entry.path, r.depth] : []));
    expect(entries).toEqual([
      ["docs", 0],
      ["docs/sub", 1],
      ["docs/a.md", 1],
      ["inbox", 0],
      ["readme.md", 0],
    ]);
  });

  it("emits a loading row for an expanded folder that has not loaded yet", () => {
    const rows = flattenRows(dirs, new Set(["inbox"]));
    const idx = rows.findIndex((r) => r.kind === "entry" && r.entry.path === "inbox");
    expect(rows[idx + 1]).toMatchObject({ kind: "status", status: "loading", dir: "inbox", depth: 1 });
  });

  it("emits error and empty rows for nested folders", () => {
    const withState: Record<string, DirState> = { ...dirs, inbox: { entries: null, loading: false, error: "boom" }, "docs/sub": loaded() };
    const rows = flattenRows(withState, new Set(["inbox", "docs", "docs/sub"]));
    expect(rows.some((r) => r.kind === "status" && r.status === "error" && r.dir === "inbox" && r.message === "boom")).toBe(true);
    expect(rows.some((r) => r.kind === "status" && r.status === "empty" && r.dir === "docs/sub")).toBe(true);
  });

  it("keeps showing stale entries while a refresh is loading", () => {
    const refreshing: Record<string, DirState> = { ...dirs, "": { entries: dirs[""]!.entries, loading: true, error: null } };
    expect(flattenRows(refreshing, new Set()).filter((r) => r.kind === "entry")).toHaveLength(3);
  });
});

describe("changed-this-session filter", () => {
  const dirs: Record<string, DirState> = {
    "": loaded(e("docs", "dir"), e("inbox", "dir"), e("readme.md")),
    docs: loaded(e("docs/a.md"), e("docs/b.md")),
  };

  it("keeps changed files and the folders that contain them", () => {
    const rows = flattenRows(dirs, new Set(["docs"]), { changed: { "docs/b.md": ch("add") } });
    expect(rows.map((r) => (r.kind === "entry" ? r.entry.path : r.status))).toEqual(["docs", "docs/b.md"]);
  });

  it("ignores deleted paths", () => {
    const rows = flattenRows(dirs, new Set(), { changed: { "readme.md": ch("unlink") } });
    expect(rows).toEqual([]);
  });

  it("isChangedEntry treats a folder as changed when anything inside changed", () => {
    expect(isChangedEntry(e("docs", "dir"), { "docs/a.md": ch() })).toBe(true);
    expect(isChangedEntry(e("inbox", "dir"), { "docs/a.md": ch() })).toBe(false);
    expect(isChangedEntry(e("docs", "dir"), { docs: ch("addDir") })).toBe(true);
    expect(isChangedEntry(e("docs/a.md"), { "docs/a.md": ch("unlink") })).toBe(false);
  });

  it("foldersToReveal lists every ancestor of existing changed paths", () => {
    expect(foldersToReveal({ "a/b/c.txt": ch(), "x/y.txt": ch("add"), "gone/z.txt": ch("unlink"), "new/dir": ch("addDir") })).toEqual(["a", "a/b", "new", "new/dir", "x"]);
  });
});

describe("misc helpers", () => {
  it("ancestorsOf", () => {
    expect(ancestorsOf("a/b/c.txt")).toEqual(["a", "a/b"]);
    expect(ancestorsOf("top.txt")).toEqual([]);
  });
  it("summarizeTree counts files (not folders) and sums bytes", () => {
    expect(summarizeTree([e("a", "dir", 0), e("a/x", "file", 1000), e("a/y", "file", 24), e("a/l", "symlink", 5)])).toEqual({ files: 3, bytes: 1029 });
    expect(summarizeTree([])).toEqual({ files: 0, bytes: 0 });
  });
  it("validFolderName", () => {
    expect(validFolderName("notes")).toBe(true);
    expect(validFolderName("  ")).toBe(false);
    expect(validFolderName("a/b")).toBe(false);
    expect(validFolderName("..")).toBe(false);
    expect(validFolderName("a\\b")).toBe(false);
  });
  it("dirOfEntry", () => {
    expect(dirOfEntry(e("docs", "dir"))).toBe("docs");
    expect(dirOfEntry(e("docs/a.md"))).toBe("docs");
    expect(dirOfEntry(e("top.md"))).toBe("");
  });
  it("imageMimeForPath", () => {
    expect(imageMimeForPath("a/b.PNG")).toBe("image/png");
    expect(imageMimeForPath("a/b.svg")).toBe("image/svg+xml");
    expect(imageMimeForPath("a/b.txt")).toBeNull();
  });
});
