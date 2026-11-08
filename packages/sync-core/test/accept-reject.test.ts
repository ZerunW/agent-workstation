import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { isSyncCoreError } from "../src/index.js";
import { commitCount, lines, localContent, localMode, makeProject, replaceLine } from "./helpers.js";

const BASE = lines(40);
const b64 = (s: string): string => Buffer.from(s).toString("base64");

function threeEdits(): string {
  let e = replaceLine(BASE, 3, "CHANGE A");
  e = replaceLine(e, 20, "CHANGE B");
  return replaceLine(e, 37, "CHANGE C");
}

describe("accept", () => {
  it("accepts a whole file: local takes the work-tree content, the work tree is untouched", async () => {
    const p = await makeProject({ "f.txt": BASE, "g.txt": "g\n" });
    await writeFile(p.w("f.txt"), threeEdits());
    await writeFile(p.w("g.txt"), "g2\n");
    const r = await p.repo.accept({ path: "f.txt" });
    expect(r.files).toEqual([{ path: "f.txt", contentBase64: b64(threeEdits()), deleted: false }]);
    expect(r.localCommit).toBe(await p.repo.localCommit());
    expect(p.git("log", "-1", "--format=%s", "refs/heads/local").trim()).toBe("accept: f.txt");
    expect(localContent(p, "f.txt")).toBe(threeEdits());
    expect(await p.read("f.txt")).toBe(threeEdits());
    expect((await p.repo.review()).files.map((f) => f.path)).toEqual(["g.txt"]);
  });

  it("accepts a subset of hunks and leaves the rest pending", async () => {
    const p = await makeProject({ "f.txt": BASE });
    await writeFile(p.w("f.txt"), threeEdits());
    const r = await p.repo.accept({ path: "f.txt", hunks: [0, 2] });
    const expected = replaceLine(replaceLine(BASE, 3, "CHANGE A"), 37, "CHANGE C");
    expect(localContent(p, "f.txt")).toBe(expected);
    expect(r.files).toEqual([{ path: "f.txt", contentBase64: b64(expected), deleted: false }]);
    expect(await p.read("f.txt")).toBe(threeEdits());
    const d = await p.repo.diffFile("f.txt");
    expect(d.hunks).toHaveLength(1);
    expect(d.hunks[0]!.lines).toContain("+CHANGE B");
    expect(d.hunks[0]!.index).toBe(0);
    // The remaining hunk can be accepted by its new index.
    await p.repo.accept({ path: "f.txt", hunks: [0] });
    expect(localContent(p, "f.txt")).toBe(threeEdits());
    expect((await p.repo.review()).files).toEqual([]);
  });

  it("places a hunk correctly when identical context appears elsewhere", async () => {
    // Two identical blocks exactly 10 lines apart; Claude adds 10 lines at the top and edits the FIRST block.
    const head = lines(10, "head");
    const block = "c1\nc2\nc3\nTARGET\nc4\nc5\nc6\n";
    const base = head + block + "f1\nf2\nf3\n" + block + lines(5, "tail");
    const p = await makeProject({ "f.txt": base });
    const edited = lines(10, "added") + head + block.replace("TARGET", "EDITED") + "f1\nf2\nf3\n" + block + lines(5, "tail");
    await writeFile(p.w("f.txt"), edited);
    const d = await p.repo.diffFile("f.txt");
    expect(d.hunks).toHaveLength(2);
    await p.repo.accept({ path: "f.txt", hunks: [1] });
    expect(localContent(p, "f.txt")).toBe(head + block.replace("TARGET", "EDITED") + "f1\nf2\nf3\n" + block + lines(5, "tail"));
  });

  it("accepts all: added, modified, deleted, renamed and executable files", async () => {
    const p = await makeProject({ "m.txt": "m\n", "d.txt": "d\n", "old.txt": lines(20, "r"), "keep.txt": "k\n" });
    await writeFile(p.w("m.txt"), "m2\n");
    await unlink(p.w("d.txt"));
    await mkdir(p.w("目录"));
    await rename(p.w("old.txt"), p.w("目录/新 名.txt"));
    await writeFile(p.w("added.sh"), "#!/bin/sh\n");
    await chmod(p.w("added.sh"), 0o755);
    const n0 = commitCount(p);
    const r = await p.repo.accept({ all: true });
    expect(commitCount(p)).toBe(n0 + 1);
    expect(p.git("log", "-1", "--format=%s", "refs/heads/local").trim()).toBe("accept: all (4 files)");
    expect(r.skipped).toEqual([]);
    expect(r.files).toEqual([
      { path: "added.sh", contentBase64: b64("#!/bin/sh\n"), deleted: false },
      { path: "d.txt", contentBase64: null, deleted: true },
      { path: "m.txt", contentBase64: b64("m2\n"), deleted: false },
      { path: "old.txt", contentBase64: null, deleted: true },
      { path: "目录/新 名.txt", contentBase64: b64(lines(20, "r")), deleted: false },
    ]);
    expect((await p.repo.review()).files).toEqual([]);
    expect(localMode(p, "added.sh")).toBe("100755");
    expect(p.git("rev-parse", "refs/heads/local^{tree}").trim()).toBe(
      p.git("rev-parse", "refs/heads/local^{tree}").trim(), // sanity
    );
    expect(localContent(p, "d.txt")).toBeNull();
  });

  it("whole-file accept of a deletion and of a rename returns deleted entries", async () => {
    const p = await makeProject({ "a.txt": "a\n", "r.txt": lines(10) });
    await unlink(p.w("a.txt"));
    await rename(p.w("r.txt"), p.w("r2.txt"));
    expect((await p.repo.accept({ path: "a.txt" })).files).toEqual([{ path: "a.txt", contentBase64: null, deleted: true }]);
    expect((await p.repo.accept({ path: "r2.txt" })).files).toEqual([
      { path: "r.txt", contentBase64: null, deleted: true },
      { path: "r2.txt", contentBase64: b64(lines(10)), deleted: false },
    ]);
    expect((await p.repo.review()).files).toEqual([]);
  });

  it("validates hunk selections and the optional localCommit guard", async () => {
    const p = await makeProject({ "f.txt": BASE, "img.bin": Buffer.from([0, 1, 2]) });
    await writeFile(p.w("f.txt"), threeEdits());
    await writeFile(p.w("img.bin"), Buffer.from([0, 1, 3]));
    await writeFile(p.w("new.txt"), "n\n");
    await expect(p.repo.accept({ path: "f.txt", hunks: [3] })).rejects.toSatisfy((e: unknown) => isSyncCoreError(e, "stale"));
    await expect(p.repo.accept({ path: "img.bin", hunks: [0] })).rejects.toSatisfy((e: unknown) => isSyncCoreError(e, "binary"));
    await expect(p.repo.accept({ path: "f.txt", localCommit: "0".repeat(40) })).rejects.toSatisfy((e: unknown) => isSyncCoreError(e, "stale"));
    // Selecting every hunk of an added file is a whole-file accept.
    expect((await p.repo.accept({ path: "new.txt", hunks: [0] })).files).toEqual([{ path: "new.txt", contentBase64: b64("n\n"), deleted: false }]);
    // Empty selection / unchanged path: nothing happens.
    const before = await p.repo.localCommit();
    expect(await p.repo.accept({ path: "f.txt", hunks: [] })).toEqual({ localCommit: before, files: [], skipped: [] });
    expect(await p.repo.accept({ path: "nope.txt" })).toEqual({ localCommit: before, files: [], skipped: [] });
  });
});

