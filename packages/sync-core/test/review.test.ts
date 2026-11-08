import { mkdir, rename, unlink, utimes, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { isSyncCoreError } from "../src/index.js";
import { lines, makeProject, replaceLine } from "./helpers.js";

const BIN = Buffer.from([0, 1, 2, 3, 0, 255, 254, 10]);

describe("review", () => {
  it("lists added, modified, deleted, renamed and binary changes", async () => {
    const p = await makeProject({
      "a.txt": "one\ntwo\nthree\n",
      "b.txt": "bye\n",
      "old name.txt": lines(30, "keep"),
      "img.bin": BIN,
      "stay.txt": "same\n",
    });
    await writeFile(p.w("a.txt"), "one\nTWO\nthree\nfour\n");
    await unlink(p.w("b.txt"));
    await mkdir(p.w("新 目录"));
    await rename(p.w("old name.txt"), p.w("新 目录/new name.txt"));
    await writeFile(p.w("c.txt"), "brand\nnew\n");
    await writeFile(p.w("img.bin"), Buffer.concat([BIN, BIN]));

    const r = await p.repo.review();
    expect(r.localCommit).toBe(await p.repo.localCommit());
    expect(r.files).toEqual([
      { path: "a.txt", status: "modified", binary: false, additions: 2, deletions: 1, sizeBytes: 19, lastTouchedBy: null },
      { path: "b.txt", status: "deleted", binary: false, additions: 0, deletions: 1, sizeBytes: 4, lastTouchedBy: null },
      { path: "c.txt", status: "added", binary: false, additions: 2, deletions: 0, sizeBytes: 10, lastTouchedBy: null },
      { path: "img.bin", status: "modified", binary: true, additions: 0, deletions: 0, sizeBytes: 16, lastTouchedBy: null },
      { path: "新 目录/new name.txt", oldPath: "old name.txt", status: "renamed", binary: false, additions: 0, deletions: 0, sizeBytes: lines(30, "keep").length, lastTouchedBy: null },
    ]);
  });

  it("detects renames with edits and ignores excluded / .gitignored files", async () => {
    const p = await makeProject({ ".gitignore": "*.log\n", "src/x.ts": lines(40, "code") });
    await rename(p.w("src/x.ts"), p.w("src/y.ts"));
    await writeFile(p.w("src/y.ts"), replaceLine(lines(40, "code"), 10, "changed"));
    await mkdir(p.w("node_modules/pkg"), { recursive: true });
    await writeFile(p.w("node_modules/pkg/index.js"), "x");
    await mkdir(p.w("build"));
    await writeFile(p.w("build/out"), "o");
    await writeFile(p.w("debug.log"), "l");
    await writeFile(p.w(".DS_Store"), "d");
    const r = await p.repo.review();
    expect(r.files).toMatchObject([{ path: "src/y.ts", oldPath: "src/x.ts", status: "renamed", additions: 1, deletions: 1 }]);
    expect(await p.repo.pendingCount()).toBe(1);
  });

  // Files over the large-file threshold (pointers + store): test/large-files.test.ts.

  it("sees a same-size edit made right after a review (racy stat cache)", async () => {
    const p = await makeProject({ "f.txt": "aaaa\n" });
    for (const v of ["bbbb\n", "cccc\n", "aaaa\n", "dddd\n"]) {
      await p.repo.review(); // refreshes and saves the stat cache
      await writeFile(p.w("f.txt"), v);
      const files = (await p.repo.review()).files;
      expect(files.map((f) => f.path)).toEqual(v === "aaaa\n" ? [] : ["f.txt"]);
    }
    // Same size, same mtime as cached: still detected because the cache is never trusted for racy entries.
    const t = new Date();
    await writeFile(p.w("f.txt"), "eeee\n");
    await utimes(p.w("f.txt"), t, t);
    await p.repo.review();
    await writeFile(p.w("f.txt"), "ffff\n");
    await utimes(p.w("f.txt"), t, t);
    const d = await p.repo.diffFile("f.txt");
    expect(d.newText).toBe("ffff\n");
  });
});

describe("diffFile", () => {
  const BASE = lines(40);

  it("returns hunks with indices that are stable across calls, and both texts", async () => {
    const p = await makeProject({ "f.txt": BASE });
    let edited = replaceLine(BASE, 3, "CHANGE A");
    edited = replaceLine(edited, 20, "CHANGE B");
    edited = replaceLine(edited, 37, "CHANGE C");
    await writeFile(p.w("f.txt"), edited);
    const d1 = await p.repo.diffFile("f.txt");
    const d2 = await p.repo.diffFile("f.txt");
    expect(d1).toEqual(d2);
    expect(d1.hunks.map((x) => x.index)).toEqual([0, 1, 2]);
    expect(d1.hunks[1]!.lines).toContain("+CHANGE B");
    expect(d1.hunks[1]!.lines).toContain("-line 20");
    expect(d1).toMatchObject({ path: "f.txt", status: "modified", binary: false, tooLarge: false, oldText: BASE, newText: edited });
    expect(d1.localCommit).toBe(await p.repo.localCommit());
  });

  it("handles added, deleted, renamed, binary, unchanged and unknown paths", async () => {
    const p = await makeProject({ "del.txt": "gone\n", "img.bin": BIN, "same.txt": "same\n", "名 字.txt": lines(10) });
    await writeFile(p.w("new file.txt"), "n1\nn2\n");
    await unlink(p.w("del.txt"));
    await writeFile(p.w("img.bin"), Buffer.concat([BIN, Buffer.from([0])]));
    await rename(p.w("名 字.txt"), p.w("改 名.txt"));
    await writeFile(p.w("改 名.txt"), replaceLine(lines(10), 5, "five"));

    const added = await p.repo.diffFile("new file.txt");
    expect(added).toMatchObject({ status: "added", oldText: "", newText: "n1\nn2\n" });
    expect(added.hunks).toHaveLength(1);
    expect(added.hunks[0]!.lines).toEqual(["+n1", "+n2"]);

    const deleted = await p.repo.diffFile("del.txt");
    expect(deleted).toMatchObject({ status: "deleted", oldText: "gone\n", newText: "" });

    const renamed = await p.repo.diffFile("改 名.txt");
    expect(renamed).toMatchObject({ status: "renamed", oldPath: "名 字.txt" });
    expect(renamed.hunks).toHaveLength(1);
    expect(renamed.hunks[0]!.lines).toContain("+five");
    // Looking a rename up by its old path finds the same change.
    expect((await p.repo.diffFile("名 字.txt")).path).toBe("改 名.txt");

    expect(await p.repo.diffFile("img.bin")).toMatchObject({ binary: true, oldText: null, newText: null, hunks: [] });
    expect(await p.repo.diffFile("same.txt")).toMatchObject({ status: "unchanged", oldText: "same\n", newText: "same\n", hunks: [] });
    await expect(p.repo.diffFile("missing.txt")).rejects.toSatisfy((e: unknown) => isSyncCoreError(e, "not_found"));
    await expect(p.repo.diffFile("../x")).rejects.toSatisfy((e: unknown) => isSyncCoreError(e, "invalid_path"));
  });

  it("gives no text payload for files over 2 MB", async () => {
    const big = "x".repeat(2 * 1024 * 1024 + 10) + "\n";
    const p = await makeProject({ "big.txt": big });
    await writeFile(p.w("big.txt"), big + "more\n");
    const d = await p.repo.diffFile("big.txt");
    expect(d).toMatchObject({ binary: false, tooLarge: true, oldText: null, newText: null, hunks: [] });
    await expect(p.repo.accept({ path: "big.txt", hunks: [0] })).rejects.toSatisfy((e: unknown) => isSyncCoreError(e, "binary"));
    const r = await p.repo.accept({ path: "big.txt" });
    expect(Buffer.from(r.files[0]!.contentBase64!, "base64").toString()).toBe(big + "more\n");
  });
});