describe("reject", () => {
  it("rejects whole files (modified, added, deleted, renamed) after writing a trash ref", async () => {
    const p = await makeProject({ "m.txt": "m\n", "d.txt": "d\n", "r.txt": lines(10, "r") });
    await writeFile(p.w("m.txt"), "claude\n");
    await writeFile(p.w("new 文件.txt"), "n\n");
    await unlink(p.w("d.txt"));
    await rename(p.w("r.txt"), p.w("r2.txt"));
    const localBefore = await p.repo.localCommit();

    const r1 = await p.repo.reject({ path: "m.txt" });
    expect(r1.trashRef).toMatch(/^refs\/trash\//);
    expect(p.git("show", `${r1.trashRef}:m.txt`)).toBe("claude\n");
    expect(await p.read("m.txt")).toBe("m\n");

    await p.repo.reject({ path: "new 文件.txt" });
    await expect(lstat(p.w("new 文件.txt"))).rejects.toThrow();
    await p.repo.reject({ path: "d.txt" });
    expect(await p.read("d.txt")).toBe("d\n");
    await p.repo.reject({ path: "r2.txt" });
    expect(await p.read("r.txt")).toBe(lines(10, "r"));
    await expect(lstat(p.w("r2.txt"))).rejects.toThrow();

    expect((await p.repo.review()).files).toEqual([]);
    expect(await p.repo.localCommit()).toBe(localBefore);
    const trash = (await p.repo.history()).filter((s) => s.kind === "trash");
    expect(trash).toHaveLength(4);
  });

  it("rejects selected hunks with git apply -R", async () => {
    const p = await makeProject({ "f.txt": BASE });
    await writeFile(p.w("f.txt"), threeEdits());
    const r = await p.repo.reject({ path: "f.txt", hunks: [1] });
    expect(r.trashRef).not.toBeNull();
    expect(p.git("show", `${r.trashRef}:f.txt`)).toBe(threeEdits());
    expect(await p.read("f.txt")).toBe(replaceLine(replaceLine(BASE, 3, "CHANGE A"), 37, "CHANGE C"));
    expect((await p.repo.diffFile("f.txt")).hunks).toHaveLength(2);

    // Several kept hunks in reverse: reject the first and last of three.
    await writeFile(p.w("f.txt"), threeEdits());
    await p.repo.reject({ path: "f.txt", hunks: [0, 2] });
    expect(await p.read("f.txt")).toBe(replaceLine(BASE, 20, "CHANGE B"));
  });

  it("rejects everything, keeping the executable bit of restored files", async () => {
    const p = await makeProject({ "run.sh": { content: "#!/bin/sh\n", mode: 0o755 }, "a.txt": "a\n" });
    await writeFile(p.w("run.sh"), "#!/bin/sh\nrm -rf /\n");
    await writeFile(p.w("a.txt"), "changed\n");
    await writeFile(p.w("extra.txt"), "x\n");
    const r = await p.repo.reject({ all: true });
    expect(r.paths.sort()).toEqual(["a.txt", "extra.txt", "run.sh"]);
    expect((await p.repo.review()).files).toEqual([]);
    expect(await readFile(p.w("run.sh"), "utf8")).toBe("#!/bin/sh\n");
    expect((await lstat(p.w("run.sh"))).mode & 0o111).not.toBe(0);
    expect(p.git("show", `${r.trashRef}:extra.txt`)).toBe("x\n");
  });

  it("does nothing (and writes no trash) when there is nothing to reject", async () => {
    const p = await makeProject({ "a.txt": "a\n" });
    expect(await p.repo.reject({ path: "a.txt" })).toEqual({ localCommit: await p.repo.localCommit(), trashRef: null, paths: [] });
    expect((await p.repo.history()).filter((s) => s.kind === "trash")).toEqual([]);
  });
});
